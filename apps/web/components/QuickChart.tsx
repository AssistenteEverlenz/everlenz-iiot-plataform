'use client';

import type { ReactNode } from 'react';
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
import { ScrollHint } from './ScrollHint';

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

// Share inside a wide slice; a dot on the edge, an elbow line and the share outside a thin one.
function sliceLabel(colors: string[]) {
  const SliceLabel = (input: object) => {
    const props = input as Record<string, unknown>;
    const cx = Number(props.cx);
    const cy = Number(props.cy);
    const midAngle = Number(props.midAngle);
    const inner = Number(props.innerRadius);
    const outer = Number(props.outerRadius);
    const percent = Number(props.percent);
    const color = colors[Number(props.index)] ?? OTHERS_COLOR;
    const cos = Math.cos(-midAngle * RADIAN);
    const sin = Math.sin(-midAngle * RADIAN);
    if (percent >= 0.07) {
      const radius = inner + (outer - inner) / 2;
      return (
        <text
          x={cx + radius * cos}
          y={cy + radius * sin}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={12}
          fontWeight={700}
          fill={textOn(color)}
        >
          {`${Math.round(percent * 100)}%`}
        </text>
      );
    }
    const side = cos >= 0 ? 1 : -1;
    const edgeX = cx + outer * cos;
    const edgeY = cy + outer * sin;
    const elbowX = cx + (outer + 12) * cos;
    const elbowY = cy + (outer + 12) * sin;
    const endX = elbowX + side * 14;
    return (
      <g>
        <path
          d={`M${edgeX},${edgeY}L${elbowX},${elbowY}L${endX},${elbowY}`}
          stroke={color}
          strokeWidth={1.2}
          fill="none"
        />
        <circle cx={edgeX} cy={edgeY} r={2.6} fill={color} />
        <text
          x={endX + side * 4}
          y={elbowY}
          textAnchor={side > 0 ? 'start' : 'end'}
          dominantBaseline="central"
          fontSize={11}
          fontWeight={700}
          fill="#4d6770"
        >
          {`${(percent * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}
        </text>
      </g>
    );
  };
  return SliceLabel;
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
        <div className="quick-layout is-donut">
          <div className="quick-donut-chart">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={products}
                  dataKey="value"
                  nameKey="product_code"
                  innerRadius="56%"
                  outerRadius="78%"
                  paddingAngle={1}
                  stroke="#fff"
                  strokeWidth={2}
                  label={sliceLabel(colors)}
                  labelLine={false}
                  isAnimationActive={false}
                >
                  {products.map((product, index) => (
                    <Cell key={product.product_code} fill={colors[index]} />
                  ))}
                </Pie>
                <Tooltip formatter={tooltip} />
              </PieChart>
            </ResponsiveContainer>
            <div className="quick-donut-center">
              <span>{counter ? 'Total' : 'Média'}</span>
              <b>{amount(total)}</b>
              <span>
                {unit} · {periodText}
              </span>
              {change != null && (
                <em className={change < 0 ? 'down' : 'up'}>{changeText} vs. anterior</em>
              )}
            </div>
          </div>
          <ScrollHint className="quick-legend-scroll">
            <ol className="quick-legend">
              {products.map((product, index) => (
                <li key={product.product_code}>
                  <span
                    className="quick-badge"
                    style={{ background: colors[index], color: textOn(colors[index]) }}
                  >
                    {product.product_code === OTHERS ? '+' : String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="quick-legend-name">
                    <strong title={product.product_code}>{product.product_code}</strong>
                    <em className="quick-legend-bar">
                      <span
                        style={{
                          width: `${Math.max(3, product.share_percent)}%`,
                          background: colors[index],
                        }}
                      />
                    </em>
                  </span>
                  <span className="quick-legend-value">
                    <b>{format(product.share_percent, 1)}%</b>
                    <small>
                      {amount(product.value)} {unit}
                    </small>
                  </span>
                </li>
              ))}
            </ol>
          </ScrollHint>
        </div>
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
