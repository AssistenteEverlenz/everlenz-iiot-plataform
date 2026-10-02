'use client';

import { Fragment, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useFirstDraw } from './firstDraw';
import { ModalPortal } from './ModalPortal';
import { MortarShiftBoard } from './MortarShift';
import { LotsTable, useLots } from './MortarLots';
import {
  PRODUCT_COLORS,
  STATES,
  clock,
  duration,
  integer,
  kilos,
  money,
  perBag,
  percent,
  periodText,
  slotLabel,
  tons,
  MortarColors,
  type BagSlot,
  type MixRecipe,
  type Spout,
  type Summary,
} from './mortarShared';

/**
 * The mortar boards, written for someone who has never seen them.
 *
 * Three rules hold on every card. A number always says what it is before it says how much: the
 * label sits above the figure, never a bare unit under it. Nothing needs the mouse to be
 * understood: a bar that splits time writes its parts in words beside it. And every figure
 * opens a window that says how it was counted and breaks it down -- by spout, by product, by
 * recipe -- because a number nobody can open is a number nobody trusts.
 */

const AXIS = { fontSize: 10, fill: '#7b9097' };
export { MortarColors };

// ---------------------------------------------------------------------------------------------
// Building blocks

function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <ModalPortal>
      <div className="modal-backdrop" onClick={onClose}>
        <div
          className={`modal-card mortar-modal${wide ? ' wide' : ''}`}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="modal-title">
            <div>
              <h2>{title}</h2>
              {subtitle && <small>{subtitle}</small>}
            </div>
            <button onClick={onClose} aria-label="Fechar">
              Fechar
            </button>
          </header>
          {children}
        </div>
      </div>
    </ModalPortal>
  );
}

/** A figure: what it is, how much, and one line of context. Clickable when it opens more. */
function Figure({
  label,
  value,
  unit,
  hint,
  onOpen,
  accent,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  onOpen?: () => void;
  accent?: string;
}) {
  const body = (
    <>
      <span>
        {accent && <i style={{ background: accent }} />}
        {label}
      </span>
      <b>
        {value}
        {unit && <small> {unit}</small>}
      </b>
      {hint && <em>{hint}</em>}
      {onOpen && <u aria-hidden="true">›</u>}
    </>
  );
  return onOpen ? (
    <button type="button" className="mortar-figure" onClick={onOpen} title="Ver como foi calculado">
      {body}
    </button>
  ) : (
    <div className="mortar-figure">{body}</div>
  );
}

/** How a stretch of time was spent, written in words beside the bar: no hover needed. */
function TimeSplit({
  running,
  idle,
  off,
  compact,
}: {
  running: number;
  idle: number;
  off: number;
  compact?: boolean;
}) {
  const total = running + idle + off;
  if (!total) return <div className="mortar-split-empty">Sem tempo registrado no período</div>;
  const parts = (
    [
      ['running', running],
      ['idle', idle],
      ['off', off],
    ] as const
  ).filter(([, seconds]) => seconds > 0);
  return (
    <div className={`mortar-split${compact ? ' compact' : ''}`}>
      <div className="mortar-split-bar" role="img" aria-label="Como o tempo foi gasto">
        {parts.map(([state, seconds]) => (
          <i
            key={state}
            style={{ width: `${(seconds / total) * 100}%`, background: STATES[state].color }}
          />
        ))}
      </div>
      <div className="mortar-split-legend">
        {parts.map(([state, seconds]) => (
          <span key={state}>
            <i style={{ background: STATES[state].color }} />
            {STATES[state].label} <b>{percent(seconds / total, 0)}</b>
            {!compact && <small> · {duration(seconds)}</small>}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The day of one spout as a strip: one cell per quarter hour (or per day), coloured by what the
 * spout did most of it. The ceramic board reads a machine the same way.
 */
function StateStrip({ series, spoutId }: { series: BagSlot[]; spoutId: string }) {
  const cells = series.map((slot) => {
    const running = slot.running[spoutId] ?? 0;
    const idle = slot.idle[spoutId] ?? 0;
    const off = slot.off[spoutId] ?? 0;
    const state =
      running + idle + off === 0
        ? 'offline'
        : running >= idle && running >= off
          ? 'running'
          : idle >= off
            ? 'idle'
            : 'off';
    return { slot: slot.slot, state, bags: slot.spouts[spoutId] ?? 0 } as const;
  });
  if (!cells.length) return null;
  const marks = [0, Math.floor(cells.length / 2), cells.length - 1];
  return (
    <div className="mortar-strip">
      <div className="mortar-strip-cells">
        {cells.map((cell) => (
          <i
            key={cell.slot}
            style={{ background: STATES[cell.state].color }}
            title={`${slotLabel(cell.slot)} · ${STATES[cell.state].label} · ${integer(cell.bags)} sacos`}
          />
        ))}
      </div>
      <div className="mortar-strip-marks">
        {marks.map((index) => (
          <span key={index}>{slotLabel(cells[index].slot)}</span>
        ))}
      </div>
    </div>
  );
}

function Explain({ children }: { children: ReactNode }) {
  return <p className="mortar-explain">{children}</p>;
}

// ---------------------------------------------------------------------------------------------
// Ensaque

type BagFigure = 'bags' | 'tons' | 'pace' | 'perBag' | 'use';

export function Bagging({
  data,
  deviceId,
  boardDate,
  onDate,
  live,
  onLink,
}: {
  data: Summary;
  deviceId: string;
  /** A single day is read as a shift board (target, S-curve); a longer period as totals. */
  boardDate: string | null;
  /** Picks the day the bagging board reads. */
  onDate?: (date: string) => void;
  /** The period includes today, so "what the spout is doing now" means something. */
  live: boolean;
  onLink?: () => void;
}) {
  const palette = useContext(MortarColors);
  const { totals, spouts } = data.bagging;
  const [figure, setFigure] = useState<BagFigure | null>(null);
  const [spoutOpen, setSpoutOpen] = useState<string | null>(null);
  const enabled = totals.runningS + totals.idleS;
  if (!spouts.length)
    return (
      <div className="stops-empty">
        Nenhum bico configurado. Em <b>Configurar</b>, ligue o módulo de ensaque e escolha as
        variáveis de cada bico.
      </div>
    );
  const opened = spouts.find((spout) => spout.id === spoutOpen);
  const spoutCards = (
    <>
      <Unlinked bags={totals.unlinkedBags} onLink={onLink} />
      <div className="shift-section-title">Bicos · clique num bico para ver o turno dele</div>
      <div className="mortar-spouts">
        {spouts.map((spout, index) => (
          <SpoutCard
            key={spout.id}
            spout={spout}
            color={palette.spout(index)}
            live={live}
            onOpen={() => setSpoutOpen(spout.id)}
          />
        ))}
      </div>
    </>
  );
  const spoutModal = opened && (
    <SpoutModal
      data={data}
      spout={opened}
      color={palette.spout(spouts.indexOf(opened))}
      live={live}
      deviceId={deviceId}
      boardDate={boardDate}
      onClose={() => setSpoutOpen(null)}
    />
  );
  // One day reads as the production board, the spouts right under its figures.
  if (boardDate)
    return (
      <>
        <MortarShiftBoard deviceId={deviceId} date={boardDate} onDate={onDate}>
          {spoutCards}
        </MortarShiftBoard>
        {spoutModal}
      </>
    );
  return (
    <>
      {
        <div className="mortar-figures">
          <Figure
            label="Sacos ensacados"
            value={integer(totals.bags)}
            hint={`${spouts.length} bicos somados`}
            onOpen={() => setFigure('bags')}
          />
          <Figure
            label="Toneladas"
            value={tons(totals.kg)}
            unit="t"
            hint="sacos × peso de cada produto"
            onOpen={() => setFigure('tons')}
          />
          <Figure
            label="Ritmo por bico"
            value={totals.runningS ? integer(totals.bags / (totals.runningS / 3600)) : '—'}
            unit="sacos/h"
            hint="enquanto o bico ensaca"
            onOpen={() => setFigure('pace')}
          />
          <Figure
            label="Tempo por saco"
            value={perBag(totals.bags ? totals.runningS / totals.bags : null)}
            hint="média dos bicos, sem paradas"
            onOpen={() => setFigure('perBag')}
          />
          <Figure
            label="Aproveitamento"
            value={percent(enabled ? totals.runningS / enabled : null)}
            hint="tempo ensacando ÷ tempo habilitado"
            onOpen={() => setFigure('use')}
          />
        </div>
      }
      {spoutCards}

      <BaggingCharts data={data} />

      {figure && <BagFigureModal data={data} figure={figure} onClose={() => setFigure(null)} />}
      {spoutModal}
    </>
  );
}

function SpoutCard({
  spout,
  color,
  live,
  onOpen,
}: {
  spout: Spout;
  color: string;
  live: boolean;
  onOpen: () => void;
}) {
  const state = STATES[spout.state];
  const names = spout.products.filter((item) => item.bags > 0);
  return (
    <button type="button" className="mortar-spout" onClick={onOpen}>
      <header>
        <i style={{ background: color }} />
        <b>Bico {spout.name}</b>
        {live && (
          <em style={{ color: state.color }}>
            <u style={{ background: state.color }} />
            {state.label}
          </em>
        )}
        <span className="mortar-spout-open" aria-hidden="true">
          ›
        </span>
      </header>
      <div className="mortar-spout-products">
        {names.length === 0 ? (
          <span className="none">Nada ensacado no período</span>
        ) : (
          <>
            <span className="chips">
              {names.slice(0, 3).map((item) => (
                <span key={item.recipe} title={item.recipe}>
                  {item.product ?? item.recipe}
                </span>
              ))}
              {names.length > 3 && <span>+{names.length - 3}</span>}
            </span>
          </>
        )}
      </div>
      <div className="mortar-spout-figures">
        <div>
          <span>Sacos</span>
          <b>{integer(spout.bags)}</b>
        </div>
        <div>
          <span>Toneladas</span>
          <b>{tons(spout.kg)}</b>
        </div>
        <div>
          <span>Ritmo</span>
          <b>
            {spout.bagsPerHour == null ? '—' : integer(spout.bagsPerHour)}
            <small> sacos/h</small>
          </b>
        </div>
        <div>
          <span>Por saco</span>
          <b>{perBag(spout.secondsPerBag)}</b>
        </div>
      </div>
      <TimeSplit running={spout.runningS} idle={spout.idleS} off={spout.offS} compact />
      <span className="mortar-spout-stops">
        {spout.stops
          ? `${spout.stops} ${spout.stops === 1 ? 'parada' : 'paradas'} · ${duration(spout.stopSeconds)} parado · maior ${duration(spout.longestStop)}`
          : 'Nenhuma parada no período'}
        {spout.performance != null && spout.runningS + spout.idleS > 0 && (
          <b>
            {' '}
            · eficiência{' '}
            {percent((spout.runningS / (spout.runningS + spout.idleS)) * spout.performance, 0)}
          </b>
        )}
      </span>
    </button>
  );
}

function SpoutModal({
  data,
  spout,
  color,
  live,
  deviceId,
  boardDate,
  onClose,
}: {
  data: Summary;
  spout: Spout;
  color: string;
  live: boolean;
  deviceId: string;
  boardDate: string | null;
  onClose: () => void;
}) {
  const enabled = spout.runningS + spout.idleS;
  const quarter = data.bagging.series.some((slot) => slot.slot.length > 13);
  const rows = useMemo(() => {
    let sum = 0;
    return data.bagging.series.map((slot) => {
      const bags = slot.spouts[spout.id] ?? 0;
      const running = slot.running[spout.id] ?? 0;
      sum += bags;
      return {
        label: slotLabel(slot.slot),
        bags,
        total: sum,
        seconds: bags >= 3 && running > 0 ? Math.round((running / bags) * 10) / 10 : null,
      };
    });
  }, [data.bagging.series, spout.id]);
  const drawing = useFirstDraw(rows.length > 0);
  const state = STATES[spout.state];
  return (
    <Modal
      wide
      title={
        <span className="mortar-modal-title">
          <i style={{ background: color }} /> Bico {spout.name}
        </span>
      }
      subtitle={`${periodText(data.from, data.to)}${live ? ` · agora: ${state.label.toLowerCase()}` : ''}${live && spout.product ? ` com ${spout.product}` : ''}`}
      onClose={onClose}
    >
      {/* One day: the spout's own production board says it all; the period figures, the time
          split and the strip below would only repeat it. */}
      {boardDate ? (
        <MortarShiftBoard
          deviceId={deviceId}
          date={boardDate}
          spoutId={spout.id}
          spoutName={spout.name}
        />
      ) : (
        <>
          <div className="mortar-figures">
            <Figure label="Sacos" value={integer(spout.bags)} />
            <Figure label="Toneladas" value={tons(spout.kg)} unit="t" />
            <Figure
              label="Ritmo"
              value={spout.bagsPerHour == null ? '—' : integer(spout.bagsPerHour)}
              unit="sacos/h"
            />
            <Figure label="Tempo por saco" value={perBag(spout.secondsPerBag)} hint="sem paradas" />
            <Figure
              label="Aproveitamento"
              value={percent(enabled ? spout.runningS / enabled : null)}
              hint={
                spout.lastBagAt && live ? `último saco às ${clock(spout.lastBagAt)}` : undefined
              }
            />
          </div>

          <div className="stops-title">Como o tempo do bico foi gasto</div>
          <TimeSplit running={spout.runningS} idle={spout.idleS} off={spout.offS} />
          <StateStrip series={data.bagging.series} spoutId={spout.id} />
          <Explain>
            <b>Ensacando</b>: os sacos estavam saindo. <b>Ociosa</b>: habilitado, mas sem saco há
            mais de dois minutos (falta de saco, palete cheio, silo vazio). <b>Desabilitada</b>: o
            operador desligou o bico na IHM. Cada faixa da linha acima é{' '}
            {quarter ? 'um quarto de hora' : 'um dia'}, pintada pelo que o bico mais fez nela.
          </Explain>
        </>
      )}

      <div className="stops-title">O que o bico ensacou</div>
      {spout.products.length ? (
        <table className="stops-table mortar-table">
          <thead>
            <tr>
              <th>Produto</th>
              <th>Receita na IHM</th>
              <th className="n">Sacos</th>
              <th className="n">Toneladas</th>
              <th className="n">Por saco</th>
              <th className="n">Tempo ensacando</th>
            </tr>
          </thead>
          <tbody>
            {spout.products.map((item) => (
              <tr key={item.recipe}>
                <td>
                  <b>{item.product ?? 'Sem produto'}</b>
                </td>
                <td className="muted">{item.recipe}</td>
                <td className="n">{integer(item.bags)}</td>
                <td className="n">{tons(item.kg)}</td>
                <td className="n">{perBag(item.secondsPerBag)}</td>
                <td className="n">{duration(item.runningS)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="stops-empty">Nada ensacado no período.</div>
      )}

      {!boardDate && rows.length > 0 && (
        <>
          <div className="stops-title">
            Andamento do bico
            <small> · sacos acumulados (linha) e tempo por saco (pontilhado)</small>
          </div>
          <div className="mortar-chart">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e6eef0" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} minTickGap={24} />
                <YAxis
                  yAxisId="bags"
                  tick={AXIS}
                  width={52}
                  tickFormatter={(v: number) => integer(v)}
                />
                <YAxis
                  yAxisId="sec"
                  orientation="right"
                  tick={AXIS}
                  width={44}
                  domain={['auto', 'auto']}
                  tickFormatter={(v: number) => Math.round(v) + ' s'}
                />
                <Tooltip
                  formatter={(value, name) =>
                    name === 'seconds'
                      ? [perBag(Number(value)), 'por saco']
                      : [integer(Number(value)), 'sacos acumulados']
                  }
                />
                <Line
                  yAxisId="bags"
                  dataKey="total"
                  stroke={color}
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={drawing}
                  animationDuration={drawing ? 700 : 0}
                />
                <Line
                  yAxisId="sec"
                  dataKey="seconds"
                  stroke="#0b2028"
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={drawing}
                  animationDuration={drawing ? 700 : 0}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Modal>
  );
}

const BAG_FIGURES: Record<BagFigure, { title: string; how: ReactNode }> = {
  bags: {
    title: 'Sacos ensacados',
    how: (
      <>
        Cada bico tem um contador de pacotes na IHM. A plataforma soma o que cada contador andou no
        período; quando o operador aperta <b>Finaliza produção</b> e o contador volta a zero, a
        contagem continua sem perder nada.
      </>
    ),
  },
  tons: {
    title: 'Toneladas',
    how: (
      <>
        Sacos vezes o peso do saco do <b>produto</b> (cadastrado em Produtos e receitas). Não usa o
        peso de corte da receita, que o operador ajusta para cima ou para baixo. Uma receita sem
        produto vinculado conta sacos mas fica fora das toneladas.
      </>
    ),
  },
  pace: {
    title: 'Ritmo por bico',
    how: (
      <>
        Quantos sacos um bico faz numa hora <b>enquanto está ensacando</b>: sacos ÷ horas ensacando.
        As paradas ficam de fora, então este número mede a máquina, não o turno. É o inverso do
        tempo por saco.
      </>
    ),
  },
  perBag: {
    title: 'Tempo por saco',
    how: (
      <>
        Quantos segundos o bico leva para encher um saco: tempo ensacando ÷ sacos, sem as paradas —
        como o tempo por palete da cerâmica. Sobe com saco mais pesado (40 kg demora mais que 20 kg)
        e com o bico desregulado; compare o mesmo produto entre bicos.
      </>
    ),
  },
  use: {
    title: 'Aproveitamento',
    how: (
      <>
        Do tempo em que o bico estava <b>habilitado</b>, quanto ele passou ensacando. O resto é
        tempo ocioso: falta de saco, troca de palete, espera de material. Bico desabilitado não
        entra, porque não usar um bico não é uma perda dele.
      </>
    ),
  },
};

function BagFigureModal({
  data,
  figure,
  onClose,
}: {
  data: Summary;
  figure: BagFigure;
  onClose: () => void;
}) {
  const palette = useContext(MortarColors);
  const { spouts, products, totals } = data.bagging;
  const info = BAG_FIGURES[figure];
  const valueOf = (spout: Spout): string => {
    const enabled = spout.runningS + spout.idleS;
    if (figure === 'bags') return integer(spout.bags);
    if (figure === 'tons') return `${tons(spout.kg)} t`;
    if (figure === 'pace')
      return spout.bagsPerHour == null ? '—' : `${integer(spout.bagsPerHour)} sacos/h`;
    if (figure === 'perBag') return perBag(spout.secondsPerBag);
    return percent(enabled ? spout.runningS / enabled : null);
  };
  const shareOf = (spout: Spout) =>
    figure === 'bags'
      ? totals.bags
        ? spout.bags / totals.bags
        : 0
      : figure === 'tons'
        ? totals.kg
          ? spout.kg / totals.kg
          : 0
        : null;
  return (
    <Modal title={info.title} subtitle={periodText(data.from, data.to)} onClose={onClose}>
      <Explain>{info.how}</Explain>
      <div className="stops-title">Por bico</div>
      <table className="stops-table mortar-table">
        <thead>
          <tr>
            <th>Bico</th>
            <th className="n">{info.title}</th>
            <th>{shareOf(spouts[0]) != null ? 'Participação' : 'Tempo ensacando'}</th>
          </tr>
        </thead>
        <tbody>
          {spouts.map((spout, index) => {
            const share = shareOf(spout);
            return (
              <tr key={spout.id}>
                <td>
                  <span className="mortar-dot" style={{ background: palette.spout(index) }} />
                  Bico {spout.name}
                </td>
                <td className="n">
                  <b>{valueOf(spout)}</b>
                </td>
                <td>
                  {share != null ? (
                    <div className="mortar-share">
                      <i style={{ width: `${share * 100}%`, background: palette.spout(index) }} />
                      <span>{percent(share)}</span>
                    </div>
                  ) : (
                    <span className="muted">{duration(spout.runningS)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(figure === 'bags' || figure === 'tons') && products.length > 0 && (
        <>
          <div className="stops-title">Por produto</div>
          <table className="stops-table mortar-table">
            <tbody>
              {products.map((item) => (
                <tr key={item.key}>
                  <td>
                    <b>{item.name}</b>
                    {!item.productId && <small className="muted"> · receita sem produto</small>}
                  </td>
                  <td className="n">{integer(item.bags)} sacos</td>
                  <td className="n">{tons(item.kg)} t</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {figure === 'perBag' && (
        <>
          <div className="stops-title">Por produto, em cada bico</div>
          <table className="stops-table mortar-table">
            <thead>
              <tr>
                <th>Produto</th>
                {spouts.map((spout) => (
                  <th className="n" key={spout.id}>
                    Bico {spout.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ...new Set(
                  spouts.flatMap((spout) => spout.products.map((p) => p.product ?? p.recipe)),
                ),
              ].map((name) => (
                <tr key={name}>
                  <td>
                    <b>{name}</b>
                  </td>
                  {spouts.map((spout) => {
                    const items = spout.products.filter((p) => (p.product ?? p.recipe) === name);
                    const bags = items.reduce((sum, p) => sum + p.bags, 0);
                    const running = items.reduce((sum, p) => sum + p.runningS, 0);
                    return (
                      <td className="n" key={spout.id}>
                        {bags ? perBag(running / bags) : <span className="muted">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

/**
 * How the bagging moved through the period: the bags of each spout piling up, the line as a
 * whole under them, and how long each spout took per bag. One day is read by the quarter hour,
 * so a spout that slowed down after lunch shows it; a longer period is read by the day.
 */
function BaggingCharts({ data }: { data: Summary }) {
  const general = true;
  const palette = useContext(MortarColors);
  const { spouts, series } = data.bagging;
  const quarter = series.some((slot) => slot.slot.length > 13);
  const rows = useMemo(() => {
    const running: Record<string, number> = {};
    let total = 0;
    return series.map((slot) => {
      const row: Record<string, number | string | null> = {
        label: slotLabel(slot.slot),
        bags: slot.bags,
      };
      total += slot.bags;
      row.total = total;
      for (const spout of spouts) {
        const bags = slot.spouts[spout.id] ?? 0;
        running[spout.id] = (running[spout.id] ?? 0) + bags;
        row['sum_' + spout.id] = running[spout.id];
        // A slot where the spout filled few bags says little about its pace: left as a gap.
        const seconds = slot.running[spout.id] ?? 0;
        row['sec_' + spout.id] =
          bags >= 3 && seconds > 0 ? Math.round((seconds / bags) * 10) / 10 : null;
      }
      return row;
    });
  }, [series, spouts]);
  const drawing = useFirstDraw(rows.length > 0);
  if (!series.some((slot) => slot.bags > 0))
    return <div className="stops-empty">Nenhum saco registrado no período.</div>;
  const grain = quarter ? 'a cada 15 minutos' : 'por dia';
  const legend = (
    <div className="stops-spent-legend">
      {spouts.map((spout, index) => (
        <span key={spout.id}>
          <i style={{ background: palette.spout(index) }} /> Bico {spout.name}
        </span>
      ))}
    </div>
  );
  return (
    <>
      {general && (
        <>
          <div className="stops-title">
            Geral da linha<small> · sacos {grain} (barras) e o total acumulado (linha)</small>
          </div>
          <div className="mortar-chart">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e6eef0" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} minTickGap={24} />
                <YAxis
                  yAxisId="slot"
                  tick={AXIS}
                  width={44}
                  tickFormatter={(value: number) => integer(value)}
                />
                <YAxis
                  yAxisId="sum"
                  orientation="right"
                  tick={AXIS}
                  width={56}
                  tickFormatter={(value: number) => integer(value)}
                />
                <Tooltip
                  formatter={(value, name) => [
                    integer(Number(value)) + ' sacos',
                    name === 'total' ? 'acumulado' : 'no intervalo',
                  ]}
                />
                <Bar
                  yAxisId="slot"
                  dataKey="bags"
                  fill={palette.accent}
                  fillOpacity={0.3}
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={drawing}
                  animationDuration={drawing ? 700 : 0}
                />
                <Line
                  yAxisId="sum"
                  dataKey="total"
                  stroke="#0b2028"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={drawing}
                  animationDuration={drawing ? 700 : 0}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      <div className="stops-title">
        Tempo por saco<small> · segundos para encher um saco, {grain}, em cada bico</small>
      </div>
      <div className="mortar-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e6eef0" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} minTickGap={24} />
            <YAxis
              tick={AXIS}
              width={52}
              domain={['auto', 'auto']}
              tickFormatter={(value: number) => Math.round(value) + ' s'}
            />
            <Tooltip formatter={(value, name) => [perBag(Number(value)) + ' por saco', name]} />
            {spouts.map((spout, index) => (
              <Line
                key={spout.id}
                dataKey={'sec_' + spout.id}
                name={'Bico ' + spout.name}
                stroke={palette.spout(index)}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={drawing}
                animationDuration={drawing ? 700 : 0}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {legend}
    </>
  );
}

export function Unlinked({ bags, onLink }: { bags: number; onLink?: () => void }) {
  if (!bags) return null;
  return (
    <div className="mortar-warning">
      <span>
        <b>{integer(bags)} sacos</b> de receitas ainda sem produto: contados, mas fora das
        toneladas.
      </span>
      {onLink && (
        <button type="button" onClick={onLink}>
          Vincular receitas
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Produzido por produto

type OutputDisplay = 'table' | 'donut' | 'bars';
const DISPLAYS: Array<[OutputDisplay, string]> = [
  ['table', 'Tabela'],
  ['donut', 'Pizza'],
  ['bars', 'Barras'],
];

export function Output({
  data,
  deviceId,
  displayKey,
  onLink,
}: {
  data: Summary;
  deviceId: string;
  /** Where this card remembers how the reader likes to see it. */
  displayKey: string;
  onLink?: () => void;
}) {
  const lots = useLots(deviceId, data.from, data.to);
  const palette = useContext(MortarColors);
  const { products, totals, spouts } = data.bagging;
  const [open, setOpen] = useState<string | null>(null);
  const [display, setDisplayState] = useState<OutputDisplay>(() => {
    try {
      const saved = window.localStorage.getItem(displayKey);
      return saved === 'donut' || saved === 'bars' ? saved : 'table';
    } catch {
      return 'table';
    }
  });
  const setDisplay = (value: OutputDisplay) => {
    setDisplayState(value);
    try {
      window.localStorage.setItem(displayKey, value);
    } catch {
      /* the choice simply is not remembered */
    }
  };
  const [metric, setMetric] = useState<'bags' | 'kg'>('bags');
  const drawing = useFirstDraw(products.length > 0);
  const opened = products.find((item) => item.key === open);
  const value = (item: (typeof products)[number]) =>
    metric === 'bags' ? item.bags : (item.kg ?? 0);
  const total = metric === 'bags' ? totals.bags : totals.kg;
  const fmt = (n: number) => (metric === 'bags' ? `${integer(n)} sacos` : `${tons(n)} t`);
  const chartRows = products
    .map((item, index) => ({
      name: item.name,
      key: item.key,
      value: value(item),
      color: PRODUCT_COLORS[index % PRODUCT_COLORS.length],
    }))
    .filter((row) => row.value > 0);
  return (
    <>
      <div className="mortar-figures">
        <Figure label="Sacos" value={integer(totals.bags)} hint="produzidos no período" />
        <Figure
          label="Toneladas"
          value={tons(totals.kg)}
          unit="t"
          hint="pelo peso de cada produto"
        />
        <Figure
          label="Produtos"
          value={products.filter((item) => item.productId).length}
          hint={products[0] ? `mais produzido: ${products[0].name}` : 'nenhum produzido no período'}
        />
      </div>
      <Unlinked bags={totals.unlinkedBags} onLink={onLink} />
      <div className="mortar-switches">
        <div className="widget-period" role="group" aria-label="Visualização">
          {DISPLAYS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={display === key ? 'active' : ''}
              onClick={() => setDisplay(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {display !== 'table' && (
          <div className="widget-period" role="group" aria-label="Medida">
            <button
              type="button"
              className={metric === 'bags' ? 'active' : ''}
              onClick={() => setMetric('bags')}
            >
              Sacos
            </button>
            <button
              type="button"
              className={metric === 'kg' ? 'active' : ''}
              onClick={() => setMetric('kg')}
            >
              Toneladas
            </button>
          </div>
        )}
      </div>
      {!products.length ? (
        <div className="stops-empty">Nenhum saco registrado no período.</div>
      ) : display === 'donut' ? (
        <div className="mortar-donut">
          <div className="mortar-donut-chart">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartRows}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="58%"
                  outerRadius="92%"
                  paddingAngle={1}
                  isAnimationActive={drawing}
                  animationDuration={drawing ? 700 : 0}
                  onClick={(entry) => setOpen(String((entry as { key?: string }).key ?? ''))}
                >
                  {chartRows.map((row) => (
                    <Cell key={row.key} fill={row.color} cursor="pointer" />
                  ))}
                </Pie>
                <Tooltip formatter={(n, name) => [fmt(Number(n)), name]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="mortar-donut-center">
              <b>{metric === 'bags' ? integer(total) : tons(total)}</b>
              <span>{metric === 'bags' ? 'sacos' : 't'}</span>
            </div>
          </div>
          <div className="mortar-donut-legend">
            {chartRows.map((row) => (
              <button type="button" key={row.key} onClick={() => setOpen(row.key)}>
                <i style={{ background: row.color }} />
                <span>{row.name}</span>
                <b>{percent(total ? row.value / total : null)}</b>
                <small>{fmt(row.value)}</small>
              </button>
            ))}
          </div>
        </div>
      ) : display === 'bars' ? (
        <div className="mortar-chart" style={{ height: Math.max(160, chartRows.length * 38 + 20) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartRows}
              layout="vertical"
              margin={{ top: 4, right: 60, bottom: 0, left: 0 }}
            >
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" tick={{ ...AXIS, fontSize: 11 }} width={130} />
              <Tooltip
                formatter={(n) => [fmt(Number(n)), metric === 'bags' ? 'sacos' : 'toneladas']}
              />
              <Bar
                dataKey="value"
                radius={[0, 5, 5, 0]}
                isAnimationActive={drawing}
                animationDuration={drawing ? 700 : 0}
                onClick={(entry) => setOpen(String((entry as { key?: string }).key ?? ''))}
                label={{
                  position: 'right',
                  fontSize: 11,
                  fill: '#24505a',
                  formatter: (n: unknown) =>
                    metric === 'bags' ? integer(Number(n)) : tons(Number(n)),
                }}
              >
                {chartRows.map((row) => (
                  <Cell key={row.key} fill={row.color} cursor="pointer" />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <table className="stops-table mortar-products">
          <thead>
            <tr>
              <th>Produto</th>
              <th className="n">Sacos</th>
              <th className="n">Toneladas</th>
              <th>Participação</th>
            </tr>
          </thead>
          <tbody>
            {products.map((item, index) => (
              <tr
                key={item.key}
                className={item.productId ? '' : 'mortar-unlinked'}
                onClick={() => setOpen(item.key)}
              >
                <td>
                  <span
                    className="mortar-dot"
                    style={{ background: PRODUCT_COLORS[index % PRODUCT_COLORS.length] }}
                  />
                  <b>{item.name}</b>
                  <small>
                    {item.productId
                      ? `saco de ${item.nominalKg?.toLocaleString('pt-BR')} kg · ${item.recipes.length} receita(s)`
                      : 'receita sem produto vinculado'}
                  </small>
                </td>
                <td className="n">{integer(item.bags)}</td>
                <td className="n">{tons(item.kg)}</td>
                <td>
                  <div className="mortar-share">
                    <i
                      style={{
                        width: `${(item.bags / Math.max(1, products[0].bags)) * 100}%`,
                        background: PRODUCT_COLORS[index % PRODUCT_COLORS.length],
                      }}
                    />
                    <span>{percent(totals.bags ? item.bags / totals.bags : null)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {opened && (
        <Modal
          title={opened.name}
          subtitle={periodText(data.from, data.to)}
          onClose={() => setOpen(null)}
        >
          <div className="mortar-figures">
            <Figure label="Sacos" value={integer(opened.bags)} />
            <Figure label="Toneladas" value={tons(opened.kg)} unit="t" />
            <Figure
              label="Peso do saco"
              value={opened.nominalKg == null ? '—' : opened.nominalKg.toLocaleString('pt-BR')}
              unit="kg"
            />
            <Figure
              label="Participação"
              value={percent(totals.bags ? opened.bags / totals.bags : null)}
              hint="dos sacos do período"
            />
          </div>
          <div className="stops-title">Por bico</div>
          <table className="stops-table mortar-table">
            <tbody>
              {spouts.map((spout, index) =>
                opened.spouts[spout.id] ? (
                  <tr key={spout.id}>
                    <td>
                      <span className="mortar-dot" style={{ background: palette.spout(index) }} />
                      Bico {spout.name}
                    </td>
                    <td className="n">{integer(opened.spouts[spout.id])} sacos</td>
                    <td className="n">
                      {perBag(
                        (() => {
                          const items = spout.products.filter((p) =>
                            opened.recipes.some((r) => r.recipe === p.recipe),
                          );
                          const bags = items.reduce((s, p) => s + p.bags, 0);
                          return bags ? items.reduce((s, p) => s + p.runningS, 0) / bags : null;
                        })(),
                      )}{' '}
                      <small className="muted">por saco</small>
                    </td>
                  </tr>
                ) : null,
              )}
            </tbody>
          </table>
          <div className="stops-title">
            Lotes de onde saiu
            <small> · rastreabilidade: o lote da mistura de cada período de ensaque</small>
          </div>
          {lots.data ? (
            <LotsTable lots={lots.data.lots} product={opened.name} />
          ) : (
            <div className="stops-empty">Carregando lotes…</div>
          )}
          <div className="stops-title">Receitas que formam este produto</div>
          <table className="stops-table mortar-table">
            <tbody>
              {opened.recipes.map((recipe) => (
                <tr key={recipe.recipe}>
                  <td className="muted">{recipe.recipe}</td>
                  <td className="n">{integer(recipe.bags)} sacos</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Matéria-prima

type MaterialOpen =
  { kind: 'batches' } | { kind: 'material'; label: string } | { kind: 'recipe'; recipe: string };

export function Materials({ data, deviceId }: { data: Summary; deviceId: string }) {
  const lots = useLots(deviceId, data.from, data.to);
  const palette = useContext(MortarColors);
  const { mix } = data;
  const [open, setOpen] = useState<MaterialOpen | null>(null);
  const colorOf = (label: string) =>
    palette.material(
      label,
      Math.max(
        0,
        mix.materials.findIndex((item) => item.label === label),
      ),
    );
  const rows = useMemo(
    () =>
      mix.series.map((slot) => ({
        label: slotLabel(slot.slot),
        batches: slot.batches,
        ...Object.fromEntries(
          mix.materials.map((m) => [m.label, (slot.materials[m.label] ?? 0) / 1000]),
        ),
      })),
    [mix],
  );
  const drawing = useFirstDraw(rows.length > 0);
  if (!data.modules.mix && !mix.batches)
    return (
      <div className="stops-empty">
        O módulo de mistura não está ligado. Em <b>Configurar</b>, escolha o contador de bateladas,
        a receita e o peso de cada material.
      </div>
    );
  const bagged = data.bagging.totals.kg;
  const scaleGap =
    mix.scaleKg != null && mix.scaleTheoreticalKg ? mix.scaleKg / mix.scaleTheoreticalKg - 1 : null;
  return (
    <>
      <div className="mortar-figures">
        <Figure
          label="Bateladas"
          value={integer(mix.batches)}
          hint={
            mix.cycleMinutes != null
              ? `uma a cada ${mix.cycleMinutes.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} min`
              : mix.lastBatchAt
                ? `última às ${clock(mix.lastBatchAt)}`
                : 'nenhuma no período'
          }
          onOpen={() => setOpen({ kind: 'batches' })}
        />
        <Figure
          label="Misturado"
          value={tons(mix.kg)}
          unit="t"
          hint={mix.batches ? `${kilos(mix.kg / mix.batches)} por batelada` : 'pela receita'}
          onOpen={() => setOpen({ kind: 'batches' })}
        />
        {mix.materials.map((item) => (
          <Figure
            key={item.label}
            label={item.label}
            value={tons(item.kg)}
            unit="t"
            accent={colorOf(item.label)}
            hint={
              bagged > 0
                ? `${integer((item.kg / bagged) * 1000)} kg por t ensacada`
                : `${percent(mix.kg ? item.kg / mix.kg : null)} da mistura`
            }
            onOpen={() => setOpen({ kind: 'material', label: item.label })}
          />
        ))}
        {mix.cost && (
          <Figure
            label="Custo da mistura"
            value={money(mix.cost.perTon)}
            unit="/t"
            hint={`${money(mix.cost.total)} no período · ${money(mix.cost.perBatch)} por batelada`}
            onOpen={() => setOpen({ kind: 'batches' })}
          />
        )}
      </div>

      {mix.kg > 0 && (
        <>
          <div className="stops-title">
            Composição da mistura<small> · quanto de cada material entrou no período</small>
          </div>
          <div className="mortar-composition">
            {mix.materials.map((item) => (
              <i
                key={item.label}
                style={{ width: `${(item.kg / mix.kg) * 100}%`, background: colorOf(item.label) }}
              >
                {item.kg / mix.kg > 0.08 && <span>{percent(item.kg / mix.kg, 0)}</span>}
              </i>
            ))}
          </div>
          <div className="stops-spent-legend">
            {mix.materials.map((item) => (
              <span key={item.label}>
                <i style={{ background: colorOf(item.label) }} /> {item.label}{' '}
                <b>{percent(item.kg / mix.kg)}</b>
              </span>
            ))}
            {scaleGap != null && (
              <span className="mortar-scale">
                Balança: {tons(mix.scaleKg)} t pesadas contra {tons(mix.scaleTheoreticalKg)} t da
                receita (
                <b>
                  {scaleGap >= 0 ? '+' : ''}
                  {percent(scaleGap)}
                </b>
                )
              </span>
            )}
          </div>
        </>
      )}

      <div className="stops-title">
        Por receita<small> · peso da receita × bateladas; clique para abrir</small>
      </div>
      {mix.recipes.length ? (
        <table className="stops-table mortar-table mortar-recipes">
          <thead>
            <tr>
              <th>Receita</th>
              <th className="n">Bateladas</th>
              <th>Composição</th>
              {mix.materials.map((item) => (
                <th className="n" key={item.label}>
                  {item.label} (t)
                </th>
              ))}
              <th className="n">Total (t)</th>
              {mix.cost && <th className="n">Custo/t</th>}
            </tr>
          </thead>
          <tbody>
            {mix.recipes.map((row) => (
              <tr key={row.recipe} onClick={() => setOpen({ kind: 'recipe', recipe: row.recipe })}>
                <td>
                  <b>{row.recipe}</b>
                </td>
                <td className="n">{integer(row.batches)}</td>
                <td>
                  <RecipeBar recipe={row} colorOf={colorOf} />
                </td>
                {mix.materials.map((item) => (
                  <td className="n" key={item.label}>
                    {tons(row.materials.find((entry) => entry.label === item.label)?.kg ?? 0)}
                  </td>
                ))}
                <td className="n">
                  <b>{tons(row.kg)}</b>
                </td>
                {mix.cost && (
                  <td className="n">
                    {money(mix.cost.byRecipe.find((item) => item.recipe === row.recipe)?.perTon)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="stops-empty">Nenhuma batelada registrada no período.</div>
      )}

      {rows.length > 0 && (
        <>
          <div className="stops-title">
            {data.granularity === 'hour' ? 'Hora a hora' : 'Dia a dia'}
            <small> · toneladas de cada material (barras) e bateladas (linha)</small>
          </div>
          <div className="mortar-chart">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e6eef0" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} minTickGap={16} />
                <YAxis
                  yAxisId="t"
                  tick={AXIS}
                  width={44}
                  tickFormatter={(v: number) => v.toLocaleString('pt-BR')}
                />
                <YAxis
                  yAxisId="b"
                  orientation="right"
                  tick={AXIS}
                  width={36}
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={(value, name) =>
                    name === 'batches'
                      ? [integer(Number(value)), 'bateladas']
                      : [tons(Number(value) * 1000) + ' t', name]
                  }
                />
                {mix.materials.map((item, index) => (
                  <Bar
                    key={item.label}
                    yAxisId="t"
                    dataKey={item.label}
                    stackId="m"
                    fill={colorOf(item.label)}
                    radius={index === mix.materials.length - 1 ? [3, 3, 0, 0] : undefined}
                    isAnimationActive={drawing}
                    animationDuration={drawing ? 700 : 0}
                  />
                ))}
                <Line
                  yAxisId="b"
                  dataKey="batches"
                  stroke="#0b2028"
                  strokeWidth={1.5}
                  dot={{ r: 2 }}
                  isAnimationActive={drawing}
                  animationDuration={drawing ? 700 : 0}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="stops-spent-legend">
            {mix.materials.map((item) => (
              <span key={item.label}>
                <i style={{ background: colorOf(item.label) }} /> {item.label}
              </span>
            ))}
            <span>
              <i style={{ background: '#0b2028' }} /> Bateladas
            </span>
          </div>
        </>
      )}

      <div className="stops-title">
        Lotes de produção
        <small> · cada lote é uma corrida do misturador; clique para ver o que ele virou</small>
      </div>
      {lots.data ? (
        <LotsTable lots={lots.data.lots} />
      ) : (
        <div className="stops-empty">Carregando lotes…</div>
      )}

      {open && (
        <MaterialsModal data={data} open={open} colorOf={colorOf} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

function RecipeBar({ recipe, colorOf }: { recipe: MixRecipe; colorOf: (label: string) => string }) {
  return (
    <div
      className="mortar-recipe-bar"
      title={recipe.materials
        .map((m) => `${m.label} ${percent(recipe.kg ? m.kg / recipe.kg : null)}`)
        .join(' · ')}
    >
      {recipe.materials.map((item) => (
        <i
          key={item.label}
          style={{
            width: `${recipe.kg ? (item.kg / recipe.kg) * 100 : 0}%`,
            background: colorOf(item.label),
          }}
        />
      ))}
    </div>
  );
}

function MaterialsModal({
  data,
  open,
  colorOf,
  onClose,
}: {
  data: Summary;
  open: MaterialOpen;
  colorOf: (label: string) => string;
  onClose: () => void;
}) {
  const { mix } = data;
  const bagged = data.bagging.totals.kg;
  const subtitle = periodText(data.from, data.to);

  if (open.kind === 'batches')
    return (
      <Modal title="Bateladas e mistura" subtitle={subtitle} onClose={onClose}>
        <Explain>
          Cada vez que o contador de bateladas da IHM sobe, a plataforma registra uma batelada com a
          receita que estava no CLP e o peso que a receita pede de cada material. Quando há balança
          configurada, o maior peso dela no ciclo é o que foi realmente dosado.
        </Explain>
        <div className="mortar-figures">
          <Figure label="Bateladas" value={integer(mix.batches)} />
          <Figure
            label="Ciclo médio"
            value={
              mix.cycleMinutes == null
                ? '—'
                : mix.cycleMinutes.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
            }
            unit="min"
            hint="entre uma batelada e a próxima"
          />
          <Figure
            label="Média por batelada"
            value={mix.batches ? kilos(mix.kg / mix.batches) : '—'}
          />
          <Figure label="Última batelada" value={clock(mix.lastBatchAt)} />
        </div>
        <div className="stops-title">Por receita</div>
        <table className="stops-table mortar-table">
          <thead>
            <tr>
              <th>Receita</th>
              <th className="n">Bateladas</th>
              <th className="n">Por batelada</th>
              <th className="n">Total</th>
              <th className="n">Balança × receita</th>
            </tr>
          </thead>
          <tbody>
            {mix.recipes.map((row) => (
              <tr key={row.recipe}>
                <td>
                  <b>{row.recipe}</b>
                </td>
                <td className="n">{integer(row.batches)}</td>
                <td className="n">{kilos(row.kg / Math.max(1, row.batches))}</td>
                <td className="n">{tons(row.kg)} t</td>
                <td className="n">
                  {row.scaleKg != null && row.scaleTheoreticalKg ? (
                    `${row.scaleKg >= row.scaleTheoreticalKg ? '+' : ''}${percent(row.scaleKg / row.scaleTheoreticalKg - 1)}`
                  ) : (
                    <span className="muted">sem balança</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>
    );

  if (open.kind === 'material') {
    const total = mix.materials.find((m) => m.label === open.label)?.kg ?? 0;
    const byRecipe = mix.recipes
      .map((row) => ({
        recipe: row.recipe,
        batches: row.batches,
        kg: row.materials.find((m) => m.label === open.label)?.kg ?? 0,
        share: row.kg ? (row.materials.find((m) => m.label === open.label)?.kg ?? 0) / row.kg : 0,
      }))
      .sort((a, b) => b.kg - a.kg);
    return (
      <Modal
        title={
          <span className="mortar-modal-title">
            <i style={{ background: colorOf(open.label) }} /> {open.label}
          </span>
        }
        subtitle={subtitle}
        onClose={onClose}
      >
        <div className="mortar-figures">
          <Figure label="Consumido" value={tons(total)} unit="t" />
          <Figure label="Da mistura" value={percent(mix.kg ? total / mix.kg : null)} />
          <Figure
            label="Por batelada"
            value={mix.batches ? kilos(total / mix.batches) : '—'}
            hint="em média"
          />
          <Figure
            label="Por t ensacada"
            value={bagged > 0 ? integer((total / bagged) * 1000) : '—'}
            unit="kg"
            hint="quanto deste material vai em cada tonelada vendida"
          />
        </div>
        <Explain>
          O consumo vem da receita: o peso de {open.label.toLowerCase()} que a receita pede em uma
          batelada, vezes as bateladas feitas com ela. Se 3 bateladas de uma receita pedem 500 kg
          cada, foram 1.500 kg.
        </Explain>
        <div className="stops-title">Por receita</div>
        <table className="stops-table mortar-table">
          <thead>
            <tr>
              <th>Receita</th>
              <th className="n">Bateladas</th>
              <th className="n">Por batelada</th>
              <th className="n">Na receita</th>
              <th className="n">Consumido</th>
            </tr>
          </thead>
          <tbody>
            {byRecipe.map((row) => (
              <tr key={row.recipe}>
                <td>
                  <b>{row.recipe}</b>
                </td>
                <td className="n">{integer(row.batches)}</td>
                <td className="n">{kilos(row.kg / Math.max(1, row.batches))}</td>
                <td className="n">{percent(row.share)}</td>
                <td className="n">
                  <b>{tons(row.kg)} t</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>
    );
  }

  const recipe = mix.recipes.find((row) => row.recipe === open.recipe);
  if (!recipe) return null;
  return (
    <Modal title={`Receita ${recipe.recipe}`} subtitle={subtitle} onClose={onClose}>
      <div className="mortar-figures">
        <Figure label="Bateladas" value={integer(recipe.batches)} />
        <Figure label="Misturado" value={tons(recipe.kg)} unit="t" />
        <Figure label="Por batelada" value={kilos(recipe.kg / Math.max(1, recipe.batches))} />
        <Figure
          label="Balança × receita"
          value={
            recipe.scaleKg != null && recipe.scaleTheoreticalKg
              ? `${recipe.scaleKg >= recipe.scaleTheoreticalKg ? '+' : ''}${percent(recipe.scaleKg / recipe.scaleTheoreticalKg - 1)}`
              : '—'
          }
          hint={recipe.lastAt ? `última batelada às ${clock(recipe.lastAt)}` : undefined}
        />
      </div>
      <div className="stops-title">Composição</div>
      <RecipeBar recipe={recipe} colorOf={colorOf} />
      <table className="stops-table mortar-table">
        <thead>
          <tr>
            <th>Material</th>
            <th className="n">Na receita</th>
            <th className="n">Por batelada</th>
            <th className="n">Consumido</th>
          </tr>
        </thead>
        <tbody>
          {recipe.materials.map((item) => (
            <Fragment key={item.label}>
              <tr>
                <td>
                  <span className="mortar-dot" style={{ background: colorOf(item.label) }} />
                  {item.label}
                </td>
                <td className="n">{percent(recipe.kg ? item.kg / recipe.kg : null)}</td>
                <td className="n">{kilos(item.kg / Math.max(1, recipe.batches))}</td>
                <td className="n">
                  <b>{tons(item.kg)} t</b>
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Rendimento

export function Yield({ data, onLink }: { data: Summary; onLink?: () => void }) {
  const palette = useContext(MortarColors);
  const { yield: result } = data;
  const peak = Math.max(1, result.mixedKg, result.baggedKg);
  return (
    <>
      <div className="mortar-figures">
        <Figure label="Misturado" value={tons(result.mixedKg)} unit="t" hint="entrou no silo" />
        <Figure label="Ensacado" value={tons(result.baggedKg)} unit="t" hint="saiu em sacos" />
        <Figure
          label="Diferença"
          value={tons(result.lossKg)}
          unit="t"
          hint={
            result.lossRatio == null
              ? 'sem mistura no período'
              : `${percent(result.lossRatio)} do misturado`
          }
        />
      </div>
      <div className="mortar-yield">
        <div>
          <span>Misturado</span>
          <i style={{ width: `${(result.mixedKg / peak) * 100}%`, background: '#c9a36a' }} />
          <b>{tons(result.mixedKg)} t</b>
        </div>
        <div>
          <span>Ensacado</span>
          <i style={{ width: `${(result.baggedKg / peak) * 100}%`, background: palette.accent }} />
          <b>{tons(result.baggedKg)} t</b>
        </div>
      </div>
      <Explain>
        A diferença soma a perda do processo e o que ainda está no silo pulmão: num período curto o
        silo pesa mais, num mês ela mostra a perda de verdade. Negativa quer dizer que se ensacou o
        que já estava no silo antes do período.
      </Explain>
      <Unlinked bags={result.unlinkedBags} onLink={onLink} />
    </>
  );
}
