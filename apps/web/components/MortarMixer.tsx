'use client';

import { Fragment, useContext, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePoll } from './data';
import { useFirstDraw } from './firstDraw';
import { MortarColors, integer, isoDay, tons } from './mortarShared';
import {
  ALARM_KINDS,
  DEFAULT_CATALOG,
  STEP_KINDS,
  StepsContext,
  alarmOf,
  materialIndex,
  stepOf,
  type Catalog,
  type Process,
  type StepKind,
} from './mortarSteps';

/**
 * The mixer board (migration 046). Two large areas, one per process of the PLC -- the weighing
 * and the mixing run independently -- told apart by their own surface, not by boxes:
 *   - the weighing: the scale filling over the recipe, each material in its colour, the step it
 *     is in, and how long each dose takes;
 *   - the mixing: the timed step running against what the recipe programs (a countdown), and
 *     mixing and discharge programmed against real in bars.
 * Under both, on one clock: the scale's work curve with what each process was doing, and where
 * the time went, the longest wait in words; every step's numbers one click away.
 * Data: apps/api/src/mortar-mixer.ts.
 */
type ProcessDay = {
  current: { step: number; since: string } | null;
  segments: Array<{ step: number; start: string; end: string; seconds: number; open: boolean }>;
  cycles: number;
  cycleSeconds: number | null;
  steps: Array<{
    step: number;
    runs: number;
    total: number;
    median: number | null;
    max: number | null;
    typical: number | null;
  }>;
};
type Mixer = {
  configured: boolean;
  /** The device's steps and alert codes (its configuration, migration 049). */
  catalog?: Catalog;
  /** The alert word through the day, kept like a process. */
  alerts?: ProcessDay | null;
  processes: Record<Process, ProcessDay | null> | null;
  live: boolean;
  updatedAt: string | null;
  recipe: string | null;
  count: number | null;
  asked: number | null;
  automatic: boolean | null;
  cycle: boolean | null;
  scale: number | null;
  target: number | null;
  scaleState: 'dosing' | 'loaded' | 'empty' | null;
  materials: Array<{ label: string; kg: number | null }>;
  /** The recipe's time, programmed (from the PLC or learnt); not the stopwatch. */
  mixSeconds: number | null;
  dischargeSeconds: number | null;
  /** The stopwatches of the PLC: how long the step has run, against what it should. */
  mix?: { elapsed: number | null; programmed: number | null; source: 'plc' | 'learnt' };
  discharge?: { elapsed: number | null; programmed: number | null; source: 'plc' | 'learnt' };
  day: {
    date: string;
    start: string;
    batches: number;
    kg: number;
    cycleSeconds: number | null;
    lastAt: string | null;
    list: Array<{ at: string; recipe: string; batches: number; kg: number }>;
  };
  curve: Array<{ at: string; kg: number }>;
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
/** A time as the HMI shows it: 300 s is 5 min, 140 s is 2 min 20 s, 2 h 05 min past an hour. */
const span = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '—';
  const total = Math.round(value);
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const rest = total % 60;
    return `${Math.floor(total / 60)} min${rest ? ` ${rest} s` : ''}`;
  }
  return `${Math.floor(total / 3600)} h ${String(Math.round((total % 3600) / 60)).padStart(2, '0')} min`;
};
/** A countdown as a clock: 2:05. */
const countdown = (seconds: number) => {
  const total = Math.abs(Math.round(seconds));
  return `${seconds < 0 ? '+' : ''}${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const AXIS = { fontSize: 11, fill: '#71868d' };
/** The chart's left axis and right margin, so the process lanes under it share its clock. */
const Y_AXIS = 52;
const RIGHT = 8;

/** Seconds of each kind of step in a process's day. */
function kindTotals(catalog: Catalog, process: Process, data: ProcessDay | null) {
  const totals: Record<StepKind, number> = { work: 0, prep: 0, wait: 0, off: 0 };
  for (const item of data?.steps ?? [])
    totals[stepOf(catalog, process, item.step).kind] += item.total;
  const on = totals.work + totals.prep + totals.wait;
  return { totals, on, working: on > 0 ? totals.work / on : null };
}
const stepStat = (data: ProcessDay | null, step: number) =>
  data?.steps.find((item) => item.step === step) ?? null;
/** How long the process has been in its step now (null when it is in none, or not live). */
function nowOf(catalog: Catalog, process: Process, data: ProcessDay | null, live: boolean) {
  if (!data?.current || !live) return null;
  const step = stepOf(catalog, process, data.current.step);
  const elapsed = (Date.now() - new Date(data.current.since).getTime()) / 1000;
  const stat = stepStat(data, step.value);
  return { step, elapsed, reference: stat?.typical ?? stat?.median ?? null };
}
const workTone = (share: number | null) =>
  share == null ? '' : share >= 0.7 ? 'good' : share >= 0.5 ? 'warn' : 'bad';
const percentOf = (share: number | null) => (share == null ? '—' : `${Math.round(share * 100)}%`);

export function MixerBoard({ deviceId }: { deviceId: string }) {
  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - 86_400_000));
  const [day, setDay] = useState(today);
  const mixer = usePoll<Mixer>(`/devices/${deviceId}/mortar/mixer?date=${day}`, 10000);
  const data = mixer.data;
  if (!data) return <div className="stops-empty">{mixer.error ?? 'Carregando o misturador…'}</div>;
  const processes = data.processes;
  if (!data.configured && !processes?.pesagem && !processes?.misturador)
    return (
      <div className="stops-empty">
        O misturador ainda não está configurado. Abra o lápis do card e escolha a receita, o
        contador de bateladas e os pesos de cada material.
      </div>
    );
  const isToday = day === today;

  return (
    <StepsContext.Provider value={data.catalog ?? DEFAULT_CATALOG}>
      <div className="mx-board">
        <MixerHead data={data} />
        {isToday && (
          <div className="mx-halves">
            <Weighing data={data} process={processes?.pesagem ?? null} />
            <Mixing data={data} process={processes?.misturador ?? null} />
          </div>
        )}

        <section className="mx-day">
          <div className="mx-day-head">
            <div>
              <strong>{isToday ? 'O dia de hoje' : 'Ontem'}</strong>
              <small>
                {integer(data.day.batches)} bateladas · {tons(data.day.kg)} t misturadas
                {data.day.lastAt ? ` · última às ${clock(data.day.lastAt)}` : ''}
              </small>
            </div>
            <div className="widget-period" role="group" aria-label="Dia">
              <button
                type="button"
                className={isToday ? 'active' : ''}
                onClick={() => setDay(today)}
              >
                Hoje
              </button>
              <button
                type="button"
                className={day === yesterday ? 'active' : ''}
                onClick={() => setDay(yesterday)}
              >
                Ontem
              </button>
            </div>
          </div>
          <WorkCurve data={data} />
          {processes && (processes.pesagem || processes.misturador) && (
            <TimeSpent processes={processes} alerts={data.alerts ?? null} />
          )}
        </section>
      </div>
    </StepsContext.Provider>
  );
}

/** The recipe, the run and the mode, on one quiet line above the two halves. */
function MixerHead({ data }: { data: Mixer }) {
  const catalog = useContext(StepsContext);
  const alert =
    data.live && data.alerts?.current && data.alerts.current.step !== 0
      ? {
          ...alarmOf(catalog, data.alerts.current.step),
          since: (Date.now() - new Date(data.alerts.current.since).getTime()) / 1000,
        }
      : null;
  const asked = data.asked != null && data.asked > 0 ? Math.min(Math.round(data.asked), 30) : null;
  const done = data.count != null ? Math.max(0, Math.round(data.count)) : null;
  return (
    <header className="mx-head">
      <div className="mx-recipe">
        <span>Receita no misturador</span>
        <b>{data.recipe ?? 'Sem receita na IHM'}</b>
      </div>
      <div className="mx-run" title="Bateladas feitas no lote, contra as pedidas">
        <span>
          Lote <b>{done ?? '—'}</b>
          {asked != null && <> de {asked}</>}
        </span>
        {asked != null && (
          <div className="mx-segments">
            {Array.from({ length: asked }, (_, at) => (
              <i key={at} className={done != null && at < done ? 'done' : ''} />
            ))}
          </div>
        )}
      </div>
      <div className="mx-pills">
        {alert && (
          <em
            className="mx-alert"
            style={{
              color: ALARM_KINDS[alert.kind].color,
              borderColor: ALARM_KINDS[alert.kind].color,
            }}
            title={ALARM_KINDS[alert.kind].label}
          >
            ⚠ {alert.label} · há {span(alert.since)}
          </em>
        )}
        {data.automatic != null && (
          <em className={data.automatic ? 'on' : 'manual'}>
            {data.automatic ? 'Automático' : 'Manual'}
          </em>
        )}
        <small className={data.live ? 'live' : 'stale'}>
          <u />
          {data.live
            ? `ao vivo · ${clock(data.updatedAt!)}`
            : data.updatedAt
              ? `sem leitura desde ${clock(data.updatedAt)}`
              : 'sem leituras'}
        </small>
      </div>
    </header>
  );
}

/** The step a process is in, said big, with its time against the typical one. */
function StepNow({
  process,
  data,
  live,
}: {
  process: Process;
  data: ProcessDay | null;
  live: boolean;
}) {
  const catalog = useContext(StepsContext);
  const now = nowOf(catalog, process, data, live);
  if (!data)
    return (
      <div className="mx-missing">
        Publique <b>{process === 'pesagem' ? 'ProcessoPesagem' : 'ProcessoMisturador'}</b> no MQTT
        para acompanhar as etapas.
      </div>
    );
  const ratio = now?.reference ? now.elapsed / now.reference : null;
  const tone = ratio == null ? '' : ratio <= 1.1 ? 'good' : ratio <= 1.5 ? 'warn' : 'bad';
  return (
    <div className={`mx-step ${now?.step.kind ?? 'off'}`}>
      <i style={{ background: STEP_KINDS[now?.step.kind ?? 'off'].color }} />
      <div>
        <span>{now ? STEP_KINDS[now.step.kind].label : 'Agora'}</span>
        <b>{now ? now.step.label : live ? 'Sem etapa em andamento' : 'Sem leitura do CLP'}</b>
      </div>
      {now && (
        <em className={tone} title={now.reference ? `Típico: ${span(now.reference)}` : undefined}>
          {span(now.elapsed)}
          {now.reference ? <small>típico {span(now.reference)}</small> : null}
        </em>
      )}
    </div>
  );
}

/** Three figures at the foot of a half: what the process did today. */
function Facts({ items }: { items: Array<[string, string, string?]> }) {
  return (
    <div className="mx-facts">
      {items.map(([label, value, tone]) => (
        <div key={label}>
          <span>{label}</span>
          <b className={tone}>{value}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * The weighing: the scale filling over the recipe. The track is the recipe, each material its
 * share in its colour; the fill is what is on the scale, so the material being dosed is the one
 * the fill has reached.
 */
function Weighing({ data, process }: { data: Mixer; process: ProcessDay | null }) {
  const palette = useContext(MortarColors);
  const recipeKg = data.materials.reduce((sum, item) => sum + (item.kg ?? 0), 0);
  const total = data.target ?? (recipeKg || null);
  const share = data.scale != null && total ? Math.min(1, data.scale / total) : null;
  const catalog = useContext(StepsContext);
  const dosing = process?.current
    ? materialIndex(data.materials, stepOf(catalog, 'pesagem', process.current.step).material)
    : -1;
  const kinds = kindTotals(catalog, 'pesagem', process);
  // How long each dose takes today, against the week before: the dosing step of each material.
  const doseStep = (index: number) =>
    catalog.pesagem.find((step) => materialIndex(data.materials, step.material) === index);
  const doses = data.materials
    .map((item, index) => {
      const step = doseStep(index);
      return { item, index, stat: step ? stepStat(process, step.value) : null };
    })
    .filter(({ item, stat }) => item.kg && stat?.median);
  const longest = Math.max(
    1,
    ...doses.map(({ stat }) => Math.max(stat!.median ?? 0, stat!.typical ?? 0)),
  );
  return (
    <section className="mx-half weighing">
      <div className="mx-half-head">
        <h3>Pesagem</h3>
        <small>a balança dosando a receita</small>
      </div>
      <StepNow process="pesagem" data={process} live={data.live} />

      <div className="mx-hero">
        <b>{data.scale == null ? '—' : integer(data.scale)}</b>
        <span>kg na balança</span>
        {total ? <em>de {integer(total)} kg</em> : null}
      </div>
      {total ? (
        <div className="mx-fill" title="A balança enchendo sobre a receita">
          <div className="mx-fill-track">
            {data.materials.map((item, index) =>
              item.kg ? (
                <i
                  key={item.label}
                  style={{
                    width: `${(item.kg / total) * 100}%`,
                    background: palette.material(item.label, index),
                  }}
                />
              ) : null,
            )}
          </div>
          <div className="mx-fill-cover" style={{ left: `${(share ?? 0) * 100}%` }} />
          <div className="mx-fill-edge" style={{ left: `${(share ?? 0) * 100}%` }} />
        </div>
      ) : null}
      {recipeKg > 0 && (
        <ul className="mx-legend-materials">
          {data.materials.map((item, index) => (
            <li
              key={item.label}
              className={`${item.kg ? '' : 'none'}${dosing === index ? ' dosing' : ''}`}
            >
              <i style={{ background: palette.material(item.label, index) }} />
              {item.label}
              <b>{item.kg ? `${integer(item.kg)} kg` : '—'}</b>
            </li>
          ))}
        </ul>
      )}

      {doses.length > 0 && (
        <div className="mx-bars">
          <div className="mx-bars-head">
            Tempo de cada dose <small>hoje · marca = típico dos 7 dias</small>
          </div>
          {doses.map(({ item, index, stat }) => (
            <div key={item.label} className="mx-bar-row">
              <span>{item.label}</span>
              <div className="mx-bar">
                <i
                  style={{
                    width: `${((stat!.median ?? 0) / longest) * 100}%`,
                    background: palette.material(item.label, index),
                  }}
                />
                {stat!.typical ? (
                  <u style={{ left: `${(stat!.typical / longest) * 100}%` }} />
                ) : null}
              </div>
              <b>{span(stat!.median)}</b>
            </div>
          ))}
        </div>
      )}

      <Facts
        items={[
          ['Pesagens hoje', integer(process?.cycles ?? 0)],
          ['Ciclo típico', span(process?.cycleSeconds)],
          ['Trabalhando', percentOf(kinds.working), workTone(kinds.working)],
        ]}
      />
    </section>
  );
}

/**
 * The mixing: when the mixer is in a timed step (mixing or discharging) a countdown against what
 * the recipe programs; under it, mixing and discharge programmed against real, in bars.
 */
function Mixing({ data, process }: { data: Mixer; process: ProcessDay | null }) {
  const catalog = useContext(StepsContext);
  const now = nowOf(catalog, 'misturador', process, data.live);
  // The timed steps are the ones the configuration marks: mixing and discharge.
  const timer = now?.step.timer ?? null;
  const programmed =
    timer === 'mix' ? data.mixSeconds : timer === 'discharge' ? data.dischargeSeconds : null;
  // How long the step has run: the PLC's own stopwatch when it publishes one, else since the
  // step began.
  const stopwatch =
    timer === 'mix' ? data.mix?.elapsed : timer === 'discharge' ? data.discharge?.elapsed : null;
  const ran = now ? (stopwatch != null && stopwatch > 0 ? stopwatch : now.elapsed) : 0;
  const learnt = (timer === 'mix' ? data.mix?.source : data.discharge?.source) === 'learnt';
  const timedStep = (which: 'mix' | 'discharge') =>
    catalog.misturador.find((step) => step.timer === which)?.value ?? null;
  const statOf = (which: 'mix' | 'discharge') => {
    const value = timedStep(which);
    return value == null ? null : stepStat(process, value);
  };
  const kinds = kindTotals(catalog, 'misturador', process);
  const rows: Array<[string, number | null, number | null, number | null]> = [
    ['Mistura', data.mixSeconds, statOf('mix')?.median ?? null, statOf('mix')?.typical ?? null],
    [
      'Descarga',
      data.dischargeSeconds,
      statOf('discharge')?.median ?? null,
      statOf('discharge')?.typical ?? null,
    ],
  ];
  const longest = Math.max(1, ...rows.flatMap(([, a, b, c]) => [a ?? 0, b ?? 0, c ?? 0]));
  const progress = now && programmed ? Math.min(1, ran / programmed) : null;
  return (
    <section className="mx-half mixing">
      <div className="mx-half-head">
        <h3>Mistura</h3>
        <small>carga · mistura · descarga</small>
      </div>
      <StepNow process="misturador" data={process} live={data.live} />

      {now && programmed ? (
        <>
          <div className="mx-hero">
            <b className={ran > programmed ? 'over' : ''}>{countdown(programmed - ran)}</b>
            <span>{ran <= programmed ? 'para terminar' : 'além do programado'}</span>
            <em>
              {timer === 'mix' ? 'mistura' : 'descarga'} de {span(programmed)}
              {learnt ? ' · programado lido do cronômetro' : ' · programado na receita'}
            </em>
          </div>
          <div className="mx-progress-big">
            <i
              className={ran > programmed ? 'over' : ''}
              style={{ width: `${(progress ?? 0) * 100}%` }}
            />
          </div>
        </>
      ) : (
        <div className="mx-hero">
          <b>{integer(data.day.batches)}</b>
          <span>bateladas hoje</span>
          <em>{tons(data.day.kg)} t misturadas</em>
        </div>
      )}

      <div className="mx-bars">
        <div className="mx-bars-head">
          Programado × real <small>real = mediana de hoje · marca = típico dos 7 dias</small>
        </div>
        {rows.map(([name, programmedTime, real, typical]) => {
          const over = programmedTime && real ? real / programmedTime - 1 : null;
          return (
            <div key={name} className="mx-bar-pair">
              <span>{name}</span>
              <div className="mx-bar ghost" title={`Programado: ${span(programmedTime)}`}>
                <i style={{ width: `${((programmedTime ?? 0) / longest) * 100}%` }} />
              </div>
              <b className="muted">{span(programmedTime)}</b>
              <span />
              <div className="mx-bar" title={`Real hoje: ${span(real)}`}>
                <i
                  className={over == null ? '' : over > 0.15 ? 'bad' : over > 0.05 ? 'warn' : ''}
                  style={{ width: `${((real ?? 0) / longest) * 100}%` }}
                />
                {typical ? <u style={{ left: `${(typical / longest) * 100}%` }} /> : null}
              </div>
              <b>
                {span(real)}
                {over != null && Math.abs(over) >= 0.05 && (
                  <small className={over > 0 ? 'mx-up' : 'mx-down'}>
                    {' '}
                    {over > 0 ? '+' : '−'}
                    {Math.round(Math.abs(over) * 100)}%
                  </small>
                )}
              </b>
            </div>
          );
        })}
        <div className="mx-bars-key">
          <span>
            <i className="ghost" /> programado na receita
          </span>
          <span>
            <i /> real
          </span>
        </div>
      </div>

      <Facts
        items={[
          ['Bateladas hoje', integer(data.day.batches)],
          ['Ciclo típico', span(process?.cycleSeconds ?? data.day.cycleSeconds)],
          ['Trabalhando', percentOf(kinds.working), workTone(kinds.working)],
        ]}
      />
    </section>
  );
}

/**
 * The scale through the day, each climb a batch being dosed and each line a batch that closed,
 * with both processes drawn under it on the same clock, coloured by what they were doing.
 */
function WorkCurve({ data }: { data: Mixer }) {
  const palette = useContext(MortarColors);
  const catalog = useContext(StepsContext);
  const color = palette.accent;
  const rows = useMemo(
    () => data.curve.map((point) => ({ t: new Date(point.at).getTime(), kg: point.kg })),
    [data.curve],
  );
  const drawing = useFirstDraw(rows.length > 0);
  const lanes = (['pesagem', 'misturador'] as const).filter((process) => data.processes?.[process]);
  const activity = [
    ...rows.map((row) => row.t),
    ...lanes.flatMap((process) =>
      data
        .processes![process]!.segments.filter((segment) => segment.step !== 0)
        .flatMap((segment) => [new Date(segment.start).getTime(), new Date(segment.end).getTime()]),
    ),
  ];
  if (!activity.length)
    return <div className="stops-empty">Sem leituras da balança nem das etapas neste dia.</div>;
  const domain: [number, number] = [
    Math.min(...activity) - 15 * 60_000,
    Math.max(...activity) + 15 * 60_000,
  ];
  const at = (t: number) => ((t - domain[0]) / (domain[1] - domain[0])) * 100;
  return (
    <div className="mx-curve">
      <div className="mx-section-title">
        Curva de trabalho
        <small>o peso na balança e, abaixo, o que cada processo fazia · linhas = bateladas</small>
      </div>
      <div className="mx-chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: RIGHT, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={domain}
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => clock(new Date(value).toISOString())}
              minTickGap={40}
            />
            <YAxis
              tick={AXIS}
              width={Y_AXIS}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => integer(value)}
            />
            <Tooltip
              labelFormatter={(value) => clock(new Date(Number(value)).toISOString())}
              formatter={(value) => [`${integer(Number(value))} kg`, 'balança']}
            />
            {data.target && (
              <ReferenceLine y={data.target} stroke="#0b2028" strokeDasharray="6 4" />
            )}
            {data.day.list.map((batch) => (
              <ReferenceLine key={batch.at} x={new Date(batch.at).getTime()} stroke="#d3dde0" />
            ))}
            <Area
              dataKey="kg"
              type="stepAfter"
              stroke={color}
              strokeWidth={1.5}
              fill={color}
              fillOpacity={0.16}
              isAnimationActive={drawing}
              animationDuration={drawing ? 700 : 0}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {lanes.map((process) => (
        <div key={process} className="mx-lane" style={{ marginLeft: Y_AXIS, marginRight: RIGHT }}>
          <span className="mx-lane-name">{process === 'pesagem' ? 'Pesagem' : 'Mistura'}</span>
          <div className="mx-lane-track">
            {data.processes![process]!.segments.map((segment) => {
              const step = stepOf(catalog, process, segment.step);
              const left = at(new Date(segment.start).getTime());
              const width = at(new Date(segment.end).getTime()) - left;
              if (width <= 0) return null;
              return (
                <i
                  key={`${segment.start}-${segment.step}`}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    background: STEP_KINDS[step.kind].color,
                  }}
                  title={`${clock(segment.start)}–${clock(segment.end)} · ${step.label} · ${span(segment.seconds)}`}
                />
              );
            })}
          </div>
        </div>
      ))}
      {data.alerts && data.alerts.segments.some((segment) => segment.step !== 0) && (
        <div className="mx-lane" style={{ marginLeft: Y_AXIS, marginRight: RIGHT }}>
          <span className="mx-lane-name">Alertas</span>
          <div className="mx-lane-track">
            {data.alerts.segments
              .filter((segment) => segment.step !== 0)
              .map((segment) => {
                const alert = alarmOf(catalog, segment.step);
                const left = at(new Date(segment.start).getTime());
                const width = Math.max(0.3, at(new Date(segment.end).getTime()) - left);
                return (
                  <i
                    key={`alert-${segment.start}`}
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      background: ALARM_KINDS[alert.kind].color,
                    }}
                    title={`${clock(segment.start)}–${clock(segment.end)} · ${alert.label} · ${span(segment.seconds)}`}
                  />
                );
              })}
          </div>
        </div>
      )}
      {lanes.length > 0 && (
        <div className="mx-legend" style={{ marginLeft: Y_AXIS }}>
          {(['work', 'prep', 'wait', 'off'] as const).map((kind) => (
            <span key={kind}>
              <i style={{ background: STEP_KINDS[kind].color }} /> {STEP_KINDS[kind].label}
            </span>
          ))}
          {data.target ? (
            <span>
              <i className="dash" /> total da receita
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Where the time went, per process: one bar split by kind, the longest wait in words, and every
 * step's numbers behind a click, so the board stays readable and the detail stays at hand.
 */
function TimeSpent({
  processes,
  alerts,
}: {
  processes: Record<Process, ProcessDay | null>;
  alerts: ProcessDay | null;
}) {
  const [open, setOpen] = useState(false);
  const catalog = useContext(StepsContext);
  // The alerts of the day, longest first: what held the mixer up, and for how long.
  const dayAlerts = (alerts?.steps ?? [])
    .filter((item) => item.step !== 0 && item.total > 0)
    .sort((a, b) => b.total - a.total);
  return (
    <div className="mx-spent">
      <div className="mx-section-title">
        Para onde foi o tempo
        <button type="button" className="mx-more" onClick={() => setOpen(!open)}>
          {open ? 'Ocultar etapas' : 'Ver todas as etapas'}
        </button>
      </div>
      <div className="mx-spent-grid">
        {(['pesagem', 'misturador'] as const).map((process) => {
          const data = processes[process];
          if (!data) return null;
          const { totals, on } = kindTotals(catalog, process, data);
          const waits = data.steps
            .filter(
              (item) => stepOf(catalog, process, item.step).kind === 'wait' && item.total >= 60,
            )
            .sort((a, b) => b.total - a.total);
          return (
            <div key={process} className="mx-spent-item">
              <div className="mx-spent-name">
                <b>{process === 'pesagem' ? 'Pesagem' : 'Mistura'}</b>
                <small>
                  {data.cycles} {data.cycles === 1 ? 'ciclo' : 'ciclos'}
                  {data.cycleSeconds ? ` · típico ${span(data.cycleSeconds)}` : ''}
                </small>
              </div>
              {on > 0 ? (
                <>
                  <div className="mx-kinds">
                    {(['work', 'prep', 'wait'] as const).map((kind) =>
                      totals[kind] > 0 ? (
                        <i
                          key={kind}
                          style={{
                            width: `${(totals[kind] / on) * 100}%`,
                            background: STEP_KINDS[kind].color,
                          }}
                          title={`${STEP_KINDS[kind].label}: ${span(totals[kind])}`}
                        />
                      ) : null,
                    )}
                  </div>
                  <div className="mx-kinds-key">
                    {(['work', 'prep', 'wait'] as const).map((kind) =>
                      totals[kind] > 0 ? (
                        <span key={kind}>
                          <i style={{ background: STEP_KINDS[kind].color }} />
                          {STEP_KINDS[kind].label} <b>{Math.round((totals[kind] / on) * 100)}%</b>
                        </span>
                      ) : null,
                    )}
                  </div>
                </>
              ) : (
                <div className="stops-empty">Sem tempo registrado neste dia.</div>
              )}
              {waits[0] && (
                <p className="mx-callout">
                  Maior espera: <b>{stepOf(catalog, process, waits[0].step).label.toLowerCase()}</b>{' '}
                  · {span(waits[0].total)}
                  {on > 0 && ` (${Math.round((waits[0].total / on) * 100)}% do tempo ligado)`}
                </p>
              )}
              {open && <StepTable process={process} data={data} on={on} />}
            </div>
          );
        })}
      </div>
      {dayAlerts.length > 0 && (
        <div className="mx-alerts">
          <div className="mx-spent-name">
            <b>Alertas do dia</b>
            <small>quanto tempo cada alerta do CLP ficou ativo</small>
          </div>
          <ul>
            {dayAlerts.map((item) => {
              const alert = alarmOf(catalog, item.step);
              return (
                <li key={item.step} title={ALARM_KINDS[alert.kind].label}>
                  <i style={{ background: ALARM_KINDS[alert.kind].color }} />
                  <span>{alert.label}</span>
                  <b>{span(item.total)}</b>
                  <small>
                    {item.runs} {item.runs === 1 ? 'vez' : 'vezes'}
                  </small>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Every step of a process: how often, its typical time against the seven days before, the total. */
function StepTable({ process, data, on }: { process: Process; data: ProcessDay; on: number }) {
  const catalog = useContext(StepsContext);
  const order = catalog[process].map((item) => item.value);
  const rows = data.steps
    .filter((item) => item.step !== 0 && (item.runs > 0 || item.total > 0))
    .sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
  if (!rows.length) return <div className="stops-empty">Nenhuma etapa registrada neste dia.</div>;
  return (
    <table className="stops-table mortar-table mx-table">
      <thead>
        <tr>
          <th>Etapa</th>
          <th className="n">Vezes</th>
          <th className="n" title="Mediana de hoje">
            Típico
          </th>
          <th className="n" title="Diferença para o típico dos 7 dias anteriores">
            vs 7 dias
          </th>
          <th className="n">Total</th>
          <th className="n">%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => {
          const step = stepOf(catalog, process, item.step);
          // In time, not percent: a 10 s wait that became 2 min reads "+1 min 50 s".
          const change =
            item.median != null && item.typical != null ? item.median - item.typical : null;
          const tone =
            change == null ||
            Math.abs(change) < 5 ||
            (item.typical ? Math.abs(change) / item.typical < 0.1 : false)
              ? ''
              : change > 0
                ? 'bad'
                : 'good';
          return (
            <Fragment key={item.step}>
              <tr>
                <td>
                  <span
                    className="mortar-dot"
                    style={{ background: STEP_KINDS[step.kind].color }}
                  />
                  {step.label}
                </td>
                <td className="n">{integer(item.runs)}</td>
                <td className="n">{span(item.median)}</td>
                <td className={`n mx-delta ${tone}`}>
                  {change == null
                    ? '—'
                    : tone === ''
                      ? 'igual'
                      : `${change > 0 ? '+' : '−'}${span(Math.abs(change))}`}
                </td>
                <td className="n">{span(item.total)}</td>
                <td className="n muted">
                  {on > 0 ? `${Math.round((item.total / on) * 100)}%` : '—'}
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
