'use client';

import { useId, useMemo, useRef, useState } from 'react';
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
import { TargetModal } from './TargetModal';
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
}: {
  board: BoardData;
  fontSize?: number;
  /** With the device, a close zoom reads the counter minute by minute. */
  deviceId?: string;
}) {
  const reactId = useId();
  const info = metricInfo[board.metric];
  const chart = board.curve.map((point, index) => ({
    ...point,
    label: clock(point.t),
    state: board.timeline[index]?.state ?? 'unknown',
  }));
  const gradientId = `shift-state-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  // Window of points on screen; null is the whole shift.
  const [view, setView] = useState<{ start: number; end: number } | null>(null);
  const drag = useRef<{ x: number; start: number; end: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const span = view ?? { start: 0, end: Math.max(0, chart.length - 1) };
  const coarse = chart.slice(span.start, span.end + 1);
  const MIN_POINTS = 6;
  // Under about an hour on screen, each 5-minute step hides more than it shows.
  const wantsMinutes = Boolean(deviceId) && view != null && coarse.length > 1 && coarse.length <= 13;
  const windowFrom = coarse[0]?.t ?? null;
  const windowTo = coarse.at(-1)?.t ?? null;
  const minutes = usePoll<{ minutes: Array<{ t: string; value: number }> }>(
    wantsMinutes && windowFrom && windowTo
      ? `/devices/${deviceId}/shift-minutes?from=${encodeURIComponent(windowFrom)}&to=${encodeURIComponent(windowTo)}`
      : null,
    60000,
  );
  // The minute curve carries on from where the coarse curve was at the start of the window.
  const detailed = useMemo(() => {
    const rows = minutes.data?.minutes;
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
      };
    });
  }, [minutes.data, wantsMinutes, coarse]);
  const visible = detailed ?? coarse;

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
      onDragStart={(event) => event.preventDefault()}
      onPointerDownCapture={(event) => {
        if (!view || event.button !== 0) return;
        // The zoom buttons keep their click: only the chart area pans.
        if ((event.target as HTMLElement).closest('.chart-zoom')) return;
        event.preventDefault();
        drag.current = { x: event.clientX, start: view.start, end: view.end };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMoveCapture={(event) => {
        const box = frame.current?.getBoundingClientRect();
        if (!drag.current || !box) return;
        event.preventDefault();
        const width = drag.current.end - drag.current.start + 1;
        const moved = Math.round(((drag.current.x - event.clientX) / box.width) * width);
        const from = Math.max(0, Math.min(chart.length - width, drag.current.start + moved));
        setView({ start: from, end: from + width - 1 });
      }}
      onPointerUpCapture={(event) => {
        if (!drag.current) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
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
        <ComposedChart data={visible} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
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
          <Tooltip content={<CurveTooltip info={info} />} />
          <Area
            type="monotone"
            dataKey="actual"
            name="Realizado"
            stroke="var(--accent, #12b8a6)"
            fill={stateStops.length ? `url(#${gradientId})` : 'var(--accent, #12b8a6)'}
            fillOpacity={stateStops.length ? 0.45 : 0.14}
            strokeWidth={2.5}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="planned"
            name="Planejado"
            stroke="#8a9ca2"
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="projected"
            name="Projeção"
            stroke="var(--accent, #12b8a6)"
            strokeDasharray="5 5"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The realized value wears the colour of the machine state at that moment, as the area does. */
function CurveTooltip({
  info,
  active,
  payload,
  label,
}: {
  info: { unit: string; decimals: number };
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
  const response = usePoll<ShiftBoardResponse>(
    `/devices/${deviceId}/shift-board?mode=${mode}`,
    30000,
  );
  if (!response.data)
    return <div className="shift-board-empty">{response.error ?? 'Carregando produção…'}</div>;
  return (
    <ShiftBoardView
      data={response.data}
      deviceId={deviceId}
      mode={mode}
      onMode={setMode}
      calculated={calculated}
      calculatedSettings={calculatedSettings}
      onChanged={() => void response.refresh()}
    />
  );
}

/**
 * The board itself. The live card passes the Turno/Dia switch; the history detail shows a
 * closed shift or day with it, without the switch and without the machine's current state.
 */
export function ShiftBoardView({
  data,
  deviceId,
  mode = data.mode,
  onMode,
  onChanged,
  historical = false,
  hideHead = false,
  calculated = [],
  calculatedSettings = [],
}: {
  calculated?: CalculatedField[];
  calculatedSettings?: CalculatedSetting[];
  /** The TV draws its own header (shift, state, clock). */
  hideHead?: boolean;
  data: ShiftBoardResponse;
  deviceId: string;
  mode?: 'shift' | 'day';
  onMode?: (mode: 'shift' | 'day') => void;
  /** The target was edited: reload the board. */
  onChanged?: () => void;
  historical?: boolean;
}) {
  const [editingTarget, setEditingTarget] = useState(false);
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
  const elapsed = board?.time.elapsedProductive ?? 0;
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
        {!historical && (
          <span
            className="shift-state"
            style={{ '--state': stateInfo[data.state]?.color } as React.CSSProperties}
          >
            <i />
            {stateInfo[data.state]?.label ?? 'Sem dados'}
          </span>
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
                    {field.unit && <small>{field.unit}</small>}
                  </b>
                </div>
              ))}
            </div>
          )}

          {healthText && <div className={`shift-health ${tone}`}>{healthText}</div>}

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
                </span>
              </div>
              <div className="shift-chart">
                <ShiftCurve board={board} deviceId={deviceId} />
              </div>
            </div>
            <div className="shift-availability">
              <div className="shift-section-title">Aproveitamento da máquina</div>
              <Gauge value={board.utilization} />
              <small className="shift-gauge-caption">produzindo ÷ (produzindo + ociosa)</small>
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
        <ShiftDetailModal
          deviceId={deviceId}
          mode={mode}
          focus={detail}
          calculated={calculatedSettings}
          onClose={() => setDetail(null)}
        />
      )}
      {editingTarget && (
        <TargetModal
          deviceId={deviceId}
          onClose={(saved) => {
            setEditingTarget(false);
            if (saved) onChanged?.();
          }}
        />
      )}
    </div>
  );
}
