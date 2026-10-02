'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { useFirstDraw } from './firstDraw';
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
import { usePoll } from './data';
import { DayCalendar, dayLabel } from './DayCalendar';
import { ModalPortal } from './ModalPortal';
import { TargetModal } from './TargetModal';
import { UtilizationModal, utilizationCaption } from './UtilizationModal';
import {
  ShiftDetailModal,
  type CalculatedSetting,
  type DetailFocus,
} from './ShiftDetailModal';

// "Quadro de produção": one card that answers how the shift (or the day) is going. Produced
// against the target, where the pace leads by the end (S-curve and projection), what is needed
// per hour to recover, and how the machine spent its time. It replaces a handful of loose cards;
// history, comparisons and exports live on the Produção page.

export type ProductionMetric = 'milheiros' | 'tons' | 'blocks' | 'pallets';
type MachineState = 'producing' | 'idle' | 'manual' | 'offline' | 'unknown';

interface Occurrence {
  /** Which of the site's shifts this is: how a plant with two of them picks one. */
  shiftId: string;
  name: string;
  productionDate: string;
  start: string;
  end: string;
  plannedSeconds: number;
}
export interface BoardData {
  span: { start: string; end: string };
  plannedSeconds: number;
  remainingSeconds: number;
  metric: ProductionMetric;
  totals: { pieces: number; milheiros: number; pallets: number; tons: number };
  products: Array<{
    product_code: string;
    pieces: number;
    milheiros: number;
    pallets: number;
    tons: number;
  }>;
  time: {
    producing: number;
    idle: number;
    manual: number;
    offline: number;
    /** Idle before the first production of the window: not counted as idleness. */
    waiting?: number;
    /** Idle after the last production when it stopped within the final minutes of the shift. */
    closing?: number;
    /** Scheduled pauses elapsed so far. */
    pause?: number;
    elapsedProductive: number;
  };
  utilization: number | null;
  /** The plant's own utilization formula; null is producing ÷ (producing + idle). */
  utilizationFormula?: string | null;
  target: {
    value: number;
    /** 'hmi': read from the HMI variable; 'fixed': the configured value. */
    source?: 'hmi' | 'fixed';
    actual: number;
    plannedToNow: number;
    projected: number;
    ratePerHour: number;
    requiredPerHour: number | null;
    health: 'achieved' | 'on_track' | 'at_risk' | 'off_track' | 'missed' | null;
  } | null;
  pacePerHour: number;
  curve: Array<{
    t: string;
    planned: number | null;
    actual: number | null;
    projected: number | null;
  }>;
  timeline: Array<{ t: string; state: string; mix?: Record<string, number> }>;
  /** Pallet pace: time between the last two pallets, and producing time per pallet. */
  palletTiming?: {
    lastSeconds: number | null;
    lastAt: string | null;
    averageSeconds: number | null;
    count: number;
  } | null;
}
export interface ShiftBoardResponse {
  configured: boolean;
  missing: string[];
  mode: 'shift' | 'day';
  defaultShifts: boolean;
  now: string;
  state: MachineState;
  /** Since when the machine is in this state (none while producing). */
  stateSince?: string | null;
  product: string | null;
  next: Occurrence | null;
  status: 'running' | 'finished' | 'upcoming' | 'between' | 'no_shift';
  productionDate: string;
  shifts: Occurrence[];
  /** Every shift of the day being looked at: what the plant may choose between. */
  available?: Occurrence[];
  /** In the day view, each shift counted on its own. */
  perShift?: Array<{
    shiftId: string;
    name: string;
    start: string;
    end: string;
    totals: { pieces: number; milheiros: number; pallets: number; tons: number } | null;
    target: { value: number; actual: number; projected: number } | null;
    utilization: number | null;
  }>;
  board: BoardData | null;
}

export const metricInfo: Record<
  ProductionMetric,
  { unit: string; name: string; decimals: number }
> = {
  milheiros: { unit: 'mil', name: 'milheiros', decimals: 1 },
  tons: { unit: 't', name: 'toneladas', decimals: 1 },
  blocks: { unit: 'peças', name: 'peças', decimals: 0 },
  pallets: { unit: 'paletes', name: 'paletes', decimals: 0 },
};
export const stateInfo: Record<string, { label: string; color: string }> = {
  producing: { label: 'Produzindo', color: '#1fbf7a' },
  idle: { label: 'Ociosa', color: '#f2a93b' },
  manual: { label: 'Manual / parada', color: '#e4572e' },
  offline: { label: 'Sem comunicação', color: '#98a6ab' },
  waiting: { label: 'Aguardando início', color: '#8fb8de' },
  closing: { label: 'Encerrado', color: '#5f7f96' },
  // Lilac, far from the grey of "sem comunicação": a lunch break read as an outage.
  pause: { label: 'Pausa', color: '#cdb9ea' },
  // A bagging spout the operator switched off on the HMI (mortar plants).
  disabled: { label: 'Desabilitada', color: '#7c93b0' },
  outside: { label: 'Fora de turno', color: '#e6ecee' },
  unknown: { label: 'Sem dados', color: '#98a6ab' },
};

export function formatNumber(value: number, decimals = 0) {
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
export function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
}
export function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
    : `${minutes} min`;
}

/** mm:ss (h:mm:ss from one hour on); "—" when unknown. */
export function minutesSeconds(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${String(minutes).padStart(2, '0')}:${rest}`;
}

function statusLine(data: ShiftBoardResponse) {
  const now = new Date(data.now).getTime();
  const span = data.board?.span;
  if (data.status === 'running' && span)
    return `termina em ${duration((new Date(span.end).getTime() - now) / 1000)}`;
  if (data.status === 'finished') return 'turno encerrado';
  if (data.status === 'upcoming' && data.shifts[0])
    return `começa às ${clock(data.shifts[0].start)}`;
  if (data.status === 'between' && data.next) return `próximo turno às ${clock(data.next.start)}`;
  return data.next ? `próximo turno ${clock(data.next.start)}` : 'sem turno programado';
}

/**
 * The S-curve: planned, actual and projected, with the area under "realizado" painted with
 * the machine state of each 5-minute stretch (the segment between curve points k and k+1 is
 * timeline[k]; hard stops over the area's own width, which objectBoundingBox measures). It
 * fills its parent, so the board and the TV size it each their own way.
 */
/**
 * Cumulative curve of the shift. The filled area carries the machine's state colour along the
 * shift, and the tooltip names the state at the point under the mouse. The chart zooms with the
 * wheel or the buttons and can be dragged sideways, so a busy hour can be looked at closely.
 */
/**
 * The colour of one block of the timeline. A block the machine spent in more than one state is
 * painted in slices, so a two-minute stop inside a producing block is visible.
 */
function segmentPaint(segment: { state: string; mix?: Record<string, number> }) {
  const solid = stateInfo[segment.state]?.color ?? stateInfo.unknown.color;
  const mix = segment.mix;
  if (!mix) return solid;
  const total = Object.values(mix).reduce((sum, seconds) => sum + seconds, 0);
  if (total <= 0) return solid;
  const order = ['producing', 'waiting', 'closing', 'idle', 'manual', 'offline'];
  let at = 0;
  const stops: string[] = [];
  for (const state of order) {
    const seconds = mix[state];
    if (!seconds) continue;
    const color = stateInfo[state]?.color ?? stateInfo.unknown.color;
    const from = (at / total) * 100;
    at += seconds;
    stops.push(`${color} ${from.toFixed(1)}%`, `${color} ${((at / total) * 100).toFixed(1)}%`);
  }
  return stops.length ? `linear-gradient(90deg, ${stops.join(', ')})` : solid;
}

export function ShiftCurve({
  board,
  fontSize = 10,
  deviceId,
  minuteSeries,
  compare,
  view: outerView,
  onView,
  syncId,
  unit,
}: {
  board: BoardData;
  /** Another unit than the board metric's: a mortar board counts bags. */
  unit?: { unit: string; name: string; decimals: number };
  fontSize?: number;
  /** With the device, a close zoom reads the counter minute by minute. */
  deviceId?: string;
  /** The whole shift minute by minute, already at hand (a shift photo): no reading is fetched. */
  minuteSeries?: Array<{ t: string; value: number }>;
  /** Another day's realized curve, matched by position in the shift, drawn behind this one. */
  compare?: { label: string; actual: Array<number | null> } | null;
  /** Held outside when two charts are read together, so zooming one zooms both. */
  view?: { start: number; end: number } | null;
  onView?: (view: { start: number; end: number } | null) => void;
  /** Charts sharing this name show the same point under the cursor. */
  syncId?: string;
}) {
  const reactId = useId();
  const info = unit ?? metricInfo[board.metric];
  const chart = board.curve.map((point, index) => ({
    ...point,
    label: clock(point.t),
    state: board.timeline[index]?.state ?? 'unknown',
    // Position in the shift, not clock time: two days line up even when one started late.
    compare: compare?.actual[index] ?? null,
  }));
  const gradientId = `shift-state-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  // Window of points on screen; null is the whole shift.
  const [ownView, setOwnView] = useState<{ start: number; end: number } | null>(null);
  const view = onView ? (outerView ?? null) : ownView;
  const setView = (
    next:
      | { start: number; end: number }
      | null
      | ((current: { start: number; end: number } | null) => { start: number; end: number } | null),
  ) => {
    const value = typeof next === 'function' ? next(view) : next;
    if (onView) onView(value);
    else setOwnView(value);
  };
  const drag = useRef<{ x: number; start: number; end: number; moving: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const span = view ?? { start: 0, end: Math.max(0, chart.length - 1) };
  const coarse = chart.slice(span.start, span.end + 1);
  const MIN_POINTS = 6;
  const DRAG_THRESHOLD_PX = 8;
  // Under about an hour on screen, each 5-minute step hides more than it shows.
  const wantsMinutes =
    (Boolean(deviceId) || Boolean(minuteSeries)) && view != null && coarse.length > 1 && coarse.length <= 13;
  const windowFrom = coarse[0]?.t ?? null;
  const windowTo = coarse.at(-1)?.t ?? null;
  const minutes = usePoll<{ minutes: Array<{ t: string; value: number }> }>(
    wantsMinutes && windowFrom && windowTo && !minuteSeries
      ? `/devices/${deviceId}/shift-minutes?from=${encodeURIComponent(windowFrom)}&to=${encodeURIComponent(windowTo)}`
      : null,
    60000,
  );
  // The minute curve carries on from where the coarse curve was at the start of the window.
  const detailed = useMemo(() => {
    const rows = minuteSeries
      ? minuteSeries.filter((row) => windowFrom && windowTo && row.t >= windowFrom && row.t <= windowTo)
      : minutes.data?.minutes;
    if (!wantsMinutes || !rows?.length) return null;
    const base = coarse[0];
    let running = base?.actual ?? 0;
    const plannedStep =
      coarse.length > 1
        ? (((coarse.at(-1)?.planned ?? 0) - (base?.planned ?? 0)) / (rows.length - 1 || 1))
        : 0;
    return rows.map((row, index) => {
      running += row.value;
      return {
        t: row.t,
        label: clock(row.t),
        state: base?.state ?? 'unknown',
        actual: base?.actual == null ? null : running,
        planned: base?.planned == null ? null : (base.planned ?? 0) + plannedStep * index,
        projected: null,
        // The zoom reads this shift minute by minute; another day is not matched that closely.
        compare: null as number | null,
      };
    });
  }, [minutes.data, wantsMinutes, coarse]);
  const visible = detailed ?? coarse;
  // Desenha-se uma vez ao montar; as atualizações seguintes entram sem repintar.
  const drawing = useFirstDraw(visible.length > 0);

  function zoom(factor: number, anchor = 0.5) {
    setView((current) => {
      const now = current ?? { start: 0, end: Math.max(0, chart.length - 1) };
      const width = now.end - now.start + 1;
      const wanted = Math.max(MIN_POINTS, Math.min(chart.length, Math.round(width * factor)));
      if (wanted >= chart.length) return null;
      const centre = now.start + width * anchor;
      const from = Math.max(0, Math.min(chart.length - wanted, Math.round(centre - wanted * anchor)));
      return { start: from, end: from + wanted - 1 };
    });
  }

  const lastActual = visible.reduce(
    (last, point, index) => (point.actual != null ? index : last),
    -1,
  );
  const stateStops =
    lastActual > 0
      ? visible.slice(0, lastActual).flatMap((point, index) => {
          const color = stateInfo[point.state]?.color ?? stateInfo.unknown.color;
          return [
            { offset: index / lastActual, color },
            { offset: (index + 1) / lastActual, color },
          ];
        })
      : [];

  return (
    <div
      className={`shift-curve-frame${view ? ' pannable' : ''}${dragging ? ' dragging' : ''}`}
      ref={frame}
      onWheel={(event) => {
        if (!chart.length) return;
        const box = frame.current?.getBoundingClientRect();
        const anchor = box ? Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) : 0.5;
        zoom(event.deltaY < 0 ? 0.75 : 1.35, anchor);
      }}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDownCapture={(event) => {
        if (!view || event.button !== 0) return;
        // The zoom buttons keep their click: only the chart area pans.
        if ((event.target as HTMLElement).closest('.chart-zoom')) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = { x: event.clientX, start: view.start, end: view.end, moving: true };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMoveCapture={(event) => {
        const box = frame.current?.getBoundingClientRect();
        if (!drag.current || !box) return;
        const travelled = Math.abs(event.clientX - drag.current.x);
        if (!drag.current.moving && travelled < DRAG_THRESHOLD_PX) return;
        event.preventDefault();
        const width = drag.current.end - drag.current.start + 1;
        const moved = Math.round(((drag.current.x - event.clientX) / box.width) * width);
        const from = Math.max(0, Math.min(chart.length - width, drag.current.start + moved));
        setView({ start: from, end: from + width - 1 });
      }}
      onPointerUpCapture={(event) => {
        if (drag.current?.moving) event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancelCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
    >
      <div className="chart-zoom">
        <button type="button" title="Aproximar" aria-label="Aproximar" onClick={(event) => { event.stopPropagation(); zoom(0.75); }}>
          +
        </button>
        <button type="button" title="Afastar" aria-label="Afastar" onClick={(event) => { event.stopPropagation(); zoom(1.35); }}>
          −
        </button>
        <button
          type="button"
          title="Ver o turno inteiro"
          aria-label="Ver o turno inteiro"
          disabled={!view}
          onClick={(event) => { event.stopPropagation(); setView(null); }}
        >
          ⤢
        </button>
      </div>
      {view && (
        <span className="chart-zoom-hint">
          {detailed ? 'minuto a minuto · arraste para andar' : 'arraste para andar no turno'}
        </span>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={visible} syncId={syncId} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          {stateStops.length > 0 && (
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                {stateStops.map((stop, index) => (
                  <stop key={index} offset={stop.offset} stopColor={stop.color} />
                ))}
              </linearGradient>
            </defs>
          )}
          <CartesianGrid
            stroke="#e6eef0"
            strokeOpacity={0.35}
            strokeDasharray="3 5"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fontSize, fill: '#71868d' }}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis
            width={fontSize * 4.4}
            tick={{ fontSize, fill: '#71868d' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) =>
              formatNumber(value, info.decimals && value < 10 ? 1 : 0)
            }
          />
          <Tooltip
            content={<CurveTooltip info={info} compareLabel={compare?.label} />}
            allowEscapeViewBox={{ x: false, y: true }}
            offset={16}
          />
          <Area
            type="monotone"
            dataKey="actual"
            name="Realizado"
            stroke="var(--accent, #12b8a6)"
            fill={stateStops.length ? `url(#${gradientId})` : 'var(--accent, #12b8a6)'}
            fillOpacity={stateStops.length ? 0.45 : 0.14}
            strokeWidth={2.5}
            isAnimationActive={drawing}
                animationDuration={700}
            connectNulls={false}
          />
          {compare && (
            <Line
              type="monotone"
              dataKey="compare"
              name={compare.label}
              stroke="#b07cc6"
              strokeWidth={2}
              strokeDasharray="2 4"
              dot={false}
              isAnimationActive={drawing}
                animationDuration={700}
              connectNulls={false}
            />
          )}
          <Line
            type="monotone"
            dataKey="planned"
            name="Planejado"
            stroke="#8a9ca2"
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={drawing}
                animationDuration={700}
          />
          <Line
            type="monotone"
            dataKey="projected"
            name="Projeção"
            stroke="var(--accent, #12b8a6)"
            strokeDasharray="5 5"
            strokeWidth={2}
            dot={false}
            isAnimationActive={drawing}
                animationDuration={700}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The realized value wears the colour of the machine state at that moment, as the area does. */
function CurveTooltip({
  info,
  compareLabel,
  active,
  payload,
  label,
}: {
  info: { unit: string; decimals: number };
  /** What the line behind this one is called, when there is one. */
  compareLabel?: string;
  active?: boolean;
  payload?: { value?: number | string | null; dataKey?: string | number }[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const point = (payload[0] as { payload?: { state?: string } }).payload;
  const state = stateInfo[point?.state ?? 'unknown'] ?? stateInfo.unknown;
  const show = (key: string) => payload.find((item) => item.dataKey === key);
  const value = (item: { value?: number | string | null } | undefined) =>
    item?.value == null ? '—' : `${formatNumber(Number(item.value), info.decimals)} ${info.unit}`;
  return (
    <div className="curve-tooltip">
      <strong>às {label}</strong>
      <span>
        <i style={{ background: '#8a9ca2' }} /> Planejado <b>{value(show('planned'))}</b>
      </span>
      {show('actual')?.value != null && (
        <span style={{ color: state.color }}>
          <i style={{ background: state.color }} /> Realizado <b>{value(show('actual'))}</b>
        </span>
      )}
      {show('projected')?.value != null && (
        <span>
          <i style={{ background: 'var(--accent, #12b8a6)' }} /> Projeção{' '}
          <b>{value(show('projected'))}</b>
        </span>
      )}
      {/* The reference drawn behind: without its number the line could only be eyeballed. */}
      {show('compare')?.value != null && (
        <span style={{ color: '#8f63a8' }}>
          <i style={{ background: '#b07cc6' }} /> {compareLabel ?? 'Comparado'}{' '}
          <b>{value(show('compare'))}</b>
        </span>
      )}
      <em>{state.label}</em>
    </div>
  );
}

export function Gauge({ value }: { value: number | null }) {
  const ratio = value == null ? 0 : Math.max(0, Math.min(1, value));
  const angle = Math.PI * (1 - ratio);
  const x = 60 + 48 * Math.cos(angle);
  const y = 58 - 48 * Math.sin(angle);
  const tone =
    value == null ? '#98a6ab' : ratio >= 0.85 ? '#1fbf7a' : ratio >= 0.65 ? '#f2a93b' : '#e4572e';
  return (
    <svg className="shift-gauge" viewBox="0 0 120 70" role="img" aria-label="Aproveitamento">
      <path d="M12 58 A48 48 0 0 1 108 58" className="shift-gauge-track" />
      {value != null && ratio > 0 && (
        <path
          d={`M12 58 A48 48 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`}
          style={{ stroke: tone }}
          className="shift-gauge-value"
        />
      )}
      <text x="60" y="54" textAnchor="middle" className="shift-gauge-number">
        {value == null ? '—' : `${formatNumber(ratio * 100)}%`}
      </text>
    </svg>
  );
}

export interface CalculatedField {
  label: string;
  value: string;
  unit: string;
}

export function ShiftBoard({
  deviceId,
  calculated,
  calculatedSettings,
}: {
  deviceId: string;
  /** The formulas themselves, so the detail modal can chart them hour by hour. */
  calculatedSettings?: CalculatedSetting[];
  /** Formulas the master wrote on the card, shown as more numbers of the board. */
  calculated?: CalculatedField[];
}) {
  const [mode, setMode] = useState<'shift' | 'day'>('shift');
  // Which shift of the day is open. Empty means the running one, as before.
  const [shiftId, setShiftId] = useState('');
  // A day of the history instead of today, and another day drawn behind it. Both read the
  // photograph taken when the day closed, so no reading is needed and nothing is recomputed.
  const [day, setDay] = useState('');
  // The comparison is named with the same words as every other card's filter, so a plant reads
  // one vocabulary across the dashboard instead of two.
  const [against, setAgainst] = useState<Comparison>('');
  const [againstDay, setAgainstDay] = useState('');
  const days = usePoll<{ days: Array<{ date: string; pallets: number | null; pieces: number | null }> }>(
    `/devices/${deviceId}/production-days?limit=400`,
    600000,
  );
  const photo = usePoll<{ photo: { detail: ShiftBoardResponse; minutes: Array<{ t: string; value: number }> } | null }>(
    day ? `/devices/${deviceId}/production-photo?date=${day}&kind=day` : null,
    600000,
  );
  const comparingDay = against === 'custom' ? againstDay : '';
  // Today as a comparison only means something while a past day is open; the pill says so.
  const againstToday = against === 'today';
  const medianDays = medianWindow(against);
  const other = usePoll<{ photo: { detail: ShiftBoardResponse; minutes: Array<{ t: string; value: number }> } | null }>(
    comparingDay ? `/devices/${deviceId}/production-photo?date=${comparingDay}&kind=day` : null,
    600000,
  );
  const median = usePoll<{ days: number; curve: Array<number | null> }>(
    medianDays ? `/devices/${deviceId}/production-median?days=${medianDays}` : null,
    600000,
  );
  // Comparing a past day against today reads the running day board, not a photograph: today
  // has not closed yet, so there is no photograph of it to read.
  const live = usePoll<ShiftBoardResponse>(
    againstToday && day ? `/devices/${deviceId}/shift-board?mode=day` : null,
    30000,
  );
  // Both charts zoom together when two days are read one above the other.
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const response = usePoll<ShiftBoardResponse>(
    day
      ? null
      : `/devices/${deviceId}/shift-board?mode=${mode}${
          mode === 'shift' && shiftId ? `&shift=${encodeURIComponent(shiftId)}` : ''
        }`,
    30000,
  );
  // Opened without the card's formulas (the operations report does that): take the ones the
  // device's own production card carries, so its calculations are charted there too.
  const config = usePoll<{ calculated?: CalculatedSetting[] }>(
    calculatedSettings ? null : `/devices/${deviceId}/production-config`,
    600000,
  );
  const settings = calculatedSettings ?? config.data?.calculated ?? [];
  const shown = day ? (photo.data?.photo?.detail ?? null) : (response.data ?? null);
  // The other day's realized curve, by position in the shift, so a late start still lines up.
  const overlay = medianDays && median.data?.curve.length
    ? { label: medianLabel(against), actual: median.data.curve }
    : null;
  const below = comparingDay
    ? (other.data?.photo?.detail ?? null)
    : againstToday && day
      ? (live.data ?? null)
      : null;
  const belowLabel = comparingDay ? dayLabel(comparingDay) : againstToday ? 'hoje' : '';

  // A plant that has run for a year has a year of days, and a year of days is not a list anyone
  // can scroll: the day is picked on a calendar. The closed days are still read, to bound that
  // calendar and to say plainly when a day typed by hand has no report behind it.
  const closedDays = useMemo(() => (days.data?.days ?? []).map((item) => item.date), [days.data]);
  const known = useMemo(() => new Set(closedDays), [closedDays]);
  const missingDay = Boolean(day) && Boolean(days.data) && !known.has(day);
  const missingAgainst = Boolean(comparingDay) && Boolean(days.data) && !known.has(comparingDay);
  // The references of the period are buttons like every other filter of the board; only the
  // one specific day needs a field, and it is only shown once that button is chosen.
  const [pickingDay, setPickingDay] = useState(false);
  const pickerFields = (
    <>
      <div className="shift-field">
        <span>Dia</span>
        <span className="shift-field-controls">
          <span className="widget-period" role="group" aria-label="Dia">
            <button
              type="button"
              className={day || pickingDay ? '' : 'active'}
              onClick={() => {
                setPickingDay(false);
                setDay('');
              }}
            >
              Hoje
            </button>
            <button
              type="button"
              className={day || pickingDay ? 'active' : ''}
              onClick={() => setPickingDay(true)}
            >
              Personalizado
            </button>
          </span>
          {(day || pickingDay) && (
            <DayCalendar value={day} available={closedDays} onPick={setDay} />
          )}
        </span>
      </div>
      <div className="shift-field">
        <span>Comparar com</span>
        <span className="shift-field-controls">
          <span className="widget-period" role="group" aria-label="Comparar com">
            {COMPARISONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={against === value ? 'active' : ''}
                disabled={value === 'today' && !day}
                title={
                  value === 'today' && !day ? 'O quadro já está mostrando hoje' : undefined
                }
                // Clicking the pill that is already on turns the comparison off, the way the
                // other cards work: no place is spent on a "none" button.
                onClick={() => {
                  setAgainst(against === value ? '' : value);
                  setAgainstDay('');
                  setZoom(null);
                }}
              >
                {label}
              </button>
            ))}
          </span>
          {against === 'custom' && (
            <DayCalendar
              value={againstDay}
              // The day already open is not offered as its own comparison.
              available={closedDays.filter((date) => date !== day)}
              onPick={(date) => {
                setAgainstDay(date);
                setZoom(null);
              }}
            />
          )}
          {missingAgainst && <em className="shift-pick-hint">sem apontamento nesse dia</em>}
        </span>
      </div>
    </>
  );
  if (!shown)
    return (
      <div className="shift-board-day">
        <div className="shift-day-picker">{pickerFields}</div>
        <div className="shift-board-empty">
          {missingDay
            ? `Nenhum dia fechado em ${dayLabel(day)}. Um dia só entra na história quando o turno é fechado.`
            : day
              ? (photo.error ?? 'Carregando o dia…')
              : (response.error ?? 'Carregando produção…')}
        </div>
      </div>
    );
  return (
    <div className={`shift-board-day${below ? ' comparing' : ''}`}>
    <ShiftBoardView
      compareBoard={below?.board ?? null}
      compareLabel={belowLabel || undefined}
      tools={<div className="shift-day-picker">{pickerFields}</div>}
      data={shown}
      deviceId={deviceId}
      mode={day ? 'day' : mode}
      onMode={day ? undefined : setMode}
      shiftId={shiftId}
      onShift={day ? undefined : setShiftId}
      historical={Boolean(day)}
      minuteSeries={day ? photo.data?.photo?.minutes : undefined}
      compare={overlay}
      calculated={calculated}
      calculatedSettings={settings}
      onChanged={() => void response.refresh()}
      view={below ? zoom : undefined}
      onView={below ? setZoom : undefined}
      syncId={below ? `board-${deviceId}` : undefined}
    />
    {/* The compared day gets a chart of its own under the first, on the same scale of time.
        The cursor and the zoom are shared, so the same minute is read on both at once. */}
    {below?.board && (
      <div className="shift-compare">
        <div className="shift-section-title">
          {belowLabel}
          <small> · dia comparado</small>
        </div>
        {/* Its curve and its gauge, in the same two columns as the day above: the numbers are
            already in the cards, so only these two are drawn again. */}
        {below.board && (
          <div className="shift-body">
            <div className="shift-curve">
              <div className="shift-chart shift-compare-chart">
                <ShiftCurve
                  board={below.board}
                  deviceId={comparingDay ? undefined : deviceId}
                  minuteSeries={comparingDay ? other.data?.photo?.minutes : undefined}
                  view={zoom}
                  onView={setZoom}
                  syncId={`board-${deviceId}`}
                />
              </div>
            </div>
            <Availability board={below.board} label={belowLabel} />
          </div>
        )}
      </div>
    )}
    </div>
  );
}

/**
 * What a day can be compared against, in the words every other card of the dashboard uses.
 * "today" draws the running day under a past one; the four middles are the median of that
 * period; "custom" is one chosen day.
 */
type Comparison = '' | 'today' | '7d' | 'week' | 'month' | 'year' | 'custom';
const COMPARISONS: Array<[Comparison, string]> = [
  ['today', 'Hoje'],
  ['7d', '7 dias'],
  ['week', 'Semana'],
  ['month', 'Mês'],
  ['year', 'Ano'],
  ['custom', 'Personalizado'],
];

/**
 * How many days back the median reads. "7 dias" is a rolling week; "Semana", "Mês" and "Ano"
 * are the calendar ones so far, which is what those words mean on the other cards. The API
 * wants at least two days and takes at most four hundred.
 */
function medianWindow(against: Comparison) {
  const now = new Date();
  const elapsed =
    against === '7d'
      ? 7
      : against === 'week'
        ? ((now.getDay() + 6) % 7) + 1
        : against === 'month'
          ? now.getDate()
          : against === 'year'
            ? Math.round(
                (now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000,
              ) + 1
            : 0;
  return elapsed ? Math.min(400, Math.max(2, elapsed)) : 0;
}

const medianLabel = (against: Comparison) =>
  against === 'week'
    ? 'mediana da semana'
    : against === 'month'
      ? 'mediana do mês'
      : against === 'year'
        ? 'mediana do ano'
        : 'mediana de 7 dias';

/**
 * The board itself. The live card passes the Turno/Dia switch; the history detail shows a
 * closed shift or day with it, without the switch and without the machine's current state.
 */
/**
 * How the machine spent the period, next to the curve it explains. It is a component because
 * a compared day gets one of its own: without it the day's curve sat beside a gauge and the
 * compared curve ran the full width, so the same minute fell on two different x positions.
 */
function Availability({
  board,
  label,
  onEdit,
}: {
  board: BoardData;
  label?: string;
  /** Opens the choice of formula; absent on history and compared days. */
  onEdit?: () => void;
}) {
  const elapsed = board.time.elapsedProductive ?? 0;
  return (
    <div className="shift-availability">
      <div className="shift-section-title">
        <span>
          Aproveitamento da máquina
          {label && <small> · {label}</small>}
        </span>
        {onEdit && (
          <button
            type="button"
            className="kpi-edit"
            title="Escolher como o aproveitamento é calculado"
            aria-label="Escolher como o aproveitamento é calculado"
            onClick={onEdit}
          >
            ✎
          </button>
        )}
      </div>
      <Gauge value={board.utilization} />
      <small className="shift-gauge-caption">{utilizationCaption(board.utilizationFormula)}</small>
      <ul className="shift-states">
        {(
          ['waiting', 'producing', 'idle', 'manual', 'offline', 'closing', 'pause'] as const
        )
          .filter(
            (state) =>
              !['waiting', 'closing', 'pause'].includes(state) ||
              (board.time[state] ?? 0) >= 60,
          )
          .map((state) => {
            const seconds = board.time[state] ?? 0;
            const hint =
              state === 'waiting'
                ? 'Em automático antes da primeira produção do período: não conta como ociosa'
                : state === 'closing'
                  ? 'Parou de contar nos minutos finais do turno e não voltou: não conta como ociosa'
                  : state === 'pause'
                    ? 'Pausas cadastradas no turno: fora do tempo produtivo'
                    : undefined;
            return (
              <li key={state} title={hint}>
                <i style={{ background: stateInfo[state].color }} />
                <span>{stateInfo[state].label}</span>
                <b>{duration(seconds)}</b>
                <em>
                  {state === 'pause'
                    ? '—'
                    : elapsed > 0
                      ? `${formatNumber((seconds / elapsed) * 100)}%`
                      : '—'}
                </em>
              </li>
            );
          })}
      </ul>
    </div>
  );
}

/** The compared day's figure, under the day's own, inside the same card. */
function Against({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <i className="shift-kpi-against">
      <span>{label}</span>
      {children}
    </i>
  );
}

export function ShiftBoardView({
  data,
  deviceId,
  mode = data.mode,
  onMode,
  shiftId = '',
  onShift,
  onChanged,
  historical = false,
  hideHead = false,
  calculated = [],
  calculatedSettings = [],
  minuteSeries,
  compare,
  view,
  onView,
  syncId,
  tools,
  compareBoard,
  compareLabel,
}: {
  /** The day being compared, folded into the same cards instead of repeating all of them. */
  compareBoard?: BoardData | null;
  compareLabel?: string;
  /** Controls belonging to the card around the board, shown in its header. */
  tools?: React.ReactNode;
  view?: { start: number; end: number } | null;
  onView?: (view: { start: number; end: number } | null) => void;
  syncId?: string;
  /** Another day drawn behind this one, matched by position in the shift. */
  compare?: { label: string; actual: Array<number | null> } | null;
  /** A shift photo's minute curve: the zoom reads it instead of the readings. */
  minuteSeries?: Array<{ t: string; value: number }>;
  calculated?: CalculatedField[];
  calculatedSettings?: CalculatedSetting[];
  /** The TV draws its own header (shift, state, clock). */
  hideHead?: boolean;
  data: ShiftBoardResponse;
  deviceId: string;
  mode?: 'shift' | 'day';
  onMode?: (mode: 'shift' | 'day') => void;
  /** The shift open now, and how to change it. Only offered when the day has more than one. */
  shiftId?: string;
  onShift?: (shiftId: string) => void;
  /** The target was edited: reload the board. */
  onChanged?: () => void;
  historical?: boolean;
}) {
  const [editingTarget, setEditingTarget] = useState(false);
  const [editingUtilization, setEditingUtilization] = useState(false);
  // Each number of the board opens what is behind it: the shift hour by hour, pallet by pallet.
  const [detail, setDetail] = useState<DetailFocus | null>(null);
  const opens = (focus: DetailFocus) =>
    historical
      ? {}
      : {
          role: 'button' as const,
          tabIndex: 0,
          onClick: () => setDetail(focus),
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') setDetail(focus);
          },
          title: 'Ver como foi durante o turno',
        };
  if (!data.configured)
    return (
      <div className="shift-board-empty">
        <strong>Quadro de produção sem configuração</strong>
        <span>
          Escolha o contador de peças (ou de paletes) e a variável de automático em Produção →
          Configurar equipamento.
        </span>
        <a className="secondary-button" href={`/production?device=${deviceId}`}>
          Configurar produção
        </a>
      </div>
    );

  const board = data.board;
  const info = metricInfo[board?.metric ?? 'milheiros'];
  const target = board?.target ?? null;
  const title =
    mode === 'day'
      ? `Dia ${data.productionDate.split('-').reverse().slice(0, 2).join('/')} · ${
          data.shifts.length
        } turno${data.shifts.length === 1 ? '' : 's'}`
      : data.shifts[0]
        ? `${data.shifts[0].name} · ${clock(data.shifts[0].start)}–${clock(data.shifts[0].end)}`
        : 'Sem turno';
  const healthText = (() => {
    if (!board || !target || !target.health) return null;
    const unit = `${info.unit}`;
    const pct = target.value > 0 ? (target.actual / target.value) * 100 : 0;
    switch (target.health) {
      case 'achieved':
        return `Meta atingida: ${formatNumber(target.actual, info.decimals)} de ${formatNumber(target.value, info.decimals)} ${unit}.`;
      case 'missed':
        return `Fechou em ${formatNumber(target.actual, info.decimals)} de ${formatNumber(target.value, info.decimals)} ${unit} (${formatNumber(pct)}% da meta).`;
      case 'on_track':
        return `No ritmo atual fecha em ${formatNumber(target.projected, info.decimals)} ${unit} — ${formatNumber((target.projected / target.value) * 100)}% da meta.`;
      default:
        return `Para bater ${formatNumber(target.value, info.decimals)} ${unit} precisa de ${formatNumber(target.requiredPerHour ?? 0, info.decimals)} ${unit}/h até ${clock(board.span.end)}; o ritmo atual é ${formatNumber(target.ratePerHour, info.decimals)} ${unit}/h. Projeção: ${formatNumber(target.projected, info.decimals)} ${unit}.`;
    }
  })();
  const tone =
    target?.health === 'achieved' || target?.health === 'on_track'
      ? 'good'
      : target?.health === 'at_risk'
        ? 'warn'
        : target?.health
          ? 'bad'
          : 'none';
  const secondaries = board
    ? [
        board.totals.pieces ? `${formatNumber(board.totals.pieces)} peças` : null,
        board.totals.pallets ? `${formatNumber(board.totals.pallets)} paletes` : null,
        board.totals.tons ? `${formatNumber(board.totals.tons, 1)} t` : null,
      ].filter(Boolean)
    : [];

  return (
    <div className={`shift-board ${hideHead ? 'no-head' : ''}`}>
      <div className="shift-board-head">
        <div>
          <strong>{title}</strong>
          <span>
            {statusLine(data)}
            {data.product ? ` · produto ${data.product}` : ''}
            {data.defaultShifts ? ' · turno padrão (seg–sex 07:00–17:00)' : ''}
          </span>
        </div>
        <div className="shift-head-tools">
        {tools}
        {!historical && (
          <span
            className="shift-state"
            style={{ '--state': stateInfo[data.state]?.color } as React.CSSProperties}
          >
            <i />
            {stateInfo[data.state]?.label ?? 'Sem dados'}
          </span>
        )}
        {/* A plant with one shift has nothing to choose, so the buttons are not drawn at all. */}
        {onShift && mode === 'shift' && (data.available?.length ?? 0) > 1 && (
          <div className="shift-mode shift-pick" role="group" aria-label="Turno">
            {data.available?.map((item) => (
              <button
                key={item.shiftId}
                className={
                  (shiftId || data.shifts[0]?.shiftId) === item.shiftId ? 'active' : ''
                }
                onClick={() => onShift(item.shiftId)}
                title={`${item.start.slice(11, 16)}–${item.end.slice(11, 16)}`}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
        {onMode && (
          <div className="shift-mode" role="group" aria-label="Período">
            <button className={mode === 'shift' ? 'active' : ''} onClick={() => onMode('shift')}>
              Turno
            </button>
            <button className={mode === 'day' ? 'active' : ''} onClick={() => onMode('day')}>
              Dia
            </button>
          </div>
        )}
        </div>
      </div>

      {!board ? (
        <div className="shift-board-empty">
          <strong>Sem turno programado</strong>
          <span>Cadastre os turnos da fábrica na tela Produção.</span>
        </div>
      ) : (
        <>
          <div className="shift-kpis">
            <div className={`shift-kpi hero ${historical ? '' : 'clickable'}`} {...opens('produced')}>
              <span>Produzido</span>
              <b>
                {formatNumber(board.totals.milheiros, 1)} <small>milheiros</small>
              </b>
              <em>{secondaries.join(' · ') || 'nenhuma peça ainda'}</em>
              {compareBoard && compareLabel && (
                <Against label={compareLabel}>
                  {formatNumber(compareBoard.totals.milheiros, 1)} <small>milheiros</small>
                </Against>
              )}
            </div>
            <div className={`shift-kpi ${historical ? '' : 'clickable'}`} {...opens('target')}>
              <span className="shift-kpi-title">
                Meta
                {!historical && (
                  <button
                    type="button"
                    className="kpi-edit"
                    title="Editar a meta do turno"
                    aria-label="Editar a meta do turno"
                    onClick={() => setEditingTarget(true)}
                  >
                    ✎
                  </button>
                )}
              </span>
              {target ? (
                <>
                  <b>
                    {formatNumber(target.value, info.decimals)} <small>{info.unit}</small>
                  </b>
                  <em>
                    esperado agora {formatNumber(target.plannedToNow, info.decimals)} · feito{' '}
                    {formatNumber(target.actual, info.decimals)}
                    {target.source === 'hmi' ? ' · meta da IHM' : ''}
                  </em>
                  {compareBoard?.target && compareLabel && (
                    <Against label={compareLabel}>
                      {formatNumber(compareBoard.target.value, info.decimals)}{' '}
                      <small>feito {formatNumber(compareBoard.target.actual, info.decimals)}</small>
                    </Against>
                  )}
                </>
              ) : (
                <>
                  <b className="muted">Sem meta</b>
                  <em>defina em Produção → Configurar equipamento</em>
                </>
              )}
            </div>
            <div className={`shift-kpi ${historical ? '' : 'clickable'}`} {...opens('projection')}>
              <span>Projeção de fechamento</span>
              <b>
                {formatNumber(
                  target ? target.projected : board.pacePerHour * (board.plannedSeconds / 3600),
                  info.decimals,
                )}{' '}
                <small>{info.unit}</small>
              </b>
              <em>
                {target
                  ? `${formatNumber((target.projected / target.value) * 100)}% da meta`
                  : 'no ritmo da última hora'}
              </em>
              {compareBoard && compareLabel && (
                <Against label={compareLabel}>
                  {formatNumber(
                    compareBoard.target
                      ? compareBoard.target.projected
                      : compareBoard.pacePerHour * (compareBoard.plannedSeconds / 3600),
                    info.decimals,
                  )}{' '}
                  <small>{info.unit}</small>
                </Against>
              )}
            </div>
            <div className={`shift-kpi ${historical ? '' : 'clickable'}`} {...opens('pace')}>
              <span>Ritmo</span>
              <b>
                {formatNumber(board.pacePerHour, info.decimals)} <small>{info.unit}/h</small>
              </b>
              <em>
                {target?.requiredPerHour != null && board.remainingSeconds > 0
                  ? `necessário ${formatNumber(target.requiredPerHour, info.decimals)} ${info.unit}/h`
                  : `restam ${duration(board.remainingSeconds)} produtivos`}
              </em>
              {compareBoard && compareLabel && (
                <Against label={compareLabel}>
                  {formatNumber(compareBoard.pacePerHour, info.decimals)}{' '}
                  <small>{info.unit}/h</small>
                </Against>
              )}
            </div>
            {board.palletTiming && board.palletTiming.count > 0 && (
              <div
                className={`shift-kpi ${historical ? '' : 'clickable'}`}
                {...opens('pallets')}
                title="Média: tempo produzindo dividido pelos paletes do período (paradas não entram). Último: tempo entre os dois últimos paletes. Clique para ver o ranking do turno."
              >
                <span>Tempo por palete</span>
                <b>
                  {minutesSeconds(board.palletTiming.averageSeconds)} <small>média</small>
                </b>
                <em>
                  último palete {minutesSeconds(board.palletTiming.lastSeconds)}
                  {board.palletTiming.lastAt ? ` · às ${clock(board.palletTiming.lastAt)}` : ''}
                </em>
                {compareBoard?.palletTiming && compareLabel && (
                  <Against label={compareLabel}>
                    {minutesSeconds(compareBoard.palletTiming.averageSeconds)} <small>média</small>
                  </Against>
                )}
              </div>
            )}
          </div>

          {calculated.length > 0 && (
            <div className="shift-calculated" aria-label="Cálculos do card">
              {calculated.map((field) => (
                <div key={field.label}>
                  <span>{field.label}</span>
                  <b>
                    {field.value}
                    {field.unit && <em>{field.unit}</em>}
                  </b>
                </div>
              ))}
            </div>
          )}

          {healthText && <div className={`shift-health ${tone}`}>{healthText}</div>}

          {mode === 'day' && (data.perShift?.length ?? 0) > 1 && (
            <div className="shift-split">
              {data.perShift?.map((item) => (
                <div key={item.shiftId}>
                  <span>
                    {item.name}
                    <small>
                      {item.start.slice(11, 16)}–{item.end.slice(11, 16)}
                    </small>
                  </span>
                  <b>
                    {/* "blocks" is counted in pieces, as everywhere else on the board. */}
                    {item.totals
                      ? formatNumber(
                          board.metric === 'blocks'
                            ? item.totals.pieces
                            : item.totals[board.metric],
                          info.decimals,
                        )
                      : '—'}
                    <em>{info.unit}</em>
                  </b>
                  <small>
                    {item.target?.value
                      ? `meta ${formatNumber(item.target.value, info.decimals)}`
                      : 'sem meta'}
                    {item.utilization != null && ` · ${formatNumber(item.utilization * 100)}% de aproveitamento`}
                  </small>
                </div>
              ))}
            </div>
          )}

          <div className="shift-body">
            <div className="shift-curve">
              <div className="shift-section-title">
                Curva S · {info.name} acumulados
                <span className="shift-legend">
                  <i className="planned" /> planejado{' '}
                  <i className="actual" />{' '}
                  <span title="A área abaixo do realizado tem a cor do estado da máquina em cada trecho, como a linha do tempo">
                    realizado (área = estado da máquina)
                  </span>{' '}
                  <i className="projected" /> projeção
                  {compare && (
                    <>
                      {' '}
                      <i className="compared" /> {compare.label}
                    </>
                  )}
                </span>
              </div>
              <div className="shift-chart">
                <ShiftCurve
                  board={board}
                  deviceId={minuteSeries ? undefined : deviceId}
                  minuteSeries={minuteSeries}
                  compare={compare}
                  view={view}
                  onView={onView}
                  syncId={syncId}
                />
              </div>
            </div>
            <Availability
              board={board}
              onEdit={historical ? undefined : () => setEditingUtilization(true)}
            />
          </div>

          <div className="shift-timeline" aria-label="Linha do tempo">
            {board.timeline.map((segment) => (
              <span
                key={segment.t}
                style={{ background: segmentPaint(segment) }}
                title={`${clock(segment.t)} · ${stateInfo[segment.state]?.label ?? segment.state}`}
              />
            ))}
          </div>
          <div className="shift-timeline-axis">
            <span>{clock(board.span.start)}</span>
            <span>{clock(board.span.end)}</span>
          </div>
          <div className="shift-timeline-legend">
            {[...new Set(board.timeline.map((segment) => segment.state))].map((state) => (
              <span key={state}>
                <i style={{ background: stateInfo[state]?.color }} />
                {stateInfo[state]?.label ?? state}
              </span>
            ))}
          </div>
          {board.products.length > 1 && (
            <div className="shift-products">
              {board.products.slice(0, 4).map((product) => (
                <span key={product.product_code}>
                  <b>{product.product_code}</b> {formatNumber(product.milheiros, 1)} mil
                </span>
              ))}
            </div>
          )}
          {data.missing.includes('auto') && (
            <small className="shift-note">
              Sem a variável de automático, parada manual aparece como ociosa. Configure em Produção
              → Configurar equipamento.
            </small>
          )}
        </>
      )}
      {detail && (
        <ModalPortal>
          <ShiftDetailModal
            deviceId={deviceId}
            mode={mode}
            focus={detail}
            calculated={calculatedSettings}
            onClose={() => setDetail(null)}
          />
        </ModalPortal>
      )}
      {editingUtilization && (
        <ModalPortal>
          <UtilizationModal
            deviceId={deviceId}
            formula={board?.utilizationFormula ?? null}
            time={board?.time ?? { producing: 0, idle: 0, manual: 0 }}
            onClose={(saved) => {
              setEditingUtilization(false);
              if (saved) onChanged?.();
            }}
          />
        </ModalPortal>
      )}
      {editingTarget && (
        <ModalPortal>
          <TargetModal
            deviceId={deviceId}
            onClose={(saved) => {
              setEditingTarget(false);
              if (saved) onChanged?.();
            }}
          />
        </ModalPortal>
      )}
    </div>
  );
}
