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
// side panel of totals turns each chart into a readable report rather than a bare plot.

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
const colorOf = (index: number) => productPalette[index % productPalette.length];
const RADIAN = Math.PI / 180;

function format(value: number | null | undefined, decimals: number) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Label renderer for recharts bars: inside the bar in bold white when the text fits,
 * otherwise outside with a short tick, so small bars never hide or clip their value.
 */
export function valueLabel(formatValue: (value: number) => string, horizontal = false) {
  // recharts passes its own LabelProps; read the geometry off it generically.
  const LabelContent = (input: object) => {
    const props = input as Record<string, unknown>;
    const value = Number(props.value);
    if (!Number.isFinite(value) || value === 0) return null;
    const x = Number(props.x);
    const y = Number(props.y);
    const width = Number(props.width);
    const height = Number(props.height);
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
          fill={inside ? '#fff' : '#182e38'}
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
          fill="#fff"
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
function sliceLabel(input: object) {
  const props = input as Record<string, unknown>;
  const cx = Number(props.cx);
  const cy = Number(props.cy);
  const midAngle = Number(props.midAngle);
  const inner = Number(props.innerRadius);
  const outer = Number(props.outerRadius);
  const percent = Number(props.percent);
  const index = Number(props.index);
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
        fill="#fff"
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
        stroke={colorOf(index)}
        strokeWidth={1.2}
        fill="none"
      />
      <circle cx={edgeX} cy={edgeY} r={2.6} fill={colorOf(index)} />
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
  const products = statistics?.product_breakdown ?? [];
  const total = counter ? statistics?.current_period_value : statistics?.average;
  const change = statistics?.change_percent ?? null;
  const leader = products[0];
  const donut = widget.widget_type === 'donut';
  const horizontal = widget.widget_type === 'bar_horizontal';
  const byDay = widget.config.chartDimension === 'day';
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
        color: widget.config.color ?? '#12b8a6',
      }))
    : products.map((product, index) => ({
        label: product.product_code,
        value: product.value,
        color: colorOf(index),
      }));
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
                  label={sliceLabel}
                  labelLine={false}
                  isAnimationActive={false}
                >
                  {products.map((product, index) => (
                    <Cell key={product.product_code} fill={colorOf(index)} />
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
                  <span className="quick-badge" style={{ background: colorOf(index) }}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="quick-legend-name">
                    <strong title={product.product_code}>{product.product_code}</strong>
                    <em className="quick-legend-bar">
                      <span
                        style={{
                          width: `${Math.max(3, product.share_percent)}%`,
                          background: colorOf(index),
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
          <aside className="quick-kpis">
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
                  ? amount(
                      total == null
                        ? null
                        : Math.round((total / Math.max(1, statistics?.trend_days ?? 1)) * 10) / 10,
                    )
                  : amount(statistics?.maximum)}
              </strong>
            </div>
            {leader && (
              <div className="quick-kpi">
                <span>Produto líder</span>
                <strong className="quick-kpi-leader">
                  <i style={{ background: colorOf(0) }} />
                  <em title={leader.product_code}>{leader.product_code}</em>
                </strong>
                <small>{format(leader.share_percent, 1)}% do total</small>
              </div>
            )}
          </aside>
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
                  maxBarSize={horizontal ? 26 : 46}
                  isAnimationActive={false}
                >
                  {bars.map((bar) => (
                    <Cell key={bar.label} fill={bar.color} />
                  ))}
                  <LabelList
                    dataKey="value"
                    content={valueLabel((value) => amount(value), horizontal)}
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
