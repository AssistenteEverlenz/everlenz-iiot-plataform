'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DashboardWidget } from './data';

// Quick analytic charts (donut, columns, bars) over a production metric. Values sit inside
// their mark when they fit and move outside with a small leader when they do not, and a
// panel of totals turns each chart into a readable report rather than a bare plot.

export interface QuickStatistic {
  metric_kind: 'rate_average' | 'counter_delta';
  current_period_value: number | null;
  previous_period_value: number | null;
  change_percent: number | null;
  average: number | null;
  maximum: number | null;
  trend_days: number;
  bucket_granularity: 'day' | 'month';
  daily_series: Array<{ date: string; value: number | null; samples: number }>;
  product_breakdown: Array<{ product_code: string; value: number; share_percent: number }>;
}

export const productPalette = [
  '#12b8a6',
  '#2f6fed',
  '#f2a93b',
  '#e4572e',
  '#7b5ea7',
  '#2bb3e6',
  '#8aa29e',
  '#d65db1',
];
const OTHERS = 'Outros';
const OTHERS_COLOR = '#c3cfd2';
const RADIAN = Math.PI / 180;

function hexToHsl(hex: string): [number, number, number] {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#12b8a6';
  const r = parseInt(clean.slice(1, 3), 16) / 255;
  const g = parseInt(clean.slice(3, 5), 16) / 255;
  const b = parseInt(clean.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number) {
  const light = l / 100;
  const a = (s / 100) * Math.min(light, 1 - light);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const value = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Dark text on light tones, white text on dark ones, so labels stay readable. */
export function textOn(hex: string) {
  return hexToHsl(hex)[2] > 62 ? '#182e38' : '#ffffff';
}

/**
 * Colour of one series. A per-product override wins; "colorful" uses the categorical
 * palette; the default "shades" derives tones of the widget colour, darkest for the
 * largest share, which keeps the dashboard sober instead of multicoloured.
 */
export function seriesColor(
  config: DashboardWidget['config'],
  index: number,
  count: number,
  productCode?: string,
) {
  const override = productCode ? config.productColors?.[productCode] : undefined;
  if (override) return override;
  if (config.chartPalette === 'colorful') return productPalette[index % productPalette.length];
  const [h, s, l] = hexToHsl(config.color ?? '#12b8a6');
  if (count <= 1) return hslToHex(h, s, l);
  const reach = Math.min(42, 90 - l);
  return hslToHex(h, s, Math.min(90, l + (index / (count - 1)) * reach));
}

function format(value: number | null | undefined, decimals: number) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Label renderer for recharts bars: inside the bar in bold when the text fits, in a colour
 * that contrasts with the bar, otherwise outside with a short tick.
 */
export function valueLabel(
  formatValue: (value: number) => string,
  horizontal = false,
  colors: string[] = [],
) {
  // recharts passes its own LabelProps; read the geometry off it generically.
  const LabelContent = (input: object) => {
    const props = input as Record<string, unknown>;
    const value = Number(props.value);
    if (!Number.isFinite(value) || value === 0) return null;
    const x = Number(props.x);
    const y = Number(props.y);
    const width = Number(props.width);
    const height = Number(props.height);
    const fill = colors[Number(props.index)];
    const insideColor = fill ? textOn(fill) : '#ffffff';
    const text = formatValue(value);
    const textWidth = text.length * 6.6 + 12;
    if (horizontal) {
      const inside = width > textWidth;
      return (
        <text
          x={inside ? x + width - 7 : x + width + 7}
          y={y + height / 2}
          textAnchor={inside ? 'end' : 'start'}
          dominantBaseline="central"
          fontSize={11}
          fontWeight={700}
          fill={inside ? insideColor : '#182e38'}
        >
          {text}
        </text>
      );
    }
    const center = x + width / 2;
    if (height > 24 && width > textWidth - 10)
      return (
        <text
          x={center}
          y={y + 13}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={11}
          fontWeight={700}
          fill={insideColor}
        >
          {text}
        </text>
      );
    return (
      <g>
        <line x1={center} x2={center} y1={y - 3} y2={y - 9} stroke="#9fb3b8" strokeWidth={1} />
        <text
          x={center}
          y={y - 15}
          textAnchor="middle"
          fontSize={11}
          fontWeight={700}
          fill="#182e38"
        >
          {text}
        </text>
      </g>
    );
  };
  return LabelContent;
}

// ---------- Donut ----------
// Each product is named on the chart itself: the share sits inside a slice wide enough to hold
// it, and the name and amount sit beside the ring, joined to their slice by a thin leader.
// With no legend beside it, the ring takes the whole card. Labels are laid out together so
// neighbours never overlap, and the ring shrinks to leave room for them on narrow cards.

interface DonutSlice {
  name: string;
  value: number;
  share: number;
  color: string;
}

const DONUT_START = 90; // the largest product starts at twelve o'clock, clockwise
const LABEL_PITCH = 34; // vertical room for a name line and an amount line
const LABEL_ROOM = 140; // horizontal room kept for the labels on each side of the ring
const INSIDE_SHARE = 7; // slices of at least this percentage carry their share inside
// Below this width there is no room for names beside the ring (phones, narrow cards): the ring
// takes the full width and the names move to a compact list of chips under it.
const COMPACT_WIDTH = 520;

function layoutDonut(slices: DonutSlice[], width: number, height: number, compact: boolean) {
  const cx = width / 2;
  const cy = height / 2;
  const outer = compact
    ? Math.max(56, Math.min(height / 2 - 8, width / 2 - 8))
    : Math.max(56, Math.min(height / 2 - 20, width / 2 - LABEL_ROOM));
  const inner = outer * 0.66;
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  let before = 0;
  const labels = slices.map((slice, index) => {
    const angle = (DONUT_START - ((before + slice.value / 2) / total) * 360) * RADIAN;
    before += slice.value;
    const cos = Math.cos(angle);
    const sin = -Math.sin(angle);
    return { index, cos, sin, side: cos >= 0 ? 1 : -1, y: cy + (outer + 16) * sin };
  });
  // Per side, top to bottom: push each label below its neighbour, then pull the column back up
  // if it ran past the bottom of the card.
  for (const side of [1, -1]) {
    const column = labels.filter((label) => label.side === side).sort((a, b) => a.y - b.y);
    column.forEach((label, i) => {
      label.y = Math.max(label.y, i ? column[i - 1].y + LABEL_PITCH : 18);
    });
    for (let i = column.length - 1; i >= 0; i -= 1)
      column[i].y = Math.min(
        column[i].y,
        i === column.length - 1 ? height - 20 : column[i + 1].y - LABEL_PITCH,
      );
  }
  return { cx, cy, outer, inner, labels };
}

function DonutChart({
  slices,
  formatValue,
  tooltip,
  center,
}: {
  slices: DonutSlice[];
  formatValue: (value: number) => string;
  tooltip: (value: unknown) => string;
  center: ReactNode;
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  const compact = size.width > 0 && size.width < COMPACT_WIDTH;
  const geometry =
    size.width > 0 && size.height > 0
      ? layoutDonut(slices, size.width, size.height, compact)
      : null;
  const shareText = (share: number) =>
    `${share.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

  return (
    <div className={`quick-donut-chart${compact ? ' compact' : ''}`}>
      <div className="donut-ring" ref={setBox}>
        {geometry && (
          <>
            <PieChart
              width={size.width}
              height={size.height}
              margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
            >
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                cx={geometry.cx}
                cy={geometry.cy}
                innerRadius={geometry.inner}
                outerRadius={geometry.outer}
                startAngle={DONUT_START}
                endAngle={DONUT_START - 360}
                paddingAngle={slices.length > 1 ? 1 : 0}
                stroke="#fff"
                strokeWidth={2}
                isAnimationActive={false}
              >
                {slices.map((slice) => (
                  <Cell key={slice.name} fill={slice.color} />
                ))}
              </Pie>
              <Tooltip formatter={tooltip} />
            </PieChart>
            <svg
              className="donut-labels"
              width={size.width}
              height={size.height}
              aria-hidden="true"
            >
              {geometry.labels.map((label) => {
                const slice = slices[label.index];
                const { cx, cy, outer, inner } = geometry;
                const edgeX = cx + outer * label.cos;
                const edgeY = cy + outer * label.sin;
                const bendX = cx + (outer + 10) * label.cos;
                const bendY = cy + (outer + 10) * label.sin;
                const textX = cx + label.side * (outer + 34);
                const anchor = label.side > 0 ? 'start' : 'end';
                const inside = slice.share >= INSIDE_SHARE;
                const share = shareText(slice.share);
                const middle = (inner + outer) / 2;
                const insideLabel = inside && (
                  <text
                    className="donut-label-share"
                    x={cx + middle * label.cos}
                    y={cy + middle * label.sin}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={textOn(slice.color)}
                  >
                    {Math.round(slice.share)}%
                  </text>
                );
                if (compact) return <g key={slice.name}>{insideLabel}</g>;
                return (
                  <g key={slice.name}>
                    <polyline
                      className="donut-leader"
                      points={`${edgeX},${edgeY} ${bendX},${bendY} ${textX - label.side * 6},${label.y}`}
                      stroke={slice.color}
                      fill="none"
                    />
                    <circle cx={edgeX} cy={edgeY} r={2.4} fill={slice.color} />
                    <text
                      className="donut-label-name"
                      x={textX}
                      y={label.y - 8}
                      textAnchor={anchor}
                      dominantBaseline="central"
                    >
                      {slice.name.length > 18 ? `${slice.name.slice(0, 17)}…` : slice.name}
                      <title>{slice.name}</title>
                    </text>
                    <text
                      className="donut-label-value"
                      x={textX}
                      y={label.y + 9}
                      textAnchor={anchor}
                      dominantBaseline="central"
                    >
                      {formatValue(slice.value)}
                      {inside ? '' : ` · ${share}`}
                    </text>
                    {insideLabel}
                  </g>
                );
              })}
            </svg>
            <div
              // A small ring keeps only the total in its hole: the other lines would spill over.
              className={`quick-donut-center${geometry.inner < 70 ? ' tight' : ''}`}
              style={{ '--donut-inner': `${geometry.inner}px` } as React.CSSProperties}
            >
              {center}
            </div>
          </>
        )}
      </div>
      {compact && (
        <ul className="donut-chips">
          {slices.map((slice) => (
            <li key={slice.name}>
              <i style={{ background: slice.color }} />
              <strong title={slice.name}>{slice.name}</strong>
              <span>
                {formatValue(slice.value)} · {shareText(slice.share)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QuickChart({
  widget,
  statistics,
  periodChips,
  periodText,
}: {
  widget: DashboardWidget;
  statistics: QuickStatistic | undefined;
  periodChips: ReactNode;
  periodText: string;
}) {
  const counter = statistics?.metric_kind === 'counter_delta';
  const decimals = widget.config.decimals ?? 1;
  // Decimal places follow the widget configuration ("Casas decimais" in the editor).
  const amount = (value: number | null | undefined) => format(value, decimals);
  const unit = widget.unit ?? '';
  const allProducts = statistics?.product_breakdown ?? [];
  // "Mostrar até N": the smaller products fold into one neutral "Outros" slice or bar.
  const limit = widget.config.maxProducts ?? 0;
  const products =
    limit > 0 && allProducts.length > limit
      ? [
          ...allProducts.slice(0, limit),
          allProducts.slice(limit).reduce(
            (others, product) => ({
              product_code: OTHERS,
              value: others.value + product.value,
              share_percent: others.share_percent + product.share_percent,
            }),
            { product_code: OTHERS, value: 0, share_percent: 0 },
          ),
        ]
      : allProducts;
  const namedCount = products.filter((product) => product.product_code !== OTHERS).length;
  const colors = products.map((product, index) =>
    product.product_code === OTHERS
      ? OTHERS_COLOR
      : seriesColor(widget.config, index, namedCount, product.product_code),
  );
  const total = counter ? statistics?.current_period_value : statistics?.average;
  const change = statistics?.change_percent ?? null;
  const leader = allProducts[0];
  const donut = widget.widget_type === 'donut';
  const horizontal = widget.widget_type === 'bar_horizontal';
  const byDay = widget.config.chartDimension === 'day';
  const accent = widget.config.color ?? '#12b8a6';
  const bars = byDay
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
    : products.map((product) => ({ label: product.product_code, value: product.value }));
  const barColors = byDay ? bars.map(() => accent) : colors;
  const empty = donut ? !products.length : !bars.some((bar) => bar.value > 0);
  const changeText =
    change == null ? '—' : `${change >= 0 ? '▲' : '▼'} ${format(Math.abs(change), 1)}%`;
  const tooltip = (value: unknown) => `${amount(Number(value))} ${unit}`;

  return (
    <div className="quick-chart">
      {periodChips}
      {empty ? (
        <div className="quick-empty">Sem produção no período.</div>
      ) : donut ? (
        <DonutChart
          slices={products.map((product, index) => ({
            name: product.product_code,
            value: product.value,
            share: product.share_percent,
            color: colors[index],
          }))}
          formatValue={(value) => `${amount(value)} ${unit}`.trim()}
          tooltip={tooltip}
          center={
            <>
              <span>{counter ? 'Total' : 'Média'}</span>
              <b>{amount(total)}</b>
              <span>
                {unit} · {periodText}
              </span>
              {change != null && (
                <em className={change < 0 ? 'down' : 'up'}>{changeText} vs. anterior</em>
              )}
            </>
          }
        />
      ) : (
        <div className="quick-layout">
          {/* A div, not an aside: the global aside style is the fixed navigation sidebar. */}
          <div className="quick-kpis" style={{ '--kpi-accent': accent } as React.CSSProperties}>
            <div className="quick-kpi hero">
              <span>
                {counter ? 'Total' : 'Média'} · {periodText}
              </span>
              <strong>
                {amount(total)}
                <small>{unit}</small>
              </strong>
            </div>
            <div className="quick-kpi">
              <span>vs. período anterior</span>
              <strong className={change == null ? '' : change < 0 ? 'down' : 'up'}>
                {changeText}
              </strong>
            </div>
            <div className="quick-kpi">
              <span>{counter ? 'Média por dia' : 'Pico'}</span>
              <strong>
                {counter
                  ? amount(total == null ? null : total / Math.max(1, statistics?.trend_days ?? 1))
                  : amount(statistics?.maximum)}
              </strong>
            </div>
            {leader && (
              <div className="quick-kpi">
                <span>Produto líder</span>
                <strong className="quick-kpi-leader">
                  <i style={{ background: colors[0] ?? accent }} />
                  <em title={leader.product_code}>{leader.product_code}</em>
                </strong>
                <small>{format(leader.share_percent, 1)}% do total</small>
              </div>
            )}
          </div>
          <div className="quick-visual">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={bars}
                layout={horizontal ? 'vertical' : 'horizontal'}
                margin={
                  horizontal
                    ? { top: 4, right: 52, bottom: 0, left: 0 }
                    : { top: 24, right: 8, bottom: 0, left: 0 }
                }
              >
                <CartesianGrid
                  stroke="#e6eef0"
                  strokeDasharray="3 5"
                  vertical={horizontal}
                  horizontal={!horizontal}
                />
                <XAxis
                  type={horizontal ? 'number' : 'category'}
                  dataKey={horizontal ? undefined : 'label'}
                  hide={horizontal}
                  tick={{ fontSize: 10, fill: '#71868d' }}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                />
                <YAxis
                  type={horizontal ? 'category' : 'number'}
                  dataKey={horizontal ? 'label' : undefined}
                  hide={!horizontal}
                  width={horizontal ? 104 : 0}
                  tick={{ fontSize: 11, fill: '#4d6770' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(value) => [tooltip(value), widget.title]}
                  cursor={{ fill: 'rgba(18, 184, 166, 0.06)' }}
                />
                <Bar
                  dataKey="value"
                  radius={horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0]}
                  maxBarSize={horizontal ? 26 : 56}
                  isAnimationActive={false}
                >
                  {bars.map((bar, index) => (
                    <Cell key={bar.label} fill={barColors[index]} />
                  ))}
                  <LabelList
                    dataKey="value"
                    content={valueLabel((value) => amount(value), horizontal, barColors)}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
