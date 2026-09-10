'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePoll, type Dashboard, type Device } from './data';

// Gestão à Vista: a wall-display board for the plant owner. Everything fits one 16:9
// screen without scrolling, because nobody operates a mouse in front of a TV.

interface ProductShare {
  product_code: string;
  value: number;
  share_percent: number;
}
interface Range {
  total: number;
  products: ProductShare[];
}
interface MetricSummary {
  configured: boolean;
  today: Range;
  yesterday: Range;
  last7: Range;
  month: Range;
  year: Range;
  average_per_day_7d: number;
  best_day_30d: { date: string; total: number } | null;
  weekday_average: Array<{ weekday: number; average: number }>;
  daily: Array<{ date: string; total: number; products: Record<string, number> }>;
}
interface Overview {
  generated_at: string;
  today: string;
  roles: {
    inferred: boolean;
    pallets: string | null;
    blocks: string | null;
    tons_total: string | null;
    rate: string | null;
    run_status: string | null;
    tons_source: 'counter' | 'rate_integral' | null;
  };
  pallets: MetricSummary;
  blocks: MetricSummary;
  tons: MetricSummary;
  current: { rate_tph: number | null; running: boolean | null; last_message_at: string | null };
  oee: {
    availability: number | null;
    performance: number | null;
    quality: number | null;
    running_hours_today: number | null;
    planned_hours_today: number;
    average_rate_while_running: number | null;
    missing: string[];
  };
}

const palette = [
  '#12b8a6',
  '#2f6fed',
  '#f2a93b',
  '#e4572e',
  '#7b5ea7',
  '#2bb3e6',
  '#8aa29e',
  '#d65db1',
];
const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function fmt(value: number | null | undefined, decimals = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
function dayLabel(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
  });
}
function percent(value: number | null) {
  return value == null ? '—' : `${fmt(value * 100, 0)}%`;
}

export function ProductionBoard({ id }: { id: string }) {
  const dashboard = usePoll<Dashboard>(`/dashboards/${id}`, 60000);
  const deviceId = dashboard.data?.device_id ?? null;
  const device = usePoll<Device>(deviceId ? `/devices/${deviceId}` : null, 60000);
  const overview = usePoll<Overview>(
    deviceId ? `/devices/${deviceId}/production-overview` : null,
    30000,
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const data = overview.data;
  // One stable colour per product across every chart on the board.
  const colors = useMemo(() => {
    const names = new Set<string>();
    for (const metric of [data?.pallets, data?.tons, data?.blocks])
      for (const product of metric?.year.products ?? []) names.add(product.product_code);
    for (const day of data?.pallets.daily ?? [])
      Object.keys(day.products).forEach((name) => names.add(name));
    return new Map([...names].map((name, index) => [name, palette[index % palette.length]]));
  }, [data]);
  const products = [...colors.keys()];
  const mix = data?.tons.configured && data.tons.today.total > 0 ? data.tons : data?.pallets;
  const mixUnit = mix === data?.tons ? 't' : 'paletes';
  const staleSeconds = data?.current.last_message_at
    ? Math.round((now.getTime() - new Date(data.current.last_message_at).getTime()) / 1000)
    : null;
  const online = staleSeconds != null && staleSeconds < 60;

  return (
    <div className="tv-board">
      <header className="tv-board-header">
        <div>
          <span className="tv-eyebrow">GESTÃO À VISTA · PRODUÇÃO</span>
          <h1>{device.data?.name ?? dashboard.data?.name ?? 'Carregando…'}</h1>
          <small>{device.data?.site_name ?? ''}</small>
        </div>
        <div className="tv-board-status">
          <span className={`tv-pill ${data?.current.running ? 'running' : 'stopped'}`}>
            {data?.current.running == null
              ? 'Sem status'
              : data.current.running
                ? '● Linha rodando'
                : '● Linha parada'}
          </span>
          <span className={`tv-pill ${online ? 'online' : 'offline'}`}>
            {online
              ? 'Comunicando'
              : staleSeconds == null
                ? 'Sem dados'
                : `Sem dados há ${fmt(staleSeconds / 60)} min`}
          </span>
          <strong className="tv-clock">
            {now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            <small>
              {now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}
            </small>
          </strong>
          <Link className="tv-board-exit" href={`/dashboards/${id}`} aria-label="Sair da TV">
            ✕
          </Link>
        </div>
      </header>

      {overview.error && <div className="tv-board-error">{overview.error}</div>}

      <section className="tv-kpis">
        <Kpi
          label="Paletes hoje"
          value={fmt(data?.pallets.today.total)}
          detail={`Ontem (dia inteiro): ${fmt(data?.pallets.yesterday.total)}`}
          missing={data && !data.pallets.configured ? 'Defina a variável de paletes' : null}
        />
        <Kpi
          label="Toneladas hoje"
          value={fmt(data?.tons.today.total, 1)}
          unit="t"
          detail={`Ontem: ${fmt(data?.tons.yesterday.total, 1)} t${data?.roles.tons_source === 'rate_integral' ? ' · estimado pela t/h' : ''}`}
          missing={data && !data.tons.configured ? 'Envie t/h ou totalizador de toneladas' : null}
        />
        <Kpi
          label="Blocos hoje"
          value={fmt(data?.blocks.today.total)}
          detail={`Ontem: ${fmt(data?.blocks.yesterday.total)}`}
          missing={
            data && !data.blocks.configured ? 'A IHM ainda não envia o contador de blocos' : null
          }
        />
        <Kpi
          label="Ritmo agora"
          value={fmt(data?.current.rate_tph, 1)}
          unit="t/h"
          detail={`Média operando hoje: ${fmt(data?.oee.average_rate_while_running, 1)} t/h`}
          missing={data && !data.roles.rate ? 'Defina a variável de t/h' : null}
        />
        <Kpi
          label="Disponibilidade hoje"
          value={percent(data?.oee.availability ?? null)}
          detail={`${fmt(data?.oee.running_hours_today, 1)} h rodando de ${fmt(data?.oee.planned_hours_today, 1)} h`}
          missing={data && !data.roles.run_status ? 'Defina a variável de linha rodando' : null}
        />
      </section>

      <section className="tv-row tv-row-charts">
        <article className="tv-card tv-span-2">
          <div className="tv-card-title">
            <strong>Paletes por dia · últimos 14 dias</strong>
            <span>
              Média 7 dias: <b>{fmt(data?.pallets.average_per_day_7d, 1)}</b>/dia · Melhor dia (30
              d):{' '}
              <b>
                {data?.pallets.best_day_30d
                  ? `${dayLabel(data.pallets.best_day_30d.date)} · ${fmt(data.pallets.best_day_30d.total)}`
                  : '—'}
              </b>
            </span>
          </div>
          <div className="tv-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={(data?.pallets.daily ?? []).map((day) => ({
                  date: day.date,
                  ...day.products,
                }))}
              >
                <CartesianGrid stroke="#27434c" strokeDasharray="3 6" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={dayLabel}
                  tick={{ fill: '#9fb8bc', fontSize: 14 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#9fb8bc', fontSize: 14 }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
                <Tooltip labelFormatter={(item) => dayLabel(String(item))} />
                {products.map((product) => (
                  <Bar
                    key={product}
                    dataKey={product}
                    stackId="day"
                    fill={colors.get(product)}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>
        <article className="tv-card">
          <div className="tv-card-title">
            <strong>Mix de produtos hoje</strong>
            <span>{mixUnit === 't' ? 'em toneladas' : 'em paletes'}</span>
          </div>
          <div className="tv-mix">
            <div className="tv-donut">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={mix?.today.products ?? []}
                    dataKey="value"
                    nameKey="product_code"
                    innerRadius="58%"
                    outerRadius="95%"
                    stroke="none"
                    isAnimationActive={false}
                  >
                    {(mix?.today.products ?? []).map((product) => (
                      <Cell key={product.product_code} fill={colors.get(product.product_code)} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <span>
                <b>{fmt(mix?.today.total, mixUnit === 't' ? 1 : 0)}</b>
                {mixUnit}
              </span>
            </div>
            <Legend
              items={mix?.today.products ?? []}
              colors={colors}
              decimals={mixUnit === 't' ? 1 : 0}
              unit={mixUnit}
            />
          </div>
        </article>
      </section>

      <section className="tv-row">
        <article className="tv-card">
          <div className="tv-card-title">
            <strong>Ranking de produtos · paletes</strong>
          </div>
          <div className="tv-ranking">
            <Ranking title="7 dias" range={data?.pallets.last7} colors={colors} />
            <Ranking title="Mês" range={data?.pallets.month} colors={colors} />
            <Ranking title="Ano" range={data?.pallets.year} colors={colors} />
          </div>
        </article>
        <article className="tv-card">
          <div className="tv-card-title">
            <strong>Acumulados</strong>
          </div>
          <table className="tv-totals">
            <thead>
              <tr>
                <th />
                <th>Hoje</th>
                <th>7 dias</th>
                <th>Mês</th>
                <th>Ano</th>
              </tr>
            </thead>
            <tbody>
              <TotalsRow label="Paletes" metric={data?.pallets} decimals={0} />
              <TotalsRow label="Toneladas" metric={data?.tons} decimals={1} />
              <TotalsRow label="Blocos" metric={data?.blocks} decimals={0} />
            </tbody>
          </table>
        </article>
        <article className="tv-card">
          <div className="tv-card-title">
            <strong>Média por dia da semana</strong>
            <span>paletes · últimas 8 semanas</span>
          </div>
          <div className="tv-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={(data?.pallets.weekday_average ?? []).map((day) => ({
                  name: weekdayNames[day.weekday],
                  value: day.average,
                }))}
              >
                <XAxis
                  dataKey="name"
                  tick={{ fill: '#9fb8bc', fontSize: 14 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip formatter={(item) => fmt(Number(item), 1)} />
                <Bar
                  dataKey="value"
                  fill="#12b8a6"
                  radius={[6, 6, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>
      </section>

      <footer className="tv-board-footer">
        {data?.roles.inferred && <span>Papéis das variáveis identificados automaticamente.</span>}
        {data && data.oee.missing.length > 0 && (
          <span>OEE completo aguarda: {data.oee.missing.join(' · ')}</span>
        )}
        <span>
          Atualizado {data ? new Date(data.generated_at).toLocaleTimeString('pt-BR') : '—'}
        </span>
      </footer>
    </div>
  );
}

function Kpi(props: {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  missing: string | null;
}) {
  return (
    <article className={`tv-kpi ${props.missing ? 'missing' : ''}`}>
      <span>{props.label}</span>
      {props.missing ? (
        <em>{props.missing}</em>
      ) : (
        <strong>
          {props.value}
          {props.unit && <small>{props.unit}</small>}
        </strong>
      )}
      {/* A comparison without a measured variable would read as a real zero. */}
      {!props.missing && <p>{props.detail}</p>}
    </article>
  );
}

function Legend(props: {
  items: ProductShare[];
  colors: Map<string, string>;
  decimals: number;
  unit: string;
}) {
  if (!props.items.length) return <p className="tv-empty">Sem produção registrada hoje.</p>;
  return (
    <ul className="tv-legend">
      {props.items.slice(0, 6).map((item) => (
        <li key={item.product_code}>
          <i style={{ background: props.colors.get(item.product_code) }} />
          <span>{item.product_code}</span>
          <b>
            {fmt(item.value, props.decimals)} {props.unit}
          </b>
          <small>{fmt(item.share_percent, 0)}%</small>
        </li>
      ))}
    </ul>
  );
}

function Ranking(props: { title: string; range: Range | undefined; colors: Map<string, string> }) {
  return (
    <div className="tv-ranking-column">
      <h3>{props.title}</h3>
      {(props.range?.products ?? []).slice(0, 5).map((product, index) => (
        <div key={product.product_code} className="tv-ranking-row">
          <span className="tv-rank">{index + 1}</span>
          <div>
            <strong>{product.product_code}</strong>
            <i>
              <span
                style={{
                  width: `${Math.max(4, product.share_percent)}%`,
                  background: props.colors.get(product.product_code),
                }}
              />
            </i>
          </div>
          <b>{fmt(product.value)}</b>
        </div>
      ))}
      {!props.range?.products.length && <p className="tv-empty">Sem produção.</p>}
    </div>
  );
}

function TotalsRow(props: { label: string; metric: MetricSummary | undefined; decimals: number }) {
  const cell = (range: Range | undefined) =>
    props.metric?.configured ? fmt(range?.total, props.decimals) : '—';
  return (
    <tr>
      <th>{props.label}</th>
      <td>{cell(props.metric?.today)}</td>
      <td>{cell(props.metric?.last7)}</td>
      <td>{cell(props.metric?.month)}</td>
      <td>{cell(props.metric?.year)}</td>
    </tr>
  );
}
