'use client';

import { useContext, useId, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { mutate, usePoll } from './data';
import { useFirstDraw } from './firstDraw';
import { usePlatform } from './PlatformShell';
import { MortarColors, STATES, clock, duration, integer, percent, tons } from './mortarShared';

/**
 * The shift (or the day) of the bagging line -- or of one spout -- against its target, read the
 * way the ceramic production board reads a shift: what was made, the target and where the line
 * should be by now, where it will close at this pace, and the S-curve, painted by what the spouts
 * were doing, beside the same window of an earlier day.
 */
export type MortarBoardData = {
  mode: 'shift' | 'day';
  date: string;
  today: string;
  status: 'running' | 'finished' | 'upcoming';
  defaultShifts: boolean;
  span: { start: string; end: string };
  shifts: Array<{ shiftId: string; name: string; start: string; end: string }>;
  available: Array<{ shiftId: string; name: string; start: string; end: string }>;
  metric: 'bags' | 'tons';
  target: null | {
    perShift: number;
    value: number;
    expectedNow: number;
    projected: number;
    ratio: number | null;
  };
  totals: {
    bags: number;
    kg: number;
    actual: number;
    runningS: number;
    idleS: number;
    offS: number;
    plannedSeconds: number;
    elapsedProductive: number;
    pacePerHour: number;
    projected: number;
    availability: number | null;
    performance: number | null;
    effectiveness: number | null;
    stops: number;
    stopSeconds: number;
    longestStop: number;
  };
  points: Array<{
    t: string;
    actual: number | null;
    planned: number | null;
    projected?: number;
    state: string;
    productive: boolean;
  }>;
  compare: Array<number | null> | null;
  compareLabel: string | null;
  spouts: Array<{ id: string; name: string; bags: number; stops: number; stopSeconds: number }>;
  stops: Array<{
    spoutId: string;
    state: string;
    startedAt: string;
    endedAt: string;
    seconds: number;
    product: string | null;
    open: boolean;
  }>;
};

const STATE_COLOR: Record<string, string> = {
  running: STATES.running.color,
  idle: STATES.idle.color,
  off: STATES.off.color,
  offline: STATES.offline.color,
  future: '#c4d0d3',
};

export function MortarShiftBoard({
  deviceId,
  date,
  spoutId,
  spoutName,
  showStops,
}: {
  deviceId: string;
  /** The plant day the board reads. */
  date: string;
  /** One spout only, when the board is opened from a spout. */
  spoutId?: string;
  spoutName?: string;
  /** List the stops of the window under the curve (the spout window does). */
  showStops?: boolean;
}) {
  const { user } = usePlatform();
  const palette = useContext(MortarColors);
  const [mode, setMode] = useState<'shift' | 'day'>('shift');
  const [shift, setShift] = useState<string | null>(null);
  const [compare, setCompare] = useState<'yesterday' | 'week' | 'none'>('yesterday');
  const [editing, setEditing] = useState(false);
  const board = usePoll<MortarBoardData>(
    `/devices/${deviceId}/mortar/board?mode=${mode}&date=${date}&compare=${compare}` +
      (shift && mode === 'shift' ? `&shift=${shift}` : '') +
      (spoutId ? `&spout=${spoutId}` : ''),
    30000,
  );
  const data = board.data;
  const tonsMetric = data?.metric === 'tons';
  const unit = tonsMetric ? 't' : 'sacos';
  const fmt = (value: number | null | undefined) =>
    value == null ? '—' : tonsMetric ? tons(value * 1000) : integer(value);

  if (!data) return <div className="stops-empty">{board.error ?? 'Carregando o turno…'}</div>;
  const target = data.target && !spoutId ? data.target : null;
  const ratio = target?.ratio ?? null;
  const tone = ratio == null ? 'neutral' : ratio >= 1 ? 'good' : ratio >= 0.9 ? 'warn' : 'bad';
  const label =
    data.mode === 'day'
      ? `Dia ${data.date.split('-').reverse().slice(0, 2).join('/')}`
      : `${data.shifts[0]?.name ?? 'Turno'} · ${clock(data.shifts[0]?.start)}–${clock(data.shifts[0]?.end)}`;
  const remaining = Math.max(0, data.totals.plannedSeconds - data.totals.elapsedProductive);

  return (
    <div className="mortar-shift">
      <div className="mortar-shift-head">
        <div>
          <b>{spoutName ? `Bico ${spoutName} · ${label}` : label}</b>
          <small>
            {data.status === 'running'
              ? `termina em ${duration(remaining)} produtivos`
              : data.status === 'finished'
                ? 'encerrado'
                : 'ainda não começou'}
            {data.defaultShifts && ' · turno padrão (cadastre os turnos da planta em Produção)'}
          </small>
        </div>
        <div className="mortar-shift-tools">
          <div className="widget-period" role="group" aria-label="Turno ou dia">
            <button
              type="button"
              className={mode === 'shift' ? 'active' : ''}
              onClick={() => setMode('shift')}
            >
              Turno
            </button>
            <button
              type="button"
              className={mode === 'day' ? 'active' : ''}
              onClick={() => setMode('day')}
            >
              Dia
            </button>
          </div>
          {mode === 'shift' && data.available.length > 1 && (
            <div className="widget-period" role="group" aria-label="Qual turno">
              {data.available.map((item) => (
                <button
                  key={item.shiftId}
                  type="button"
                  className={(shift ?? data.shifts[0]?.shiftId) === item.shiftId ? 'active' : ''}
                  onClick={() => setShift(item.shiftId)}
                >
                  {item.name}
                </button>
              ))}
            </div>
          )}
          <div className="widget-period" role="group" aria-label="Comparar com">
            <span className="mortar-shift-caption">Comparar</span>
            {(
              [
                ['yesterday', 'Ontem'],
                ['week', 'Semana passada'],
                ['none', 'Nada'],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                className={compare === key ? 'active' : ''}
                onClick={() => setCompare(key)}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mortar-figures mortar-shift-figures">
        <div className="mortar-figure hero">
          <span>Produzido</span>
          <b>
            {fmt(data.totals.actual)}
            <small> {unit}</small>
          </b>
          <em>
            {integer(data.totals.bags)} sacos · {tons(data.totals.kg)} t
          </em>
        </div>
        {!spoutId && (
          <div className="mortar-figure">
            <span>
              Meta
              {user.role === 'master' && (
                <button
                  type="button"
                  className="mortar-pencil"
                  onClick={() => setEditing(true)}
                  aria-label="Editar meta"
                >
                  ✎
                </button>
              )}
            </span>
            <b>
              {target ? fmt(target.value) : '—'}
              {target && <small> {unit}</small>}
            </b>
            <em>
              {target
                ? `esperado agora ${fmt(target.expectedNow)} · feito ${fmt(data.totals.actual)}`
                : user.role === 'master'
                  ? 'defina a meta no lápis'
                  : 'sem meta definida'}
            </em>
          </div>
        )}
        <div className="mortar-figure">
          <span>Projeção</span>
          <b>
            {fmt(data.totals.projected)}
            <small> {unit}</small>
          </b>
          <em>{data.status === 'running' ? 'no ritmo atual, ao fim' : 'fechou o período'}</em>
        </div>
        <div className="mortar-figure">
          <span>Ritmo</span>
          <b>
            {tonsMetric ? tons(data.totals.pacePerHour * 1000) : integer(data.totals.pacePerHour)}
            <small> {unit}/h</small>
          </b>
          <em>por hora produtiva do {data.mode === 'day' ? 'dia' : 'turno'}</em>
        </div>
        <div
          className="mortar-figure"
          title="Disponibilidade × desempenho. A qualidade entra quando o CLP contar os sacos rejeitados."
        >
          <span>Eficiência</span>
          <b>{percent(data.totals.effectiveness ?? data.totals.availability)}</b>
          <em>
            disponível {percent(data.totals.availability, 0)} × desempenho{' '}
            {percent(data.totals.performance, 0)}
          </em>
        </div>
        <div className="mortar-figure">
          <span>Paradas</span>
          <b>{integer(data.totals.stops)}</b>
          <em>
            {data.totals.stops
              ? `${duration(data.totals.stopSeconds)} paradas · maior ${duration(data.totals.longestStop)}`
              : 'nenhuma no período'}
          </em>
        </div>
      </div>

      {target && (
        <div className={`mortar-banner ${tone}`}>
          {data.status === 'finished' ? 'Fechou em ' : 'No ritmo atual fecha em '}
          <b>
            {fmt(data.totals.projected)} {unit}
          </b>{' '}
          — {percent(ratio, 0)} da meta.
          {data.status === 'running' && target.value > data.totals.actual && remaining > 0 && (
            <>
              {' '}
              Para bater a meta, faltam {fmt(target.value - data.totals.actual)} {unit} em{' '}
              {duration(remaining)}:{' '}
              {tonsMetric
                ? tons(((target.value - data.totals.actual) / (remaining / 3600)) * 1000)
                : integer((target.value - data.totals.actual) / (remaining / 3600))}{' '}
              {unit}/h.
            </>
          )}
        </div>
      )}

      <Curve data={data} accent={palette.accent} fmt={fmt} unit={unit} />

      {showStops && (
        <>
          <div className="stops-title">
            Paradas<small> · quando o bico ficou sem ensacar além do limite de ociosa</small>
          </div>
          {data.stops.length ? (
            <table className="stops-table mortar-table">
              <thead>
                <tr>
                  <th>Início</th>
                  <th>Fim</th>
                  <th className="n">Duração</th>
                  <th>Motivo</th>
                  <th>Produto</th>
                </tr>
              </thead>
              <tbody>
                {data.stops.map((stop) => (
                  <tr key={stop.spoutId + stop.startedAt}>
                    <td>{clock(stop.startedAt)}</td>
                    <td>{stop.open ? <b>agora</b> : clock(stop.endedAt)}</td>
                    <td className="n">{duration(stop.seconds)}</td>
                    <td>
                      <span
                        className="mortar-dot"
                        style={{ background: STATE_COLOR[stop.state] }}
                      />
                      {stop.state === 'off' ? 'Desabilitada' : 'Ociosa'}
                    </td>
                    <td className="muted">{stop.product ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="stops-empty">Nenhuma parada no período.</div>
          )}
        </>
      )}

      {editing && (
        <TargetEditor
          deviceId={deviceId}
          metric={data.metric}
          perShift={data.target?.perShift ?? null}
          onClose={() => {
            setEditing(false);
            void board.refresh();
          }}
        />
      )}
    </div>
  );
}

function Curve({
  data,
  accent,
  fmt,
  unit,
}: {
  data: MortarBoardData;
  accent: string;
  fmt: (value: number | null | undefined) => string;
  unit: string;
}) {
  const gradient = useId().replace(/:/g, '');
  const rows = useMemo(
    () =>
      data.points.map((point, index) => ({
        label: clock(point.t),
        actual: point.actual,
        planned: point.planned,
        projected:
          point.projected ??
          (point.actual != null &&
          data.points[index + 1]?.actual == null &&
          data.status === 'running'
            ? point.actual
            : null),
        compare: data.compare?.[index] ?? null,
        state: point.state,
      })),
    [data],
  );
  const drawing = useFirstDraw(rows.length > 0);
  const last = rows.reduce((at, row, index) => (row.actual != null ? index : at), -1);
  // The line is painted by what the spouts were doing in each stretch.
  const stops =
    last > 0
      ? rows.slice(1, last + 1).flatMap((row, index) => [
          { offset: index / last, color: STATE_COLOR[row.state] ?? accent },
          { offset: (index + 1) / last, color: STATE_COLOR[row.state] ?? accent },
        ])
      : [];
  return (
    <>
      <div className="stops-title">
        Curva S<small> · {unit} acumulados, pintados pelo que a linha fazia</small>
      </div>
      <div className="mortar-curve">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`fill-${gradient}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.22} />
                <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
              </linearGradient>
              {stops.length > 0 && (
                <linearGradient id={`line-${gradient}`} x1="0" y1="0" x2="1" y2="0">
                  {stops.map((stop, index) => (
                    <stop key={index} offset={stop.offset} stopColor={stop.color} />
                  ))}
                </linearGradient>
              )}
            </defs>
            <CartesianGrid stroke="#e6eef0" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#7b9097' }} minTickGap={28} />
            <YAxis
              tick={{ fontSize: 10, fill: '#7b9097' }}
              width={52}
              tickFormatter={(value: number) => fmt(value)}
            />
            <Tooltip
              formatter={(value, name) => [
                `${fmt(Number(value))} ${unit}`,
                name === 'actual'
                  ? 'Produzido'
                  : name === 'planned'
                    ? 'Meta'
                    : name === 'projected'
                      ? 'Projeção'
                      : (data.compareLabel ?? 'Comparação'),
              ]}
            />
            {data.compare && (
              <Line
                dataKey="compare"
                stroke="#9fb2b7"
                strokeWidth={1.5}
                strokeDasharray="2 3"
                dot={false}
                isAnimationActive={false}
              />
            )}
            <Line
              dataKey="planned"
              stroke="#0b2028"
              strokeOpacity={0.45}
              strokeWidth={1.5}
              strokeDasharray="6 4"
              dot={false}
              isAnimationActive={false}
            />
            <Area
              dataKey="actual"
              stroke={stops.length ? `url(#line-${gradient})` : accent}
              strokeWidth={3}
              fill={`url(#fill-${gradient})`}
              connectNulls={false}
              isAnimationActive={drawing}
              animationDuration={drawing ? 700 : 0}
            />
            <Line
              dataKey="projected"
              stroke={accent}
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="stops-spent-legend">
        <span>
          <i style={{ background: STATES.running.color }} /> Ensacando
        </span>
        <span>
          <i style={{ background: STATES.idle.color }} /> Ociosa
        </span>
        <span>
          <i style={{ background: STATES.off.color }} /> Desabilitada
        </span>
        <span>
          <i style={{ background: STATES.offline.color }} /> Sem comunicação
        </span>
        <span>
          <i className="dash" style={{ borderColor: '#0b2028' }} /> Meta
        </span>
        {data.status === 'running' && (
          <span>
            <i className="dash" style={{ borderColor: accent }} /> Projeção
          </span>
        )}
        {data.compare && (
          <span>
            <i className="dash" style={{ borderColor: '#9fb2b7' }} /> {data.compareLabel}
          </span>
        )}
      </div>
    </>
  );
}

function TargetEditor({
  deviceId,
  metric,
  perShift,
  onClose,
}: {
  deviceId: string;
  metric: 'bags' | 'tons';
  perShift: number | null;
  onClose: () => void;
}) {
  const [unit, setUnit] = useState(metric);
  const [value, setValue] = useState(perShift == null ? '' : String(perShift).replace('.', ','));
  const [error, setError] = useState('');
  const save = async (clear = false) => {
    const number = Number(value.replace(',', '.'));
    if (!clear && !(number > 0)) return setError('Informe a meta de um turno.');
    try {
      await mutate(`/devices/${deviceId}/mortar/target`, 'PATCH', {
        metric: unit,
        perShift: clear ? null : number,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar');
    }
  };
  return (
    <div className="mortar-target-editor">
      <b>Meta por turno</b>
      <div className="widget-period" role="group" aria-label="Unidade">
        <button
          type="button"
          className={unit === 'bags' ? 'active' : ''}
          onClick={() => setUnit('bags')}
        >
          Sacos
        </button>
        <button
          type="button"
          className={unit === 'tons' ? 'active' : ''}
          onClick={() => setUnit('tons')}
        >
          Toneladas
        </button>
      </div>
      <input
        inputMode="decimal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={unit === 'bags' ? 'ex.: 6000' : 'ex.: 140'}
      />
      <small>A meta do dia é a soma dos turnos do dia.</small>
      {error && <span className="form-error">{error}</span>}
      <div>
        <button type="button" onClick={onClose}>
          Cancelar
        </button>
        {perShift != null && (
          <button type="button" onClick={() => void save(true)}>
            Tirar a meta
          </button>
        )}
        <button type="button" className="primary" onClick={() => void save()}>
          Salvar
        </button>
      </div>
    </div>
  );
}
