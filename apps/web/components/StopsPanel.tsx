'use client';

import { useMemo, useState } from 'react';
import { usePoll } from './data';

/**
 * Why the production was not reached.
 *
 * The production board answers how much the line made; this one answers what took the rest of
 * the day. The five-minute buckets always knew how many seconds a machine spent stopped, but
 * never how many times it stopped, and seconds cannot be turned back into a count: twelve
 * stops of two minutes and one stop of twenty-four are the same seconds and completely
 * different problems -- the first is a line that keeps tripping, the second is a breakdown.
 *
 * It is read as a maintenance board, so it carries what maintenance asks for: a Pareto of the
 * reasons, availability and the pace the line holds, and the mean time between stops. Every
 * number opens the stops behind it, because a count nobody can open is a number nobody trusts.
 *
 * The reasons are whatever the rows carry. Today the platform infers three from the counter
 * and the automatic flag; when the HMI starts sending a justification, its codes appear here
 * with no change to this file -- the Pareto simply gets more bars.
 */
type Stop = {
  startedAt: string;
  endedAt: string | null;
  seconds: number | null;
  state: string;
  product: string | null;
  planned: boolean;
  date: string;
};
type Stops = {
  from: string;
  to: string;
  time: {
    producing: number;
    idle: number;
    manual: number;
    pieces: number;
    reference: number | null;
    plannedSeconds: number;
    reports: number;
  };
  days: Array<{
    date: string;
    stops: number;
    seconds: number;
    pauses: number;
    pauseSeconds: number;
    longestSeconds: number;
  }>;
  reasons: Array<{ state: string; stops: number; seconds: number }>;
  longest: Array<{ startedAt: string; seconds: number; state: string; product: string | null }>;
  all: Stop[];
};

const REASONS: Record<string, { label: string; color: string }> = {
  idle: { label: 'Ociosa', color: '#f2a93b' },
  manual: { label: 'Manual / parada', color: '#e4572e' },
  offline: { label: 'Sem comunicação', color: '#98a6ab' },
};
const reasonOf = (state: string) => REASONS[state] ?? { label: state, color: '#7a8fa6' };

/** A duration as a plant says it: "2 min", "1h05". */
function duration(seconds: number) {
  if (!seconds || seconds < 60) return `${Math.round(seconds || 0)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
    : `${minutes} min`;
}
const day = (date: string) => date.split('-').reverse().slice(0, 2).join('/');
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const percent = (value: number | null) =>
  value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;

/** The dashboard's own period words, so every card is filtered the same way. */
type Period = 'today' | '7d' | 'week' | 'month' | 'year' | 'custom';
const PERIODS: Array<[Period, string]> = [
  ['today', 'Hoje'],
  ['7d', '7 dias'],
  ['week', 'Semana'],
  ['month', 'Mês'],
  ['year', 'Ano'],
  ['custom', 'Personalizado'],
];

const isoDay = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

/** The window each word means, as a pair of dates. */
function windowOf(period: Period): { from: string; to: string } {
  const now = new Date();
  const to = isoDay(now);
  const back = (days: number) => isoDay(new Date(now.getTime() - days * 86400000));
  if (period === 'today') return { from: to, to };
  if (period === '7d') return { from: back(6), to };
  if (period === 'week') return { from: back((now.getDay() + 6) % 7), to };
  if (period === 'month') return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  return { from: isoDay(new Date(now.getFullYear(), 0, 1)), to };
}

type Tab = 'resumo' | 'pareto' | 'paradas' | 'eficiencia';
const TABS: Array<[Tab, string]> = [
  ['resumo', 'Resumo'],
  ['pareto', 'Pareto'],
  ['paradas', 'Paradas'],
  ['eficiencia', 'Eficiência'],
];

export function StopsPanel({ deviceId, days = 7 }: { deviceId: string; days?: number }) {
  const [period, setPeriod] = useState<Period>(days <= 1 ? 'today' : '7d');
  const [custom, setCustom] = useState(() => windowOf('7d'));
  const [tab, setTab] = useState<Tab>('resumo');
  // Which number the reader asked to see behind: the modal opens on that slice.
  const [opening, setOpening] = useState<null | 'all' | 'time' | 'average' | 'longest'>(null);

  const range = period === 'custom' ? custom : windowOf(period);
  const stops = usePoll<Stops>(
    `/devices/${deviceId}/stops?from=${range.from}&to=${range.to}`,
    120000,
  );

  const totals = useMemo(() => {
    const rows = stops.data?.days ?? [];
    const time = stops.data?.time;
    const count = rows.reduce((sum, row) => sum + row.stops, 0);
    const seconds = rows.reduce((sum, row) => sum + row.seconds, 0);
    const worked = rows.filter((row) => row.stops > 0).length;
    const producing = time?.producing ?? 0;
    /*
     * The stopped side is taken from the stops, not from the buckets.
     *
     * A bucket only exists while the equipment is talking, so the hours a line spends off the
     * air leave no idle seconds anywhere -- and availability read from buckets alone answered
     * 93 % for a week in which the line was silent for eighteen hours. The stops know about
     * that time, because that is exactly what they record, so the bar, the Pareto and the
     * availability all count the same seconds.
     */
    const running = producing + seconds;
    // The pace the line held, against the pace it reaches when it is going well.
    const rate = producing > 0 ? ((time?.pieces ?? 0) / producing) * 3600 : 0;
    const raw = time?.reference && rate ? rate / time.reference : null;
    /*
     * Performance above 100 % is not a line beating itself: it means the reference pace is set
     * below what the line really does. The standard answer is to cap it and fix the reference,
     * so it is capped here and the card says the reference is short.
     */
    const performance = raw == null ? null : Math.min(1, raw);
    const optimistic = raw != null && raw > 1.02;
    const availability = running > 0 ? producing / running : null;
    return {
      count,
      seconds,
      // Days with no stop at all are not averaged in: they would flatter the number.
      perDay: worked ? count / worked : 0,
      average: count ? seconds / count : 0,
      longest: rows.reduce((most, row) => Math.max(most, row.longestSeconds), 0),
      plannedSeconds: rows.reduce((sum, row) => sum + row.pauseSeconds, 0),
      producing,
      running,
      rate,
      availability,
      performance,
      // No scrap is recorded anywhere, so the quality factor of a real OEE cannot be had.
      // What is shown is availability times performance, and it says so.
      effectiveness: availability != null && performance != null ? availability * performance : null,
      optimistic,
      // Mean time between stops: how long the line holds before the next one.
      mtbf: count ? producing / count : null,
    };
  }, [stops.data]);

  // The vital few: reasons ranked by time lost, with the running share beside them.
  const pareto = useMemo(() => {
    const rows = [...(stops.data?.reasons ?? [])].sort((a, b) => b.seconds - a.seconds);
    const total = rows.reduce((sum, row) => sum + row.seconds, 0);
    let running = 0;
    return rows.map((row) => {
      running += row.seconds;
      return {
        ...row,
        share: total ? row.seconds / total : 0,
        cumulative: total ? running / total : 0,
      };
    });
  }, [stops.data]);

  const peak = Math.max(1, ...(stops.data?.days ?? []).map((row) => row.stops));

  const tools = (
    <div className="stops-tools">
      <div className="widget-period" role="group" aria-label="Período">
        {PERIODS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={period === value ? 'active' : ''}
            onClick={() => setPeriod(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <span className="widget-period-custom">
          <input
            type="date"
            aria-label="De"
            value={custom.from}
            max={custom.to}
            onChange={(event) => setCustom((was) => ({ ...was, from: event.target.value }))}
          />
          <span>até</span>
          <input
            type="date"
            aria-label="Até"
            value={custom.to}
            min={custom.from}
            onChange={(event) => setCustom((was) => ({ ...was, to: event.target.value }))}
          />
        </span>
      )}
    </div>
  );

  if (!stops.data)
    return (
      <div className="stops-panel">
        <div className="stops-head">{tools}</div>
        <div className="stops-empty">{stops.error ?? 'Carregando paradas…'}</div>
      </div>
    );

  return (
    <div className="stops-panel">
      <div className="stops-head">
        <div className="shift-mode stops-tabs" role="group" aria-label="Assunto">
          {TABS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={tab === value ? 'active' : ''}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {tools}
      </div>

      {tab === 'resumo' && (
        <>
          {/* Every figure opens the stops that made it. */}
          <div className="stops-totals">
            <button type="button" onClick={() => setOpening('all')}>
              <span>Paradas</span>
              <b>{totals.count}</b>
              <small>
                {totals.perDay ? `${totals.perDay.toFixed(1)} por dia produzido` : 'nenhuma ainda'}
              </small>
            </button>
            <button type="button" onClick={() => setOpening('time')}>
              <span>Tempo parado</span>
              <b>{duration(totals.seconds)}</b>
              <small>somado no período</small>
            </button>
            <button type="button" onClick={() => setOpening('average')}>
              <span>Parada média</span>
              <b>{duration(totals.average)}</b>
              <small>cada vez que parou</small>
            </button>
            <button type="button" onClick={() => setOpening('longest')}>
              <span>Maior parada</span>
              <b>{duration(totals.longest)}</b>
              <small>a mais longa do período</small>
            </button>
          </div>

          {/* Producing against stopped, on one bar: the same ratio the production board draws. */}
          {totals.running > 0 && (
            <>
              <div className="stops-title">Como o período foi gasto</div>
              <div className="stops-spent">
                <i
                  style={{
                    width: `${(totals.producing / totals.running) * 100}%`,
                    background: '#12b8a6',
                  }}
                  title={`Produzindo · ${duration(totals.producing)}`}
                />
                {pareto.map((row) => (
                  <i
                    key={row.state}
                    style={{
                      width: `${(row.seconds / totals.running) * 100}%`,
                      background: reasonOf(row.state).color,
                    }}
                    title={`${reasonOf(row.state).label} · ${duration(row.seconds)}`}
                  />
                ))}
              </div>
              <div className="stops-spent-legend">
                <span>
                  <i style={{ background: '#12b8a6' }} /> Produzindo {duration(totals.producing)}
                </span>
                {pareto.map((row) => (
                  <span key={row.state}>
                    <i style={{ background: reasonOf(row.state).color }} />{' '}
                    {reasonOf(row.state).label} {duration(row.seconds)}
                  </span>
                ))}
                <b>{percent(totals.availability)} de aproveitamento</b>
              </div>
            </>
          )}

          <div className="stops-title">Dia a dia</div>
          <div className="stops-days">
            {stops.data.days.map((row) => (
              <div
                className="stops-day"
                key={row.date}
                title={`${row.stops} parada(s) · ${duration(row.seconds)}`}
              >
                <div className="stops-day-bar">
                  <i style={{ height: `${(row.stops / peak) * 100}%` }} />
                </div>
                <b>{row.stops}</b>
                <small>{day(row.date)}</small>
              </div>
            ))}
            {!stops.data.days.length && (
              <div className="stops-empty">
                Nenhuma parada registrada no período. A contagem começa a partir do dia em que a
                plataforma passou a gravá-las.
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'pareto' && (
        <>
          <div className="stops-title">
            Onde o tempo foi
            <small> · os motivos que somam a maior parte da parada</small>
          </div>
          {pareto.length ? (
            <div className="stops-pareto">
              {pareto.map((row, index) => {
                const info = reasonOf(row.state);
                // The cut where the running share passes 80 %: above it are the few that matter.
                const vital = index === 0 || pareto[index - 1].cumulative < 0.8;
                return (
                  <button
                    type="button"
                    key={row.state}
                    className={vital ? 'vital' : ''}
                    onClick={() => setOpening('all')}
                  >
                    <span className="stops-pareto-head">
                      <i style={{ background: info.color }} />
                      <strong>{info.label}</strong>
                      <em>
                        {row.stops}× · {duration(row.seconds)}
                      </em>
                    </span>
                    <span className="stops-pareto-bar">
                      <i style={{ width: `${row.share * 100}%`, background: info.color }} />
                      <u style={{ left: `${row.cumulative * 100}%` }} />
                    </span>
                    <span className="stops-pareto-foot">
                      {percent(row.share)} do tempo parado · acumulado {percent(row.cumulative)}
                    </span>
                  </button>
                );
              })}
              <small className="stops-note">
                A marca em cada barra é o acumulado. Os motivos até 80 % são os que vale atacar
                primeiro; abaixo disso, o ganho é pequeno.
              </small>
            </div>
          ) : (
            <div className="stops-empty">Sem paradas no período.</div>
          )}
          <div className="stops-note stops-future">
            Hoje o motivo é deduzido do contador e da variável de automático: ociosa, parada
            manual ou sem comunicação. Quando a IHM passar a mandar a justificativa do operador,
            cada código vira uma barra nova aqui, sem mudar mais nada.
          </div>
        </>
      )}

      {tab === 'paradas' && (
        <div className="stops-list">
          {/* The list scrolls inside the card, so a hundred stops never stretch the card. */}
          <div className="stops-list-body">
            <StopsTable rows={stops.data.all} limit={40} />
          </div>
          {stops.data.all.length > 40 && (
            <button type="button" className="stops-more" onClick={() => setOpening('all')}>
              Ver as {stops.data.all.length} paradas do período
            </button>
          )}
        </div>
      )}

      {tab === 'eficiencia' && (
        <>
          <div className="stops-totals stops-quiet">
            <div>
              <span>Disponibilidade</span>
              <b>{percent(totals.availability)}</b>
              <small>produzindo ÷ tempo de linha</small>
            </div>
            <div>
              <span>Desempenho</span>
              <b>{percent(totals.performance)}</b>
              <small>
                {!stops.data.time.reference
                  ? 'sem referência de ritmo ainda'
                  : totals.optimistic
                    ? `ritmo de referência curto (${Math.round(stops.data.time.reference).toLocaleString('pt-BR')} peças/h)`
                    : `${Math.round(totals.rate).toLocaleString('pt-BR')} contra ${Math.round(stops.data.time.reference).toLocaleString('pt-BR')} peças/h`}
              </small>
            </div>
            <div>
              <span>Eficiência</span>
              <b>{percent(totals.effectiveness)}</b>
              <small>disponibilidade × desempenho</small>
            </div>
            <div>
              <span>Entre paradas</span>
              <b>{totals.mtbf == null ? '—' : duration(totals.mtbf)}</b>
              <small>produzindo antes da próxima</small>
            </div>
          </div>

          <div className="stops-title">Planejada e não planejada</div>
          <div className="stops-planned">
            <div>
              <span>Pausas de turno</span>
              <b>{duration(totals.plannedSeconds)}</b>
              <small>cadastradas, fora do tempo produtivo</small>
            </div>
            <div>
              <span>Paradas não planejadas</span>
              <b>{duration(totals.seconds)}</b>
              <small>
                {totals.seconds + totals.plannedSeconds > 0
                  ? `${percent(totals.seconds / (totals.seconds + totals.plannedSeconds))} de tudo que parou`
                  : '—'}
              </small>
            </div>
          </div>

          {totals.optimistic && (
            <div className="stops-note stops-warn">
              O ritmo medido no período passou do ritmo de referência, então o desempenho está
              limitado a 100 %. Isso quer dizer que a referência ficou abaixo do que a linha faz
              — ela se corrige sozinha conforme mais cinco minutos cheios entram no histórico.
            </div>
          )}
          <div className="stops-note stops-future">
            <b>Não é o OEE completo.</b> O OEE é disponibilidade × desempenho × qualidade, e a
            qualidade pede o refugo, que a plataforma ainda não recebe de lugar nenhum. O que
            está acima são os dois fatores que dá para medir com honestidade hoje. O ritmo de
            referência é o p95 do que esta linha alcança em cinco minutos cheios — tirado dela
            mesma, porque ninguém anotou um tempo de ciclo ideal.
          </div>
        </>
      )}

      {opening && (
        <StopsDetail
          rows={stops.data.all}
          focus={opening}
          from={stops.data.from}
          to={stops.data.to}
          onClose={() => setOpening(null)}
        />
      )}
    </div>
  );
}

/** The stops themselves, newest first or longest first. */
function StopsTable({
  rows,
  limit,
  onOpen,
}: {
  rows: Stop[];
  limit?: number;
  onOpen?: () => void;
}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  if (!rows.length) return <div className="stops-empty">Sem paradas no período.</div>;
  return (
    <>
      <table className="stops-table">
        <thead>
          <tr>
            <th>Quando</th>
            <th>Motivo</th>
            <th>Produto</th>
            <th className="n">Durou</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.startedAt} className={row.planned ? 'planned' : ''}>
              <td>
                {day(row.date)} às {clock(row.startedAt)}
                {row.endedAt && <span className="stops-until"> → {clock(row.endedAt)}</span>}
              </td>
              <td>
                <i className="stops-dot" style={{ background: reasonOf(row.state).color }} />
                {reasonOf(row.state).label}
                {row.planned && <small> · pausa de turno</small>}
              </td>
              <td>{row.product ?? '—'}</td>
              <td className="n">{row.seconds == null ? 'em curso' : duration(row.seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {limit && rows.length > limit && onOpen && (
        <button type="button" className="stops-more" onClick={onOpen}>
          Ver as {rows.length} paradas do período
        </button>
      )}
    </>
  );
}

/** What is behind one of the figures, as a window over the whole list. */
function StopsDetail({
  rows,
  focus,
  from,
  to,
  onClose,
}: {
  rows: Stop[];
  focus: 'all' | 'time' | 'average' | 'longest';
  from: string;
  to: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const title = {
    all: 'Todas as paradas',
    time: 'O tempo parado, parada por parada',
    average: 'A média, parada por parada',
    longest: 'As paradas mais longas',
  }[focus];

  const list = useMemo(() => {
    const kept = rows.filter((row) => !reason || row.state === reason);
    // Time and length are read longest first; the rest reads as it happened.
    return focus === 'all'
      ? kept
      : [...kept].sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0));
  }, [rows, reason, focus]);

  const reasons = useMemo(
    () => [...new Set(rows.map((row) => row.state))],
    [rows],
  );
  const counted = list.filter((row) => !row.planned);
  const seconds = counted.reduce((sum, row) => sum + (row.seconds ?? 0), 0);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-card stops-detail-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-title">
          <div>
            <div className="eyebrow">PARADAS DE PRODUÇÃO</div>
            <h2>{title}</h2>
            <small>
              {day(from)} a {day(to)} · {counted.length} parada(s) · {duration(seconds)} somados
            </small>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>
        <div className="widget-period stops-detail-filter" role="group" aria-label="Motivo">
          <button
            type="button"
            className={reason === '' ? 'active' : ''}
            onClick={() => setReason('')}
          >
            Todos os motivos
          </button>
          {reasons.map((state) => (
            <button
              key={state}
              type="button"
              className={reason === state ? 'active' : ''}
              onClick={() => setReason(state)}
            >
              {reasonOf(state).label}
            </button>
          ))}
        </div>
        <div className="stops-detail-body">
          <StopsTable rows={list} />
        </div>
      </div>
    </div>
  );
}
