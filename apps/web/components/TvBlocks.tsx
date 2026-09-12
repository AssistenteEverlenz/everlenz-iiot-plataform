'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { usePoll, type Dashboard, type DashboardWidget, type Device, type Sample } from './data';
import { QuickChart } from './QuickChart';
import { ProductionInsight, type ProductionPeriod, type Statistic } from './DashboardCanvas';
import type { TvScreen } from './tvConfig';
import {
  clock,
  duration,
  formatNumber,
  Gauge,
  metricInfo,
  minutesSeconds,
  ShiftBoardView,
  ShiftCurve,
  stateInfo,
  type ProductionMetric,
  type ShiftBoardResponse,
} from './ShiftBoard';

// The pieces of the TV: the data every block reads (loaded once per TV), the TV blocks
// (shift numbers, S-curve, today's product mix, week targets, machine state, stop alert), the
// dashboard cards at wall size and the 12-column grid a screen is laid out on.

interface ReportRow {
  kind: 'shift' | 'off_shift';
  open?: boolean;
  source?: 'auto' | 'manual';
  production_date: string;
  pieces: number;
  pallets: number;
  tons: number;
  producing_s?: number;
  idle_s?: number;
  target_metric: ProductionMetric | null;
  target_value: number | null;
  products?: Array<{ product_code: string; pieces: number; pallets: number; tons: number }>;
}

export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const PALETTE = ['#12b8a6', '#3b82f6', '#f2a93b', '#e4572e', '#a78bfa', '#2bb3e6', '#8aa29e', '#d65db1'];

function plantToday() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
export function weekdayOf(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}
function amountOf(row: { pieces: number; pallets: number; tons: number }, metric: ProductionMetric) {
  if (metric === 'milheiros') return Number(row.pieces) / 1000;
  if (metric === 'tons') return Number(row.tons);
  if (metric === 'blocks') return Number(row.pieces);
  return Number(row.pallets);
}
function share(part: number, total: number) {
  return total > 0 ? `${formatNumber((part / total) * 100, 1)}%` : '—';
}
/** "35 min", "4h03", "2d 5h": how long the machine has been in its state. */
export function sinceText(minutes: number) {
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  return duration(minutes * 60);
}
function isOn(sample: Sample | undefined) {
  if (!sample) return false;
  if (sample.value_boolean != null) return sample.value_boolean;
  if (sample.value_number != null) return sample.value_number !== 0;
  return /^(1|true|on|sim|ligado)$/i.test(sample.value_text?.trim() ?? '');
}

/** Everything the TV shows, loaded once and shared by every block. */
export function useTvData(id: string) {
  const dashboard = usePoll<Dashboard>(`/dashboards/${id}`, 300000);
  const deviceId = dashboard.data?.device_id ?? null;
  const device = usePoll<Device>(deviceId ? `/devices/${deviceId}` : null, 300000);
  const board = usePoll<ShiftBoardResponse>(
    deviceId ? `/devices/${deviceId}/shift-board?mode=shift` : null,
    20000,
  );
  const latest = usePoll<Sample[]>(deviceId ? `/devices/${deviceId}/latest` : null, 5000);
  const saved = usePoll<{ screens: TvScreen[] }>(`/dashboards/${id}/tv`, 300000);
  const today = plantToday();
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  const reports = usePoll<{ reports: ReportRow[] }>(
    deviceId ? `/devices/${deviceId}/shift-reports?from=${monday}&to=${today}` : null,
    60000,
  );
  const current = board.data?.board ?? null;
  const metric: ProductionMetric = current?.metric ?? 'pallets';
  const state = board.data?.state ?? 'unknown';
  // How long the machine has been in its current state, as the API measured it from what was
  // recorded (the shift timeline stops at the shift end, which froze the count). None while
  // producing.
  const stateSince = board.data?.stateSince ?? null;
  const stateMinutes = useMemo(
    () =>
      stateSince ? Math.max(0, Math.round((Date.now() - new Date(stateSince).getTime()) / 60000)) : 0,
    // Recomputed with every board refresh (20 s).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stateSince, board.data],
  );

  const week = useMemo(() => {
    const byDate = new Map<
      string,
      {
        target: number;
        achieved: number;
        metric: ProductionMetric | null;
        open: boolean;
        producing: number;
        idle: number;
      }
    >();
    for (const row of reports.data?.reports ?? []) {
      if (row.kind !== 'shift' || row.source === 'manual') continue;
      const day = byDate.get(row.production_date) ?? {
        target: 0,
        achieved: 0,
        metric: null,
        open: false,
        producing: 0,
        idle: 0,
      };
      if (row.target_value && row.target_metric) {
        day.target += Number(row.target_value);
        day.achieved += amountOf(row, row.target_metric);
        day.metric = row.target_metric;
      }
      day.producing += Number(row.producing_s ?? 0);
      day.idle += Number(row.idle_s ?? 0);
      day.open = day.open || Boolean(row.open);
      byDate.set(row.production_date, day);
    }
    return Array.from({ length: 7 }, (_, index) => {
      const date = addDays(monday, index);
      const day = byDate.get(date);
      const ratio = day && day.target > 0 ? day.achieved / day.target : null;
      const availability =
        day && day.producing + day.idle > 0 ? day.producing / (day.producing + day.idle) : null;
      const future = date > today;
      const status = future || !day
        ? 'none'
        : ratio == null
          ? 'no-target'
          : ratio >= 1
            ? 'met'
            : day.open
              ? 'running'
              : ratio >= 0.9
                ? 'near'
                : 'missed';
      return { date, day, ratio, availability, status, future, isToday: date === today };
    });
  }, [reports.data, monday, today]);

  const dayMix = useMemo(() => {
    const totals = new Map<string, { pallets: number; tons: number; pieces: number }>();
    for (const row of reports.data?.reports ?? []) {
      if (row.production_date !== today || row.source === 'manual') continue;
      for (const product of row.products ?? []) {
        const total = totals.get(product.product_code) ?? { pallets: 0, tons: 0, pieces: 0 };
        total.pallets += Number(product.pallets);
        total.tons += Number(product.tons);
        total.pieces += Number(product.pieces);
        totals.set(product.product_code, total);
      }
    }
    const list = [...totals]
      .map(([code, total]) => ({ code, ...total }))
      .filter((row) => row.pallets > 0 || row.tons > 0 || row.pieces > 0);
    const pallets = list.reduce((sum, row) => sum + row.pallets, 0);
    const tons = list.reduce((sum, row) => sum + row.tons, 0);
    const pieces = list.reduce((sum, row) => sum + row.pieces, 0);
    const byPallets = pallets > 0;
    list.sort((a, b) => (byPallets ? b.pallets - a.pallets : b.pieces - a.pieces));
    return { list, pallets, tons, pieces, byPallets };
  }, [reports.data, today]);

  return {
    dashboard,
    deviceId,
    device,
    board,
    latest,
    saved,
    reports,
    current,
    metric,
    info: metricInfo[metric],
    state,
    stateMinutes,
    target: current?.target ?? null,
    week,
    dayMix,
  };
}
export type TvData = ReturnType<typeof useTvData>;

function TvKpis({ data }: { data: TvData }) {
  const { current, target, info } = data;
  const number = (value: number) => formatNumber(value, info.decimals);
  const pace = current?.palletTiming;
  const pct = target && target.value > 0 ? target.actual / target.value : null;
  const tone =
    target?.health === 'achieved' || target?.health === 'on_track'
      ? 'good'
      : target?.health === 'at_risk'
        ? 'warn'
        : target?.health
          ? 'bad'
          : '';
  return (
    <section className="tv3-kpis">
      <div className="tv3-kpi">
        <span>Produzido</span>
        <b>
          {formatNumber(current?.totals.milheiros ?? 0, 1)} <small>milheiros</small>
        </b>
        <em>
          {formatNumber(current?.totals.pieces ?? 0)} peças · {formatNumber(current?.totals.pallets ?? 0)}{' '}
          paletes · {formatNumber(current?.totals.tons ?? 0, 1)} t
        </em>
      </div>
      <div className={`tv3-kpi ${tone}`}>
        <span>Meta</span>
        {target ? (
          <>
            <b>
              {pct == null ? '—' : `${formatNumber(pct * 100)}%`}{' '}
              <small>
                {number(target.actual)} de {number(target.value)} {info.unit}
              </small>
            </b>
            <em>esperado agora {number(target.plannedToNow)}</em>
          </>
        ) : (
          <>
            <b className="muted">Sem meta</b>
            <em>defina no quadro de produção</em>
          </>
        )}
      </div>
      <div className="tv3-kpi">
        <span>Projeção</span>
        <b>
          {number(target ? target.projected : (current?.pacePerHour ?? 0) * ((current?.plannedSeconds ?? 0) / 3600))}{' '}
          <small>{info.unit}</small>
        </b>
        <em>
          {target ? `${formatNumber((target.projected / target.value) * 100)}% da meta` : 'no ritmo da última hora'}
        </em>
      </div>
      <div className="tv3-kpi">
        <span>Ritmo</span>
        <b>
          {number(current?.pacePerHour ?? 0)} <small>{info.unit}/h</small>
        </b>
        <em>
          {target?.requiredPerHour != null && (current?.remainingSeconds ?? 0) > 0
            ? `necessário ${number(target.requiredPerHour)} ${info.unit}/h`
            : `aproveitamento ${current?.utilization == null ? '—' : `${formatNumber(current.utilization * 100)}%`}`}
        </em>
      </div>
      <div className="tv3-kpi">
        <span>Tempo por palete</span>
        <b>
          {minutesSeconds(pace?.averageSeconds)} <small>média</small>
        </b>
        <em>
          último {minutesSeconds(pace?.lastSeconds)}
          {pace?.lastAt ? ` · às ${clock(pace.lastAt)}` : ''}
        </em>
      </div>
    </section>
  );
}

function TvCurve({ data }: { data: TvData }) {
  const { current, info, board } = data;
  if (!current)
    return (
      <section className="tv3-card tv3-empty-shift">
        <strong>Sem turno em andamento</strong>
        <span>
          {board.data?.next
            ? `Próximo turno às ${clock(board.data.next.start)}`
            : 'Cadastre os turnos da fábrica na tela Produção.'}
        </span>
      </section>
    );
  return (
    <section className="tv3-card tv3-curve">
      <div className="tv3-card-title">
        <strong>Curva S · {info.name} acumulados</strong>
        <span className="tv3-curve-legend">
          <i className="planned" /> planejado <i className="actual" /> realizado{' '}
          <i className="projected" /> projeção
        </span>
      </div>
      {/* The colours under "realizado" are the machine states, each with its time and share of
          the shift's productive time (the pause, outside it, shows its time only). */}
      <div className="tv3-legend tv3-curve-states">
        {[...new Set(current.timeline.map((segment) => segment.state))].map((item) => {
          const seconds = (current.time as unknown as Record<string, number | undefined>)[item];
          const elapsed = current.time.elapsedProductive;
          return (
            <span key={item}>
              <i style={{ background: stateInfo[item]?.color }} />
              {stateInfo[item]?.label ?? item}
              {seconds != null && (
                <b>
                  {duration(seconds)}
                  {item !== 'pause' && elapsed > 0 ? ` · ${formatNumber((seconds / elapsed) * 100)}%` : ''}
                </b>
              )}
            </span>
          );
        })}
      </div>
      <div className="tv3-chart">
        <ShiftCurve board={current} fontSize={13} />
      </div>
    </section>
  );
}

function TvDayMix({ data }: { data: TvData }) {
  const { dayMix } = data;
  return (
    <section className="tv3-card tv3-daymix">
      <div className="tv3-card-title">
        <strong>Produção por produto · hoje</strong>
        <span>
          {formatNumber(dayMix.byPallets ? dayMix.pallets : dayMix.pieces)}{' '}
          {dayMix.byPallets ? 'paletes' : 'peças'} · {formatNumber(dayMix.tons, 1)} t
        </span>
      </div>
      {dayMix.list.length ? (
        <div className="tv3-daymix-body">
          <div className="tv3-donut">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={dayMix.list}
                  dataKey={dayMix.byPallets ? 'pallets' : 'pieces'}
                  nameKey="code"
                  innerRadius="58%"
                  outerRadius="96%"
                  stroke="none"
                  isAnimationActive={false}
                >
                  {dayMix.list.map((row, index) => (
                    <Cell key={row.code} fill={PALETTE[index % PALETTE.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="tv3-mixlist">
            {dayMix.list.slice(0, 5).map((row, index) => (
              <li key={row.code}>
                <span className="tv3-mixlist-name">
                  <i style={{ background: PALETTE[index % PALETTE.length] }} />
                  {row.code}
                </span>
                <span className="tv3-mixlist-values">
                  <b>{formatNumber(dayMix.byPallets ? row.pallets : row.pieces)} un</b>
                  <small>
                    {share(
                      dayMix.byPallets ? row.pallets : row.pieces,
                      dayMix.byPallets ? dayMix.pallets : dayMix.pieces,
                    )}
                  </small>
                  <span className="tv3-mixlist-sep">|</span>
                  <b>{formatNumber(row.tons, 1)} t</b>
                  <small>{share(row.tons, dayMix.tons)}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="tv3-empty">Sem produção hoje.</p>
      )}
    </section>
  );
}

function TvWeek({ data }: { data: TvData }) {
  return (
    <section className="tv3-card tv3-week">
      <div className="tv3-card-title">
        <strong>Meta da semana</strong>
        <span>% da meta · produzido de previsto · aproveitamento da máquina</span>
      </div>
      <div className="tv3-week-days">
        {data.week.map((item) => {
          const unit = item.day?.metric ? metricInfo[item.day.metric] : null;
          return (
            <div key={item.date} className={`tv3-day ${item.isToday ? 'today' : ''}`} data-goal={item.status}>
              <div className="tv3-day-head">
                <span>
                  {WEEKDAYS[weekdayOf(item.date)]} {item.date.slice(8)}/{item.date.slice(5, 7)}
                </span>
                {item.isToday && <em>hoje</em>}
              </div>
              <div className="tv3-day-body">
                <div className="tv3-day-goal">
                  <b>{item.ratio == null ? '—' : `${formatNumber(item.ratio * 100)}%`}</b>
                  <small>
                    {item.day && item.ratio != null && unit
                      ? `${formatNumber(item.day.achieved, unit.decimals)} de ${formatNumber(item.day.target, unit.decimals)} ${unit.unit}`
                      : item.future
                        ? ''
                        : item.day
                          ? 'sem meta'
                          : 'sem turno'}
                  </small>
                </div>
                {item.availability != null && (
                  <div className="tv3-day-util" title="Aproveitamento: produzindo ÷ (produzindo + ociosa)">
                    <Gauge value={item.availability} />
                    <small>aproveitamento</small>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TvState({ data }: { data: TvData }) {
  const info = stateInfo[data.state];
  return (
    <section
      className="tv3-card tv3-statecard"
      style={{ '--state': info?.color ?? '#98a6ab' } as React.CSSProperties}
    >
      <span className="tv3-statecard-label">
        <i />
        {info?.label ?? 'Sem dados'}
      </span>
      <b>{data.stateMinutes >= 1 ? `há ${sinceText(data.stateMinutes)}` : ''}</b>
      <small>{data.board.data?.product ? `produto ${data.board.data.product}` : ''}</small>
    </section>
  );
}

function TvAlert({ data }: { data: TvData }) {
  const stopped =
    data.board.data?.status === 'running' &&
    ['manual', 'idle', 'offline'].includes(data.state) &&
    data.stateMinutes >= 10;
  return stopped ? (
    <div className="tv3-alert bad">
      Máquina {stateInfo[data.state]?.label.toLowerCase() ?? 'parada'} há {sinceText(data.stateMinutes)}
    </div>
  ) : (
    <div className="tv3-alert good">Sem paradas longas no turno</div>
  );
}

/** A gauge card of the dashboard (PeçasHora, ToneladaHora…) at wall size. */
export function TvGauge({ widget, sample }: { widget: DashboardWidget; sample?: Sample }) {
  const min = widget.config.min ?? 0;
  const max = widget.config.max ?? 100;
  const decimals = widget.config.decimals ?? 1;
  const value = sample?.value_number ?? null;
  const ratio =
    value == null || max <= min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angle = Math.PI * (1 - ratio);
  const x = 60 + 48 * Math.cos(angle);
  const y = 60 - 48 * Math.sin(angle);
  return (
    <div className="tv3-kpi tv3-gauge">
      <span>{widget.title}</span>
      <svg viewBox="0 0 120 74" role="img" aria-label={widget.title}>
        <path d="M12 60 A48 48 0 0 1 108 60" className="tv3-gauge-track" />
        {ratio > 0 && (
          <path d={`M12 60 A48 48 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`} className="tv3-gauge-value" />
        )}
        <text x="60" y="55" textAnchor="middle" className="tv3-gauge-number">
          {value == null ? '—' : formatNumber(value, decimals)}
        </text>
        <text x="12" y="72" textAnchor="middle" className="tv3-gauge-limit">
          {formatNumber(min, decimals)}
        </text>
        <text x="108" y="72" textAnchor="middle" className="tv3-gauge-limit">
          {formatNumber(max, decimals)}
        </text>
      </svg>
    </div>
  );
}

function TvLine({ widget, deviceId, minutes }: { widget: DashboardWidget; deviceId: string | null; minutes: number }) {
  const from = new Date(Math.floor(Date.now() / 60000) * 60000 - minutes * 60000).toISOString();
  const history = usePoll<Sample[]>(
    deviceId
      ? `/telemetry?deviceId=${deviceId}&from=${encodeURIComponent(from)}&bucket=minute&limit=5000`
      : null,
    30000,
  );
  const points = (history.data ?? [])
    .filter((sample) => sample.tag_id === widget.tag_id && sample.value_number != null && sample.timestamp)
    .map((sample) => ({ t: clock(sample.timestamp as string), v: sample.value_number }));
  return (
    <section className="tv3-card tv3-line">
      <div className="tv3-card-title">
        <strong>{widget.title}</strong>
        <span>{widget.config.unitLabel?.trim() || widget.unit || ''}</span>
      </div>
      <div className="tv3-chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#8a9ca2" strokeOpacity={0.2} strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="t" tick={{ fontSize: 12, fill: '#71868d' }} tickLine={false} axisLine={false} minTickGap={36} />
            <YAxis width={48} tick={{ fontSize: 12, fill: '#71868d' }} tickLine={false} axisLine={false} />
            <Area dataKey="v" stroke="#12b8a6" fill="#12b8a6" fillOpacity={0.18} strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

const PERIOD_TEXT: Record<string, string> = {
  today: 'hoje',
  '7d': 'últimos 7 dias',
  week: 'esta semana',
  month: 'este mês',
  year: 'este ano',
  '30d': 'últimos 30 dias',
};

const PERIOD_CHIP: Record<string, string> = {
  today: 'Hoje',
  '7d': '7 dias',
  week: 'Semana',
  month: 'Mês',
  year: 'Ano',
  '30d': '30 dias',
};
// Width of one dashboard column, in pixels, on a wide screen: a TV card of N columns is laid
// out as the dashboard lays out a card of N columns, then zoomed to its place on the TV.
const PANEL_COLUMN_PX = 130;

/**
 * Draws a dashboard card inside the dashboard's own card frame, at the width that card would
 * have on the dashboard for the same columns, and zooms the whole of it to fill its TV cell:
 * the TV shows the card exactly as the dashboard does, only bigger or smaller.
 */
function PanelScale({
  columns,
  color,
  children,
}: {
  columns: number;
  color: string;
  children: React.ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = outer.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const designWidth = Math.max(360, columns * PANEL_COLUMN_PX);
  const scale = box.width > 0 ? box.width / designWidth : 1;
  return (
    <div ref={outer} className="tv-panel-scale">
      {box.width > 0 && (
        <article
          className="dashboard-widget sized tv-panel-card"
          style={
            {
              width: designWidth,
              height: box.height / scale,
              transform: `scale(${scale})`,
              '--accent': color,
            } as React.CSSProperties
          }
        >
          {children}
        </article>
      )}
    </div>
  );
}

/** A production, donut or bar card of the dashboard, drawn as the dashboard draws it. */
function TvPanelCard({
  dashboardId,
  widget,
  columns,
}: {
  dashboardId: string;
  widget: DashboardWidget;
  columns: number;
}) {
  const configured = widget.config.productionDefaultPeriod;
  const period: ProductionPeriod = configured && configured !== 'custom' ? configured : '7d';
  const statistics = usePoll<Statistic[]>(
    `/dashboards/${dashboardId}/statistics?widgetId=${widget.id}&period=${period}`,
    60000,
  );
  // The period in use, shown as the dashboard shows its selected chip (no choosing on a TV).
  const chip = (
    <div className="widget-period" role="group" aria-label="Período do gráfico">
      <button type="button" className="active" tabIndex={-1}>
        {PERIOD_CHIP[period] ?? '7 dias'}
      </button>
    </div>
  );
  const text = PERIOD_TEXT[period] ?? 'últimos 7 dias';
  return (
    <PanelScale columns={columns} color={widget.config.color ?? '#12b8a6'}>
      <div className="widget-head">
        <span />
        <div>
          <span className="widget-kicker">{widget.widget_type.toUpperCase()}</span>
          <h2>{widget.title}</h2>
        </div>
        <span />
      </div>
      {!statistics.data ? (
        <div className="tv3-loading">
          {statistics.error ?? <span className="detail-spinner" aria-label="Carregando" />}
        </div>
      ) : widget.widget_type === 'production' ? (
        <ProductionInsight
          widget={widget}
          statistics={statistics.data[0]}
          period={period}
          periodChips={chip}
        />
      ) : (
        <QuickChart widget={widget} statistics={statistics.data[0]} periodChips={chip} periodText={text} />
      )}
    </PanelScale>
  );
}

/** A dashboard card on the TV, drawn at wall size with the dashboard's own configuration. */
function TvWidgetCard({
  widget,
  data,
  dashboardId,
  columns,
}: {
  widget: DashboardWidget;
  data: TvData;
  dashboardId: string;
  /** Columns the card takes on the TV grid: the dashboard width it is laid out at. */
  columns: number;
}) {
  const sample = widget.tag_id ? data.latest.data?.find((item) => item.tag_id === widget.tag_id) : undefined;
  const unit = widget.config.unitLabel?.trim() || widget.unit || '';
  switch (widget.widget_type) {
    case 'gauge':
      return <TvGauge widget={widget} sample={sample} />;
    case 'value': {
      const text =
        sample?.value_number != null
          ? formatNumber(sample.value_number, widget.config.decimals ?? 1)
          : sample?.value_boolean != null
            ? sample.value_boolean
              ? 'Ligado'
              : 'Desligado'
            : (sample?.value_text ?? '—');
      return (
        <section className="tv3-card tv3-value">
          <div className="tv3-card-title">
            <strong>{widget.title}</strong>
          </div>
          <div className="tv3-value-body">
            <b>{text}</b>
            {unit && <small>{unit}</small>}
          </div>
        </section>
      );
    }
    case 'status': {
      const on = isOn(sample);
      return (
        <section className={`tv3-card tv3-status ${on ? 'on' : ''}`}>
          <div className="tv3-card-title">
            <strong>{widget.title}</strong>
          </div>
          <div className="tv3-status-body">
            <i />
            <b>{on ? 'Em operação' : 'Parada'}</b>
          </div>
        </section>
      );
    }
    case 'donut':
    case 'bar_vertical':
    case 'bar_horizontal':
    case 'production':
      return <TvPanelCard dashboardId={dashboardId} widget={widget} columns={columns} />;
    case 'line':
      return <TvLine widget={widget} deviceId={data.deviceId} minutes={data.dashboard.data?.time_window_minutes ?? 60} />;
    case 'shift_board':
      return data.board.data && data.deviceId ? (
        <section className="tv3-card tv3-embedded-board">
          <ShiftBoardView data={data.board.data} deviceId={data.deviceId} hideHead />
        </section>
      ) : null;
    default:
      return (
        <section className="tv3-card tv3-empty-shift">
          <strong>{widget.title}</strong>
          <span>Este tipo de card ainda não tem visualização na TV.</span>
        </section>
      );
  }
}

/** One TV screen: its cards placed on a 12-column grid that fills the screen. */
export function TvGrid({ screen, data, dashboardId }: { screen: TvScreen; data: TvData; dashboardId: string }) {
  const widgets = new Map((data.dashboard.data?.widgets ?? []).map((widget) => [widget.id, widget]));
  return (
    <div className="tv-grid" style={{ gridTemplateRows: `repeat(${screen.rows}, minmax(0, 1fr))` }}>
      {screen.cards.map((card, index) => {
        const widget = card.widget_id ? widgets.get(card.widget_id) : undefined;
        return (
          <div
            key={index}
            className="tv-cell"
            data-card={index}
            style={{ gridColumn: `${card.x} / span ${card.w}`, gridRow: `${card.y} / span ${card.h}` }}
          >
            {card.kind === 'tv_kpis' ? (
              <TvKpis data={data} />
            ) : card.kind === 'tv_curve' ? (
              <TvCurve data={data} />
            ) : card.kind === 'tv_daymix' ? (
              <TvDayMix data={data} />
            ) : card.kind === 'tv_week' ? (
              <TvWeek data={data} />
            ) : card.kind === 'tv_state' ? (
              <TvState data={data} />
            ) : card.kind === 'tv_alert' ? (
              <TvAlert data={data} />
            ) : widget ? (
              <TvWidgetCard widget={widget} data={data} dashboardId={dashboardId} columns={card.w} />
            ) : (
              <section className="tv3-card tv3-empty-shift">
                <span>Card removido do painel</span>
              </section>
            )}
          </div>
        );
      })}
    </div>
  );
}
