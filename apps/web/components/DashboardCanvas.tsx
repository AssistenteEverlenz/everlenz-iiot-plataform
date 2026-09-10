'use client';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BrandSpinner, usePlatform } from './PlatformShell';
import { ActionModal } from './ActionModal';
import {
  mutate,
  time,
  usePoll,
  type Dashboard,
  type DashboardWidget,
  type Device,
  type Sample,
  type Signal,
} from './data';

import { ScrollHint } from './ScrollHint';

type ProductionPeriod = NonNullable<DashboardWidget['config']['productionDefaultPeriod']>;

const periodOptions: Array<[ProductionPeriod, string]> = [
  ['today', 'Hoje'],
  ['7d', '7 dias'],
  ['week', 'Semana'],
  ['month', 'Mês'],
  ['year', 'Ano'],
  ['custom', 'Personalizado'],
];

// Types that read the production statistics: the full production card and the quick
// analytic charts, which are lighter views of the same metric and filters.
const analyticTypes = new Set<DashboardWidget['widget_type']>([
  'production',
  'donut',
  'bar_vertical',
  'bar_horizontal',
]);
const productPalette = [
  '#12b8a6',
  '#2f6fed',
  '#f2a93b',
  '#e4572e',
  '#7b5ea7',
  '#2bb3e6',
  '#8aa29e',
  '#d65db1',
];

interface CounterValue {
  widget_id: string;
  since_reset: number;
  reset_at: string;
}

interface Statistic {
  widget_id: string;
  tag_id: string;
  period_minutes: number;
  minimum_value: number;
  samples: number;
  ignored_samples: number;
  minimum: number | null;
  maximum: number | null;
  average: number | null;
  trend_per_second: number | null;
  metric_kind: 'rate_average' | 'counter_delta';
  trend_days: number;
  current_period_value: number | null;
  previous_period_value: number | null;
  change_percent: number | null;
  best_day: string | null;
  best_value: number | null;
  daily_series: Array<{ date: string; value: number | null; samples: number }>;
  bucket_granularity: 'day' | 'month';
  /** Products a master hid on this device; left out of every number above. */
  hidden_products: string[];
  product_breakdown: Array<{
    product_code: string;
    value: number;
    samples: number;
    share_percent: number;
  }>;
}

interface ProductionContext {
  product_key: string | null;
  fallback_product_code: string;
}

type AlarmRange = NonNullable<DashboardWidget['config']['alarmRanges']>[number];

function legacyAlarmRanges(widget: DashboardWidget, min: number, max: number): AlarmRange[] {
  const low = Math.max(min, Math.min(max, widget.config.warningLow ?? min + (max - min) * 0.6));
  const high = Math.max(low, Math.min(max, widget.config.warningHigh ?? min + (max - min) * 0.85));
  return [
    { id: 'normal', label: 'Normal', start: min, end: low, color: '#19a66f', priority: 0 },
    { id: 'attention', label: 'Atenção', start: low, end: high, color: '#e3a51f', priority: 1 },
    { id: 'critical', label: 'Crítico', start: high, end: max, color: '#dc3f45', priority: 2 },
  ].filter((range) => range.end > range.start);
}

function visibleGaugeZones(ranges: AlarmRange[], min: number, max: number) {
  const boundaries = Array.from(
    new Set([
      min,
      max,
      ...ranges.flatMap((range) => [
        Math.max(min, Math.min(max, range.start)),
        Math.max(min, Math.min(max, range.end)),
      ]),
    ]),
  ).sort((a, b) => a - b);
  return boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1];
    if (end <= start) return [];
    const middle = (start + end) / 2;
    const winner = [...ranges]
      .sort((a, b) => b.priority - a.priority)
      .find((range) => middle >= range.start && middle < range.end);
    if (!winner) return [];
    return [{ ...winner, start, end }];
  });
}

function number(value: number | null | undefined, decimals = 1) {
  return value == null
    ? '—'
    : value.toLocaleString('pt-BR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
}

function periodLabel(period: ProductionPeriod, days: number) {
  return {
    today: 'hoje',
    '7d': 'últimos 7 dias',
    week: 'esta semana',
    month: 'este mês',
    year: 'este ano',
    '30d': 'últimos 30 dias',
    custom: `${days} dias selecionados`,
  }[period];
}

function shiftDay(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

const visualizationHelp: Record<DashboardWidget['widget_type'], string> = {
  value: 'Mostra a leitura atual de uma variável numérica, booleana ou de texto.',
  line: 'Usa uma variável numérica e desenha sua evolução dentro da janela do painel.',
  gauge: 'Usa uma variável numérica com escala mínima, máxima e faixas coloridas.',
  status: 'Usa uma variável booleana: verdadeiro representa operação e falso representa parada.',
  production:
    'Usa uma taxa numérica, como ton/h. Calcula média, mínimo e pico no período configurado.',
  oee: 'O OEE não usa uma única variável. Precisa de tempo planejado, tempo operando, produção total, produção boa e ciclo ideal.',
  pareto: 'Precisa de eventos de parada com motivo e duração para ordenar as maiores perdas.',
  donut: 'Pizza com a participação (%) de cada produto no período. Use um contador, como paletes.',
  bar_vertical: 'Barras verticais da produção no período, uma por produto ou uma por dia.',
  bar_horizontal: 'Barras horizontais ordenadas, ideais para ranking de produtos com nomes longos.',
};

function EyeOff() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.2 6.2C4.3 7.6 2.8 9.6 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.5 4.8-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SixDots() {
  return (
    <span className="six-dots">
      {Array.from({ length: 6 }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  );
}

function Widget({
  widget,
  latest,
  history,
  dashboardId,
  counter,
  edit,
  remove,
  reset,
  dragStart,
  drop,
}: {
  widget: DashboardWidget;
  latest?: Sample;
  history: Sample[];
  dashboardId: string;
  counter?: CounterValue;
  edit: () => void;
  remove: () => void;
  reset: () => void;
  dragStart: () => void;
  drop: () => void;
}) {
  const color = widget.config.color ?? '#12b8a6';
  // Each production chart owns its period, so two charts can compare different windows.
  const [period, setPeriod] = useState<ProductionPeriod>(
    widget.config.productionDefaultPeriod ?? '7d',
  );
  const localToday = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  const [customFrom, setCustomFrom] = useState(() => shiftDay(localToday, -6));
  const [customTo, setCustomTo] = useState(localToday);
  // The config fingerprint in the path refetches at once after the widget is edited.
  const fingerprint = encodeURIComponent(
    `${widget.config.productionMetricKind ?? ''}:${widget.config.productionMinimumValue ?? ''}`,
  );
  const customRange = period === 'custom' ? `&from=${customFrom}&to=${customTo}` : '';
  const productionPath =
    analyticTypes.has(widget.widget_type) &&
    widget.tag_id &&
    (period !== 'custom' || (customFrom && customTo))
      ? `/dashboards/${dashboardId}/statistics?widgetId=${widget.id}&period=${period}${customRange}&v=${fingerprint}`
      : null;
  const productionStats = usePoll<Statistic[]>(productionPath, 30000);
  const statistics = productionStats.data?.[0];
  const { user } = usePlatform();
  const hiddenProducts = statistics?.hidden_products ?? [];
  const [hidingProduct, setHidingProduct] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  async function toggleProduct(productCode: string, hidden: boolean) {
    await mutate(`/devices/${widget.device_id}/hidden-products`, 'POST', { productCode, hidden });
    await productionStats.refresh();
  }
  const rawNumeric = latest?.value_number ?? null;
  // A zeroed counter shows what the server summed since the reset moment, which survives the
  // HMI rolling its own counter back to zero. Before the first reset it shows the raw value.
  const numeric =
    widget.config.counterMode && widget.config.counterResetAt
      ? (counter?.since_reset ?? null)
      : rawNumeric;
  const points = history
    .filter((sample) => sample.tag_id === widget.tag_id && sample.value_number != null)
    .reverse()
    .map((sample) => ({
      timestamp: new Date(sample.timestamp!).getTime(),
      value: sample.value_number,
    }));
  const min = widget.config.min ?? 0;
  const max = widget.config.max ?? 100;
  const progress =
    numeric == null ? 0 : Math.max(0, Math.min(100, ((numeric - min) / (max - min || 1)) * 100));
  const needleAngle = Math.PI - (progress / 100) * Math.PI;
  const needleTip = {
    x: 110 + Math.cos(needleAngle) * 68,
    y: 108 - Math.sin(needleAngle) * 68,
  };
  const ranges = widget.config.alarmRanges?.length
    ? widget.config.alarmRanges
    : legacyAlarmRanges(widget, min, max);
  const currentRange =
    widget.config.alarmEnabled && numeric != null
      ? [...ranges]
          .sort((a, b) => b.priority - a.priority)
          .find(
            (range) =>
              numeric >= range.start &&
              (numeric < range.end || (range.end === max && numeric <= range.end)),
          )
      : undefined;
  const activeColor = currentRange?.color ?? color;
  const gaugeZones = visibleGaugeZones(ranges, min, max);
  const thresholds = Array.from(
    new Map(
      ranges
        .filter((range) => range.end > min && range.end < max)
        .map((range) => [range.end, range]),
    ).values(),
  );
  const periodChips = (
    <div className="widget-period" role="group" aria-label="Período do gráfico">
      {periodOptions.map(([value, label]) => (
        <button
          key={value}
          type="button"
          className={period === value ? 'active' : ''}
          onClick={() => setPeriod(value)}
        >
          {label}
        </button>
      ))}
      {period === 'custom' && (
        <span className="widget-period-custom">
          <input
            type="date"
            aria-label="De"
            value={customFrom}
            max={customTo}
            onChange={(event) => setCustomFrom(event.target.value)}
          />
          <span>até</span>
          <input
            type="date"
            aria-label="Até"
            value={customTo}
            min={customFrom}
            max={localToday}
            onChange={(event) => setCustomTo(event.target.value)}
          />
        </span>
      )}
      {productionStats.loading && <span className="widget-period-loading">atualizando…</span>}
    </div>
  );
  const horizontalBars = widget.widget_type === 'bar_horizontal';
  const quickBars =
    widget.config.chartDimension === 'day'
      ? (statistics?.daily_series ?? []).map((day) => ({
          label: new Date(
            `${day.date}${day.date.length === 7 ? '-01' : ''}T12:00:00`,
          ).toLocaleDateString(
            'pt-BR',
            statistics?.bucket_granularity === 'month'
              ? { month: 'short', year: '2-digit' }
              : { day: '2-digit', month: 'short' },
          ),
          value: day.value ?? 0,
        }))
      : (statistics?.product_breakdown ?? []).map((product) => ({
          label: product.product_code,
          value: product.value,
        }));
  const quickEmpty =
    widget.widget_type === 'donut'
      ? !statistics?.product_breakdown?.length
      : !quickBars.some((bar) => bar.value > 0);
  return (
    <article
      draggable
      onDragStart={dragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
      className={`dashboard-widget widget-${widget.width} ${currentRange ? 'alarm-active' : ''}`}
      style={{ '--accent': activeColor } as React.CSSProperties}
    >
      <div className="widget-head">
        <button className="drag-handle" title="Arrastar para reorganizar">
          <SixDots />
        </button>
        <div>
          <span className="widget-kicker">{widget.widget_type.toUpperCase()}</span>
          <h2>{widget.title}</h2>
        </div>
        <div className="widget-actions">
          <button className="icon-button" title="Editar indicador" onClick={edit}>
            ✎
          </button>
          <button className="icon-button danger-button" title="Remover" onClick={remove}>
            ×
          </button>
        </div>
      </div>
      {currentRange && currentRange.priority > 0 && (
        <div
          className="widget-alarm-label"
          style={{ color: currentRange.color, borderColor: currentRange.color }}
        >
          Faixa “{currentRange.label}” atingida
        </div>
      )}
      {widget.widget_type === 'line' &&
        (points.length ? (
          <div className="widget-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points}>
                <defs>
                  <linearGradient id={`fill-${widget.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#20313a" strokeDasharray="2 6" vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(item) =>
                    new Date(item).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  }
                  tick={{ fontSize: 10, fill: '#78909a' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#78909a' }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip
                  labelFormatter={(item) => new Date(Number(item)).toLocaleString('pt-BR')}
                  formatter={(item) => [
                    `${number(Number(item), 2)} ${widget.unit ?? ''}`,
                    widget.title,
                  ]}
                />
                {widget.config.alarmEnabled &&
                  thresholds.map((range) => (
                    <ReferenceLine
                      key={`${range.id}-${range.end}`}
                      y={range.end}
                      stroke={range.color}
                      strokeWidth={1.5}
                      strokeDasharray="6 4"
                      label={{
                        value: `${range.label} ${number(range.end, widget.config.decimals ?? 1)}`,
                        position: 'insideTopLeft',
                        fill: range.color,
                        fontSize: 10,
                      }}
                    />
                  ))}
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={activeColor}
                  strokeWidth={2.5}
                  fill={`url(#fill-${widget.id})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="widget-empty">Aguardando histórico</div>
        ))}
      {widget.widget_type === 'gauge' && (
        <div className={`gauge-v2 gauge-${widget.config.gaugeStyle ?? 'top'}`}>
          <div className="gauge-dial">
            <svg viewBox="0 0 220 132">
              <path className="gauge-track" pathLength="100" d="M 20 108 A 90 90 0 0 1 200 108" />
              {widget.config.alarmEnabled &&
                gaugeZones.map((zone, index) => {
                  const start = ((zone.start - min) / (max - min || 1)) * 100;
                  const length = ((zone.end - zone.start) / (max - min || 1)) * 100;
                  return (
                    <path
                      key={`${zone.id}-${index}`}
                      className="gauge-zone"
                      pathLength="100"
                      d="M 20 108 A 90 90 0 0 1 200 108"
                      style={{
                        stroke: zone.color,
                        strokeDasharray: `${length} ${100 - length}`,
                        strokeDashoffset: -start,
                      }}
                    />
                  );
                })}
              {widget.config.gaugeNeedle !== false && numeric != null && (
                <g className="gauge-needle">
                  <line x1="110" y1="108" x2={needleTip.x} y2={needleTip.y} />
                  <circle cx="110" cy="108" r="5" />
                </g>
              )}
            </svg>
            <div className="gauge-reading">
              <strong>{number(numeric, widget.config.decimals ?? 1)}</strong>
              <span>{widget.unit}</span>
            </div>
            <span className="gauge-limit gauge-limit-min">
              {number(min, widget.config.decimals ?? 1)}
            </span>
            <span className="gauge-limit gauge-limit-max">
              {number(max, widget.config.decimals ?? 1)}
            </span>
          </div>
        </div>
      )}
      {widget.widget_type === 'status' && (
        <div className={`machine-status ${latest?.value_boolean ? 'running' : ''}`}>
          <span className="status-orb" />
          <div>
            <strong>{latest?.value_boolean ? 'Em operação' : 'Parada'}</strong>
          </div>
        </div>
      )}
      {widget.widget_type === 'value' && (
        <>
          <div className="hero-value">
            {latest?.value_number != null
              ? number(latest.value_number, widget.config.decimals ?? 1)
              : latest?.value_boolean != null
                ? latest.value_boolean
                  ? 'Ligado'
                  : 'Desligado'
                : (latest?.value_text ?? '—')}
            <span>{widget.unit}</span>
          </div>
          {widget.config.counterMode && latest?.value_number != null && (
            <button className="counter-reset" type="button" onClick={reset}>
              Zerar contador
            </button>
          )}
        </>
      )}
      {widget.widget_type === 'production' && (
        <div className="production-insight">
          {periodChips}
          <div className="production-kpis">
            <div>
              <span className="metric-label">
                {statistics?.metric_kind === 'counter_delta'
                  ? 'Produção no período'
                  : 'Média operacional'}
              </span>
              <div className="hero-value">
                {number(
                  statistics?.metric_kind === 'counter_delta'
                    ? statistics.current_period_value
                    : statistics?.average,
                  widget.config.decimals ?? 1,
                )}
                <span>{widget.unit}</span>
              </div>
            </div>
            <div
              className={`period-comparison ${(statistics?.change_percent ?? 0) < 0 ? 'negative' : ''}`}
            >
              <span>vs. período anterior</span>
              <strong>
                {statistics?.change_percent == null
                  ? '—'
                  : `${statistics.change_percent >= 0 ? '+' : ''}${number(statistics.change_percent, 1)}%`}
              </strong>
              <small>
                {number(statistics?.previous_period_value, widget.config.decimals ?? 1)}{' '}
                {widget.unit}
              </small>
            </div>
          </div>
          <div className="production-history">
            <div className="production-history-title">
              <strong>Desempenho: {periodLabel(period, statistics?.trend_days ?? 7)}</strong>
              <span>
                Melhor {statistics?.bucket_granularity === 'month' ? 'mês' : 'dia'}:{' '}
                {statistics?.best_day
                  ? new Date(
                      `${statistics.best_day}${statistics.best_day.length === 7 ? '-01' : ''}T12:00:00`,
                    ).toLocaleDateString('pt-BR', {
                      ...(statistics.bucket_granularity === 'day' ? { day: '2-digit' } : {}),
                      month: 'short',
                      ...(statistics.bucket_granularity === 'month' ? { year: '2-digit' } : {}),
                    })
                  : '—'}{' '}
                · {number(statistics?.best_value, widget.config.decimals ?? 1)} {widget.unit}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart
                data={statistics?.daily_series ?? []}
                margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
              >
                <CartesianGrid stroke="#dfe8ea" strokeDasharray="3 5" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(item) =>
                    new Date(
                      `${item}${String(item).length === 7 ? '-01' : ''}T12:00:00`,
                    ).toLocaleDateString('pt-BR', {
                      ...(statistics?.bucket_granularity === 'day' ? { day: '2-digit' } : {}),
                      month: 'short',
                      ...(statistics?.bucket_granularity === 'month' ? { year: '2-digit' } : {}),
                    })
                  }
                  tick={{ fontSize: 10, fill: '#71868d' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#71868d' }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip
                  labelFormatter={(item) =>
                    new Date(
                      `${String(item)}${String(item).length === 7 ? '-01' : ''}T12:00:00`,
                    ).toLocaleDateString('pt-BR', {
                      month: 'long',
                      year: 'numeric',
                      ...(String(item).length === 10 ? { day: '2-digit' } : {}),
                    })
                  }
                  formatter={(item) => [
                    `${number(Number(item), widget.config.decimals ?? 1)} ${widget.unit ?? ''}`,
                    widget.title,
                  ]}
                />
                <Bar
                  dataKey="value"
                  fill={color}
                  radius={[5, 5, 0, 0]}
                  maxBarSize={44}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="product-ranking">
            <div className="production-history-title">
              <strong>Produção por produto</strong>
              <span>{statistics?.product_breakdown?.length ?? 0} receitas</span>
            </div>
            <ScrollHint>
              <div className="product-ranking-list">
                {(statistics?.product_breakdown ?? []).map((product, index) => (
                  <div className="product-ranking-row" key={product.product_code}>
                    <span className="product-rank">{index + 1}</span>
                    <div>
                      <strong>{product.product_code}</strong>
                      <i>
                        <span
                          style={{
                            width: `${Math.max(3, product.share_percent)}%`,
                            background: color,
                          }}
                        />
                      </i>
                    </div>
                    <b>
                      {number(product.value, widget.config.decimals ?? 1)} {widget.unit}
                      <small>{number(product.share_percent, 1)}%</small>
                    </b>
                    {user.role === 'master' && (
                      <button
                        type="button"
                        className="product-hide"
                        title="Ocultar produto"
                        aria-label={`Ocultar ${product.product_code}`}
                        onClick={() => setHidingProduct(product.product_code)}
                      >
                        <EyeOff />
                      </button>
                    )}
                  </div>
                ))}
                {!statistics?.product_breakdown?.length && (
                  <div className="product-ranking-empty">Aguardando produção no período.</div>
                )}
              </div>
            </ScrollHint>
            {hiddenProducts.length > 0 && (
              <div className="hidden-products">
                <button
                  type="button"
                  className="hidden-products-toggle"
                  onClick={() => setShowHidden(!showHidden)}
                >
                  {hiddenProducts.length} oculto{hiddenProducts.length > 1 ? 's' : ''} ·{' '}
                  {showHidden ? 'fechar' : 'mostrar'}
                </button>
                {showHidden && (
                  <div className="hidden-products-list">
                    {hiddenProducts.map((code) => (
                      <span key={code}>
                        {code}
                        {user.role === 'master' && (
                          <button type="button" onClick={() => void toggleProduct(code, false)}>
                            restaurar
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* A counter answers management questions; raw counter extremes and sample
              counts meant nothing to a plant owner. A rate keeps its operating range. */}
          {statistics?.metric_kind === 'counter_delta' ? (
            <div className="three-metrics">
              <span>
                <b>
                  {number(
                    statistics.current_period_value == null
                      ? null
                      : statistics.current_period_value / Math.max(1, statistics.trend_days),
                    widget.config.decimals ?? 1,
                  )}
                </b>
                média por dia
              </span>
              <span>
                <b>{number(statistics.best_value, widget.config.decimals ?? 1)}</b>
                melhor {statistics.bucket_granularity === 'month' ? 'mês' : 'dia'}
              </span>
              <span>
                <b>{statistics.product_breakdown.length}</b>
                receitas produzidas
              </span>
            </div>
          ) : (
            <>
              <div className="three-metrics">
                <span>
                  <b>{number(statistics?.minimum, widget.config.decimals ?? 1)}</b>
                  mínimo operacional
                </span>
                <span>
                  <b>{number(statistics?.average, widget.config.decimals ?? 1)}</b>
                  média
                </span>
                <span>
                  <b>{number(statistics?.maximum, widget.config.decimals ?? 1)}</b>
                  pico
                </span>
              </div>
              <small className="production-note">
                Leitura: {periodLabel(period, statistics?.trend_days ?? 7)} · valores abaixo de{' '}
                {number(statistics?.minimum_value ?? 0.1, widget.config.decimals ?? 1)} ignorados
              </small>
            </>
          )}
        </div>
      )}
      {(widget.widget_type === 'donut' ||
        widget.widget_type === 'bar_vertical' ||
        widget.widget_type === 'bar_horizontal') && (
        <div className="quick-chart">
          {periodChips}
          <div className="quick-chart-total">
            <b>
              {number(
                statistics?.current_period_value ?? statistics?.average,
                widget.config.decimals ?? 1,
              )}
            </b>
            {widget.unit} · {periodLabel(period, statistics?.trend_days ?? 7)}
          </div>
          {quickEmpty ? (
            <div className="quick-empty">Sem produção no período.</div>
          ) : widget.widget_type === 'donut' ? (
            <div className="quick-donut">
              <div className="quick-donut-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={statistics?.product_breakdown ?? []}
                      dataKey="value"
                      nameKey="product_code"
                      innerRadius="58%"
                      outerRadius="95%"
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {(statistics?.product_breakdown ?? []).map((product, index) => (
                        <Cell
                          key={product.product_code}
                          fill={productPalette[index % productPalette.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(item) =>
                        `${number(Number(item), widget.config.decimals ?? 1)} ${widget.unit ?? ''}`
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
                <span>
                  <b>{statistics?.product_breakdown?.length ?? 0}</b>
                  produtos
                </span>
              </div>
              <ScrollHint>
                <ul className="quick-legend">
                  {(statistics?.product_breakdown ?? []).map((product, index) => (
                    <li key={product.product_code}>
                      <i style={{ background: productPalette[index % productPalette.length] }} />
                      <span title={product.product_code}>{product.product_code}</span>
                      <b>
                        {number(product.share_percent, 1)}%
                        <small>{number(product.value, widget.config.decimals ?? 1)}</small>
                      </b>
                    </li>
                  ))}
                </ul>
              </ScrollHint>
            </div>
          ) : (
            <div className="quick-chart-body">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={quickBars}
                  layout={horizontalBars ? 'vertical' : 'horizontal'}
                  margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
                >
                  <CartesianGrid
                    stroke="#dfe8ea"
                    strokeDasharray="3 5"
                    vertical={horizontalBars}
                    horizontal={!horizontalBars}
                  />
                  <XAxis
                    type={horizontalBars ? 'number' : 'category'}
                    dataKey={horizontalBars ? undefined : 'label'}
                    tick={{ fontSize: 10, fill: '#71868d' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type={horizontalBars ? 'category' : 'number'}
                    dataKey={horizontalBars ? 'label' : undefined}
                    width={horizontalBars ? 96 : 42}
                    tick={{ fontSize: 10, fill: '#71868d' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    formatter={(item) => [
                      `${number(Number(item), widget.config.decimals ?? 1)} ${widget.unit ?? ''}`,
                      widget.title,
                    ]}
                  />
                  <Bar
                    dataKey="value"
                    radius={horizontalBars ? [0, 5, 5, 0] : [5, 5, 0, 0]}
                    maxBarSize={40}
                    isAnimationActive={false}
                  >
                    {quickBars.map((bar, index) => (
                      <Cell
                        key={bar.label}
                        fill={
                          widget.config.chartDimension === 'day'
                            ? color
                            : productPalette[index % productPalette.length]
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
      {widget.widget_type === 'oee' && (
        <div className="model-placeholder">
          <strong>OEE pronto para configurar</strong>
          <span>Associe contagem total, peças boas, rejeitos, tempo planejado e ciclo ideal.</span>
        </div>
      )}
      {widget.widget_type === 'pareto' && (
        <div className="model-placeholder">
          <strong>Pareto de perdas</strong>
          <span>O gráfico surgirá quando motivos e duração das paradas forem coletados.</span>
        </div>
      )}
      {/* Portal: a fixed modal inside a draggable card would be clipped by the card. */}
      {hidingProduct &&
        createPortal(
          <ActionModal
            title="Ocultar produto"
            description={`“${hidingProduct}” deixa de aparecer nos totais, gráficos e rankings deste equipamento. Os dados continuam guardados e o produto pode ser restaurado a qualquer momento em “mostrar”.`}
            confirmLabel="Ocultar"
            onClose={() => setHidingProduct(null)}
            onConfirm={() => toggleProduct(hidingProduct, true)}
          />,
          document.body,
        )}
    </article>
  );
}

export function DashboardCanvas({ id }: { id: string }) {
  const { branding } = usePlatform();
  const dashboard = usePoll<Dashboard>(`/dashboards/${id}`, 2000);
  const refreshMs = dashboard.data?.refresh_ms ?? 2000;
  const deviceId = dashboard.data?.device_id ?? '';
  const device = usePoll<Device>(deviceId ? `/devices/${deviceId}` : null, refreshMs);
  const latest = usePoll<Sample[]>(deviceId ? `/devices/${deviceId}/latest` : null, refreshMs);
  const signals = usePoll<Signal[]>(deviceId ? `/devices/${deviceId}/signals` : null, 5000);
  const productionContext = usePoll<ProductionContext>(
    deviceId ? `/devices/${deviceId}/production-context` : null,
    10000,
  );
  const hasCounters = Boolean(dashboard.data?.widgets?.some((widget) => widget.config.counterMode));
  const counters = usePoll<CounterValue[]>(
    hasCounters ? `/dashboards/${id}/counters` : null,
    refreshMs,
  );
  const windowMinutes = dashboard.data?.time_window_minutes ?? 60;
  const from = new Date(
    Math.floor(Date.now() / 60000) * 60000 - windowMinutes * 60000,
  ).toISOString();
  const history = usePoll<Sample[]>(
    deviceId ? `/telemetry?deviceId=${deviceId}&from=${encodeURIComponent(from)}&limit=2000` : null,
    refreshMs,
  );
  const [adding, setAdding] = useState(false);
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | null>(null);
  const [tv, setTv] = useState(false);
  const [error, setError] = useState('');
  const [signalId, setSignalId] = useState('');
  const [widgetType, setWidgetType] = useState<DashboardWidget['widget_type']>('value');
  const [title, setTitle] = useState('');
  const [color, setColor] = useState('#12b8a6');
  const [width, setWidth] = useState<DashboardWidget['width']>('small');
  const [minimum, setMinimum] = useState(0);
  const [maximum, setMaximum] = useState(100);
  const [decimals, setDecimals] = useState(1);
  const [gaugeStyle, setGaugeStyle] = useState<'top' | 'bottom' | 'left' | 'right'>('top');
  const [alarmEnabled, setAlarmEnabled] = useState(false);
  const [alarmRanges, setAlarmRanges] = useState<AlarmRange[]>([]);
  const [gaugeNeedle, setGaugeNeedle] = useState(true);
  const [productionMinimumValue, setProductionMinimumValue] = useState(0.1);
  const [productionMetricKind, setProductionMetricKind] = useState<
    'rate_average' | 'counter_delta'
  >('rate_average');
  const [productionDefaultPeriod, setProductionDefaultPeriod] = useState<ProductionPeriod>('7d');
  const [chartDimension, setChartDimension] = useState<'product' | 'day'>('product');
  const [productKey, setProductKey] = useState('');
  const [fallbackProductCode, setFallbackProductCode] = useState('ITEM GERAL');
  const [counterMode, setCounterMode] = useState(false);
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const [savingModal, setSavingModal] = useState(false);
  const [savingRefresh, setSavingRefresh] = useState(false);
  const [removingWidget, setRemovingWidget] = useState<DashboardWidget | null>(null);
  const [resettingWidget, setResettingWidget] = useState<DashboardWidget | null>(null);
  useEffect(() => {
    if (dashboard.data?.widgets)
      setWidgets([...dashboard.data.widgets].sort((a, b) => a.position - b.position));
  }, [dashboard.data?.widgets]);
  useEffect(() => {
    if (!productionContext.data) return;
    setProductKey(productionContext.data.product_key ?? '');
    setFallbackProductCode(productionContext.data.fallback_product_code);
  }, [productionContext.data]);
  const allLoaded = Boolean(
    dashboard.data && device.data && latest.data && signals.data && history.data,
  );
  useEffect(() => {
    if (allLoaded) setLoadedOnce(true);
  }, [allLoaded]);
  useEffect(() => {
    const timer = window.setTimeout(() => setLoadingTimedOut(true), 8000);
    return () => window.clearTimeout(timer);
  }, []);
  const selectedSignal = signals.data?.find(
    (signal) => signal.id === signalId || signal.tag_id === signalId,
  );
  const byTag = useMemo(
    () => new Map((latest.data ?? []).map((sample) => [sample.tag_id, sample])),
    [latest.data],
  );
  async function addWidget(event: React.FormEvent) {
    event.preventDefault();
    if (!dashboard.data || !deviceId) return;
    setError('');
    setSavingModal(true);
    try {
      let tagId = selectedSignal?.tag_id ?? null;
      if (selectedSignal && !tagId) {
        const tag = await mutate<{ id: string }>(`/devices/${deviceId}/tags`, 'POST', {
          key: selectedSignal.key,
          name: title || selectedSignal.key,
          dataType: selectedSignal.data_type,
          unit: selectedSignal.unit,
          scaleMultiplier: 1,
          scaleOffset: 0,
        });
        tagId = tag.id;
      }
      await mutate(`/dashboards/${id}/widgets`, 'POST', {
        deviceId,
        tagId,
        widgetType,
        title:
          title ||
          selectedSignal?.name ||
          selectedSignal?.key ||
          (widgetType === 'oee' ? 'OEE' : 'Pareto de perdas'),
        width,
        config: {
          color: '#12b8a6',
          min: 0,
          max: 100,
          decimals: 1,
          gaugeStyle: 'top',
          gaugeNeedle: true,
          productionPeriodMinutes: 60,
          productionMinimumValue: 0.1,
          // Counters (pallets, blocks, totals) are summed; rates such as t/h are averaged.
          productionMetricKind: /palete|pallet|bloco|block|quant|contad|count|total|pe[cç]a/i.test(
            selectedSignal?.key ?? '',
          )
            ? 'counter_delta'
            : 'rate_average',
          chartDimension: 'product',
          productionDefaultPeriod: '7d',
          productionTrendDays: 7,
        },
      });
      setAdding(false);
      await Promise.all([dashboard.refresh(), signals.refresh()]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Não foi possível adicionar o indicador.',
      );
    } finally {
      setSavingModal(false);
    }
  }
  async function updateRefresh(refresh: number) {
    setSavingRefresh(true);
    try {
      await mutate(`/dashboards/${id}`, 'PATCH', { refreshMs: refresh });
      await dashboard.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar');
    } finally {
      setSavingRefresh(false);
    }
  }
  function startEdit(widget: DashboardWidget) {
    setEditingWidget(widget);
    setTitle(widget.title);
    setWidth(widget.width);
    setColor(widget.config.color ?? '#12b8a6');
    setMinimum(widget.config.min ?? 0);
    setMaximum(widget.config.max ?? 100);
    setDecimals(widget.config.decimals ?? 1);
    setGaugeStyle(widget.config.gaugeStyle ?? 'top');
    setAlarmEnabled(widget.config.alarmEnabled ?? false);
    setAlarmRanges(
      widget.config.alarmRanges?.length
        ? widget.config.alarmRanges
        : legacyAlarmRanges(widget, widget.config.min ?? 0, widget.config.max ?? 100),
    );
    setGaugeNeedle(widget.config.gaugeNeedle ?? true);
    setProductionMinimumValue(widget.config.productionMinimumValue ?? 0.1);
    setProductionMetricKind(widget.config.productionMetricKind ?? 'rate_average');
    setProductionDefaultPeriod(widget.config.productionDefaultPeriod ?? '7d');
    setChartDimension(widget.config.chartDimension ?? 'product');
    setCounterMode(widget.config.counterMode ?? false);
  }
  async function saveWidget(event: React.FormEvent) {
    event.preventDefault();
    if (!editingWidget) return;
    if (maximum <= minimum) return setError('O valor máximo precisa ser maior que o mínimo.');
    if (
      alarmEnabled &&
      alarmRanges.some(
        (range) =>
          !range.label.trim() ||
          range.end <= range.start ||
          (editingWidget.widget_type === 'gauge' && (range.start < minimum || range.end > maximum)),
      )
    )
      return setError('Revise as faixas: nome, início e fim precisam estar dentro do medidor.');
    setSavingModal(true);
    setError('');
    try {
      if (analyticTypes.has(editingWidget.widget_type)) {
        await mutate(`/devices/${deviceId}/production-context`, 'PATCH', {
          productKey: productKey || null,
          fallbackProductCode: fallbackProductCode.trim() || 'ITEM GERAL',
        });
      }
      await mutate(`/dashboards/${id}/widgets/${editingWidget.id}`, 'PATCH', {
        title,
        width,
        config: {
          color,
          min: minimum,
          max: maximum,
          decimals,
          gaugeStyle,
          gaugeNeedle,
          alarmEnabled,
          alarmRanges,
          productionMinimumValue,
          productionMetricKind,
          productionDefaultPeriod,
          chartDimension,
          counterMode,
        },
      });
      setEditingWidget(null);
      await Promise.all([dashboard.refresh(), productionContext.refresh()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar indicador.');
    } finally {
      setSavingModal(false);
    }
  }
  async function removeWidget(widget: DashboardWidget) {
    await mutate(`/dashboards/${id}/widgets/${widget.id}`, 'DELETE');
    setEditingWidget(null);
    await dashboard.refresh();
  }
  async function resetCounter(widget: DashboardWidget) {
    await mutate(`/dashboards/${id}/widgets/${widget.id}/reset-counter`, 'POST');
    await Promise.all([dashboard.refresh(), counters.refresh()]);
  }
  async function dropWidget(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const next = [...widgets];
    const fromIndex = next.findIndex((widget) => widget.id === draggedId);
    const toIndex = next.findIndex((widget) => widget.id === targetId);
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setWidgets(next);
    setDraggedId(null);
    try {
      await mutate(`/dashboards/${id}/layout`, 'PATCH', {
        widgetIds: next.map((widget) => widget.id),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar a ordem.');
      await dashboard.refresh();
    }
  }
  if (!loadedOnce) {
    const loadError =
      dashboard.error || device.error || latest.error || signals.error || history.error;
    if (loadingTimedOut && loadError)
      return (
        <div className="dashboard-load-failed">
          <BrandSpinner branding={branding} />
          <h2>Não foi possível carregar o painel</h2>
          <p>{loadError}</p>
          <button onClick={() => window.location.reload()}>Tentar novamente</button>
        </div>
      );
    return (
      <div className="dashboard-loading">
        <BrandSpinner branding={branding} />
        <strong>Carregando dados do equipamento…</strong>
      </div>
    );
  }
  return (
    <div className={tv ? 'tv-shell' : ''}>
      <div className="dashboard-toolbar">
        <div>
          <div className="eyebrow">SALA DE CONTROLE · TEMPO REAL</div>
          <h1>{dashboard.data?.name ?? 'Painel industrial'}</h1>
          <p>
            {device.data?.name} <span className="code-chip">{device.data?.device_code}</span>
          </p>
        </div>
        <div className="toolbar-actions">
          <span className={`connection-state ${device.data?.online ? 'online' : ''}`}>
            <span />
            {device.data?.online ? 'Online' : 'Offline'}
          </span>
          <button onClick={() => window.print()}>Exportar PDF</button>
          <a
            className="secondary-button"
            href={`/api/export/telemetry.csv?deviceId=${deviceId}&limit=10000`}
          >
            Exportar CSV
          </a>
          {/* Opens the managerial wall board; the widget grid stays the operator's view. */}
          <button onClick={() => window.location.assign(`/dashboards/${id}/tv`)}>Modo TV</button>
          <button className="primary-button" onClick={() => setAdding(true)}>
            + Adicionar indicador
          </button>
        </div>
      </div>
      <div className="editor-bar">
        <span>
          Arraste os seis pontos para organizar. A configuração fica salva neste equipamento.
        </span>
        <label>
          Atualização {savingRefresh && <span className="button-spinner dark" />}
          <select
            value={refreshMs}
            onChange={(event) => void updateRefresh(Number(event.target.value))}
          >
            <option value={1000}>1 segundo</option>
            <option value={2000}>2 segundos</option>
            <option value={5000}>5 segundos</option>
            <option value={10000}>10 segundos</option>
          </select>
        </label>
        <small>
          A IHM também precisa publicar neste intervalo para chegar um valor novo a cada ciclo.
        </small>
      </div>
      {(error || dashboard.error || latest.error) && (
        <div className="error-banner">{error || dashboard.error || latest.error}</div>
      )}
      <div className="dashboard-meta">
        <span>
          <b>Janela</b> últimos{' '}
          {windowMinutes >= 60 ? `${windowMinutes / 60} h` : `${windowMinutes} min`}
        </span>
        <span>
          <b>Atualização</b> {refreshMs / 1000} s
        </span>
        <span>
          <b>Atualizado em</b> {time(device.data?.last_message_at)}
        </span>
      </div>
      <section className="widget-grid">
        {widgets.map((widget) => (
          <Widget
            key={widget.id}
            widget={widget}
            latest={widget.tag_id ? byTag.get(widget.tag_id) : undefined}
            history={history.data ?? []}
            dashboardId={id}
            counter={counters.data?.find((item) => item.widget_id === widget.id)}
            edit={() => startEdit(widget)}
            remove={() => setRemovingWidget(widget)}
            reset={() => setResettingWidget(widget)}
            dragStart={() => setDraggedId(widget.id)}
            drop={() => void dropWidget(widget.id)}
          />
        ))}
        {!widgets.length && (
          <button className="empty-dashboard" onClick={() => setAdding(true)}>
            +<strong>Monte a primeira visão da operação</strong>
            <span>Escolha uma variável que já chegou pelo MQTT.</span>
          </button>
        )}
      </section>
      <footer className="dashboard-footer">
        <span>EVERLENZ INDUSTRIAL INTELLIGENCE</span>
        <span>Dados recebidos via MQTT · atualização automática</span>
      </footer>
      {adding && (
        <div className="modal-backdrop" onMouseDown={() => !savingModal && setAdding(false)}>
          <form
            className="modal-card"
            onSubmit={addWidget}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-title">
              <div>
                <div className="eyebrow">BIBLIOTECA DE INDICADORES</div>
                <h2>Adicionar ao painel</h2>
              </div>
              <button
                type="button"
                disabled={savingModal}
                className="icon-button"
                onClick={() => setAdding(false)}
              >
                ×
              </button>
            </div>
            <p>As variáveis abaixo foram descobertas nas mensagens reais deste equipamento.</p>
            <div className="form-grid">
              <label className="field full-field">
                Variável
                <select
                  value={signalId}
                  onChange={(event) => {
                    const next = signals.data?.find(
                      (signal) =>
                        signal.id === event.target.value || signal.tag_id === event.target.value,
                    );
                    setSignalId(event.target.value);
                    setTitle(next?.name || next?.key || '');
                  }}
                >
                  <option value="">Indicador calculado ou selecione uma variável…</option>
                  {signals.data?.map((signal) => (
                    <option key={signal.id} value={signal.id}>
                      {signal.key} · {signal.data_type}
                      {signal.configured ? ' · configurada' : ' · descoberta agora'}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field full-field">
                Visualização
                <div className="visualization-picker">
                  {(
                    [
                      ['value', '42', 'Valor'],
                      ['line', '∿', 'Tendência'],
                      ['gauge', '◒', 'Medidor'],
                      ['status', '●', 'Estado'],
                      ['production', '▥', 'Produção'],
                      ['donut', '◔', 'Pizza'],
                      ['bar_vertical', '▮', 'Barras'],
                      ['bar_horizontal', '▬', 'Barras horiz.'],
                      ['oee', '%', 'OEE'],
                      ['pareto', '▥', 'Pareto'],
                    ] as const
                  ).map(([type, icon, label]) => (
                    <button
                      type="button"
                      key={type}
                      className={widgetType === type ? 'selected' : ''}
                      onClick={() => setWidgetType(type)}
                    >
                      <span className="visualization-symbol">{icon}</span>
                      <b>{label}</b>
                      <span className="visualization-info" title={visualizationHelp[type]}>
                        i
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <label className="field">
                Título
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Ex.: Toneladas por hora"
                />
              </label>
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" disabled={savingModal} onClick={() => setAdding(false)}>
                Cancelar
              </button>
              <button className="primary-button" type="submit" disabled={savingModal}>
                {savingModal && <span className="button-spinner" />}
                {savingModal ? 'Adicionando…' : 'Adicionar ao painel'}
              </button>
            </div>
          </form>
        </div>
      )}
      {editingWidget && (
        <div className="modal-backdrop" onMouseDown={() => !savingModal && setEditingWidget(null)}>
          <form
            className="modal-card widget-settings-modal"
            onSubmit={saveWidget}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-title">
              <div>
                <div className="eyebrow">CONFIGURAÇÃO DO ITEM</div>
                <h2>{editingWidget.title}</h2>
              </div>
              <button
                type="button"
                disabled={savingModal}
                className="icon-button"
                onClick={() => setEditingWidget(null)}
              >
                ×
              </button>
            </div>
            <div className="form-grid">
              <label className="field full-field">
                Título
                <input required value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label className="field">
                Largura
                <select
                  value={width}
                  onChange={(event) => setWidth(event.target.value as DashboardWidget['width'])}
                >
                  <option value="small">Pequena</option>
                  <option value="medium">Média</option>
                  <option value="large">Grande</option>
                  <option value="full">Linha inteira</option>
                </select>
              </label>
              <label className="field">
                Casas decimais
                <input
                  type="number"
                  min="0"
                  max="6"
                  value={decimals}
                  onChange={(event) => setDecimals(Number(event.target.value))}
                />
              </label>
              <label className="field">
                Cor
                <input
                  type="color"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                />
              </label>
              {editingWidget.widget_type === 'gauge' && (
                <>
                  <label className="field">
                    Mínimo
                    <input
                      type="number"
                      value={minimum}
                      onChange={(event) => setMinimum(Number(event.target.value))}
                    />
                  </label>
                  <label className="field">
                    Máximo
                    <input
                      type="number"
                      value={maximum}
                      onChange={(event) => setMaximum(Number(event.target.value))}
                    />
                  </label>
                  <div className="field full-field">
                    Posição do medidor
                    <div className="gauge-style-picker">
                      {(['top', 'bottom', 'left', 'right'] as const).map((style) => (
                        <button
                          type="button"
                          key={style}
                          className={gaugeStyle === style ? 'selected' : ''}
                          onClick={() => setGaugeStyle(style)}
                        >
                          <span className={`mini-gauge mini-${style}`} />
                          {
                            {
                              top: 'Superior',
                              bottom: 'Inferior',
                              left: 'Esquerda',
                              right: 'Direita',
                            }[style]
                          }
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="check-field full-field">
                    <input
                      type="checkbox"
                      checked={gaugeNeedle}
                      onChange={(event) => setGaugeNeedle(event.target.checked)}
                    />
                    Exibir ponteiro no medidor
                  </label>
                </>
              )}
              {analyticTypes.has(editingWidget.widget_type) && (
                <>
                  <label className="field">
                    Tipo de medição
                    <select
                      value={productionMetricKind}
                      onChange={(event) =>
                        setProductionMetricKind(
                          event.target.value as 'rate_average' | 'counter_delta',
                        )
                      }
                    >
                      <option value="rate_average">Taxa instantânea (ex.: ton/h)</option>
                      <option value="counter_delta">Contador acumulativo (ex.: paletes)</option>
                    </select>
                  </label>
                  {(editingWidget.widget_type === 'bar_vertical' ||
                    editingWidget.widget_type === 'bar_horizontal') && (
                    <label className="field">
                      Uma barra por
                      <select
                        value={chartDimension}
                        onChange={(event) =>
                          setChartDimension(event.target.value as 'product' | 'day')
                        }
                      >
                        <option value="product">Produto</option>
                        <option value="day">Dia</option>
                      </select>
                    </label>
                  )}
                  <label className="field">
                    Período ao abrir o painel
                    <select
                      value={productionDefaultPeriod}
                      onChange={(event) =>
                        setProductionDefaultPeriod(event.target.value as ProductionPeriod)
                      }
                    >
                      {periodOptions.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Variável de produto/receita
                    <select
                      value={productKey}
                      onChange={(event) => setProductKey(event.target.value)}
                    >
                      <option value="">A IHM não envia (usar produto padrão)</option>
                      {signals.data?.map((signal) => (
                        <option value={signal.key} key={signal.id}>
                          {signal.key}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Produto padrão
                    <input
                      required
                      maxLength={120}
                      value={fallbackProductCode}
                      onChange={(event) => setFallbackProductCode(event.target.value)}
                      placeholder="Ex.: BLOCO GERAL"
                    />
                  </label>
                  <small className="full-field alarm-range-help">
                    Quando a variável de receita vier no payload, ela identifica cada incremento.
                    Quando não vier, a plataforma usa o produto padrão. Sem configuração, registra
                    como ITEM GERAL.
                  </small>
                  <label className="field">
                    Desconsiderar valores abaixo de
                    <input
                      type="number"
                      step="any"
                      value={productionMinimumValue}
                      onChange={(event) => setProductionMinimumValue(Number(event.target.value))}
                    />
                  </label>
                  <small className="full-field alarm-range-help">
                    A média operacional ignora períodos parados abaixo desse valor. Mínimo, pico e
                    quantidade de amostras usam o mesmo filtro.
                  </small>
                </>
              )}
              {editingWidget.widget_type === 'value' && editingWidget.data_type === 'number' && (
                <>
                  <label className="check-field full-field">
                    <input
                      type="checkbox"
                      checked={counterMode}
                      onChange={(event) => setCounterMode(event.target.checked)}
                    />
                    Tratar esta variável como contador acumulativo
                  </label>
                  <small className="full-field alarm-range-help">
                    O botão “Zerar contador” cria uma referência no painel e mantém o CLP intacto.
                    Os próximos incrementos continuam aparecendo normalmente.
                  </small>
                </>
              )}
              <label className="check-field full-field">
                <input
                  type="checkbox"
                  checked={alarmEnabled}
                  onChange={(event) => setAlarmEnabled(event.target.checked)}
                />
                Ativar alarme visual por limite
              </label>
              {alarmEnabled && (
                <div className="full-field alarm-ranges-editor">
                  <div className="alarm-ranges-title">
                    <div>
                      <strong>Faixas de operação</strong>
                      <small>
                        Em uma sobreposição, a faixa com maior prioridade define a cor e o alerta.
                      </small>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setAlarmRanges((current) => [
                          ...current,
                          {
                            id: crypto.randomUUID(),
                            label: `Faixa ${current.length + 1}`,
                            start: minimum,
                            end: maximum,
                            color: '#12b8a6',
                            priority: current.length,
                          },
                        ])
                      }
                    >
                      + Adicionar faixa
                    </button>
                  </div>
                  {alarmRanges.map((range) => (
                    <div className="alarm-range-row" key={range.id}>
                      <label>
                        Nome
                        <input
                          value={range.label}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, label: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Início
                        <input
                          type="number"
                          step="any"
                          value={range.start}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, start: Number(event.target.value) }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Final
                        <input
                          type="number"
                          step="any"
                          value={range.end}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, end: Number(event.target.value) }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Cor
                        <input
                          type="color"
                          value={range.color}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, color: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Prioridade
                        <input
                          type="number"
                          min="0"
                          value={range.priority}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, priority: Number(event.target.value) }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="alarm-range-remove"
                        aria-label={`Remover ${range.label}`}
                        onClick={() =>
                          setAlarmRanges((current) =>
                            current.filter((item) => item.id !== range.id),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {!alarmRanges.length && <small>Adicione ao menos uma faixa de operação.</small>}
                </div>
              )}
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button
                type="button"
                disabled={savingModal}
                className="danger-text"
                onClick={() => setRemovingWidget(editingWidget)}
              >
                Excluir item
              </button>
              <button type="button" disabled={savingModal} onClick={() => setEditingWidget(null)}>
                Cancelar
              </button>
              <button className="primary-button" disabled={savingModal}>
                {savingModal && <span className="button-spinner" />}
                {savingModal ? 'Salvando…' : 'Salvar configuração'}
              </button>
            </div>
          </form>
        </div>
      )}
      {removingWidget && (
        <ActionModal
          title="Excluir indicador"
          description={`O item “${removingWidget.title}” será removido deste painel compartilhado para todos os usuários.`}
          confirmLabel="Excluir indicador"
          danger
          onClose={() => setRemovingWidget(null)}
          onConfirm={() => removeWidget(removingWidget)}
        />
      )}
      {resettingWidget && (
        <ActionModal
          title="Zerar contador"
          description={`O valor exibido em “${resettingWidget.title}” começará novamente em zero e continuará acompanhando os próximos incrementos do equipamento. O valor original no CLP será preservado.`}
          confirmLabel="Zerar agora"
          onClose={() => setResettingWidget(null)}
          onConfirm={() => resetCounter(resettingWidget)}
        />
      )}
      {tv && (
        <div className="tv-controls">
          <span>Atualizado em {time(device.data?.last_message_at)}</span>
          <button className="tv-exit" onClick={() => setTv(false)}>
            Sair da TV
          </button>
        </div>
      )}
    </div>
  );
}
