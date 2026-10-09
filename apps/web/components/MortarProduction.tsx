'use client';

import { Fragment, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { mutate, usePoll } from './data';
import { useFirstDraw } from './firstDraw';
import { ModalPortal } from './ModalPortal';
import { MortarShiftBoard } from './MortarShift';
import { ProductsModal } from './MortarPanel';
import { usePlatform } from './PlatformShell';
import {
  MATERIAL_COLORS,
  PRODUCT_COLORS,
  SPOUT_COLORS,
  duration,
  integer,
  money,
  percent,
  tons,
} from './mortarShared';

/**
 * The Produção page of a mortar plant: one line or all of them, any period, by day, week or
 * month. Three tabs: the overview (where production stands and how it was built), the history
 * (every period, opened down to the shift of a day) and the comparisons (period against period,
 * month by month against last year). One answer of the API feeds each, so the numbers agree.
 */
type Group = 'day' | 'week' | 'month';
type Line = { id: string; name: string; site_id: string; site_name: string };
type Efficiency = {
  availability: number | null;
  performance: number | null;
  effectiveness: number | null;
};
type Slot = Efficiency & {
  slot: string;
  bags: number;
  kg: number;
  products: Record<string, number>;
  days: number;
  targetBags: number;
  targetKg: number;
  daysHit: number;
  daysWithTarget: number;
  stops: number;
  stopSeconds: number;
  batches: number;
  mixedKg: number;
  top: string | null;
};
type History = {
  from: string;
  to: string;
  group: Group;
  lines: Line[];
  totals: Efficiency & {
    bags: number;
    kg: number;
    days: number;
    perDay: number;
    best: { day: string; bags: number; kg: number } | null;
    daysHit: number;
    daysWithTarget: number;
    targetBags: number;
    targetKg: number;
    stops: number;
    stopSeconds: number;
    batches: number;
    mixedKg: number;
    cost: number | null;
    costPerTon: number | null;
  };
  series: Slot[];
  products: Array<{
    name: string;
    bags: number;
    kg: number;
    share: number;
    cumulative: number;
    abc: 'A' | 'B' | 'C';
  }>;
  spouts: Array<
    Efficiency & {
      id: string;
      name: string;
      bags: number;
      kg: number;
      stops: number;
      stopSeconds: number;
      pacePerHour: number | null;
      series: Array<Efficiency & { bags: number }>;
    }
  >;
  materials: Array<{
    label: string;
    kg: number;
    pricePerTon: number | null;
    cost: number | null;
    perTonBagged: number | null;
  }>;
  recipes: Array<{ recipe: string; batches: number; kg: number }>;
  stock: Array<{ name: string; opening: number; series: number[] }>;
  heatmap: Array<{ weekday: number; hour: number; bags: number }>;
  calendar: Array<{ date: string; bags: number }>;
};

// ---- Dates and periods -----------------------------------------------------------------------

const iso = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
const parse = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (date: string, days: number) => {
  const at = parse(date);
  at.setDate(at.getDate() + days);
  return iso(at);
};
const daysBetween = (from: string, to: string) =>
  Math.round((parse(to).getTime() - parse(from).getTime()) / 86400000);
const minusYear = (date: string) => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const brDay = (date: string) => date.split('-').reverse().slice(0, 2).join('/');
/** How a slot reads: "08/10", "sem. 06/10", "out/26". */
function slotLabel(slot: string, group: Group) {
  if (group === 'month') return `${MONTHS[Number(slot.slice(5, 7)) - 1]}/${slot.slice(2, 4)}`;
  if (group === 'week') return `sem. ${brDay(slot)}`;
  return brDay(slot);
}
function slotRange(slot: string, group: Group): { from: string; to: string } {
  if (group === 'day') return { from: slot, to: slot };
  if (group === 'week') return { from: slot, to: addDays(slot, 6) };
  const first = `${slot}-01`;
  const next = parse(first);
  next.setMonth(next.getMonth() + 1);
  return { from: first, to: addDays(iso(next), -1) };
}

type Period = 'month' | 'last_month' | 'quarter' | 'year' | 'custom';
const PERIODS: Array<[Period, string]> = [
  ['month', 'Este mês'],
  ['last_month', 'Mês anterior'],
  ['quarter', '3 meses'],
  ['year', 'Ano'],
  ['custom', 'Personalizado'],
];
function rangeOf(period: Period, custom: { from: string; to: string }) {
  const today = new Date();
  const to = iso(today);
  if (period === 'month')
    return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to };
  if (period === 'last_month')
    return {
      from: iso(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      to: iso(new Date(today.getFullYear(), today.getMonth(), 0)),
    };
  if (period === 'quarter')
    return { from: iso(new Date(today.getFullYear(), today.getMonth() - 2, 1)), to };
  if (period === 'year') return { from: iso(new Date(today.getFullYear(), 0, 1)), to };
  return custom;
}
type Against = 'previous' | 'year' | '';
function compareRange(range: { from: string; to: string }, against: Against) {
  if (!against) return null;
  if (against === 'year') return { from: minusYear(range.from), to: minusYear(range.to) };
  const length = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

const delta = (now: number | null | undefined, before: number | null | undefined) =>
  now == null || before == null || !before ? null : now / before - 1;
function Delta({ value, invert }: { value: number | null; invert?: boolean }) {
  if (value == null || !Number.isFinite(value)) return null;
  const good = invert ? value < 0 : value > 0;
  return (
    <i className={`mp-delta ${Math.abs(value) < 0.005 ? '' : good ? 'up' : 'down'}`}>
      {value > 0 ? '▲' : value < 0 ? '▼' : '='} {percent(Math.abs(value), 1)}
    </i>
  );
}

const color = (palette: string[], index: number) => palette[index % palette.length];
const AXIS = { fontSize: 11, fill: '#71868d' };

// ---- The page ---------------------------------------------------------------------------------

export function MortarProduction({ initialLine }: { initialLine?: string }) {
  const { user } = usePlatform();
  const lines = usePoll<{ lines: Line[] }>('/mortar/lines', 600000);
  const [line, setLine] = useState(initialLine ?? 'all');
  const [period, setPeriod] = useState<Period>('month');
  const [custom, setCustom] = useState(() => ({
    from: addDays(iso(new Date()), -29),
    to: iso(new Date()),
  }));
  const [group, setGroup] = useState<Group>('day');
  const [against, setAgainst] = useState<Against>('previous');
  const [tab, setTab] = useState<'overview' | 'history' | 'compare'>('overview');
  const [openingStock, setOpeningStock] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  // The history opens a period down: month, week, day, and the board of that day.
  const [drill, setDrill] = useState<{ from: string; to: string; group: Group } | null>(null);
  const [dayBoard, setDayBoard] = useState<string | null>(null);

  const range = rangeOf(period, custom);
  const shown = drill ?? { ...range, group };
  const query = (r: { from: string; to: string }, g: Group) =>
    `/mortar/history?device=${line}&from=${r.from}&to=${r.to}&group=${g}`;
  const history = usePoll<History>(query(shown, shown.group), 120000);
  const otherRange = compareRange(shown, against);
  const other = usePoll<History>(otherRange ? query(otherRange, shown.group) : null, 600000);
  const data = history.data;
  const before = otherRange ? (other.data ?? null) : null;
  const lineList = lines.data?.lines ?? [];
  const boardLine = line === 'all' ? lineList[0]?.id : line;

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">PRODUÇÃO · ARGAMASSA</div>
          <h1>Produção</h1>
          <p>
            O balanço do que foi ensacado, como o estoque foi formado e como cada período se compara
            com os outros.
          </p>
        </div>
        <div className="toolbar-actions">
          {user.role === 'master' && (
            <>
              <button onClick={() => setOpeningStock(true)}>Saldo inicial do estoque</button>
              <button onClick={() => setProductsOpen(true)}>Produtos e receitas</button>
            </>
          )}
        </div>
      </div>

      <section className="card mp-filters">
        <label className="field">
          Linha
          <select
            value={line}
            onChange={(event) => {
              setLine(event.target.value);
              setDrill(null);
            }}
          >
            <option value="all">Todas as linhas</option>
            {lineList.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.site_name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          Período
          <div className="widget-period" role="group" aria-label="Período">
            {PERIODS.map(([id, text]) => (
              <button
                key={id}
                type="button"
                className={period === id ? 'active' : ''}
                onClick={() => {
                  setPeriod(id);
                  setDrill(null);
                  if (id === 'year') setGroup('month');
                  if (id === 'quarter') setGroup('week');
                  if (id === 'month' || id === 'last_month') setGroup('day');
                }}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        {period === 'custom' && (
          <div className="mp-dates">
            <label className="field">
              De
              <input
                type="date"
                value={custom.from}
                max={custom.to}
                onChange={(event) => setCustom({ ...custom, from: event.target.value })}
              />
            </label>
            <label className="field">
              Até
              <input
                type="date"
                value={custom.to}
                min={custom.from}
                onChange={(event) => setCustom({ ...custom, to: event.target.value })}
              />
            </label>
          </div>
        )}
        <div className="field">
          Agrupar por
          <div className="widget-period" role="group" aria-label="Agrupar por">
            {(
              [
                ['day', 'Dia'],
                ['week', 'Semana'],
                ['month', 'Mês'],
              ] as const
            ).map(([id, text]) => (
              <button
                key={id}
                type="button"
                className={group === id ? 'active' : ''}
                onClick={() => {
                  setGroup(id);
                  setDrill(null);
                }}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          Comparar com
          <div className="widget-period" role="group" aria-label="Comparar com">
            {(
              [
                ['previous', 'Período anterior'],
                ['year', 'Ano anterior'],
              ] as const
            ).map(([id, text]) => (
              <button
                key={id}
                type="button"
                className={against === id ? 'active' : ''}
                onClick={() => setAgainst(against === id ? '' : id)}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="mp-tabs" role="tablist">
        {(
          [
            ['overview', 'Panorama'],
            ['history', 'Histórico'],
            ['compare', 'Comparativos'],
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {text}
          </button>
        ))}
        <span className="mp-tabs-period">
          {brDay(shown.from)}/{shown.from.slice(2, 4)} a {brDay(shown.to)}/{shown.to.slice(2, 4)}
          {otherRange && (
            <small>
              {' '}
              · contra {brDay(otherRange.from)}/{otherRange.from.slice(2, 4)} a{' '}
              {brDay(otherRange.to)}/{otherRange.to.slice(2, 4)}
            </small>
          )}
        </span>
      </div>

      {!lineList.length && lines.data ? (
        <div className="notice">
          <b>Nenhuma linha de argamassa configurada</b>
          Ligue o módulo de ensaque ou de mistura no lápis do card de Ensaque de um equipamento.
        </div>
      ) : !data ? (
        <div className="stops-empty">{history.error ?? 'Carregando a produção…'}</div>
      ) : tab === 'overview' ? (
        <Overview data={data} before={before} onDay={(date) => setDayBoard(date)} />
      ) : tab === 'history' ? (
        <HistoryTab
          data={data}
          before={before}
          drill={drill}
          onDrill={(slot) => {
            if (shown.group === 'day') return setDayBoard(slot);
            const r = slotRange(slot, shown.group);
            setDrill({ ...r, group: shown.group === 'month' ? 'week' : 'day' });
          }}
          onBack={() => setDrill(null)}
        />
      ) : (
        <CompareTab line={line} range={range} group={group} />
      )}

      {openingStock && (
        <ModalPortal>
          <OpeningStockModal onClose={() => setOpeningStock(false)} />
        </ModalPortal>
      )}
      {productsOpen && (
        <ModalPortal>
          <ProductsModal onClose={() => setProductsOpen(false)} />
        </ModalPortal>
      )}
      {dayBoard && boardLine && (
        <ModalPortal>
          <DayBoardModal
            lines={line === 'all' ? lineList : lineList.filter((item) => item.id === line)}
            date={dayBoard}
            onClose={() => setDayBoard(null)}
          />
        </ModalPortal>
      )}
    </>
  );
}

// ---- Overview -----------------------------------------------------------------------------------

function Overview({
  data,
  before,
  onDay,
}: {
  data: History;
  before: History | null;
  onDay: (date: string) => void;
}) {
  const { totals } = data;
  const productNames = data.products.map((item) => item.name);
  const colorOf = (name: string) => color(PRODUCT_COLORS, Math.max(0, productNames.indexOf(name)));
  const rows = useMemo(() => {
    let cumulative = 0;
    return data.series.map((slot, at) => {
      cumulative += slot.bags;
      return {
        label: slotLabel(slot.slot, data.group),
        ...Object.fromEntries(productNames.map((name) => [name, slot.products[name] ?? 0])),
        target: slot.targetBags || null,
        cumulative,
        compare: before?.series[at]?.bags ?? null,
      };
    });
  }, [data, before, productNames]);
  const drawing = useFirstDraw(rows.length > 0);
  const targetShare = totals.targetBags ? totals.bags / totals.targetBags : null;

  return (
    <div className="mp-overview">
      <div className="mp-kpis">
        <div className="shift-kpi hero">
          <span>Ensacado</span>
          <b>
            {integer(totals.bags)} <small>sacos</small>
          </b>
          <em>
            {tons(totals.kg)} t <Delta value={delta(totals.bags, before?.totals.bags)} />
          </em>
        </div>
        <div className="shift-kpi">
          <span>Média por dia</span>
          <b>
            {integer(totals.perDay)} <small>sacos</small>
          </b>
          <em>
            {totals.days} dias produzidos{' '}
            <Delta value={delta(totals.perDay, before?.totals.perDay)} />
          </em>
        </div>
        <div className="shift-kpi">
          <span>Melhor dia</span>
          <b>{totals.best ? integer(totals.best.bags) : '—'}</b>
          <em>
            {totals.best ? `${brDay(totals.best.day)} · ${tons(totals.best.kg)} t` : 'sem produção'}
          </em>
        </div>
        <div className="shift-kpi">
          <span>Meta</span>
          <b>
            {totals.daysWithTarget ? `${totals.daysHit}/${totals.daysWithTarget}` : '—'}{' '}
            <small>dias batidos</small>
          </b>
          <em>
            {targetShare != null
              ? `${percent(targetShare, 0)} da meta do período`
              : 'sem meta definida'}
          </em>
        </div>
        <div className="shift-kpi">
          <span>Eficiência</span>
          <b>{percent(totals.effectiveness ?? totals.availability, 1)}</b>
          <em>
            {percent(totals.availability, 0)} disp. × {percent(totals.performance, 0)} desemp.{' '}
            <Delta
              value={delta(
                totals.effectiveness ?? totals.availability,
                before?.totals.effectiveness ?? before?.totals.availability,
              )}
            />
          </em>
        </div>
        <div className="shift-kpi">
          <span>Custo da mistura</span>
          <b>
            {money(totals.costPerTon)} <small>/t</small>
          </b>
          <em>
            {totals.cost != null ? `${money(totals.cost)} no período` : 'sem preços dos insumos'}
          </em>
        </div>
      </div>

      <section className="card mp-card">
        <div className="mp-card-head">
          <strong>Evolução da produção</strong>
          <small>
            sacos por {data.group === 'day' ? 'dia' : data.group === 'week' ? 'semana' : 'mês'}, por
            produto · linha: acumulado
          </small>
        </div>
        <div className="mp-chart tall">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS}
                tickLine={false}
                axisLine={false}
                minTickGap={12}
              />
              <YAxis
                yAxisId="bags"
                tick={AXIS}
                width={52}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => integer(v)}
              />
              <YAxis
                yAxisId="sum"
                orientation="right"
                tick={AXIS}
                width={60}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => integer(v)}
              />
              <Tooltip
                formatter={(value, name) => [
                  `${integer(Number(value))} sacos`,
                  name === 'cumulative'
                    ? 'acumulado'
                    : name === 'target'
                      ? 'meta'
                      : name === 'compare'
                        ? 'período comparado'
                        : name,
                ]}
              />
              {productNames.map((name, index) => (
                <Bar
                  key={name}
                  yAxisId="bags"
                  dataKey={name}
                  stackId="p"
                  fill={colorOf(name)}
                  radius={index === productNames.length - 1 ? [3, 3, 0, 0] : undefined}
                  isAnimationActive={drawing}
                  animationDuration={drawing ? 700 : 0}
                />
              ))}
              <Line
                yAxisId="bags"
                dataKey="target"
                stroke="#0b2028"
                strokeDasharray="6 4"
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
              {before && (
                <Line
                  yAxisId="bags"
                  dataKey="compare"
                  stroke="#b07cc6"
                  strokeDasharray="2 4"
                  strokeWidth={2}
                  dot={false}
                />
              )}
              <Line
                yAxisId="sum"
                dataKey="cumulative"
                stroke="var(--brand-accent, #12b8a6)"
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={drawing}
                animationDuration={drawing ? 700 : 0}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mp-legend">
          {productNames.map((name) => (
            <span key={name}>
              <i style={{ background: colorOf(name) }} /> {name}
            </span>
          ))}
          <span>
            <i className="dash" style={{ borderColor: '#0b2028' }} /> meta
          </span>
          {before && (
            <span>
              <i className="dash" style={{ borderColor: '#b07cc6' }} /> período comparado
            </span>
          )}
          <span>
            <i style={{ background: 'var(--brand-accent, #12b8a6)' }} /> acumulado
          </span>
        </div>
      </section>

      <section className="card mp-card">
        <div className="mp-card-head">
          <strong>Calendário de {data.to.slice(0, 4)}</strong>
          <small>cada dia pintado pelo que ensacou · clique num dia para abrir o quadro dele</small>
        </div>
        <CalendarHeat year={data.to.slice(0, 4)} days={data.calendar} onDay={onDay} />
      </section>

      <div className="mp-grid">
        <section className="card mp-card">
          <div className="mp-card-head">
            <strong>Mix de produtos · curva ABC</strong>
            <small>A: os que fazem 80% dos sacos · B: até 95% · C: o resto</small>
          </div>
          <table className="stops-table mortar-table">
            <thead>
              <tr>
                <th>Produto</th>
                <th>Classe</th>
                <th className="n">Sacos</th>
                <th className="n">t</th>
                <th>Participação</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((item) => (
                <tr key={item.name}>
                  <td>
                    <span className="mortar-dot" style={{ background: colorOf(item.name) }} />
                    <b>{item.name}</b>
                  </td>
                  <td>
                    <span className={`mp-abc ${item.abc}`}>{item.abc}</span>
                  </td>
                  <td className="n">{integer(item.bags)}</td>
                  <td className="n">{tons(item.kg)}</td>
                  <td>
                    <div className="mortar-share">
                      <i
                        style={{ width: `${item.share * 100}%`, background: colorOf(item.name) }}
                      />
                      <span>{percent(item.share)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card mp-card">
          <div className="mp-card-head">
            <strong>Evolução do mix</strong>
            <small>participação de cada produto em cada período</small>
          </div>
          <div className="mp-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                // Days with no bags (a Sunday) would drop every share to zero: they are left out.
                data={rows.filter((row, at) => (data.series[at]?.bags ?? 0) > 0)}
                stackOffset="expand"
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <XAxis
                  dataKey="label"
                  tick={AXIS}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={12}
                />
                <YAxis
                  tick={AXIS}
                  width={40}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                />
                <Tooltip formatter={(value, name) => [`${integer(Number(value))} sacos`, name]} />
                {productNames.map((name) => (
                  <Area
                    key={name}
                    dataKey={name}
                    stackId="m"
                    type="monotone"
                    stroke={colorOf(name)}
                    fill={colorOf(name)}
                    fillOpacity={0.75}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <div className="mp-grid">
        <section className="card mp-card">
          <div className="mp-card-head">
            <strong>Bicos</strong>
            <small>quanto cada um ensacou e a eficiência no período</small>
          </div>
          <div className="mp-spouts">
            {data.spouts.map((spout, index) => {
              const top = Math.max(1, data.spouts[0]?.bags ?? 1);
              return (
                <div key={spout.id} className="mp-spout">
                  <div className="mp-spout-name">
                    <i style={{ background: color(SPOUT_COLORS, index) }} />
                    <b>{spout.name}</b>
                    <span className="mp-rank">{index + 1}º</span>
                  </div>
                  <div className="mp-spout-bar">
                    <i
                      style={{
                        width: `${(spout.bags / top) * 100}%`,
                        background: color(SPOUT_COLORS, index),
                      }}
                    />
                  </div>
                  <div className="mp-spout-figures">
                    <span>
                      <b>{integer(spout.bags)}</b> sacos
                    </span>
                    <span>
                      <b>{percent(spout.effectiveness ?? spout.availability, 0)}</b> eficiência
                    </span>
                    <span>
                      <b>{spout.pacePerHour == null ? '—' : integer(spout.pacePerHour)}</b> sacos/h
                    </span>
                    <span>
                      <b>{integer(spout.stops)}</b> paradas · {duration(spout.stopSeconds)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <section className="card mp-card">
          <div className="mp-card-head">
            <strong>Eficiência dos bicos</strong>
            <small>disponível × desempenho, período a período</small>
          </div>
          <div className="mp-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data.series.map((slot, at) => ({
                  label: slotLabel(slot.slot, data.group),
                  ...Object.fromEntries(
                    data.spouts.map((spout) => {
                      const point = spout.series[at];
                      const value = point?.effectiveness ?? point?.availability;
                      return [spout.id, value == null ? null : Math.round(value * 1000) / 10];
                    }),
                  ),
                }))}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={AXIS}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={12}
                />
                <YAxis
                  tick={AXIS}
                  width={40}
                  tickLine={false}
                  axisLine={false}
                  domain={['auto', 'auto']}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip
                  formatter={(value, name) => [
                    `${Number(value).toLocaleString('pt-BR')}%`,
                    data.spouts.find((spout) => spout.id === name)?.name ?? '',
                  ]}
                />
                {data.spouts.map((spout, index) => (
                  <Line
                    key={spout.id}
                    dataKey={spout.id}
                    stroke={color(SPOUT_COLORS, index)}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <section className="card mp-card">
        <div className="mp-card-head">
          <strong>Quando a linha rende</strong>
          <small>média de sacos em cada hora, por dia da semana, nos dias produzidos</small>
        </div>
        <WeekHeat cells={data.heatmap} />
      </section>

      <div className="mp-grid">
        <section className="card mp-card">
          <div className="mp-card-head">
            <strong>Formação do estoque</strong>
            <small>
              saldo inicial + o que foi ensacado, por produto · saídas entram com a nota fiscal
            </small>
          </div>
          <StockChart data={data} colorOf={colorOf} />
        </section>
        <section className="card mp-card">
          <div className="mp-card-head">
            <strong>Matéria-prima</strong>
            <small>
              {integer(totals.batches)} bateladas · {tons(totals.mixedKg)} t misturadas
            </small>
          </div>
          <div className="mp-materials">
            {data.materials.map((item, index) => {
              const top = Math.max(1, data.materials[0]?.kg ?? 1);
              return (
                <div key={item.label}>
                  <span>
                    <i style={{ background: color(MATERIAL_COLORS, index) }} /> {item.label}
                  </span>
                  <div className="mp-spout-bar">
                    <i
                      style={{
                        width: `${(item.kg / top) * 100}%`,
                        background: color(MATERIAL_COLORS, index),
                      }}
                    />
                  </div>
                  <b>{tons(item.kg)} t</b>
                  <small>
                    {item.perTonBagged != null ? `${integer(item.perTonBagged)} kg/t ensacada` : ''}
                    {item.cost != null ? ` · ${money(item.cost)}` : ''}
                  </small>
                </div>
              );
            })}
          </div>
          {data.recipes.length > 0 && (
            <table className="stops-table mortar-table">
              <thead>
                <tr>
                  <th>Receita</th>
                  <th className="n">Bateladas</th>
                  <th className="n">Misturado</th>
                </tr>
              </thead>
              <tbody>
                {data.recipes.map((row) => (
                  <tr key={row.recipe}>
                    <td>{row.recipe}</td>
                    <td className="n">{integer(row.batches)}</td>
                    <td className="n">{tons(row.kg)} t</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

/** A year, a cell per day, coloured by the bags it made: weeks across, weekdays down. */
function CalendarHeat({
  year,
  days,
  onDay,
}: {
  year: string;
  days: Array<{ date: string; bags: number }>;
  onDay: (date: string) => void;
}) {
  const byDate = new Map(days.map((item) => [item.date, item.bags]));
  const max = Math.max(1, ...days.map((item) => item.bags));
  const first = parse(`${year}-01-01`);
  const offset = (first.getDay() + 6) % 7;
  const cells: Array<{ date: string | null; bags: number }> = [];
  for (let i = 0; i < offset; i += 1) cells.push({ date: null, bags: 0 });
  for (let date = `${year}-01-01`; date.startsWith(year); date = addDays(date, 1))
    cells.push({ date, bags: byDate.get(date) ?? 0 });
  const weeks = Math.ceil(cells.length / 7);
  const today = iso(new Date());
  const level = (bags: number) => (bags <= 0 ? 0 : Math.min(4, Math.ceil((bags / max) * 4)));
  const monthStarts = MONTHS.map((_, month) => {
    const at = parse(`${year}-${String(month + 1).padStart(2, '0')}-01`);
    return Math.floor((offset + Math.round((at.getTime() - first.getTime()) / 86400000)) / 7);
  });
  return (
    <div className="mp-calendar">
      <div className="mp-calendar-months" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }}>
        {MONTHS.map((name, month) => (
          <span key={name} style={{ gridColumn: monthStarts[month] + 1 }}>
            {name}
          </span>
        ))}
      </div>
      <div className="mp-calendar-body">
        <div className="mp-calendar-days">
          {WEEKDAYS.map((name, index) => (
            <span key={name}>{index % 2 === 0 ? name : ''}</span>
          ))}
        </div>
        <div className="mp-calendar-grid" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }}>
          {cells.map((cell, index) =>
            cell.date ? (
              <button
                key={cell.date}
                type="button"
                className={`l${level(cell.bags)}${cell.date === today ? ' today' : ''}`}
                style={{ gridColumn: Math.floor(index / 7) + 1, gridRow: (index % 7) + 1 }}
                title={`${brDay(cell.date)} · ${integer(cell.bags)} sacos`}
                disabled={cell.date > today}
                onClick={() => onDay(cell.date!)}
              />
            ) : (
              <i key={`pad-${index}`} style={{ gridColumn: 1, gridRow: (index % 7) + 1 }} />
            ),
          )}
        </div>
      </div>
      <div className="mp-calendar-scale">
        menos <i className="l0" />
        <i className="l1" />
        <i className="l2" />
        <i className="l3" />
        <i className="l4" /> mais · melhor dia: {integer(max)} sacos
      </div>
    </div>
  );
}

/** Weekdays down, hours across: where in the week the line makes its bags. */
function WeekHeat({ cells }: { cells: Array<{ weekday: number; hour: number; bags: number }> }) {
  if (!cells.length) return <div className="stops-empty">Nenhum saco no período.</div>;
  const hours = cells.map((cell) => cell.hour);
  const from = Math.min(...hours);
  const to = Math.max(...hours);
  const max = Math.max(1, ...cells.map((cell) => cell.bags));
  const at = new Map(cells.map((cell) => [`${cell.weekday}-${cell.hour}`, cell.bags]));
  const span = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return (
    <div
      className="mp-weekheat"
      style={{ gridTemplateColumns: `40px repeat(${span.length}, minmax(22px, 1fr))` }}
    >
      <span />
      {span.map((hour) => (
        <span key={hour} className="mp-weekheat-hour">
          {hour}h
        </span>
      ))}
      {WEEKDAYS.map((name, index) => (
        <Fragment key={name}>
          <span className="mp-weekheat-day">{name}</span>
          {span.map((hour) => {
            const bags = at.get(`${index + 1}-${hour}`) ?? 0;
            return (
              <i
                key={hour}
                style={{
                  background: bags
                    ? `color-mix(in srgb, var(--brand-accent, #12b8a6) ${Math.round(15 + (bags / max) * 85)}%, #fff)`
                    : '#f1f5f6',
                }}
                title={`${name} ${hour}h · ${integer(bags)} sacos em média`}
              >
                {bags >= max * 0.5 ? integer(bags) : ''}
              </i>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

function StockChart({ data, colorOf }: { data: History; colorOf: (name: string) => string }) {
  const rows = data.series.map((slot, at) => ({
    label: slotLabel(slot.slot, data.group),
    ...Object.fromEntries(data.stock.map((item) => [item.name, item.series[at] ?? 0])),
  }));
  const openings = data.stock.filter((item) => item.opening > 0);
  return (
    <>
      <div className="mp-chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={12} />
            <YAxis
              tick={AXIS}
              width={56}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => integer(v)}
            />
            <Tooltip formatter={(value, name) => [`${integer(Number(value))} sacos`, name]} />
            {data.stock.map((item) => (
              <Area
                key={item.name}
                dataKey={item.name}
                stackId="s"
                type="monotone"
                stroke={colorOf(item.name)}
                fill={colorOf(item.name)}
                fillOpacity={0.6}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mp-stock-list">
        {data.stock.map((item) => (
          <span key={item.name}>
            <i style={{ background: colorOf(item.name) }} /> {item.name}{' '}
            <b>{integer(item.series.at(-1) ?? item.opening)}</b>
            {item.opening > 0 && <small> (inicial {integer(item.opening)})</small>}
          </span>
        ))}
        {!openings.length && (
          <small className="muted">
            Sem saldo inicial: a curva começa do zero no início do período.
          </small>
        )}
      </div>
    </>
  );
}

// ---- History ------------------------------------------------------------------------------------

function HistoryTab({
  data,
  before,
  drill,
  onDrill,
  onBack,
}: {
  data: History;
  before: History | null;
  drill: { from: string; to: string; group: Group } | null;
  onDrill: (slot: string) => void;
  onBack: () => void;
}) {
  const rows = [...data.series].reverse();
  const unit = data.group === 'day' ? 'Dia' : data.group === 'week' ? 'Semana' : 'Mês';
  function exportCsv() {
    const header =
      'periodo;sacos;toneladas;dias;meta_sacos;dias_meta;eficiencia;paradas;bateladas;produto_principal';
    const lines = data.series.map((row) =>
      [
        row.slot,
        Math.round(row.bags),
        (row.kg / 1000).toFixed(3).replace('.', ','),
        row.days,
        Math.round(row.targetBags),
        `${row.daysHit}/${row.daysWithTarget}`,
        row.effectiveness == null ? '' : (row.effectiveness * 100).toFixed(1).replace('.', ','),
        row.stops,
        row.batches,
        row.top ?? '',
      ].join(';'),
    );
    const blob = new Blob(['﻿' + [header, ...lines].join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `producao-argamassa-${data.from}-a-${data.to}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  return (
    <section className="card mp-card">
      <div className="mp-card-head">
        <strong>
          {drill ? (
            <>
              <button type="button" className="mp-back" onClick={onBack}>
                ‹ Voltar
              </button>{' '}
              {brDay(drill.from)} a {brDay(drill.to)}
            </>
          ) : (
            'Histórico'
          )}
        </strong>
        <small>
          {data.group === 'day'
            ? 'clique num dia para abrir o quadro de turno dele'
            : `clique num${data.group === 'week' ? 'a semana' : ' mês'} para ver ${data.group === 'week' ? 'os dias' : 'as semanas'}`}
        </small>
        <button type="button" className="mp-export" onClick={exportCsv}>
          Exportar CSV
        </button>
      </div>
      <table className="stops-table mortar-table mp-history">
        <thead>
          <tr>
            <th>{unit}</th>
            <th className="n">Sacos</th>
            <th className="n">t</th>
            {data.group !== 'day' && <th className="n">Dias</th>}
            <th>Meta</th>
            <th className="n">Eficiência</th>
            <th className="n">Paradas</th>
            <th className="n">Bateladas</th>
            <th>Produto principal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const share = row.targetBags ? row.bags / row.targetBags : null;
            const index = data.series.indexOf(row);
            const was = before?.series[index];
            return (
              <tr
                key={row.slot}
                onClick={() => onDrill(row.slot)}
                className={row.bags ? '' : 'mp-quiet'}
              >
                <td>
                  <b>{slotLabel(row.slot, data.group)}</b>
                </td>
                <td className="n">
                  {integer(row.bags)}{' '}
                  {was && row.bags > 0 && <Delta value={delta(row.bags, was.bags)} />}
                </td>
                <td className="n">{tons(row.kg)}</td>
                {data.group !== 'day' && <td className="n">{row.days}</td>}
                <td>
                  {share == null ? (
                    <span className="muted">—</span>
                  ) : (
                    <div className="mortar-share mp-target">
                      <i
                        style={{
                          width: `${Math.min(100, share * 100)}%`,
                          background: share >= 1 ? '#1fbf7a' : share >= 0.9 ? '#f2a93b' : '#e4572e',
                        }}
                      />
                      <span>
                        {percent(share, 0)}
                        {data.group !== 'day' && ` · ${row.daysHit}/${row.daysWithTarget} dias`}
                      </span>
                    </div>
                  )}
                </td>
                <td className="n">{percent(row.effectiveness ?? row.availability, 1)}</td>
                <td className="n">
                  {integer(row.stops)}{' '}
                  <small className="muted">· {duration(row.stopSeconds)}</small>
                </td>
                <td className="n">{integer(row.batches)}</td>
                <td>{row.top ?? <span className="muted">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---- Comparisons ----------------------------------------------------------------------------------

function CompareTab({
  line,
  range,
  group,
}: {
  line: string;
  range: { from: string; to: string };
  group: Group;
}) {
  const [a, setA] = useState(range);
  const [b, setB] = useState(() => compareRange(range, 'previous')!);
  const query = (r: { from: string; to: string }, g: Group) =>
    `/mortar/history?device=${line}&from=${r.from}&to=${r.to}&group=${g}`;
  const first = usePoll<History>(query(a, group), 600000);
  const second = usePoll<History>(query(b, group), 600000);
  const year = Number(iso(new Date()).slice(0, 4));
  const thisYear = usePoll<History>(
    query({ from: `${year}-01-01`, to: `${year}-12-31` }, 'month'),
    600000,
  );
  const lastYear = usePoll<History>(
    query({ from: `${year - 1}-01-01`, to: `${year - 1}-12-31` }, 'month'),
    600000,
  );
  const A = first.data;
  const B = second.data;
  const rows: Array<
    [string, (h: History) => number | null, (n: number | null) => string, boolean?]
  > = [
    ['Sacos', (h) => h.totals.bags, (n) => integer(n ?? 0)],
    ['Toneladas', (h) => h.totals.kg, (n) => tons(n)],
    ['Dias produzidos', (h) => h.totals.days, (n) => integer(n ?? 0)],
    ['Média por dia', (h) => h.totals.perDay, (n) => integer(n ?? 0)],
    ['Eficiência', (h) => h.totals.effectiveness ?? h.totals.availability, (n) => percent(n, 1)],
    ['Disponibilidade', (h) => h.totals.availability, (n) => percent(n, 1)],
    ['Paradas', (h) => h.totals.stops, (n) => integer(n ?? 0), true],
    ['Bateladas', (h) => h.totals.batches, (n) => integer(n ?? 0)],
    ['Custo da mistura (R$/t)', (h) => h.totals.costPerTon, (n) => money(n), true],
  ];
  const products = useMemo(() => {
    if (!A || !B) return [];
    const names = [...new Set([...A.products, ...B.products].map((item) => item.name))];
    return names
      .map((name) => ({
        name,
        a: A.products.find((item) => item.name === name)?.bags ?? 0,
        b: B.products.find((item) => item.name === name)?.bags ?? 0,
      }))
      .sort((x, y) => y.a - x.a);
  }, [A, B]);
  const spouts = useMemo(() => {
    if (!A || !B) return [];
    return A.spouts.map((spout) => ({
      name: spout.name,
      a: spout,
      b: B.spouts.find((item) => item.id === spout.id) ?? null,
    }));
  }, [A, B]);
  const months = MONTHS.map((name, month) => ({
    label: name,
    now: thisYear.data?.series[month]?.bags ?? 0,
    then: lastYear.data?.series[month]?.bags ?? 0,
  }));
  const picker = (
    label: string,
    value: { from: string; to: string },
    set: (r: { from: string; to: string }) => void,
    tone: string,
  ) => (
    <div className={`mp-pick ${tone}`}>
      <span>{label}</span>
      <input
        type="date"
        value={value.from}
        max={value.to}
        onChange={(event) => set({ ...value, from: event.target.value })}
      />
      <small>até</small>
      <input
        type="date"
        value={value.to}
        min={value.from}
        onChange={(event) => set({ ...value, to: event.target.value })}
      />
    </div>
  );
  return (
    <div className="mp-overview">
      <section className="card mp-card">
        <div className="mp-card-head">
          <strong>Período contra período</strong>
          <small>escolha os dois períodos; a variação é de A sobre B</small>
        </div>
        <div className="mp-picks">
          {picker('A', a, setA, 'a')}
          {picker('B', b, setB, 'b')}
        </div>
        {!A || !B ? (
          <div className="stops-empty">Carregando…</div>
        ) : (
          <table className="stops-table mortar-table mp-versus">
            <thead>
              <tr>
                <th>Indicador</th>
                <th className="n">A</th>
                <th className="n">B</th>
                <th className="n">Variação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, pick, fmt, invert]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="n">
                    <b>{fmt(pick(A))}</b>
                  </td>
                  <td className="n">{fmt(pick(B))}</td>
                  <td className="n">
                    <Delta value={delta(pick(A), pick(B))} invert={invert} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {A && B && (
        <div className="mp-grid">
          <section className="card mp-card">
            <div className="mp-card-head">
              <strong>Produtos · A × B</strong>
              <small>sacos de cada produto nos dois períodos</small>
            </div>
            <div className="mp-chart" style={{ height: Math.max(200, products.length * 44 + 30) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={products}
                  layout="vertical"
                  margin={{ top: 4, right: 20, bottom: 0, left: 0 }}
                >
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ ...AXIS, fontSize: 11 }}
                    width={120}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={(value, name) => [
                      `${integer(Number(value))} sacos`,
                      name === 'a' ? 'A' : 'B',
                    ]}
                  />
                  <Bar dataKey="a" fill="var(--brand-accent, #12b8a6)" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="b" fill="#b9c7cb" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
          <section className="card mp-card">
            <div className="mp-card-head">
              <strong>Bicos · A × B</strong>
              <small>sacos e eficiência de cada bico</small>
            </div>
            <table className="stops-table mortar-table">
              <thead>
                <tr>
                  <th>Bico</th>
                  <th className="n">Sacos A</th>
                  <th className="n">Sacos B</th>
                  <th className="n">Efic. A</th>
                  <th className="n">Efic. B</th>
                </tr>
              </thead>
              <tbody>
                {spouts.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <b>{row.name}</b>
                    </td>
                    <td className="n">
                      {integer(row.a.bags)} <Delta value={delta(row.a.bags, row.b?.bags)} />
                    </td>
                    <td className="n">{integer(row.b?.bags ?? 0)}</td>
                    <td className="n">{percent(row.a.effectiveness ?? row.a.availability, 1)}</td>
                    <td className="n">{percent(row.b?.effectiveness ?? row.b?.availability, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      <section className="card mp-card">
        <div className="mp-card-head">
          <strong>
            Mês a mês · {year} × {year - 1}
          </strong>
          <small>sacos ensacados em cada mês dos dois anos</small>
        </div>
        <div className="mp-chart tall">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={months} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis
                tick={AXIS}
                width={56}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => integer(v)}
              />
              <Tooltip
                formatter={(value, name) => [
                  `${integer(Number(value))} sacos`,
                  name === 'now' ? String(year) : String(year - 1),
                ]}
              />
              <Bar dataKey="then" fill="#b9c7cb" radius={[3, 3, 0, 0]} />
              <Bar dataKey="now" radius={[3, 3, 0, 0]}>
                {months.map((month) => (
                  <Cell key={month.label} fill="var(--brand-accent, #12b8a6)" />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mp-legend">
          <span>
            <i style={{ background: 'var(--brand-accent, #12b8a6)' }} /> {year}
          </span>
          <span>
            <i style={{ background: '#b9c7cb' }} /> {year - 1}
          </span>
        </div>
      </section>
    </div>
  );
}

// ---- Windows ----------------------------------------------------------------------------------------

/** One day opened from the calendar or the history: the shift board of each line. */
function DayBoardModal({
  lines,
  date,
  onClose,
}: {
  lines: Line[];
  date: string;
  onClose: () => void;
}) {
  const [line, setLine] = useState(lines[0]?.id ?? '');
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-card mortar-modal wide"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-title">
          <div>
            <h2>Produção de {brDay(date)}</h2>
            {lines.length > 1 && (
              <span className="widget-period" role="group" aria-label="Linha">
                {lines.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={line === item.id ? 'active' : ''}
                    onClick={() => setLine(item.id)}
                  >
                    {item.name}
                  </button>
                ))}
              </span>
            )}
          </div>
          <button onClick={onClose} aria-label="Fechar">
            Fechar
          </button>
        </header>
        {line && <MortarShiftBoard key={line} deviceId={line} date={date} />}
      </div>
    </div>
  );
}

function OpeningStockModal({ onClose }: { onClose: () => void }) {
  const stock = usePoll<{
    products: Array<{
      product_id: string;
      name: string;
      nominal_kg: number;
      bags: number | null;
      as_of: string | null;
    }>;
  }>('/mortar/stock-opening', 600000);
  const [form, setForm] = useState<Record<string, { bags: string; asOf: string }>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const today = iso(new Date());
  const valueOf = (item: { product_id: string; bags: number | null; as_of: string | null }) =>
    form[item.product_id] ?? {
      bags: item.bags == null ? '' : String(item.bags),
      asOf: item.as_of ?? today,
    };
  async function save() {
    setSaving(true);
    setError('');
    try {
      await mutate('/mortar/stock-opening', 'PUT', {
        items: Object.entries(form)
          .filter(([, value]) => value.bags.trim() !== '')
          .map(([productId, value]) => ({
            productId,
            bags: Number(value.bags.replace(/\./g, '').replace(',', '.')),
            asOf: value.asOf,
          })),
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card mortar-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-title">
          <div>
            <h2>Saldo inicial do estoque</h2>
            <small>
              Quantos sacos de cada produto havia no estoque e em que data. A partir dela a
              plataforma soma o que foi ensacado; as saídas entram com a integração das notas.
            </small>
          </div>
          <button onClick={onClose} aria-label="Fechar">
            Fechar
          </button>
        </header>
        {error && <div className="form-error">{error}</div>}
        <table className="stops-table mortar-table">
          <thead>
            <tr>
              <th>Produto</th>
              <th>Sacos em estoque</th>
              <th>Na data</th>
            </tr>
          </thead>
          <tbody>
            {(stock.data?.products ?? []).map((item) => {
              const value = valueOf(item);
              return (
                <tr key={item.product_id}>
                  <td>
                    <b>{item.name}</b>
                  </td>
                  <td>
                    <input
                      inputMode="numeric"
                      value={value.bags}
                      placeholder="0"
                      onChange={(event) =>
                        setForm({
                          ...form,
                          [item.product_id]: { ...value, bags: event.target.value },
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="date"
                      value={value.asOf}
                      max={today}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          [item.product_id]: { ...value, asOf: event.target.value },
                        })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving || !Object.keys(form).length}
            onClick={() => void save()}
          >
            {saving ? 'Salvando…' : 'Salvar saldo'}
          </button>
        </div>
      </div>
    </div>
  );
}
