'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePoll } from './data';
import { useFirstDraw } from './firstDraw';
import { InfoTip } from './InfoTip';
import { AXIS, color, delta, Delta, endLabel, Head, HIT, MISS, NEAR } from './MortarProduction';
import { PRODUCT_COLORS, percent } from './mortarShared';
import { duration, formatNumber, metricInfo, stateInfo, type ProductionMetric } from './ShiftBoard';

/**
 * The Produção page of a ceramic line, beyond the history table: where the period stands
 * (Resumo), what was made (Produtos), where the time went (Tempo e paradas) and how it compares
 * (Comparar). Everything is read from the same shift rows as the table and the same stop record
 * as the board, so no figure here can disagree with them.
 *
 * One standard for every plant: bricks (milheiros) first, then tons, then pallets; a line that
 * does not count pallets (bricks counted by hand into pallets later) simply has no pallet
 * figures, never a zero. Every figure says beside it what it is, behind an "i".
 */

export type CeramicTab = 'summary' | 'days' | 'products' | 'time' | 'compare';
export type Against = 'previous' | 'year';
export interface CeramicRow {
  date: string;
  shift: string;
  offShift: boolean;
  open: boolean;
  source: 'auto' | 'manual' | null;
  pieces: number;
  pallets: number;
  tons: number;
  producing: number;
  idle: number;
  manual: number;
  offline: number;
  planned: number;
  target: number | null;
  targetMetric: ProductionMetric | null;
  products: Array<{ product_code: string; pieces: number; pallets: number; tons: number }>;
}
type Totals = { pieces: number; pallets: number; tons: number };
type Day = Totals & {
  date: string;
  target: number;
  achieved: number;
  metric: ProductionMetric | null;
  open: boolean;
  producing: number;
  idle: number;
  products: Map<string, Totals>;
};
interface StopsData {
  time: {
    producing: number;
    idle: number;
    manual: number;
    offline: number;
    plannedSeconds: number;
  };
  all: Array<{
    startedAt: string;
    seconds: number;
    state: 'idle' | 'manual' | 'offline';
    planned: boolean;
    micro: boolean;
    date: string;
    product: string | null;
  }>;
  days: Array<{ date: string; stops: number; seconds: number; longestSeconds: number }>;
  reasons: Array<{ state: 'idle' | 'manual' | 'offline'; stops: number; seconds: number }>;
  micro: { stops: number; seconds: number };
  longest: Array<{
    startedAt: string;
    seconds: number;
    state: 'idle' | 'manual' | 'offline';
    product: string | null;
  }>;
}

// ---- Sections ---------------------------------------------------------------------------------

const TABS: Array<[CeramicTab, string, string, string]> = [
  ['summary', 'Resumo', 'Como foi o período', 'M4 20V10M10 20V4M16 20v-7M22 20H2'],
  [
    'days',
    'Dia a dia',
    'Cada turno e cada dia',
    'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 12h2M14 12h2M8 16h2',
  ],
  [
    'products',
    'Produtos',
    'O que foi produzido',
    'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
  ],
  [
    'time',
    'Tempo e paradas',
    'Onde a linha perde tempo',
    'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  ],
  [
    'compare',
    'Comparar',
    'Um período contra outro',
    'M7 4v16M7 4L3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4',
  ],
];

/** The page's sections, in the same band as the panel tabs. */
export function CeramicTabs({
  tab,
  onPick,
}: {
  tab: CeramicTab;
  onPick: (tab: CeramicTab) => void;
}) {
  return (
    <div className="dashboard-tabs" role="tablist" aria-label="Seções da produção">
      {TABS.map(([id, name, hint, icon]) => (
        <div key={id} className={`dashboard-tab${tab === id ? ' active' : ''}`}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-label={name}
            title={hint}
            onClick={() => onPick(id)}
          >
            <span className="dashboard-tab-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={icon} />
              </svg>
            </span>
            <span className="dashboard-tab-text">
              <b>{name}</b>
              <small>{hint}</small>
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}

// ---- Dates ------------------------------------------------------------------------------------

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const addDays = (date: string, days: number) => {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const brDay = (date: string) => date.split('-').reverse().slice(0, 2).join('/');
const plantToday = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
const minusYear = (date: string) => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;

export function compareRange(from: string, to: string, against: Against) {
  if (against === 'year') return { from: minusYear(from), to: minusYear(to) };
  const length = daysBetween(from, to) + 1;
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

// ---- Figures ----------------------------------------------------------------------------------

const mil = (pieces: number) => formatNumber(pieces / 1000, pieces >= 100_000 ? 0 : 1);
const t = (value: number) => formatNumber(value, value >= 100 ? 0 : 1);
const whole = (value: number) => formatNumber(Math.round(value));
const metricOf = (totals: Totals, metric: ProductionMetric) =>
  metric === 'milheiros'
    ? totals.pieces / 1000
    : metric === 'blocks'
      ? totals.pieces
      : metric === 'pallets'
        ? totals.pallets
        : totals.tons;
const inMetric = (value: number, metric: ProductionMetric | null) =>
  metric
    ? `${formatNumber(value, metricInfo[metric].decimals)} ${metricInfo[metric].unit}`
    : formatNumber(value);
const reach = (achieved: number, target: number) =>
  !target ? null : achieved >= target ? HIT : achieved >= target * 0.9 ? NEAR : MISS;
/** Reference lines and their labels: dark ink on the light theme, light ink on the dark one. */
const INK = 'var(--chart-ink, #0b2028)';
const STATE_TEXT = {
  idle: 'linha parada (contador sem contar)',
  manual: 'máquina em manual',
  offline: 'sem comunicação com a IHM',
} as const;

/** The period's shift rows folded into days, products and shifts. Partials never count twice. */
function fold(rows: CeramicRow[]) {
  const counted = rows.filter((row) => row.source !== 'manual');
  const days = new Map<string, Day>();
  const products = new Map<string, Totals & { days: Set<string> }>();
  const shifts = new Map<
    string,
    Totals & { reports: number; producing: number; idle: number; target: number; achieved: number }
  >();
  const sum = { pieces: 0, pallets: 0, tons: 0, producing: 0, idle: 0, manual: 0, offline: 0 };
  for (const row of counted) {
    sum.pieces += row.pieces;
    sum.pallets += row.pallets;
    sum.tons += row.tons;
    sum.producing += row.producing;
    sum.idle += row.idle;
    sum.manual += row.manual;
    sum.offline += row.offline;
    const day = days.get(row.date) ?? {
      date: row.date,
      pieces: 0,
      pallets: 0,
      tons: 0,
      target: 0,
      achieved: 0,
      metric: null,
      open: false,
      producing: 0,
      idle: 0,
      products: new Map(),
    };
    day.pieces += row.pieces;
    day.pallets += row.pallets;
    day.tons += row.tons;
    day.producing += row.producing;
    day.idle += row.idle;
    day.open = day.open || row.open;
    if (row.target && row.targetMetric) {
      day.target += row.target;
      day.achieved += metricOf(row, row.targetMetric);
      day.metric = row.targetMetric;
    }
    for (const item of row.products) {
      const code = item.product_code || 'Sem produto';
      const own = day.products.get(code) ?? { pieces: 0, pallets: 0, tons: 0 };
      own.pieces += Number(item.pieces);
      own.pallets += Number(item.pallets);
      own.tons += Number(item.tons);
      day.products.set(code, own);
      const all = products.get(code) ?? { pieces: 0, pallets: 0, tons: 0, days: new Set() };
      all.pieces += Number(item.pieces);
      all.pallets += Number(item.pallets);
      all.tons += Number(item.tons);
      if (Number(item.pieces) || Number(item.pallets)) all.days.add(row.date);
      products.set(code, all);
    }
    days.set(row.date, day);
    if (!row.offShift) {
      const shift = shifts.get(row.shift) ?? {
        pieces: 0,
        pallets: 0,
        tons: 0,
        reports: 0,
        producing: 0,
        idle: 0,
        target: 0,
        achieved: 0,
      };
      shift.reports += 1;
      shift.pieces += row.pieces;
      shift.pallets += row.pallets;
      shift.tons += row.tons;
      shift.producing += row.producing;
      shift.idle += row.idle;
      if (row.target && row.targetMetric) {
        shift.target += row.target;
        shift.achieved += metricOf(row, row.targetMetric);
      }
      shifts.set(row.shift, shift);
    }
  }
  const worked = [...days.values()].filter((day) => day.pieces > 0 || day.pallets > 0);
  const closed = worked.filter((day) => !day.open);
  const withTarget = [...days.values()].filter(
    (day) => day.target > 0 && (!day.open || day.achieved >= day.target),
  );
  const hit = withTarget.filter((day) => day.achieved >= day.target);
  const best = [...worked].sort((a, b) => b.tons - a.tons || b.pieces - a.pieces)[0] ?? null;
  const productList = [...products.entries()]
    .map(([code, item]) => ({ code, ...item, days: item.days.size }))
    .filter((item) => item.pieces > 0 || item.pallets > 0)
    .sort((a, b) => b.pieces - a.pieces || b.pallets - a.pallets);
  const productTotal = productList.reduce(
    (total, item) => total + (item.pieces || item.pallets),
    0,
  );
  let running = 0;
  const ranked = productList.map((item) => {
    const share = productTotal ? (item.pieces || item.pallets) / productTotal : 0;
    // The class goes by what came before it: the product that crosses 80 % is still an A.
    const before = running;
    running += share;
    return { ...item, share, abc: before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C' };
  });
  const perDay = (value: number) => (worked.length ? value / worked.length : 0);
  return {
    totals: sum,
    days,
    worked,
    closed,
    best,
    daysHit: hit.length,
    daysWithTarget: withTarget.length,
    target: withTarget.reduce((total, day) => total + day.target, 0),
    achieved: withTarget.reduce((total, day) => total + day.achieved, 0),
    metric: [...days.values()].find((day) => day.metric)?.metric ?? null,
    utilization: sum.producing + sum.idle > 0 ? sum.producing / (sum.producing + sum.idle) : null,
    perDay: { pieces: perDay(sum.pieces), pallets: perDay(sum.pallets), tons: perDay(sum.tons) },
    products: ranked,
    shifts: [...shifts.entries()]
      .map(([name, item]) => ({
        name,
        ...item,
        perReport: item.reports ? item.pieces / item.reports : 0,
        perHour: item.producing > 0 ? item.pieces / (item.producing / 3600) : null,
        utilization:
          item.producing + item.idle > 0 ? item.producing / (item.producing + item.idle) : null,
      }))
      .sort((a, b) => b.reports - a.reports),
  };
}
type Folded = ReturnType<typeof fold>;

/** The period's days, one slot each; past two months a slot is a week, past seven a month. */
function slotsOf(from: string, to: string, days: Map<string, Day>) {
  const span = daysBetween(from, to) + 1;
  const group = span > 210 ? 'month' : span > 62 ? 'week' : 'day';
  const slots = new Map<
    string,
    Totals & {
      label: string;
      target: number;
      achieved: number;
      products: Map<string, number>;
      date: string;
    }
  >();
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const key =
      group === 'month'
        ? date.slice(0, 7)
        : group === 'week'
          ? addDays(date, -((weekdayOf(date) + 6) % 7))
          : date;
    const label =
      group === 'month'
        ? `${MONTHS[Number(key.slice(5, 7)) - 1]}/${key.slice(2, 4)}`
        : group === 'week'
          ? `sem. ${brDay(key)}`
          : brDay(key);
    const slot = slots.get(key) ?? {
      label,
      date: key,
      pieces: 0,
      pallets: 0,
      tons: 0,
      target: 0,
      achieved: 0,
      products: new Map(),
    };
    const day = days.get(date);
    if (day) {
      slot.pieces += day.pieces;
      slot.pallets += day.pallets;
      slot.tons += day.tons;
      if (day.target && (!day.open || day.achieved >= day.target)) {
        slot.target += day.target;
        slot.achieved += day.achieved;
      }
      for (const [code, item] of day.products)
        slot.products.set(code, (slot.products.get(code) ?? 0) + item.pieces);
    }
    slots.set(key, slot);
  }
  return { group, slots: [...slots.values()] };
}

// ---- The page ---------------------------------------------------------------------------------

export function CeramicProduction({
  tab,
  deviceId,
  siteId,
  rows,
  from,
  to,
  against,
  onDay,
  daysTab,
}: {
  tab: CeramicTab;
  deviceId: string;
  siteId: string;
  rows: CeramicRow[];
  from: string;
  to: string;
  against: Against;
  /** Opens a day as the history table does. */
  onDay: (date: string) => void;
  /** The day-by-day tab is the page's own calendar and table. */
  daysTab: ReactNode;
}) {
  const config = usePoll<{ blocks_tag_id: string | null; pallets_tag_id: string | null }>(
    `/devices/${deviceId}/production-config`,
    600000,
  );
  const range = compareRange(from, to, against);
  const before = usePoll<{ reports: Array<Record<string, unknown>> }>(
    `/devices/${deviceId}/shift-reports?from=${range.from}&to=${range.to}`,
    300000,
  );
  // The stop record reaches 180 days back at most.
  const stopsFrom = daysBetween(from, to) > 179 ? addDays(to, -179) : from;
  const stops = usePoll<StopsData>(
    tab === 'time' || tab === 'summary'
      ? `/devices/${deviceId}/stops?from=${stopsFrom}&to=${to}`
      : null,
    300000,
  );
  const calendar = usePoll<{ shifts: Array<{ weekdays: number[] }> }>(
    `/sites/${siteId}/shifts`,
    600000,
  );

  const now = useMemo(() => fold(rows), [rows]);
  const earlier = useMemo(
    () => (before.data ? fold((before.data.reports ?? []).map(toCeramicRow)) : null),
    [before.data],
  );
  // A period before the line came onto the platform holds a few days at most: against it every
  // figure would read "+1.000 %". It only counts with most of the days the current one has.
  const comparable =
    earlier != null && earlier.worked.length >= Math.max(3, now.worked.length * 0.6);
  const was = comparable ? earlier : null;
  const counts = {
    pieces: config.data ? Boolean(config.data.blocks_tag_id) : now.totals.pieces > 0,
    pallets: config.data ? Boolean(config.data.pallets_tag_id) : now.totals.pallets > 0,
  };

  if (tab === 'days') return <>{daysTab}</>;
  if (!rows.length && !before.data) return <div className="card empty">Carregando…</div>;
  if (tab === 'summary')
    return (
      <Summary
        now={now}
        was={was}
        from={from}
        to={to}
        against={against}
        counts={counts}
        stops={stops.data ?? null}
        workWeekdays={calendar.data?.shifts.flatMap((shift) => shift.weekdays) ?? null}
        onDay={onDay}
        thinBefore={earlier != null && !comparable}
      />
    );
  if (tab === 'products') return <Products now={now} from={from} to={to} counts={counts} />;
  if (tab === 'time')
    return (
      <TimeTab
        stops={stops.data ?? null}
        error={stops.error ?? undefined}
        clipped={stopsFrom !== from}
      />
    );
  return (
    <Compare
      now={now}
      was={earlier}
      against={against}
      counts={counts}
      thin={earlier != null && !comparable}
    />
  );
}

/** A stored report, as the shift-reports route answers it, in this page's shape. */
export function toCeramicRow(report: Record<string, unknown>): CeramicRow {
  const number = (value: unknown) => Number(value ?? 0);
  return {
    date: String(report.production_date),
    shift: String(report.shift_name),
    offShift: report.kind === 'off_shift',
    open: Boolean(report.open),
    source: (report.source as CeramicRow['source']) ?? null,
    pieces: number(report.pieces),
    pallets: number(report.pallets),
    tons: number(report.tons),
    producing: number(report.producing_s),
    idle: number(report.idle_s),
    manual: number(report.manual_s),
    offline: number(report.offline_s),
    planned: number(report.planned_seconds),
    target: report.target_value == null ? null : number(report.target_value),
    targetMetric: (report.target_metric as ProductionMetric | null) ?? null,
    products: (report.products as CeramicRow['products']) ?? [],
  };
}

// ---- Resumo -----------------------------------------------------------------------------------

function Kpi({
  label,
  info,
  hero,
  children,
  sub,
}: {
  label: string;
  info: string;
  hero?: boolean;
  children: ReactNode;
  sub: ReactNode;
}) {
  return (
    <div className={`shift-kpi${hero ? ' hero' : ''}`}>
      <span className="cp-kpi-label">
        {label} <InfoTip text={info} />
      </span>
      <b>{children}</b>
      <em>{sub}</em>
    </div>
  );
}

function Summary({
  now,
  was,
  from,
  to,
  against,
  counts,
  stops,
  workWeekdays,
  onDay,
  thinBefore,
}: {
  now: Folded;
  was: Folded | null;
  from: string;
  to: string;
  against: Against;
  counts: { pieces: boolean; pallets: boolean };
  stops: StopsData | null;
  workWeekdays: number[] | null;
  onDay: (date: string) => void;
  /** The period before has too few days on the platform to compare with. */
  thinBefore: boolean;
}) {
  const { totals } = now;
  const versus = against === 'year' ? 'no mesmo período do ano passado' : 'no período anterior';
  const change = delta(
    totals.tons || totals.pieces,
    was ? was.totals.tons || was.totals.pieces : null,
  );
  const targetShare = now.target ? now.achieved / now.target : null;
  // Stops of the line only: time without the HMI is told apart (see the Tempo e paradas tab).
  const failures = stops
    ? stops.all.filter((stop) => !stop.planned && !stop.micro && stop.state !== 'offline').length
    : null;
  const stoppedSeconds = stops ? stops.time.idle + stops.time.manual : null;
  const projection = useMemo(
    () => projectMonth(now, from, to, workWeekdays),
    [now, from, to, workWeekdays],
  );
  // A line whose HMI sends no recipe has one product only ("ITEM GERAL"): nothing to rank.
  const top = now.products.length > 1 ? now.products[0] : null;

  return (
    <div className="mp-overview">
      <p className="mp-headline">
        De {brDay(from)} a {brDay(to)} a linha produziu{' '}
        {counts.pieces && (
          <>
            <b>{mil(totals.pieces)} milheiros</b> de tijolos
          </>
        )}
        {totals.tons > 0 && (
          <>
            {counts.pieces ? ', ' : ' '}
            <b>{t(totals.tons)} t</b>
          </>
        )}
        {counts.pallets && totals.pallets > 0 && (
          <>
            {' '}
            em <b>{whole(totals.pallets)} paletes</b>
          </>
        )}
        {change != null && Math.abs(change) >= 0.005 && (
          <>
            ,{' '}
            <b className={change > 0 ? 'up' : 'down'}>
              {percent(Math.abs(change), 0)} {change > 0 ? 'a mais' : 'a menos'}
            </b>{' '}
            que {versus}
          </>
        )}
        .{' '}
        {thinBefore && (
          <>
            O período anterior tem poucos dias registrados na plataforma, então não há
            comparação.{' '}
          </>
        )}
        {now.daysWithTarget > 0 && (
          <>
            A meta foi batida em{' '}
            <b>
              {now.daysHit} de {now.daysWithTarget} dias
            </b>
            .{' '}
          </>
        )}
        {now.best && (
          <>
            O melhor dia foi <b>{brDay(now.best.date)}</b>, com{' '}
            {now.best.tons ? `${t(now.best.tons)} t` : `${mil(now.best.pieces)} milheiros`}
            {top ? ', e o produto que mais saiu foi o ' : '. '}
            {top && (
              <>
                <b>{top.code}</b> ({percent(top.share, 0)}).{' '}
              </>
            )}
          </>
        )}
        {projection && (
          <>
            No ritmo atual o mês fecha com cerca de{' '}
            <b>
              {counts.pieces
                ? `${mil(projection.pieces)} milheiros`
                : `${whole(projection.pallets)} paletes`}
            </b>
            {projection.perDayNeeded != null && now.metric && (
              <>
                {projection.perDayNeeded <= 0 ? (
                  <>
                    {' '}
                    e a meta do mês <b className="up">já está garantida</b>
                  </>
                ) : (
                  <>
                    ; para bater a meta do mês faltam{' '}
                    <b>{inMetric(projection.perDayNeeded, now.metric)} por dia</b>
                  </>
                )}
              </>
            )}
            .
          </>
        )}
      </p>

      <div className={`mp-kpis cp-kpis${counts.pallets ? '' : ' no-pallets'}`}>
        <Kpi
          hero
          label="Tijolos"
          info="Tijolos (peças) contados pela máquina no período, em milheiros: 1 milheiro = 1.000 peças. Soma de todos os turnos e da produção fora de turno."
          sub={
            <>
              {whole(totals.pieces)} peças · {mil(now.perDay.pieces)} mil/dia{' '}
              <Delta value={delta(totals.pieces, was?.totals.pieces)} />
            </>
          }
        >
          {mil(totals.pieces)} <small>milheiros</small>
        </Kpi>
        <Kpi
          label="Toneladas"
          info="Peso produzido: as peças contadas vezes o peso de cada peça do produto (ou o contador de toneladas da IHM, quando existe)."
          sub={
            <>
              {t(now.perDay.tons)} t por dia <Delta value={delta(totals.tons, was?.totals.tons)} />
            </>
          }
        >
          {t(totals.tons)} <small>t</small>
        </Kpi>
        {counts.pallets && (
          <Kpi
            label="Paletes"
            info="Paletes que a máquina contou como fechados no período."
            sub={
              <>
                {formatNumber(now.perDay.pallets, 0)} por dia{' '}
                <Delta value={delta(totals.pallets, was?.totals.pallets)} />
              </>
            }
          >
            {whole(totals.pallets)}
          </Kpi>
        )}
        <Kpi
          label="Meta"
          info="Dias em que a soma dos turnos alcançou a meta do dia. O dia em andamento só entra quando já bateu."
          sub={targetShare != null ? `${percent(targetShare, 0)} do previsto` : 'sem meta definida'}
        >
          {now.daysWithTarget ? `${now.daysHit}/${now.daysWithTarget}` : '—'}{' '}
          <small>dias batidos</small>
        </Kpi>
        <Kpi
          label="Aproveitamento"
          info="Do tempo em que a máquina estava ligada em automático, quanto ela passou produzindo de fato. O resto é tempo ociosa (ligada sem contar peças)."
          sub={
            <>
              {duration(totals.producing)} produzindo{' '}
              <Delta value={delta(now.utilization, was?.utilization)} />
            </>
          }
        >
          {now.utilization == null ? '—' : percent(now.utilization, 0)}
        </Kpi>
        <Kpi
          label="Paradas"
          info="Vezes que a linha parou dentro do horário de turno (ligada sem contar peças ou em manual), com o tempo total parado. Pausas programadas e paradinhas curtas não contam. O tempo em que a IHM ficou sem comunicar aparece à parte, porque nele não se sabe se a linha parou."
          sub={
            stoppedSeconds == null
              ? 'carregando…'
              : `${duration(stoppedSeconds)} parada${stops?.time.offline ? ` · ${duration(stops.time.offline)} sem comunicação` : ''}`
          }
        >
          {failures == null ? '…' : whole(failures)}
        </Kpi>
      </div>

      <div className="mp-grid wide">
        <DailyChart now={now} from={from} to={to} counts={counts} onDay={onDay} />
        <PaceChart now={now} was={was} from={from} to={to} against={against} counts={counts} />
      </div>
      <div className="mp-grid">
        <section className="card mp-card">
          <Head
            title="O que mais saiu"
            hint="milheiros de cada produto"
            info="Cada produto (receita da IHM) com o que produziu no período e a parte que ele representa do total."
            note={
              top && (
                <>
                  <b>{top.code}</b> · {percent(top.share, 0)}
                </>
              )
            }
          />
          {now.products.length > 1 ? (
            <ProductBars now={now} />
          ) : (
            <p className="shifts-help">
              {!now.products.length
                ? 'Nada produzido no período.'
                : /^(item geral|sem produto)$/i.test(now.products[0].code.trim())
                  ? `Esta linha não informa o produto (a receita) na IHM, então toda a produção aparece como "${now.products[0].code}". Com a receita publicada, cada produto aparece aqui.`
                  : `No período só saiu um produto: ${now.products[0].code}, com ${mil(now.products[0].pieces)} milheiros.`}
            </p>
          )}
        </section>
        <ShiftCompare now={now} />
      </div>
    </div>
  );
}

/**
 * Where the month ends if the line keeps the pace of its closed days: the days left with a shift
 * in the calendar, at the average of the days already produced. Only for a period that runs from
 * the first of the month to today.
 */
function projectMonth(now: Folded, from: string, to: string, weekdays: number[] | null) {
  const today = plantToday();
  if (to !== today || from !== `${today.slice(0, 8)}01` || !weekdays?.length) return null;
  const closed = now.closed.filter((day) => day.date < today);
  if (closed.length < 3) return null;
  const work = new Set(weekdays);
  const monthEnd = addDays(`${addDays(`${today.slice(0, 8)}28`, 4).slice(0, 8)}01`, -1);
  let after = 0;
  for (let date = addDays(today, 1); date <= monthEnd; date = addDays(date, 1))
    if (work.has(weekdayOf(date))) after += 1;
  // On the month's last working day there is nothing left to project.
  if (!after) return null;
  const average = (pick: (day: Day) => number) =>
    closed.reduce((total, day) => total + pick(day), 0) / closed.length;
  const done = (pick: (day: Day) => number) =>
    [...now.days.values()].reduce((total, day) => total + pick(day), 0);
  // Today: what it made so far, or a normal day if it is a working day still running.
  const todaySoFar = now.days.get(today);
  const todayLeft = (pick: (day: Day) => number) =>
    work.has(weekdayOf(today))
      ? Math.max(0, average(pick) - (todaySoFar ? pick(todaySoFar) : 0))
      : 0;
  const project = (pick: (day: Day) => number) =>
    done(pick) + todayLeft(pick) + average(pick) * after;
  const projected = {
    pieces: project((day) => day.pieces),
    pallets: project((day) => day.pallets),
  };
  const left = after + (work.has(weekdayOf(today)) ? 1 : 0);
  // The month's target: the average daily target over every working day of the month.
  const targeted = closed.filter((day) => day.target > 0);
  let perDayNeeded: number | null = null;
  if (targeted.length && left > 0) {
    const dailyTarget = targeted.reduce((total, day) => total + day.target, 0) / targeted.length;
    const monthTarget = dailyTarget * (targeted.length + left);
    const achieved = targeted.reduce((total, day) => total + day.achieved, 0);
    perDayNeeded = (monthTarget - achieved) / left;
  }
  return { ...projected, left, perDayNeeded };
}

/** Production per day (or week, or month), painted by the target; products one click away. */
function DailyChart({
  now,
  from,
  to,
  counts,
  onDay,
}: {
  now: Folded;
  from: string;
  to: string;
  counts: { pieces: boolean; pallets: boolean };
  onDay: (date: string) => void;
}) {
  const [split, setSplit] = useState(false);
  const { group, slots } = useMemo(() => slotsOf(from, to, now.days), [from, to, now.days]);
  const names = now.products.map((item) => item.code);
  const colorOf = (name: string) => color(PRODUCT_COLORS, Math.max(0, names.indexOf(name)));
  const usePieces = counts.pieces;
  const rows = slots.map((slot) => ({
    label: slot.label,
    date: slot.date,
    value: usePieces ? slot.pieces / 1000 : slot.pallets,
    tons: slot.tons,
    pallets: slot.pallets,
    ratio: slot.target ? slot.achieved / slot.target : null,
    fill: reach(slot.achieved, slot.target) ?? 'var(--brand-accent, #12b8a6)',
    ...Object.fromEntries(names.map((name) => [name, (slot.products.get(name) ?? 0) / 1000])),
  }));
  const drawing = useFirstDraw(rows.length > 0);
  const hasTarget = rows.some((row) => row.ratio != null);
  const worked = rows.filter((row) => row.value > 0);
  const average = worked.length
    ? worked.reduce((sum, row) => sum + row.value, 0) / worked.length
    : 0;
  const unit = usePieces ? 'milheiros' : 'paletes';
  const per = group === 'day' ? 'dia' : group === 'week' ? 'semana' : 'mês';
  return (
    <section className="card mp-card">
      <div className="mp-card-head">
        <strong>Quanto foi produzido</strong>
        <InfoTip
          text={`Cada barra é um ${per}. A cor diz se a meta foi batida (verde), ficou perto (amarelo, 90 a 99%) ou abaixo de 90% (vermelho). A linha tracejada é a média dos ${per}s produzidos. Clique numa barra para abrir o ${per}.`}
        />
        <small>
          {unit} por {per} · média {formatNumber(average, usePieces ? 1 : 0)}
        </small>
        <div className="widget-period mp-switch" role="group" aria-label="Cor das barras">
          <button type="button" className={split ? '' : 'active'} onClick={() => setSplit(false)}>
            Pela meta
          </button>
          <button type="button" className={split ? 'active' : ''} onClick={() => setSplit(true)}>
            Por produto
          </button>
        </div>
      </div>
      <div className="mp-chart tall">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows.map((row) => ({ ...row, average: average || null }))}
            margin={{ top: 8, right: 70, bottom: 0, left: 0 }}
            onClick={(state) => {
              const index = Number(state?.activeTooltipIndex);
              if (group === 'day' && Number.isFinite(index) && rows[index]?.value)
                onDay(rows[index].date);
            }}
          >
            <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={12} />
            <YAxis
              tick={AXIS}
              width={48}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatNumber(v)}
            />
            <Tooltip
              cursor={{ fill: '#0b20280a' }}
              content={({ active, payload }) => {
                const row = active ? (payload?.[0]?.payload as (typeof rows)[number]) : null;
                if (!row) return null;
                return (
                  <div className="cp-tooltip">
                    <b>{row.label}</b>
                    {usePieces && <span>{formatNumber(row.value, 1)} milheiros</span>}
                    {row.tons > 0 && <span>{t(row.tons)} t</span>}
                    {counts.pallets && <span>{whole(row.pallets)} paletes</span>}
                    {row.ratio != null && <span>{percent(row.ratio, 0)} da meta</span>}
                    {split &&
                      names
                        .filter((name) => Number((row as Record<string, unknown>)[name]) > 0)
                        .map((name) => (
                          <span key={name}>
                            <i style={{ background: colorOf(name) }} /> {name}:{' '}
                            {formatNumber(Number((row as Record<string, unknown>)[name]), 1)} mil
                          </span>
                        ))}
                  </div>
                );
              }}
            />
            {split && usePieces ? (
              names.map((name, index) => (
                <Bar
                  key={name}
                  dataKey={name}
                  stackId="p"
                  fill={colorOf(name)}
                  stroke="#fff"
                  strokeWidth={1}
                  radius={index === names.length - 1 ? [4, 4, 0, 0] : undefined}
                  isAnimationActive
                  animationDuration={drawing ? 700 : 0}
                  cursor="pointer"
                />
              ))
            ) : (
              <Bar
                dataKey="value"
                radius={[4, 4, 0, 0]}
                isAnimationActive
                animationDuration={drawing ? 700 : 0}
                cursor="pointer"
              >
                {rows.map((row) => (
                  <Cell key={row.label} fill={row.fill} />
                ))}
              </Bar>
            )}
            {average > 0 && (
              <Line
                dataKey="average"
                stroke={INK}
                strokeDasharray="6 4"
                strokeWidth={1.2}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                label={endLabel(
                  rows.length,
                  (v) => `média ${formatNumber(v, usePieces ? 1 : 0)}`,
                  INK,
                )}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mp-legend">
        {split && usePieces ? (
          names.map((name) => (
            <span key={name}>
              <i style={{ background: colorOf(name) }} /> {name}
            </span>
          ))
        ) : hasTarget ? (
          <>
            <span>
              <i style={{ background: HIT }} /> bateu a meta
            </span>
            <span>
              <i style={{ background: NEAR }} /> perto (90 a 99%)
            </span>
            <span>
              <i style={{ background: MISS }} /> abaixo de 90%
            </span>
          </>
        ) : (
          <span>
            <i style={{ background: 'var(--brand-accent, #12b8a6)' }} /> produção · defina uma meta
            para pintar os dias
          </span>
        )}
        <span>
          <i className="dash" style={{ borderColor: INK }} /> média
        </span>
      </div>
    </section>
  );
}

/** The period added up day after day: against the target, and against the period before. */
function PaceChart({
  now,
  was,
  from,
  to,
  against,
  counts,
}: {
  now: Folded;
  was: Folded | null;
  from: string;
  to: string;
  against: Against;
  counts: { pieces: boolean; pallets: boolean };
}) {
  // With a target the race is run in its unit; without one, in milheiros (or pallets).
  const metric: ProductionMetric = now.metric ?? (counts.pieces ? 'milheiros' : 'pallets');
  const unit = metricInfo[metric];
  const range = compareRange(from, to, against);
  const rows = useMemo(() => {
    let done = 0;
    let goal = 0;
    let before = 0;
    const out: Array<{
      label: string;
      done: number | null;
      goal: number | null;
      was: number | null;
    }> = [];
    const today = plantToday();
    for (let at = 0, date = from; date <= to; at += 1, date = addDays(date, 1)) {
      const day = now.days.get(date);
      if (day) {
        done += metricOf(day, metric);
        if (day.target) goal += day.target;
      }
      const then = was?.days.get(addDays(range.from, at));
      if (then) before += metricOf(then, metric);
      out.push({
        label: brDay(date),
        done: date <= today ? done : null,
        goal: now.metric && goal ? goal : null,
        was: was && addDays(range.from, at) <= range.to ? before : null,
      });
    }
    return out;
  }, [now, was, from, to, metric, range.from, range.to]);
  const drawing = useFirstDraw(rows.length > 0);
  const last = [...rows].reverse().find((row) => row.done != null);
  const gap = last?.goal != null && last.done != null ? last.done - last.goal : null;
  const beforeName = against === 'year' ? 'ano passado' : 'período anterior';
  const lastDone = rows.reduce((at, row, index) => (row.done != null ? index : at), -1);
  return (
    <section className="card mp-card">
      <Head
        title="Ritmo do período"
        hint={`${unit.name} somados dia após dia`}
        info={`A linha cheia é o que foi produzido, somado dia após dia. A tracejada escura é a meta somada do mesmo jeito; a cinza é o ${beforeName}, no mesmo dia do período. Se a linha cheia está acima da meta, a produção está adiantada.`}
        note={
          gap == null ? null : gap >= 0 ? (
            <b className="up">{inMetric(gap, metric)} acima da meta</b>
          ) : (
            <b className="down">faltam {inMetric(-gap, metric)}</b>
          )
        }
      />
      <div className="mp-chart tall">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 64, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis
              tick={AXIS}
              width={52}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatNumber(v)}
            />
            <Tooltip
              formatter={(value, name) => [
                inMetric(Number(value), metric),
                name === 'done' ? 'produzido' : name === 'goal' ? 'meta' : beforeName,
              ]}
            />
            {was && (
              <Line
                dataKey="was"
                stroke="#a8b8bd"
                strokeDasharray="2 4"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            )}
            {now.metric && (
              <Line
                dataKey="goal"
                stroke={INK}
                strokeDasharray="6 4"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            )}
            <Line
              dataKey="done"
              stroke="var(--brand-accent, #12b8a6)"
              strokeWidth={2.5}
              dot={false}
              isAnimationActive
              animationDuration={drawing ? 700 : 0}
              label={endLabel(lastDone + 1, (v) => formatNumber(v, unit.decimals), INK)}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mp-legend">
        <span>
          <i style={{ background: 'var(--brand-accent, #12b8a6)' }} /> produzido
        </span>
        {now.metric && (
          <span>
            <i className="dash" style={{ borderColor: INK }} /> meta
          </span>
        )}
        {was && (
          <span>
            <i className="dash" style={{ borderColor: '#a8b8bd' }} /> {beforeName}
          </span>
        )}
      </div>
    </section>
  );
}

function ProductBars({ now }: { now: Folded }) {
  if (!now.products.length) return <div className="stops-empty">Nada produzido no período.</div>;
  const names = now.products.map((item) => item.code);
  const top = Math.max(1, now.products[0].pieces || now.products[0].pallets);
  return (
    <div className="mp-bars">
      {now.products.slice(0, 8).map((item, index) => (
        <div
          key={item.code}
          title={`${item.code}: ${mil(item.pieces)} milheiros, ${t(item.tons)} t, ${whole(item.pallets)} paletes`}
        >
          <span>
            <i style={{ background: color(PRODUCT_COLORS, names.indexOf(item.code)) }} />
            <span className="cp-ellipsis">{item.code}</span>
          </span>
          <div className="mp-spout-bar">
            <i
              style={{
                width: `${((item.pieces || item.pallets) / top) * 100}%`,
                background: color(PRODUCT_COLORS, index),
                animationDelay: `${index * 60}ms`,
              }}
            />
          </div>
          <b>{item.pieces ? mil(item.pieces) : whole(item.pallets)}</b>
          <small>{percent(item.share, 0)}</small>
        </div>
      ))}
    </div>
  );
}

/** One row per shift: how much it makes per shift and per hour it runs. */
function ShiftCompare({ now }: { now: Folded }) {
  const shifts = now.shifts.filter((shift) => shift.reports > 0);
  const best = Math.max(1, ...shifts.map((shift) => shift.perReport));
  return (
    <section className="card mp-card">
      <Head
        title="Turno a turno"
        hint="média de cada turno registrado"
        info="Para cada turno cadastrado: quanto produz em média por turno trabalhado e por hora em que está de fato produzindo. A hora produzindo deixa de fora o tempo parado, então mostra o ritmo da linha quando ela anda."
        note={
          shifts.length > 1 && (
            <>
              <b>{[...shifts].sort((a, b) => b.perReport - a.perReport)[0].name}</b> à frente
            </>
          )
        }
      />
      {!shifts.length ? (
        <div className="stops-empty">Nenhum turno encerrado no período.</div>
      ) : (
        <div className="mp-spouts">
          {shifts.map((shift, index) => (
            <div key={shift.name} className="mp-spout">
              <div className="mp-spout-name">
                <i style={{ background: color(PRODUCT_COLORS, index) }} />
                <b>{shift.name}</b>
                <span className="mp-rank">{shift.reports} turnos</span>
              </div>
              <div className="mp-spout-bar">
                <i
                  style={{
                    width: `${(shift.perReport / best) * 100}%`,
                    background: color(PRODUCT_COLORS, index),
                  }}
                />
              </div>
              <div className="mp-spout-figures">
                <span>
                  <b>{mil(shift.perReport)}</b> milheiros por turno
                </span>
                {shift.perHour != null && (
                  <span>
                    <b>{whole(shift.perHour)}</b> peças por hora produzindo
                  </span>
                )}
                {shift.utilization != null && (
                  <span>
                    <b>{percent(shift.utilization, 0)}</b> de aproveitamento
                  </span>
                )}
                {shift.target > 0 && (
                  <span>
                    <b>{percent(shift.achieved / shift.target, 0)}</b> da meta
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- Produtos ---------------------------------------------------------------------------------

function Products({
  now,
  from,
  to,
  counts,
}: {
  now: Folded;
  from: string;
  to: string;
  counts: { pieces: boolean; pallets: boolean };
}) {
  const names = now.products.map((item) => item.code);
  const colorOf = (name: string) => color(PRODUCT_COLORS, Math.max(0, names.indexOf(name)));
  const { slots, group } = useMemo(() => slotsOf(from, to, now.days), [from, to, now.days]);
  const rows = slots.map((slot) => ({
    label: slot.label,
    ...Object.fromEntries(names.map((name) => [name, (slot.products.get(name) ?? 0) / 1000])),
  }));
  const drawing = useFirstDraw(rows.length > 0);
  const top = now.products[0];
  return (
    <div className="mp-overview">
      <section className="card mp-card">
        <Head
          title="Cada produto no período"
          hint="do que mais saiu para o que menos"
          info="Peças por palete e peso por peça são calculados do que a máquina contou: se fogem do cadastro do produto, vale conferir a receita na IHM. A curva ABC agrupa os produtos que somam 80% (A), os próximos 15% (B) e o restante (C)."
          note={
            top && (
              <>
                <b>{top.code}</b> · {percent(top.share, 0)} da produção
              </>
            )
          }
        />
        {!now.products.length ? (
          <div className="stops-empty">Nada produzido no período.</div>
        ) : (
          <div className="table-scroll">
            <table className="production-table cp-products">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th className="numeric">Milheiros</th>
                  <th className="numeric">Toneladas</th>
                  {counts.pallets && <th className="numeric">Paletes</th>}
                  {counts.pallets && <th className="numeric">Peças por palete</th>}
                  <th className="numeric">Peso por peça</th>
                  <th className="numeric">Dias</th>
                  <th>Participação</th>
                  <th>ABC</th>
                </tr>
              </thead>
              <tbody>
                {now.products.map((item) => (
                  <tr key={item.code}>
                    <td>
                      <span className="cp-dot" style={{ background: colorOf(item.code) }} />
                      {item.code}
                    </td>
                    <td className="numeric">{mil(item.pieces)}</td>
                    <td className="numeric">{t(item.tons)}</td>
                    {counts.pallets && <td className="numeric">{whole(item.pallets)}</td>}
                    {counts.pallets && (
                      <td className="numeric">
                        {item.pallets >= 1 ? whole(item.pieces / item.pallets) : '—'}
                      </td>
                    )}
                    <td className="numeric">
                      {item.pieces > 0 && item.tons > 0
                        ? `${formatNumber((item.tons * 1000) / item.pieces, 2)} kg`
                        : '—'}
                    </td>
                    <td className="numeric">{item.days}</td>
                    <td>
                      <div className="cp-share">
                        <div className="mp-spout-bar">
                          <i
                            style={{
                              width: `${item.share * 100}%`,
                              background: colorOf(item.code),
                            }}
                          />
                        </div>
                        <small>{percent(item.share, 0)}</small>
                      </div>
                    </td>
                    <td>
                      <span className={`mp-abc ${item.abc}`}>{item.abc}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card mp-card">
        <Head
          title="O que saiu em cada dia"
          hint={`milheiros por ${group === 'day' ? 'dia' : group === 'week' ? 'semana' : 'mês'}, por produto`}
          info="Cada cor é um produto. Mostra quando a linha trocou de produto e quanto cada um ocupou."
        />
        <div className="mp-chart tall">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS}
                tickLine={false}
                axisLine={false}
                minTickGap={12}
              />
              <YAxis tick={AXIS} width={44} tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: '#0b20280a' }}
                formatter={(value, name) => [`${formatNumber(Number(value), 1)} milheiros`, name]}
              />
              {names.map((name, index) => (
                <Bar
                  key={name}
                  dataKey={name}
                  stackId="p"
                  fill={colorOf(name)}
                  stroke="#fff"
                  strokeWidth={1}
                  radius={index === names.length - 1 ? [4, 4, 0, 0] : undefined}
                  isAnimationActive
                  animationDuration={drawing ? 700 : 0}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mp-legend">
          {names.map((name) => (
            <span key={name}>
              <i style={{ background: colorOf(name) }} /> {name}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---- Tempo e paradas --------------------------------------------------------------------------

function TimeTab({
  stops,
  error,
  clipped,
}: {
  stops: StopsData | null;
  error?: string;
  clipped: boolean;
}) {
  if (!stops) return <div className="card empty">{error ?? 'Carregando as paradas…'}</div>;
  const time = stops.time;
  const total = time.producing + time.idle + time.manual + time.offline;
  const parts = (['producing', 'idle', 'manual', 'offline'] as const).map((state) => ({
    state,
    seconds: time[state],
    share: total ? time[state] / total : 0,
  }));
  // A stop is the line standing still (idle or in manual). Silence from the HMI is not the line
  // stopping: it is shown apart everywhere, or a network fault would read as a production loss.
  const lineStops = stops.all.filter((stop) => !stop.planned && stop.state !== 'offline');
  const count = lineStops.filter((stop) => !stop.micro).length;
  const stopped = time.idle + time.manual;
  const byDay = new Map<string, { idle: number; manual: number; offline: number; stops: number }>();
  for (const stop of stops.all.filter((item) => !item.planned)) {
    const day = byDay.get(stop.date) ?? { idle: 0, manual: 0, offline: 0, stops: 0 };
    day[stop.state] += stop.seconds / 60;
    if (stop.state !== 'offline' && !stop.micro) day.stops += 1;
    byDay.set(stop.date, day);
  }
  const days = stops.days.map((item) => ({
    label: brDay(item.date),
    date: item.date,
    ...(byDay.get(item.date) ?? { idle: 0, manual: 0, offline: 0, stops: 0 }),
  }));
  const worstDay = [...days].sort((a, b) => b.idle + b.manual - (a.idle + a.manual))[0];
  const longest = [...lineStops].sort((a, b) => b.seconds - a.seconds).slice(0, 10);
  return (
    <div className="mp-overview">
      <p className="mp-headline">
        No horário de turno a linha passou{' '}
        <b>{percent(total ? time.producing / total : null, 0)}</b> do tempo produzindo e parou{' '}
        <b>{count} vezes</b>, somando <b>{duration(stopped)}</b> parada
        {worstDay && worstDay.idle + worstDay.manual > 0 && (
          <>
            . O dia com mais tempo parado foi <b>{brDay(worstDay.date)}</b> (
            {duration((worstDay.idle + worstDay.manual) * 60)})
          </>
        )}
        {stops.micro.stops > 0 && (
          <>
            , fora <b>{stops.micro.stops} paradinhas</b> curtas
          </>
        )}
        .{' '}
        {time.offline > 0 && (
          <>
            Por <b>{duration(time.offline)}</b> a IHM ficou sem comunicar: nesse tempo não dá para
            saber se a linha produziu.{' '}
          </>
        )}
        {clipped ? 'As paradas cobrem os últimos 180 dias do período.' : ''}
      </p>

      <section className="card mp-card">
        <Head
          title="Para onde foi o tempo do turno"
          hint="dentro do horário de turno, pausas fora"
          info="Produzindo: contando peças. Ociosa: ligada em automático sem contar. Manual / parada: fora do automático. Sem comunicação: a IHM não enviou dados (o tempo não pode ser lido)."
          note={
            <>
              <b>{percent(total ? time.producing / total : null, 0)}</b> produzindo
            </>
          }
        />
        <div className="cp-timebar">
          {parts
            .filter((part) => part.seconds > 0)
            .map((part) => (
              <i
                key={part.state}
                style={{ width: `${part.share * 100}%`, background: stateInfo[part.state].color }}
                title={`${stateInfo[part.state].label}: ${duration(part.seconds)} (${percent(part.share, 0)})`}
              />
            ))}
        </div>
        <div className="cp-timeparts">
          {parts.map((part) => (
            <div key={part.state}>
              <span>
                <i style={{ background: stateInfo[part.state].color }} />{' '}
                {stateInfo[part.state].label}
              </span>
              <b>{percent(part.share, 0)}</b>
              <small>{duration(part.seconds)}</small>
            </div>
          ))}
        </div>
      </section>

      <div className="mp-grid wide">
        <section className="card mp-card">
          <Head
            title="Tempo parado por dia"
            hint="minutos parados dentro do turno"
            info="Laranja: linha ligada sem contar peças. Vermelho: máquina em manual. Cinza: a IHM sem comunicar (não se sabe se parou). O número em cima é quantas paradas a linha teve no dia."
            note={
              worstDay && worstDay.idle + worstDay.manual > 0 ? (
                <>
                  pior dia <b>{brDay(worstDay.date)}</b>
                </>
              ) : null
            }
          />
          <div className="mp-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={days} margin={{ top: 18, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={AXIS}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={12}
                />
                <YAxis tick={AXIS} width={40} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: '#0b20280a' }}
                  formatter={(value, name) => [
                    duration(Number(value) * 60),
                    name === 'idle' ? 'ociosa' : name === 'manual' ? 'manual' : 'sem comunicação',
                  ]}
                />
                <Bar
                  dataKey="idle"
                  stackId="s"
                  fill={stateInfo.idle.color}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="manual"
                  stackId="s"
                  fill={stateInfo.manual.color}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="offline"
                  stackId="s"
                  fill={stateInfo.offline.color}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                >
                  <LabelList
                    dataKey="stops"
                    position="top"
                    fontSize={10}
                    fill="#5d747b"
                    formatter={(value: unknown) => (Number(value) ? String(value) : '')}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="card mp-card">
          <Head
            title="Por que parou"
            hint="paradas e tempo de cada causa"
            info="A causa vem do estado da máquina na parada: ligada em automático sem contar peças (ociosa) ou fora do automático (manual). O tempo sem comunicação aparece à parte, porque nele não se sabe o que a linha fez."
          />
          <div className="mp-spouts">
            {stops.reasons.some((reason) => reason.state !== 'offline') ? (
              stops.reasons
                .filter((reason) => reason.state !== 'offline')
                .map((reason) => (
                  <div key={reason.state} className="mp-spout">
                    <div className="mp-spout-name">
                      <i style={{ background: stateInfo[reason.state].color }} />
                      <b>{stateInfo[reason.state].label}</b>
                      <span className="mp-rank">{reason.stops} paradas</span>
                    </div>
                    <div className="mp-spout-bar">
                      <i
                        style={{
                          width: `${stopped ? (reason.seconds / stopped) * 100 : 0}%`,
                          background: stateInfo[reason.state].color,
                        }}
                      />
                    </div>
                    <div className="mp-spout-figures">
                      <span>
                        <b>{duration(reason.seconds)}</b> · {STATE_TEXT[reason.state]}
                      </span>
                    </div>
                  </div>
                ))
            ) : (
              <div className="stops-empty">Nenhuma parada no período.</div>
            )}
            {time.offline > 0 && (
              <p className="cp-offline-note">
                <i style={{ background: stateInfo.offline.color }} />
                <span>
                  <b>{duration(time.offline)}</b> sem comunicação com a IHM, em{' '}
                  {stops.reasons.find((reason) => reason.state === 'offline')?.stops ?? 0} vezes.
                  Não é parada da linha: se for muito, vale conferir a rede ou a energia da IHM.
                </span>
              </p>
            )}
          </div>
        </section>
      </div>

      <div className="mp-grid">
        <section className="card mp-card">
          <Head
            title="Quando a linha mais para"
            hint="minutos parados por dia da semana e hora"
            info="Cada quadrado soma o tempo parado naquele dia da semana e naquela hora, no período todo. Quadrados escuros repetidos mostram um horário que sempre dá problema (troca de turno, almoço, início do dia)."
          />
          <StopHeat stops={lineStops} />
        </section>
        <section className="card mp-card">
          <Head
            title="As maiores paradas"
            hint="as dez mais longas do período"
            info="As paradas mais longas da linha dentro do turno (ociosa ou em manual), com o dia, a hora em que começaram e a causa. O tempo sem comunicação fica de fora: não se sabe se a linha parou."
          />
          {longest.length ? (
            <div className="cp-longest">
              {longest.map((stop) => (
                <div key={stop.startedAt}>
                  <span className="cp-dot" style={{ background: stateInfo[stop.state].color }} />
                  <span>
                    {new Date(stop.startedAt).toLocaleString('pt-BR', {
                      timeZone: 'America/Sao_Paulo',
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <b>{duration(stop.seconds)}</b>
                  <small>
                    {stateInfo[stop.state].label}
                    {stop.product ? ` · ${stop.product}` : ''}
                  </small>
                </div>
              ))}
            </div>
          ) : (
            <div className="stops-empty">Nenhuma parada no período.</div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Weekdays down, hours across: minutes stopped, darker where the line stops more. */
function StopHeat({ stops }: { stops: StopsData['all'] }) {
  const cells = new Map<string, number>();
  for (const stop of stops) {
    // Each stop split across the hours it covered.
    let at = new Date(stop.startedAt).getTime();
    let left = stop.seconds;
    while (left > 0) {
      const local = new Date(at - 3 * 3600 * 1000);
      const key = `${local.getUTCDay()}-${local.getUTCHours()}`;
      const toHour = 3600 - (local.getUTCMinutes() * 60 + local.getUTCSeconds());
      const take = Math.min(left, toHour);
      cells.set(key, (cells.get(key) ?? 0) + take / 60);
      left -= take;
      at += take * 1000;
    }
  }
  if (!cells.size) return <div className="stops-empty">Nenhuma parada no período.</div>;
  const hours = [...cells.keys()].map((key) => Number(key.split('-')[1]));
  const from = Math.min(...hours);
  const to = Math.max(...hours);
  const max = Math.max(1, ...cells.values());
  const span = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div
      className="mp-weekheat"
      style={{ gridTemplateColumns: `40px repeat(${span.length}, minmax(20px, 1fr))` }}
    >
      <span />
      {span.map((hour) => (
        <span key={hour} className="mp-weekheat-hour">
          {hour}h
        </span>
      ))}
      {order.map((weekday) => (
        <Fragment key={weekday}>
          <span className="mp-weekheat-day">{WEEKDAYS[weekday]}</span>
          {span.map((hour) => {
            const minutes = cells.get(`${weekday}-${hour}`) ?? 0;
            return (
              <i
                key={hour}
                style={{
                  background: minutes
                    ? `color-mix(in srgb, ${MISS} ${Math.round(12 + (minutes / max) * 88)}%, #fff)`
                    : '#f1f5f6',
                  color: minutes >= max * 0.55 ? '#fff' : undefined,
                }}
                title={`${WEEKDAYS[weekday]} ${hour}h · ${duration(minutes * 60)} parado no período`}
              >
                {minutes >= max * 0.5 ? whole(minutes) : ''}
              </i>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

// ---- Comparar ---------------------------------------------------------------------------------

function Compare({
  now,
  was,
  against,
  counts,
  thin,
}: {
  now: Folded;
  was: Folded | null;
  against: Against;
  counts: { pieces: boolean; pallets: boolean };
  thin: boolean;
}) {
  const name = against === 'year' ? 'Ano passado' : 'Período anterior';
  if (!was) return <div className="card empty">Carregando o {name.toLowerCase()}…</div>;
  if (thin)
    return (
      <div className="notice">
        <b>Sem base para comparar</b>O {name.toLowerCase()} tem só {was.worked.length} dia(s) com
        produção registrada na plataforma, contra {now.worked.length} neste período. Escolha um
        período mais recente, ou compare de novo quando houver mais histórico.
      </div>
    );
  const lines: Array<{
    label: string;
    info: string;
    now: number | null;
    was: number | null;
    show: (value: number) => string;
    invert?: boolean;
  }> = [
    ...(counts.pieces
      ? [
          {
            label: 'Tijolos (milheiros)',
            info: 'Peças contadas, em milheiros.',
            now: now.totals.pieces,
            was: was.totals.pieces,
            show: mil,
          },
        ]
      : []),
    {
      label: 'Toneladas',
      info: 'Peso produzido.',
      now: now.totals.tons,
      was: was.totals.tons,
      show: t,
    },
    ...(counts.pallets
      ? [
          {
            label: 'Paletes',
            info: 'Paletes contados.',
            now: now.totals.pallets,
            was: was.totals.pallets,
            show: whole,
          },
        ]
      : []),
    {
      label: 'Dias produzidos',
      info: 'Dias com alguma produção.',
      now: now.worked.length,
      was: was.worked.length,
      show: whole,
    },
    ...(counts.pieces
      ? [
          {
            label: 'Média por dia (milheiros)',
            info: 'Produção dividida pelos dias produzidos: compara períodos com números de dias diferentes.',
            now: now.perDay.pieces,
            was: was.perDay.pieces,
            show: mil,
          },
        ]
      : []),
    {
      label: 'Média por dia (t)',
      info: 'Toneladas divididas pelos dias produzidos.',
      now: now.perDay.tons,
      was: was.perDay.tons,
      show: t,
    },
    {
      label: 'Dias com meta batida',
      info: 'Dias em que a soma dos turnos alcançou a meta.',
      now: now.daysWithTarget ? now.daysHit : null,
      was: was.daysWithTarget ? was.daysHit : null,
      show: whole,
    },
    {
      label: 'Aproveitamento',
      info: 'Tempo produzindo sobre o tempo ligada em automático.',
      now: now.utilization,
      was: was.utilization,
      show: (value) => percent(value, 0),
    },
    {
      label: 'Tempo parado em manual',
      info: 'Tempo fora do automático dentro dos turnos.',
      now: now.totals.manual,
      was: was.totals.manual,
      show: duration,
      invert: true,
    },
  ];
  const weekday = (folded: Folded) =>
    [1, 2, 3, 4, 5, 6, 0].map((day) => {
      const own = folded.worked.filter((item) => weekdayOf(item.date) === day);
      return own.length
        ? own.reduce((sum, item) => sum + (counts.pieces ? item.pieces / 1000 : item.pallets), 0) /
            own.length
        : 0;
    });
  const nowWeek = weekday(now);
  const wasWeek = weekday(was);
  const weekRows = [1, 2, 3, 4, 5, 6, 0].map((day, index) => ({
    label: WEEKDAYS[day],
    now: nowWeek[index],
    was: wasWeek[index],
  }));
  return (
    <div className="mp-overview">
      <div className="mp-grid wide">
        <section className="card mp-card">
          <Head
            title="Este período contra o outro"
            hint={name.toLowerCase()}
            info="Os mesmos números lado a lado. A variação em verde é melhora; em vermelho, piora."
          />
          <div className="table-scroll">
            <table className="production-table cp-compare">
              <thead>
                <tr>
                  <th>Indicador</th>
                  <th className="numeric">Este período</th>
                  <th className="numeric">{name}</th>
                  <th className="numeric">Variação</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.label}>
                    <td>
                      {line.label} <InfoTip text={line.info} />
                    </td>
                    <td className="numeric">{line.now == null ? '—' : line.show(line.now)}</td>
                    <td className="numeric">{line.was == null ? '—' : line.show(line.was)}</td>
                    <td className="numeric">
                      <Delta value={delta(line.now, line.was)} invert={line.invert} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card mp-card">
          <Head
            title="Média por dia da semana"
            hint={counts.pieces ? 'milheiros num dia produzido' : 'paletes num dia produzido'}
            info="Quanto a linha produz, em média, em cada dia da semana em que trabalhou. Mostra se a segunda começa devagar ou se o sábado rende menos."
          />
          <div className="mp-chart tall">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekRows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
                <YAxis tick={AXIS} width={40} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: '#0b20280a' }}
                  formatter={(value, key) => [
                    formatNumber(Number(value), 1),
                    key === 'now' ? 'este período' : name.toLowerCase(),
                  ]}
                />
                <Bar dataKey="was" fill="#c4d1d5" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar
                  dataKey="now"
                  fill="var(--brand-accent, #12b8a6)"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mp-legend">
            <span>
              <i style={{ background: 'var(--brand-accent, #12b8a6)' }} /> este período
            </span>
            <span>
              <i style={{ background: '#c4d1d5' }} /> {name.toLowerCase()}
            </span>
          </div>
        </section>
      </div>
      <ShiftTable now={now} was={was} name={name} />
    </div>
  );
}

function ShiftTable({ now, was, name }: { now: Folded; was: Folded; name: string }) {
  const shifts = now.shifts.filter((shift) => shift.reports > 0);
  if (!shifts.length) return null;
  return (
    <section className="card mp-card">
      <Head
        title="Turno contra turno"
        hint="cada turno cadastrado, neste período"
        info="Média por turno: o que um turno produz num dia normal. Peças por hora produzindo: o ritmo da linha quando ela anda, sem o tempo parado. A variação compara com o mesmo turno no outro período."
      />
      <div className="table-scroll">
        <table className="production-table cp-compare">
          <thead>
            <tr>
              <th>Turno</th>
              <th className="numeric">Turnos</th>
              <th className="numeric">Milheiros por turno</th>
              <th className="numeric">Peças por hora produzindo</th>
              <th className="numeric">Aproveitamento</th>
              <th className="numeric">% da meta</th>
              <th className="numeric">vs {name.toLowerCase()}</th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((shift) => {
              const other = was.shifts.find((item) => item.name === shift.name);
              return (
                <tr key={shift.name}>
                  <td>{shift.name}</td>
                  <td className="numeric">{shift.reports}</td>
                  <td className="numeric">{mil(shift.perReport)}</td>
                  <td className="numeric">{shift.perHour == null ? '—' : whole(shift.perHour)}</td>
                  <td className="numeric">
                    {shift.utilization == null ? '—' : percent(shift.utilization, 0)}
                  </td>
                  <td className="numeric">
                    {shift.target ? percent(shift.achieved / shift.target, 0) : '—'}
                  </td>
                  <td className="numeric">
                    <Delta value={delta(shift.perReport, other?.perReport)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
