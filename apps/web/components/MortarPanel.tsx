'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useFirstDraw } from './firstDraw';
import { mutate, usePoll } from './data';
import { ModalPortal } from './ModalPortal';
import { usePlatform } from './PlatformShell';

/**
 * The mortar cards (migration 037): bagging, production by product, raw materials and yield.
 *
 * All four read one summary of the device for the period, so they always agree with each other:
 * the bags the bagging card counts are the bags the product card splits and the yield card
 * weighs. Tons are always bags times the product's nominal weight; a recipe not linked to a
 * product is counted in bags and left out of the tons, and the card says so instead of guessing.
 */
export type MortarView = 'bagging' | 'mortar_output' | 'mortar_materials' | 'mortar_yield';

type Spout = {
  id: string;
  position: number;
  name: string;
  state: 'running' | 'idle' | 'off' | 'offline' | 'unknown';
  recipe: string | null;
  product: string | null;
  lastBagAt: string | null;
  bags: number;
  kg: number;
  runningS: number;
  idleS: number;
  offS: number;
  bagsPerHour: number | null;
  secondsPerBag: number | null;
};
type Summary = {
  from: string;
  to: string;
  granularity: 'hour' | 'day';
  modules: { mix: boolean; bagging: boolean };
  bagging: {
    totals: {
      bags: number;
      kg: number;
      unlinkedBags: number;
      runningS: number;
      idleS: number;
      offS: number;
    };
    spouts: Spout[];
    products: Array<{
      key: string;
      productId: string | null;
      name: string;
      nominalKg: number | null;
      bags: number;
      kg: number | null;
      recipes: Array<{ recipe: string; bags: number }>;
      spouts: Record<string, number>;
    }>;
    series: Array<{
      slot: string;
      bags: number;
      kg: number;
      spouts: Record<string, number>;
      running: Record<string, number>;
    }>;
  };
  mix: {
    batches: number;
    kg: number;
    scaleKg: number | null;
    scaleTheoreticalKg: number;
    lastBatchAt: string | null;
    materials: Array<{ label: string; kg: number }>;
    recipes: Array<{
      recipe: string;
      batches: number;
      kg: number;
      materials: Array<{ label: string; kg: number }>;
    }>;
    series: Array<{ slot: string; materials: Record<string, number> }>;
  };
  yield: {
    mixedKg: number;
    baggedKg: number;
    unlinkedBags: number;
    lossKg: number | null;
    lossRatio: number | null;
  };
};

const SPOUT_COLORS = ['#12b8a6', '#3a7bd5', '#f2a93b', '#9b6bd3', '#e4572e', '#5aa469'];
const MATERIAL_COLORS = ['#c9a36a', '#7a8fa6', '#e8e1d2', '#5aa469', '#9b6bd3', '#f2a93b'];
const STATES: Record<Spout['state'], { label: string; color: string }> = {
  running: { label: 'Ensacando', color: '#12b8a6' },
  idle: { label: 'Ociosa', color: '#f2a93b' },
  off: { label: 'Desabilitada', color: '#98a6ab' },
  offline: { label: 'Sem comunicação', color: '#e4572e' },
  unknown: { label: 'Aguardando dados', color: '#c4d0d3' },
};

const integer = (value: number) => Math.round(value).toLocaleString('pt-BR');
const tons = (kg: number | null | undefined) =>
  kg == null
    ? '—'
    : (kg / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
function duration(seconds: number) {
  if (!seconds || seconds < 60) return `${Math.round(seconds || 0)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
    : `${minutes} min`;
}
/** "2026-10-01" → "01/10"; "2026-10-01T14" → "14h"; "2026-10-01T14:15" → "14:15". */
const slotLabel = (slot: string) =>
  slot.length > 13
    ? slot.slice(11)
    : slot.includes('T')
      ? `${slot.slice(11)}h`
      : slot.split('-').reverse().slice(0, 2).join('/');
/** Seconds per bag as the plant reads it: "14,2 s". */
const perBag = (seconds: number | null | undefined) =>
  seconds == null || !Number.isFinite(seconds)
    ? '—'
    : `${seconds.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;

/** The dashboard's own period words, the same the stops card offers. */
type Period = 'today' | 'yesterday' | '7d' | 'week' | 'month' | 'year' | 'custom';
const PERIODS: Array<[Period, string]> = [
  ['today', 'Hoje'],
  ['yesterday', 'Ontem'],
  ['7d', '7 dias'],
  ['week', 'Semana'],
  ['month', 'Mês'],
  ['year', 'Ano'],
  ['custom', 'Personalizado'],
];
const isoDay = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
function windowOf(period: Period): { from: string; to: string } {
  const now = new Date();
  const to = isoDay(now);
  const back = (days: number) => isoDay(new Date(now.getTime() - days * 86400000));
  if (period === 'today') return { from: to, to };
  if (period === 'yesterday') return { from: back(1), to: back(1) };
  if (period === '7d') return { from: back(6), to };
  if (period === 'week') return { from: back((now.getDay() + 6) % 7), to };
  if (period === 'month')
    return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  return { from: isoDay(new Date(now.getFullYear(), 0, 1)), to };
}

export function MortarPanel({ deviceId, view }: { deviceId: string; view: MortarView }) {
  const { user } = usePlatform();
  const master = user.role === 'master';
  const [period, setPeriod] = useState<Period>(view === 'bagging' ? 'today' : 'month');
  const [custom, setCustom] = useState(() => windowOf('7d'));
  const [modal, setModal] = useState<null | 'products' | 'config'>(null);
  const range = period === 'custom' ? custom : windowOf(period);
  const summary = usePoll<Summary>(
    `/devices/${deviceId}/mortar?from=${range.from}&to=${range.to}`,
    view === 'bagging' ? 30000 : 120000,
  );

  const tools = (
    <div className="stops-tools">
      <div className="widget-period" role="group" aria-label="Período">
        {PERIODS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={period === value ? 'active' : ''}
            onClick={() => setPeriod(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <span className="widget-period-custom">
          <input
            type="date"
            aria-label="De"
            value={custom.from}
            max={custom.to}
            onChange={(event) => setCustom((was) => ({ ...was, from: event.target.value }))}
          />
          <span>até</span>
          <input
            type="date"
            aria-label="Até"
            value={custom.to}
            min={custom.from}
            onChange={(event) => setCustom((was) => ({ ...was, to: event.target.value }))}
          />
        </span>
      )}
      {master && (
        <span className="mortar-actions">
          {view !== 'mortar_materials' && (
            <button type="button" onClick={() => setModal('products')}>
              Produtos e receitas
            </button>
          )}
          <button type="button" onClick={() => setModal('config')}>
            Configurar
          </button>
        </span>
      )}
    </div>
  );

  const data = summary.data;
  return (
    <div className="stops-panel mortar-panel">
      <div className="stops-head">{tools}</div>
      {!data ? (
        <div className="stops-empty">{summary.error ?? 'Carregando…'}</div>
      ) : view === 'bagging' ? (
        <Bagging data={data} onLink={master ? () => setModal('products') : undefined} />
      ) : view === 'mortar_output' ? (
        <Output data={data} onLink={master ? () => setModal('products') : undefined} />
      ) : view === 'mortar_materials' ? (
        <Materials data={data} />
      ) : (
        <Yield data={data} onLink={master ? () => setModal('products') : undefined} />
      )}
      {modal === 'products' && (
        <ModalPortal>
          <ProductsModal
            onClose={() => {
              setModal(null);
              void summary.refresh();
            }}
          />
        </ModalPortal>
      )}
      {modal === 'config' && (
        <ModalPortal>
          <MortarConfigModal
            deviceId={deviceId}
            onClose={() => {
              setModal(null);
              void summary.refresh();
            }}
          />
        </ModalPortal>
      )}
    </div>
  );
}

function Unlinked({ bags, onLink }: { bags: number; onLink?: () => void }) {
  if (!bags) return null;
  return (
    <div className="mortar-warning">
      <span>
        <b>{integer(bags)} sacos</b> de receitas ainda sem produto: contados, mas fora das
        toneladas.
      </span>
      {onLink && (
        <button type="button" onClick={onLink}>
          Vincular receitas
        </button>
      )}
    </div>
  );
}

/** Bars per slot, stacked by series; one colour per series and a legend under them. */
function StackedBars({
  slots,
  series,
  unit,
}: {
  slots: Array<{ slot: string; values: Record<string, number> }>;
  series: Array<{ key: string; label: string; color: string }>;
  unit: (value: number) => string;
}) {
  const peak = Math.max(
    1,
    ...slots.map((slot) => Object.values(slot.values).reduce((a, b) => a + b, 0)),
  );
  if (!slots.length) return <div className="stops-empty">Nada registrado no período.</div>;
  return (
    <>
      <div className="stops-days mortar-bars">
        {slots.map((slot) => {
          const total = Object.values(slot.values).reduce((a, b) => a + b, 0);
          return (
            <div
              className="stops-day"
              key={slot.slot}
              title={`${slotLabel(slot.slot)} · ${unit(total)}`}
            >
              <div className="stops-day-bar mortar-stack">
                <span style={{ height: `${(total / peak) * 100}%` }}>
                  {series.map((item) =>
                    slot.values[item.key] ? (
                      <i
                        key={item.key}
                        style={{ flexGrow: slot.values[item.key], background: item.color }}
                        title={`${item.label} · ${unit(slot.values[item.key])}`}
                      />
                    ) : null,
                  )}
                </span>
              </div>
              <b>{unit(total)}</b>
              <small>{slotLabel(slot.slot)}</small>
            </div>
          );
        })}
      </div>
      <div className="stops-spent-legend">
        {series.map((item) => (
          <span key={item.key}>
            <i style={{ background: item.color }} /> {item.label}
          </span>
        ))}
      </div>
    </>
  );
}

function Bagging({ data, onLink }: { data: Summary; onLink?: () => void }) {
  const { totals, spouts, series } = data.bagging;
  const worked = totals.runningS + totals.idleS;
  if (!spouts.length)
    return (
      <div className="stops-empty">
        Nenhum bico configurado. Em <b>Configurar</b>, ligue o módulo de ensaque e escolha as
        variáveis de cada bico.
      </div>
    );
  return (
    <>
      <div className="stops-totals">
        <div>
          <span>Sacos</span>
          <b>{integer(totals.bags)}</b>
          <small>todos os bicos</small>
        </div>
        <div>
          <span>Toneladas</span>
          <b>{tons(totals.kg)}</b>
          <small>sacos × peso do produto</small>
        </div>
        <div>
          <span>Ritmo</span>
          <b>{totals.runningS ? integer(totals.bags / (totals.runningS / 3600)) : '—'}</b>
          <small>sacos por hora de bico ensacando</small>
        </div>
        <div>
          <span>Tempo por saco</span>
          <b>{perBag(totals.bags ? totals.runningS / totals.bags : null)}</b>
          <small>em cada bico, sem as paradas</small>
        </div>
        <div>
          <span>Aproveitamento</span>
          <b>{percent(worked ? totals.runningS / worked : null)}</b>
          <small>ensacando ÷ habilitado</small>
        </div>
      </div>
      <Unlinked bags={totals.unlinkedBags} onLink={onLink} />

      <div className="stops-title">Bicos</div>
      <div className="mortar-spouts">
        {spouts.map((spout, index) => {
          const state = STATES[spout.state];
          const time = spout.runningS + spout.idleS + spout.offS;
          return (
            <div className="mortar-spout" key={spout.id}>
              <header>
                <i style={{ background: SPOUT_COLORS[index % SPOUT_COLORS.length] }} />
                <b>{spout.name}</b>
                <em style={{ color: state.color }}>
                  <u style={{ background: state.color }} />
                  {state.label}
                </em>
              </header>
              <small className="mortar-spout-recipe" title={spout.recipe ?? ''}>
                {spout.product ?? spout.recipe ?? 'Sem receita'}
                {spout.product && spout.recipe ? <span> · {spout.recipe}</span> : null}
              </small>
              <div className="mortar-spout-figures">
                <div>
                  <b>{integer(spout.bags)}</b>
                  <small>sacos</small>
                </div>
                <div>
                  <b>{tons(spout.kg)}</b>
                  <small>t</small>
                </div>
                <div>
                  <b>{spout.bagsPerHour == null ? '—' : integer(spout.bagsPerHour)}</b>
                  <small>sacos/h</small>
                </div>
                <div>
                  <b>{perBag(spout.secondsPerBag)}</b>
                  <small>por saco</small>
                </div>
              </div>
              {time > 0 && (
                <div
                  className="stops-spent"
                  title={`Ensacando ${duration(spout.runningS)} · Ociosa ${duration(spout.idleS)} · Desabilitada ${duration(spout.offS)}`}
                >
                  <i
                    style={{
                      width: `${(spout.runningS / time) * 100}%`,
                      background: STATES.running.color,
                    }}
                  />
                  <i
                    style={{
                      width: `${(spout.idleS / time) * 100}%`,
                      background: STATES.idle.color,
                    }}
                  />
                  <i
                    style={{ width: `${(spout.offS / time) * 100}%`, background: STATES.off.color }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <BaggingCharts data={data} />
    </>
  );
}

/**
 * How the bagging moved through the period: the bags of each spout piling up, the line as a
 * whole under them, and how long each spout took per bag. One day is read by the quarter hour,
 * so a spout that slowed down after lunch shows it; a longer period is read by the day.
 */
function BaggingCharts({ data }: { data: Summary }) {
  const { spouts, series } = data.bagging;
  const quarter = series.some((slot) => slot.slot.length > 13);
  const rows = useMemo(() => {
    const running: Record<string, number> = {};
    let total = 0;
    return series.map((slot) => {
      const row: Record<string, number | string | null> = {
        label: slotLabel(slot.slot),
        bags: slot.bags,
      };
      total += slot.bags;
      row.total = total;
      for (const spout of spouts) {
        const bags = slot.spouts[spout.id] ?? 0;
        running[spout.id] = (running[spout.id] ?? 0) + bags;
        row['sum_' + spout.id] = running[spout.id];
        // A slot where the spout filled few bags says little about its pace: left as a gap.
        const seconds = slot.running[spout.id] ?? 0;
        row['sec_' + spout.id] =
          bags >= 3 && seconds > 0 ? Math.round((seconds / bags) * 10) / 10 : null;
      }
      return row;
    });
  }, [series, spouts]);
  const drawing = useFirstDraw(rows.length > 0);
  if (!rows.length) return <div className="stops-empty">Nenhum saco registrado no período.</div>;
  const colorOf = (index: number) => SPOUT_COLORS[index % SPOUT_COLORS.length];
  const axis = { fontSize: 10, fill: '#7b9097' };
  const grain = quarter ? 'a cada 15 minutos' : 'por dia';
  const legend = (
    <div className="stops-spent-legend">
      {spouts.map((spout, index) => (
        <span key={spout.id}>
          <i style={{ background: colorOf(index) }} /> {spout.name}
        </span>
      ))}
    </div>
  );
  return (
    <>
      <div className="stops-title">
        Andamento por ensacadeira<small> · sacos acumulados de cada bico</small>
      </div>
      <div className="mortar-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e6eef0" vertical={false} />
            <XAxis dataKey="label" tick={axis} minTickGap={24} />
            <YAxis tick={axis} width={52} tickFormatter={(value: number) => integer(value)} />
            <Tooltip formatter={(value) => [integer(Number(value)), 'sacos']} />
            {spouts.map((spout, index) => (
              <Line
                key={spout.id}
                dataKey={'sum_' + spout.id}
                name={spout.name}
                stroke={colorOf(index)}
                strokeWidth={2}
                dot={false}
                isAnimationActive={drawing}
                animationDuration={drawing ? 700 : 0}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {legend}

      <div className="stops-title">
        Geral da linha<small> · sacos {grain} e o acumulado</small>
      </div>
      <div className="mortar-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e6eef0" vertical={false} />
            <XAxis dataKey="label" tick={axis} minTickGap={24} />
            <YAxis
              yAxisId="slot"
              tick={axis}
              width={44}
              tickFormatter={(value: number) => integer(value)}
            />
            <YAxis
              yAxisId="sum"
              orientation="right"
              tick={axis}
              width={56}
              tickFormatter={(value: number) => integer(value)}
            />
            <Tooltip
              formatter={(value, name) => [
                integer(Number(value)),
                name === 'total' ? 'acumulado' : 'sacos no intervalo',
              ]}
            />
            <Bar
              yAxisId="slot"
              dataKey="bags"
              fill="#bfe9e3"
              radius={[3, 3, 0, 0]}
              isAnimationActive={drawing}
              animationDuration={drawing ? 700 : 0}
            />
            <Line
              yAxisId="sum"
              dataKey="total"
              stroke="#0b2028"
              strokeWidth={2}
              dot={false}
              isAnimationActive={drawing}
              animationDuration={drawing ? 700 : 0}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="stops-title">
        Tempo por saco<small> · segundos ensacando ÷ sacos, {grain}, em cada bico</small>
      </div>
      <div className="mortar-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e6eef0" vertical={false} />
            <XAxis dataKey="label" tick={axis} minTickGap={24} />
            <YAxis
              tick={axis}
              width={52}
              domain={['auto', 'auto']}
              tickFormatter={(value: number) => value + ' s'}
            />
            <Tooltip formatter={(value) => [perBag(Number(value)), 'por saco']} />
            {spouts.map((spout, index) => (
              <Line
                key={spout.id}
                dataKey={'sec_' + spout.id}
                name={spout.name}
                stroke={colorOf(index)}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={drawing}
                animationDuration={drawing ? 700 : 0}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {legend}
    </>
  );
}

function Output({ data, onLink }: { data: Summary; onLink?: () => void }) {
  const { products, totals, spouts } = data.bagging;
  const [open, setOpen] = useState<string | null>(null);
  const peak = Math.max(1, ...products.map((item) => item.bags));
  return (
    <>
      <div className="stops-totals">
        <div>
          <span>Sacos</span>
          <b>{integer(totals.bags)}</b>
          <small>produzidos no período</small>
        </div>
        <div>
          <span>Toneladas</span>
          <b>{tons(totals.kg)}</b>
          <small>pelo peso de cada produto</small>
        </div>
        <div>
          <span>Produtos</span>
          <b>{products.filter((item) => item.productId).length}</b>
          <small>com produção no período</small>
        </div>
      </div>
      <Unlinked bags={totals.unlinkedBags} onLink={onLink} />
      {products.length ? (
        <table className="stops-table mortar-products">
          <thead>
            <tr>
              <th>Produto</th>
              <th className="n">Sacos</th>
              <th className="n">t</th>
              <th>Participação</th>
            </tr>
          </thead>
          <tbody>
            {products.map((item) => (
              <Fragment key={item.key}>
                <tr
                  className={item.productId ? '' : 'mortar-unlinked'}
                  onClick={() => setOpen(open === item.key ? null : item.key)}
                >
                  <td>
                    <b>{item.name}</b>
                    <small>
                      {item.productId
                        ? `${item.nominalKg?.toLocaleString('pt-BR')} kg · ${item.recipes.length} receita(s)`
                        : 'receita sem produto'}
                    </small>
                  </td>
                  <td className="n">{integer(item.bags)}</td>
                  <td className="n">{tons(item.kg)}</td>
                  <td>
                    <div className="mortar-share">
                      <i style={{ width: `${(item.bags / peak) * 100}%` }} />
                      <span>{percent(totals.bags ? item.bags / totals.bags : null)}</span>
                    </div>
                  </td>
                </tr>
                {open === item.key && (
                  <tr className="mortar-detail">
                    <td colSpan={4}>
                      {item.recipes.map((recipe) => (
                        <span key={recipe.recipe}>
                          {recipe.recipe}: <b>{integer(recipe.bags)}</b>
                        </span>
                      ))}
                      {spouts.map((spout) =>
                        item.spouts[spout.id] ? (
                          <span key={spout.id}>
                            Bico {spout.name}: <b>{integer(item.spouts[spout.id])}</b>
                          </span>
                        ) : null,
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="stops-empty">Nenhum saco registrado no período.</div>
      )}
    </>
  );
}

function Materials({ data }: { data: Summary }) {
  const { mix } = data;
  const colorOf = (label: string) =>
    MATERIAL_COLORS[
      Math.max(
        0,
        mix.materials.findIndex((item) => item.label === label),
      ) % MATERIAL_COLORS.length
    ];
  if (!data.modules.mix && !mix.batches)
    return (
      <div className="stops-empty">
        O módulo de mistura não está ligado. Em <b>Configurar</b>, escolha o contador de bateladas,
        a receita e o peso de cada material.
      </div>
    );
  return (
    <>
      <div className="stops-totals">
        <div>
          <span>Bateladas</span>
          <b>{integer(mix.batches)}</b>
          <small>
            {mix.lastBatchAt
              ? `última às ${new Date(mix.lastBatchAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
              : 'nenhuma no período'}
          </small>
        </div>
        <div>
          <span>Misturado</span>
          <b>{tons(mix.kg)}</b>
          <small>t pela receita</small>
        </div>
        {mix.materials.map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <b>{tons(item.kg)}</b>
            <small>t · {percent(mix.kg ? item.kg / mix.kg : null)} da mistura</small>
          </div>
        ))}
      </div>
      {mix.scaleKg != null && (
        <div className="stops-note">
          Pela balança: <b>{tons(mix.scaleKg)} t</b> dosadas contra {tons(mix.scaleTheoreticalKg)} t
          pedidas pela receita nas mesmas bateladas (
          {percent(mix.scaleTheoreticalKg ? mix.scaleKg / mix.scaleTheoreticalKg - 1 : null)}).
        </div>
      )}

      <div className="stops-title">
        Por receita<small> · peso da receita × bateladas</small>
      </div>
      {mix.recipes.length ? (
        <table className="stops-table">
          <thead>
            <tr>
              <th>Receita</th>
              <th className="n">Bateladas</th>
              {mix.materials.map((item) => (
                <th className="n" key={item.label}>
                  {item.label} (t)
                </th>
              ))}
              <th className="n">Total (t)</th>
            </tr>
          </thead>
          <tbody>
            {mix.recipes.map((row) => (
              <tr key={row.recipe}>
                <td>
                  <b>{row.recipe}</b>
                </td>
                <td className="n">{integer(row.batches)}</td>
                {mix.materials.map((item) => (
                  <td className="n" key={item.label}>
                    {tons(row.materials.find((entry) => entry.label === item.label)?.kg ?? 0)}
                  </td>
                ))}
                <td className="n">
                  <b>{tons(row.kg)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="stops-empty">Nenhuma batelada registrada no período.</div>
      )}

      <div className="stops-title">
        {data.granularity === 'hour' ? 'Hora a hora' : 'Dia a dia'}
        <small> · toneladas de cada material</small>
      </div>
      <StackedBars
        slots={mix.series.map((slot) => ({ slot: slot.slot, values: slot.materials }))}
        series={mix.materials.map((item) => ({
          key: item.label,
          label: item.label,
          color: colorOf(item.label),
        }))}
        unit={(kg) => tons(kg)}
      />
    </>
  );
}

function Yield({ data, onLink }: { data: Summary; onLink?: () => void }) {
  const { yield: result } = data;
  const peak = Math.max(1, result.mixedKg, result.baggedKg);
  return (
    <>
      <div className="stops-totals">
        <div>
          <span>Misturado</span>
          <b>{tons(result.mixedKg)}</b>
          <small>t que entraram no silo</small>
        </div>
        <div>
          <span>Ensacado</span>
          <b>{tons(result.baggedKg)}</b>
          <small>t que saíram em sacos</small>
        </div>
        <div>
          <span>Diferença</span>
          <b>{tons(result.lossKg)}</b>
          <small>
            {result.lossRatio == null
              ? 'sem mistura no período'
              : `${percent(result.lossRatio)} do misturado`}
          </small>
        </div>
      </div>
      <div className="mortar-yield">
        <div>
          <span>Misturado</span>
          <i style={{ width: `${(result.mixedKg / peak) * 100}%`, background: '#c9a36a' }} />
          <b>{tons(result.mixedKg)} t</b>
        </div>
        <div>
          <span>Ensacado</span>
          <i style={{ width: `${(result.baggedKg / peak) * 100}%`, background: '#12b8a6' }} />
          <b>{tons(result.baggedKg)} t</b>
        </div>
      </div>
      <div className="stops-note">
        A diferença soma a perda do processo e o que ainda está no silo pulmão; num período curto o
        silo pesa mais, num mês ela mostra a perda de verdade. Uma diferença negativa quer dizer que
        se ensacou o que já estava no silo antes do período.
      </div>
      <Unlinked bags={result.unlinkedBags} onLink={onLink} />
    </>
  );
}

// ---- Products and the recipes linked to them ----

type Catalog = {
  products: Array<{ id: string; name: string; nominal_kg: number }>;
  recipes: Array<{ recipe: string; productId: string | null; bags: number; lastAt: string | null }>;
};

function ProductsModal({ onClose }: { onClose: () => void }) {
  const catalog = usePoll<Catalog>('/mortar/products', 600000);
  const [name, setName] = useState('');
  const [kg, setKg] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; kg: string } | null>(null);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      await catalog.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar');
    }
  };
  const number = (text: string) => Number(text.replace(',', '.'));
  const products = catalog.data?.products ?? [];
  const recipes = catalog.data?.recipes ?? [];
  const pending = recipes.filter((row) => !row.productId).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card mortar-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-title">
          <div>
            <h2>Produtos e receitas</h2>
            <small>
              Cada receita das ensacadeiras aponta para um produto. Receitas iguais em bicos
              diferentes somam no mesmo produto.
            </small>
          </div>
          <button onClick={onClose} aria-label="Fechar">
            Fechar
          </button>
        </header>
        {error && <div className="form-error">{error}</div>}

        <div className="stops-title">Produtos</div>
        <form
          className="mortar-form-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !(number(kg) > 0)) return;
            void run(async () => {
              await mutate('/mortar/products', 'POST', {
                name: name.trim(),
                nominalKg: number(kg),
              });
              setName('');
              setKg('');
            });
          }}
        >
          <input
            placeholder="Nome do produto (ex.: AC-II 20kg)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Peso do saco (kg)"
            inputMode="decimal"
            value={kg}
            onChange={(e) => setKg(e.target.value)}
          />
          <button type="submit" className="primary">
            Adicionar
          </button>
        </form>
        <table className="stops-table">
          <tbody>
            {products.map((product) =>
              editing?.id === product.id ? (
                <tr key={product.id}>
                  <td>
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      inputMode="decimal"
                      value={editing.kg}
                      onChange={(e) => setEditing({ ...editing, kg: e.target.value })}
                    />
                  </td>
                  <td className="n">
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          await mutate(`/mortar/products/${product.id}`, 'PATCH', {
                            name: editing.name.trim(),
                            nominalKg: number(editing.kg),
                          });
                          setEditing(null);
                        })
                      }
                    >
                      Salvar
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={product.id}>
                  <td>
                    <b>{product.name}</b>
                  </td>
                  <td>{product.nominal_kg.toLocaleString('pt-BR')} kg</td>
                  <td className="n">
                    <button
                      type="button"
                      onClick={() =>
                        setEditing({
                          id: product.id,
                          name: product.name,
                          kg: String(product.nominal_kg).replace('.', ','),
                        })
                      }
                    >
                      Editar
                    </button>{' '}
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Excluir ${product.name}? As receitas voltam a contar sem produto.`,
                          )
                        )
                          void run(() => mutate(`/mortar/products/${product.id}`, 'DELETE'));
                      }}
                    >
                      Excluir
                    </button>
                  </td>
                </tr>
              ),
            )}
            {!products.length && (
              <tr>
                <td className="stops-empty">Nenhum produto cadastrado.</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="stops-title">
          Receitas das ensacadeiras
          <small> · {pending ? `${pending} sem produto` : 'todas vinculadas'}</small>
        </div>
        <table className="stops-table">
          <thead>
            <tr>
              <th>Receita na IHM</th>
              <th className="n">Sacos</th>
              <th>Produto</th>
            </tr>
          </thead>
          <tbody>
            {recipes.map((row) => (
              <tr key={row.recipe} className={row.productId ? '' : 'mortar-unlinked'}>
                <td>{row.recipe}</td>
                <td className="n">{integer(row.bags)}</td>
                <td>
                  <select
                    value={row.productId ?? ''}
                    onChange={(event) =>
                      void run(() =>
                        mutate('/mortar/recipes', 'PUT', {
                          recipe: row.recipe,
                          productId: event.target.value || null,
                        }),
                      )
                    }
                  >
                    <option value="">— sem produto —</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
            {!recipes.length && (
              <tr>
                <td colSpan={3} className="stops-empty">
                  As receitas aparecem aqui assim que as ensacadeiras mandarem o primeiro saco.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Which variables feed the mixing and the bagging ----

type Tag = { id: string; key: string; name: string; data_type: string };
type SpoutForm = {
  id?: string;
  name: string;
  countTagId: string | null;
  recipeTagId: string | null;
  runningTagId: string | null;
  enabledTagId: string | null;
};
type Form = {
  mixEnabled: boolean;
  recipeTagId: string | null;
  batchCountTagId: string | null;
  scaleTagId: string | null;
  materials: Array<{ label: string; tagId: string | null }>;
  baggingEnabled: boolean;
  idleSeconds: number;
  spouts: SpoutForm[];
};
const EMPTY_FORM: Form = {
  mixEnabled: true,
  recipeTagId: null,
  batchCountTagId: null,
  scaleTagId: null,
  materials: [
    { label: 'Areia', tagId: null },
    { label: 'Cimento', tagId: null },
    { label: 'Cal / complemento', tagId: null },
  ],
  baggingEnabled: true,
  idleSeconds: 120,
  spouts: [
    { name: 'LE', countTagId: null, recipeTagId: null, runningTagId: null, enabledTagId: null },
    { name: 'CT', countTagId: null, recipeTagId: null, runningTagId: null, enabledTagId: null },
    { name: 'LD', countTagId: null, recipeTagId: null, runningTagId: null, enabledTagId: null },
  ],
};

function TagSelect({
  tags,
  value,
  onChange,
  types,
}: {
  tags: Tag[];
  value: string | null;
  onChange: (value: string | null) => void;
  types: string[];
}) {
  return (
    <select value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">— nenhuma —</option>
      {tags
        .filter((tag) => types.includes(tag.data_type) || tag.id === value)
        .map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.key}
            {tag.name && tag.name !== tag.key ? ` · ${tag.name}` : ''}
          </option>
        ))}
    </select>
  );
}

function MortarConfigModal({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const tags = usePoll<Tag[]>(`/devices/${deviceId}/tags`, 600000);
  const saved = usePoll<{
    settings: null | {
      mix_enabled: boolean;
      recipe_tag_id: string | null;
      batch_count_tag_id: string | null;
      scale_tag_id: string | null;
      materials: Array<{ label: string; tagId: string | null }>;
      bagging_enabled: boolean;
      idle_seconds: number;
    };
    spouts: Array<{
      id: string;
      name: string;
      count_tag_id: string | null;
      recipe_tag_id: string | null;
      running_tag_id: string | null;
      enabled_tag_id: string | null;
    }>;
  }>(`/devices/${deviceId}/mortar/settings`, 600000);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (form || !saved.data) return;
    const { settings, spouts } = saved.data;
    setForm(
      settings
        ? {
            mixEnabled: settings.mix_enabled,
            recipeTagId: settings.recipe_tag_id,
            batchCountTagId: settings.batch_count_tag_id,
            scaleTagId: settings.scale_tag_id,
            materials: settings.materials ?? [],
            baggingEnabled: settings.bagging_enabled,
            idleSeconds: settings.idle_seconds,
            spouts: spouts.map((spout) => ({
              id: spout.id,
              name: spout.name,
              countTagId: spout.count_tag_id,
              recipeTagId: spout.recipe_tag_id,
              runningTagId: spout.running_tag_id,
              enabledTagId: spout.enabled_tag_id,
            })),
          }
        : EMPTY_FORM,
    );
  }, [saved.data, form]);

  const list = tags.data ?? [];
  const set = (patch: Partial<Form>) => setForm((was) => (was ? { ...was, ...patch } : was));
  const setSpout = (index: number, patch: Partial<SpoutForm>) =>
    setForm((was) =>
      was
        ? {
            ...was,
            spouts: was.spouts.map((spout, at) => (at === index ? { ...spout, ...patch } : spout)),
          }
        : was,
    );
  const setMaterial = (index: number, patch: Partial<Form['materials'][number]>) =>
    setForm((was) =>
      was
        ? {
            ...was,
            materials: was.materials.map((item, at) =>
              at === index ? { ...item, ...patch } : item,
            ),
          }
        : was,
    );
  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError('');
    try {
      await mutate(`/devices/${deviceId}/mortar/settings`, 'PUT', form);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card mortar-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-title">
          <div>
            <h2>Mistura e ensaque</h2>
            <small>
              Quais variáveis da IHM alimentam os quadros de argamassa deste equipamento.
            </small>
          </div>
          <button onClick={onClose} aria-label="Fechar">
            Fechar
          </button>
        </header>
        {!form ? (
          <div className="stops-empty">Carregando…</div>
        ) : (
          <div className="mortar-config">
            {error && <div className="form-error">{error}</div>}
            <label className="mortar-switch">
              <input
                type="checkbox"
                checked={form.mixEnabled}
                onChange={(event) => set({ mixEnabled: event.target.checked })}
              />
              <b>Mistura</b> <small>bateladas e consumo de matéria-prima</small>
            </label>
            {form.mixEnabled && (
              <div className="mortar-grid">
                <label>
                  Contador de bateladas
                  <TagSelect
                    tags={list}
                    types={['number']}
                    value={form.batchCountTagId}
                    onChange={(v) => set({ batchCountTagId: v })}
                  />
                </label>
                <label>
                  Receita atual
                  <TagSelect
                    tags={list}
                    types={['string']}
                    value={form.recipeTagId}
                    onChange={(v) => set({ recipeTagId: v })}
                  />
                </label>
                <label>
                  Balança (opcional)
                  <TagSelect
                    tags={list}
                    types={['number']}
                    value={form.scaleTagId}
                    onChange={(v) => set({ scaleTagId: v })}
                  />
                </label>
                <div className="mortar-sub">
                  Peso de cada material numa batelada (peso desejado da receita)
                </div>
                {form.materials.map((item, index) => (
                  <div className="mortar-row" key={index}>
                    <input
                      value={item.label}
                      aria-label="Material"
                      onChange={(e) => setMaterial(index, { label: e.target.value })}
                    />
                    <TagSelect
                      tags={list}
                      types={['number']}
                      value={item.tagId}
                      onChange={(v) => setMaterial(index, { tagId: v })}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        set({ materials: form.materials.filter((_, at) => at !== index) })
                      }
                    >
                      Remover
                    </button>
                  </div>
                ))}
                {form.materials.length < 8 && (
                  <button
                    type="button"
                    className="mortar-add"
                    onClick={() =>
                      set({ materials: [...form.materials, { label: 'Material', tagId: null }] })
                    }
                  >
                    + Material
                  </button>
                )}
              </div>
            )}

            <label className="mortar-switch">
              <input
                type="checkbox"
                checked={form.baggingEnabled}
                onChange={(event) => set({ baggingEnabled: event.target.checked })}
              />
              <b>Ensaque</b> <small>sacos por bico e por receita</small>
            </label>
            {form.baggingEnabled && (
              <div className="mortar-grid">
                <label>
                  Bico ocioso depois de (segundos sem saco)
                  <input
                    type="number"
                    min={10}
                    max={3600}
                    value={form.idleSeconds}
                    onChange={(e) => set({ idleSeconds: Number(e.target.value) || 120 })}
                  />
                </label>
                {form.spouts.map((spout, index) => (
                  <fieldset className="mortar-spout-form" key={spout.id ?? `new-${index}`}>
                    <legend>
                      Bico {index + 1}
                      <input
                        value={spout.name}
                        aria-label="Nome do bico"
                        onChange={(e) => setSpout(index, { name: e.target.value })}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            !spout.id ||
                            window.confirm(
                              `Remover o bico ${spout.name}? A contagem dele é apagada junto.`,
                            )
                          )
                            set({ spouts: form.spouts.filter((_, at) => at !== index) });
                        }}
                      >
                        Remover
                      </button>
                    </legend>
                    <label>
                      Pacotes (contador)
                      <TagSelect
                        tags={list}
                        types={['number']}
                        value={spout.countTagId}
                        onChange={(v) => setSpout(index, { countTagId: v })}
                      />
                    </label>
                    <label>
                      Produto / receita
                      <TagSelect
                        tags={list}
                        types={['string']}
                        value={spout.recipeTagId}
                        onChange={(v) => setSpout(index, { recipeTagId: v })}
                      />
                    </label>
                    <label>
                      Habilitado
                      <TagSelect
                        tags={list}
                        types={['boolean', 'number']}
                        value={spout.enabledTagId}
                        onChange={(v) => setSpout(index, { enabledTagId: v })}
                      />
                    </label>
                    <label>
                      Ligado (opcional)
                      <TagSelect
                        tags={list}
                        types={['boolean', 'number']}
                        value={spout.runningTagId}
                        onChange={(v) => setSpout(index, { runningTagId: v })}
                      />
                    </label>
                  </fieldset>
                ))}
                {form.spouts.length < 24 && (
                  <button
                    type="button"
                    className="mortar-add"
                    onClick={() =>
                      set({
                        spouts: [
                          ...form.spouts,
                          {
                            name: `B${form.spouts.length + 1}`,
                            countTagId: null,
                            recipeTagId: null,
                            runningTagId: null,
                            enabledTagId: null,
                          },
                        ],
                      })
                    }
                  >
                    + Bico
                  </button>
                )}
              </div>
            )}
            <p className="stops-note">
              Só aparecem variáveis já configuradas no equipamento. Se faltar alguma, adicione-a em
              Variáveis antes.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                Cancelar
              </button>
              <button
                type="button"
                className="primary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** For the picker: the four mortar cards, their help line and a sensible start size. */
export const MORTAR_CARDS: Array<[MortarView, string, string, string]> = [
  [
    'bagging',
    '▤',
    'Ensaque',
    'Sacos e toneladas da linha e de cada bico, ritmo, estado agora e a produção hora a hora.',
  ],
  [
    'mortar_output',
    '▦',
    'Produzido por produto',
    'Sacos e toneladas por produto no período, somando as receitas de todos os bicos.',
  ],
  [
    'mortar_materials',
    '◫',
    'Matéria-prima',
    'Bateladas e o consumo de cada material (areia, cimento, cal…) por receita.',
  ],
  [
    'mortar_yield',
    '⇄',
    'Rendimento',
    'O que foi misturado contra o que saiu ensacado, e a diferença.',
  ],
];
export const isMortarView = (type: string): type is MortarView =>
  MORTAR_CARDS.some(([view]) => view === type);
