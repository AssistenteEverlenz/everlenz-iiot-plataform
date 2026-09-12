'use client';

import { useId, useState } from 'react';
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
interface BoardData {
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
  timeline: Array<{ t: string; state: string }>;
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

function Gauge({ value }: { value: number | null }) {
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

export function ShiftBoard({ deviceId }: { deviceId: string }) {
  const [mode, setMode] = useState<'shift' | 'day'>('shift');
  const response = usePoll<ShiftBoardResponse>(
    `/devices/${deviceId}/shift-board?mode=${mode}`,
    30000,
  );
  if (!response.data)
    return <div className="shift-board-empty">{response.error ?? 'Carregando produção…'}</div>;
  return <ShiftBoardView data={response.data} deviceId={deviceId} mode={mode} onMode={setMode} />;
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
  historical = false,
}: {
  data: ShiftBoardResponse;
  deviceId: string;
  mode?: 'shift' | 'day';
  onMode?: (mode: 'shift' | 'day') => void;
  historical?: boolean;
}) {
  // Unique gradient id per board: several boards can share one page.
  const reactId = useId();
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
  const chart = (board?.curve ?? []).map((point) => ({ ...point, label: clock(point.t) }));
  // The area under "realizado" is painted with the machine state of each 5-minute stretch:
  // the segment between curve points k and k+1 is timeline[k]. Hard stops over the area's own
  // width (first point to the last actual one), which is what objectBoundingBox measures.
  const gradientId = `shift-state-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const lastActual = chart.reduce((last, point, index) => (point.actual != null ? index : last), -1);
  const stateStops =
    board && lastActual > 0
      ? board.timeline.slice(0, lastActual).flatMap((segment, index) => {
          const color = stateInfo[segment.state]?.color ?? stateInfo.unknown.color;
          return [
            { offset: index / lastActual, color },
            { offset: (index + 1) / lastActual, color },
          ];
        })
      : [];
  const elapsed = board?.time.elapsedProductive ?? 0;
  const secondaries = board
    ? [
        board.totals.pieces ? `${formatNumber(board.totals.pieces)} peças` : null,
        board.totals.pallets ? `${formatNumber(board.totals.pallets)} paletes` : null,
        board.totals.tons ? `${formatNumber(board.totals.tons, 1)} t` : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="shift-board">
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
            <div className="shift-kpi hero">
              <span>Produzido</span>
              <b>
                {formatNumber(board.totals.milheiros, 1)} <small>milheiros</small>
              </b>
              <em>{secondaries.join(' · ') || 'nenhuma peça ainda'}</em>
            </div>
            <div className="shift-kpi">
              <span>Meta</span>
              {target ? (
                <>
                  <b>
                    {formatNumber(target.value, info.decimals)} <small>{info.unit}</small>
                  </b>
                  <em>
                    esperado agora {formatNumber(target.plannedToNow, info.decimals)} · feito{' '}
                    {formatNumber(target.actual, info.decimals)}
                  </em>
                </>
              ) : (
                <>
                  <b className="muted">Sem meta</b>
                  <em>defina em Produção → Configurar equipamento</em>
                </>
              )}
            </div>
            <div className="shift-kpi">
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
            <div className="shift-kpi">
              <span>Ritmo</span>
              <b>
                {formatNumber(board.pacePerHour, info.decimals)} <small>{info.unit}/h</small>
              </b>
              <em>
                {target?.requiredPerHour != null && board.remainingSeconds > 0
                  ? `necessário ${formatNumber(target.requiredPerHour, info.decimals)} ${info.unit}/h`
                  : `restam ${duration(board.remainingSeconds)} produtivos`}
              </em>
              {board.palletTiming && board.palletTiming.count > 0 && (
                <em
                  className="shift-pallet-timing"
                  title="Último palete: tempo entre os dois últimos paletes. Média: tempo produzindo dividido pelos paletes do período."
                >
                  último palete <b>{minutesSeconds(board.palletTiming.lastSeconds)}</b> · média{' '}
                  <b>{minutesSeconds(board.palletTiming.averageSeconds)}</b>
                </em>
              )}
            </div>
          </div>

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
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chart} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    {stateStops.length > 0 && (
                      <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                          {stateStops.map((stop, index) => (
                            <stop key={index} offset={stop.offset} stopColor={stop.color} />
                          ))}
                        </linearGradient>
                      </defs>
                    )}
                    <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: '#71868d' }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={28}
                    />
                    <YAxis
                      width={44}
                      tick={{ fontSize: 10, fill: '#71868d' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: number) =>
                        formatNumber(value, info.decimals && value < 10 ? 1 : 0)
                      }
                    />
                    <Tooltip
                      formatter={(value) =>
                        value == null
                          ? '—'
                          : `${formatNumber(Number(value), info.decimals)} ${info.unit}`
                      }
                      labelFormatter={(label) => `às ${label}`}
                    />
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
                style={{ background: stateInfo[segment.state]?.color }}
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
    </div>
  );
}
