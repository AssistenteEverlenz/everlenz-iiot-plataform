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
import { PROCESS_STEPS, STEP_KINDS, stepOf, type Process, type StepKind } from './mortarSteps';

/**
 * The mixer board (migration 046), read top-down in three layers:
 *   1. now -- the recipe and the run, then the two processes side by side (the weighing and the
 *      mixer run independently in the PLC), each with the step it is in, for how long against
 *      its typical time, and what it is working on (the scale against the recipe; the mixing
 *      and discharge times);
 *   2. the day -- batches, tons, cycle and the share of time each process worked, the work
 *      curve of the scale with both processes drawn under it on the same clock;
 *   3. the steps -- every step with how often it ran, its typical time against the last seven
 *      days, and where the time went, the longest wait called out in words.
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
  mixSeconds: number | null;
  dischargeSeconds: number | null;
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

const PROCESS_NAMES: Record<Process, { title: string; hint: string }> = {
  pesagem: { title: 'Pesagem', hint: 'balança · doses da receita' },
  misturador: { title: 'Misturador', hint: 'carga · mistura · descarga' },
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
const AXIS = { fontSize: 11, fill: '#71868d' };
/** The chart's left axis and right margin, so the process lanes under it share its clock. */
const Y_AXIS = 52;
const RIGHT = 8;

/** Seconds of each kind of step in a process's day. */
function kindTotals(process: Process, data: ProcessDay) {
  const totals: Record<StepKind, number> = { work: 0, prep: 0, wait: 0, off: 0 };
  for (const item of data.steps) totals[stepOf(process, item.step).kind] += item.total;
  const on = totals.work + totals.prep + totals.wait;
  return { totals, on, working: on > 0 ? totals.work / on : null };
}

export function MixerBoard({ deviceId }: { deviceId: string }) {
  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - 86_400_000));
  const [day, setDay] = useState(today);
  const mixer = usePoll<Mixer>(`/devices/${deviceId}/mortar/mixer?date=${day}`, 10000);
  const palette = useContext(MortarColors);
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
  const asked = data.asked != null && data.asked > 0 ? Math.min(Math.round(data.asked), 30) : null;
  const done = data.count != null ? Math.max(0, Math.round(data.count)) : null;

  return (
    <div className="mx-board">
      {isToday && (
        <header className="mx-head">
          <div className="mx-recipe">
            <span>Receita no misturador</span>
            <b>{data.recipe ?? 'Sem receita na IHM'}</b>
          </div>
          <div className="mx-run" title="Bateladas feitas no lote, contra as pedidas">
            <span>
              Lote <b>{done ?? '—'}</b>
              {asked != null && <> de {asked} bateladas</>}
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
            {data.automatic != null && (
              <em className={data.automatic ? 'on' : 'manual'}>
                {data.automatic ? 'Automático' : 'Manual'}
              </em>
            )}
            <small className={data.live ? '' : 'stale'}>
              {data.live
                ? `ao vivo · ${clock(data.updatedAt!)}`
                : data.updatedAt
                  ? `sem leitura desde ${clock(data.updatedAt)}`
                  : 'sem leituras'}
            </small>
          </div>
        </header>
      )}

      {isToday && (
        <div className="mx-procs">
          <ProcessNow process="pesagem" data={processes?.pesagem ?? null} live={data.live}>
            <ScaleNow data={data} dosing={processes?.pesagem?.current?.step} />
          </ProcessNow>
          <ProcessNow process="misturador" data={processes?.misturador ?? null} live={data.live}>
            <MixerTimes data={data} />
          </ProcessNow>
        </div>
      )}

      <section className="mx-day">
        <div className="mx-day-head">
          <strong>{isToday ? 'O dia de hoje' : 'Ontem'}</strong>
          <div className="widget-period" role="group" aria-label="Dia">
            <button type="button" className={isToday ? 'active' : ''} onClick={() => setDay(today)}>
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
        <div className="mx-figures">
          <Figure label="Bateladas" value={integer(data.day.batches)} />
          <Figure label="Misturado" value={tons(data.day.kg)} unit="t" />
          <Figure
            label="Ciclo típico"
            value={span(processes?.misturador?.cycleSeconds ?? data.day.cycleSeconds)}
            hint="de uma mistura à próxima"
          />
          {(['pesagem', 'misturador'] as const).map((process) => {
            const day = processes?.[process];
            const kinds = day ? kindTotals(process, day) : null;
            const share = kinds?.working ?? null;
            const waiting = kinds && kinds.on > 0 ? kinds.totals.wait / kinds.on : null;
            return (
              <Figure
                key={process}
                label={`${PROCESS_NAMES[process].title} trabalhando`}
                value={share == null ? '—' : `${Math.round(share * 100)}%`}
                hint={
                  waiting != null && waiting >= 0.05
                    ? `${Math.round(waiting * 100)}% aguardando`
                    : 'do tempo ligado'
                }
                tone={share == null ? undefined : share >= 0.7 ? 'good' : share >= 0.5 ? 'warn' : 'bad'}
              />
            );
          })}
          <Figure label="Última batelada" value={data.day.lastAt ? clock(data.day.lastAt) : '—'} />
        </div>
        <WorkCurve data={data} color={palette.accent} />
        {processes && (processes.pesagem || processes.misturador) && (
          <div className="mx-steps">
            {(['pesagem', 'misturador'] as const).map((process) =>
              processes[process] ? (
                <StepTable key={process} process={process} data={processes[process]!} />
              ) : null,
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Figure({
  label,
  value,
  unit,
  hint,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className={`mx-figure${tone ? ` ${tone}` : ''}`}>
      <span>{label}</span>
      <b>
        {value}
        {unit && <small> {unit}</small>}
      </b>
      {hint && <em>{hint}</em>}
    </div>
  );
}

/**
 * One process now: the step it is in, how long it has been there against the time that step
 * usually takes, and its steps in order with the current one lit.
 */
function ProcessNow({
  process,
  data,
  live,
  children,
}: {
  process: Process;
  data: ProcessDay | null;
  live: boolean;
  children?: React.ReactNode;
}) {
  const now = data?.current && live ? stepOf(process, data.current.step) : null;
  const elapsed = data?.current ? (Date.now() - new Date(data.current.since).getTime()) / 1000 : null;
  const typical = now ? data?.steps.find((item) => item.step === now.step)?.typical ?? null : null;
  const reference = typical ?? (now ? data?.steps.find((item) => item.step === now.step)?.median : null) ?? null;
  const ratio = elapsed != null && reference ? elapsed / reference : null;
  const tone = ratio == null ? '' : ratio <= 1.1 ? 'good' : ratio <= 1.5 ? 'warn' : 'bad';
  // The track shows each kind of job once, in order: the calculating steps fold into one chip.
  const track = PROCESS_STEPS[process].filter(
    (item) => item.kind !== 'off' && !(item.kind === 'prep' && item.label.startsWith('Calculando')),
  );
  return (
    <section className="mx-proc">
      <div className="mx-proc-head">
        <strong>{PROCESS_NAMES[process].title}</strong>
        <small>{PROCESS_NAMES[process].hint}</small>
      </div>
      {!data ? (
        <div className="mx-proc-missing">
          Publique a variável <b>{process === 'pesagem' ? 'ProcessoPesagem' : 'ProcessoMisturador'}</b>{' '}
          no MQTT para acompanhar as etapas.
        </div>
      ) : (
        <>
          <div className={`mx-now ${now ? now.kind : 'off'}`}>
            <i style={{ background: STEP_KINDS[now?.kind ?? 'off'].color }} />
            <div>
              <span>{now ? STEP_KINDS[now.kind].label : 'Agora'}</span>
              <b>{now ? now.label : live ? 'Sem etapa em andamento' : 'Sem leitura do CLP'}</b>
            </div>
            {now && elapsed != null && (
              <div className={`mx-elapsed ${tone}`}>
                <b>{span(elapsed)}</b>
                <small>{reference ? `típico ${span(reference)}` : 'nesta etapa'}</small>
              </div>
            )}
          </div>
          {now && ratio != null && (
            <div className={`mx-progress ${tone}`} title="Tempo nesta etapa contra o típico">
              <i style={{ width: `${Math.min(100, (ratio / 1.5) * 100)}%` }} />
              <u style={{ left: `${(1 / 1.5) * 100}%` }} />
            </div>
          )}
          <ol className="mx-track">
            {track.map((item) => {
              // A calculating step lights the dose it is preparing (Calcula a areia: Areia).
              const lit =
                now && now.label.startsWith('Calculando') ? now.step + 5 : now?.step;
              const active = item.step === lit;
              return (
                <li key={item.step} className={`${item.kind}${active ? ' active' : ''}`} title={item.label}>
                  {item.short}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {children}
    </section>
  );
}

/** The scale against the recipe's total, and what the recipe is made of, the dosing one lit. */
function ScaleNow({ data, dosing }: { data: Mixer; dosing?: number }) {
  const palette = useContext(MortarColors);
  const recipeKg = data.materials.reduce((sum, item) => sum + (item.kg ?? 0), 0);
  const share = data.scale != null && data.target ? Math.min(1.15, data.scale / data.target) : null;
  const dosingMaterial = dosing != null ? stepOf('pesagem', dosing).material : undefined;
  return (
    <div className="mx-scale">
      <div className="mx-big">
        <b>{data.scale == null ? '—' : integer(data.scale)}</b>
        <small>kg na balança{data.target ? ` · de ${integer(data.target)} kg` : ''}</small>
        {share != null && <em>{Math.round(share * 100)}%</em>}
      </div>
      <div className="mx-gauge" title="Peso na balança contra o total da receita">
        <i style={{ width: `${Math.min(100, (share ?? 0) * 100)}%` }} />
      </div>
      {recipeKg > 0 && (
        <ul className="mx-materials">
          {data.materials.map((item, index) => (
            <li
              key={item.label}
              className={`${item.kg ? '' : 'none'}${dosingMaterial === index ? ' dosing' : ''}`}
            >
              <i style={{ background: palette.material(item.label, index) }} />
              <span>{item.label}</span>
              <b>{item.kg ? `${integer(item.kg)} kg` : '—'}</b>
              <div className="mx-material-bar">
                <u
                  style={{
                    width: `${((item.kg ?? 0) / recipeKg) * 100}%`,
                    background: palette.material(item.label, index),
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The mixer's two timed steps: what the recipe programs, and what they really take. */
function MixerTimes({ data }: { data: Mixer }) {
  const steps = data.processes?.misturador?.steps ?? [];
  const real = (step: number) => steps.find((item) => item.step === step)?.median ?? null;
  const rows: Array<[string, number | null, number | null]> = [
    ['Mistura', data.mixSeconds, real(15)],
    ['Descarga', data.dischargeSeconds, real(21)],
  ];
  return (
    <div className="mx-times">
      <div className="mx-times-head">
        <span />
        <span>Programado</span>
        <span>Real hoje</span>
      </div>
      {rows.map(([name, programmed, measured]) => {
        const over = programmed && measured ? measured / programmed - 1 : null;
        return (
          <div key={name} className="mx-times-row">
            <span>{name}</span>
            <b>{span(programmed)}</b>
            <b className={over == null ? '' : over > 0.15 ? 'bad' : over > 0.05 ? 'warn' : 'good'}>
              {span(measured)}
              {over != null && Math.abs(over) >= 0.05 && (
                <small> {over > 0 ? '+' : '−'}{Math.round(Math.abs(over) * 100)}%</small>
              )}
            </b>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The scale through the day, each climb a batch being dosed and each line a batch that closed,
 * with both processes drawn under it on the same clock, coloured by what they were doing.
 */
function WorkCurve({ data, color }: { data: Mixer; color: string }) {
  const rows = useMemo(
    () => data.curve.map((point) => ({ t: new Date(point.at).getTime(), kg: point.kg })),
    [data.curve],
  );
  const drawing = useFirstDraw(rows.length > 0);
  const lanes = (['pesagem', 'misturador'] as const).filter((process) => data.processes?.[process]);
  const activity = [
    ...rows.map((row) => row.t),
    ...lanes.flatMap((process) =>
      data.processes![process]!.segments
        .filter((segment) => segment.step !== 0)
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
      <div className="mx-label">
        Curva de trabalho
        <small>peso na balança e o que cada processo fazia · linhas cinzas = bateladas fechadas</small>
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
              <ReferenceLine
                y={data.target}
                stroke="#0b2028"
                strokeDasharray="6 4"
                label={{
                  value: 'total da receita',
                  position: 'insideTopRight',
                  fontSize: 10,
                  fill: '#5d747b',
                }}
              />
            )}
            {data.day.list.map((batch) => (
              <ReferenceLine
                key={batch.at}
                x={new Date(batch.at).getTime()}
                stroke="#c3d0d4"
                strokeWidth={1}
              />
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
          <span className="mx-lane-name">{PROCESS_NAMES[process].title}</span>
          <div className="mx-lane-track">
            {data.processes![process]!.segments.map((segment) => {
              const step = stepOf(process, segment.step);
              const left = at(new Date(segment.start).getTime());
              const width = at(new Date(segment.end).getTime()) - left;
              if (width <= 0) return null;
              return (
                <i
                  key={`${segment.start}-${segment.step}`}
                  style={{ left: `${left}%`, width: `${width}%`, background: STEP_KINDS[step.kind].color }}
                  title={`${clock(segment.start)}–${clock(segment.end)} · ${step.label} · ${span(segment.seconds)}`}
                />
              );
            })}
          </div>
        </div>
      ))}
      {lanes.length > 0 && (
        <div className="mx-legend" style={{ marginLeft: Y_AXIS }}>
          {(['work', 'prep', 'wait', 'off'] as const).map((kind) => (
            <span key={kind}>
              <i style={{ background: STEP_KINDS[kind].color }} /> {STEP_KINDS[kind].label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A process's steps in the day: how often each ran, its typical time against the seven days
 * before, and where the time went. The longest wait is said in words above the table.
 */
function StepTable({ process, data }: { process: Process; data: ProcessDay }) {
  const { totals, on } = kindTotals(process, data);
  const rows = data.steps.filter((item) => item.step !== 0 && (item.runs > 0 || item.total > 0));
  const longestWait = rows
    .filter((item) => stepOf(process, item.step).kind === 'wait')
    .sort((a, b) => b.total - a.total)[0];
  return (
    <section className="mx-step-table">
      <div className="mx-step-head">
        <strong>Etapas · {PROCESS_NAMES[process].title}</strong>
        <small>
          {data.cycles} {data.cycles === 1 ? 'ciclo' : 'ciclos'}
          {data.cycleSeconds ? ` · típico ${span(data.cycleSeconds)}` : ''}
        </small>
      </div>
      {on > 0 && (
        <div className="mx-kinds" title="Como o tempo ligado se dividiu">
          {(['work', 'prep', 'wait'] as const).map((kind) =>
            totals[kind] > 0 ? (
              <i
                key={kind}
                style={{ width: `${(totals[kind] / on) * 100}%`, background: STEP_KINDS[kind].color }}
                title={`${STEP_KINDS[kind].label}: ${span(totals[kind])} (${Math.round((totals[kind] / on) * 100)}%)`}
              />
            ) : null,
          )}
        </div>
      )}
      {longestWait && longestWait.total >= 60 && (
        <p className="mx-callout">
          Maior espera: <b>{stepOf(process, longestWait.step).label.toLowerCase()}</b> ·{' '}
          {span(longestWait.total)}
          {on > 0 && ` (${Math.round((longestWait.total / on) * 100)}% do tempo ligado)`}
        </p>
      )}
      {rows.length === 0 ? (
        <div className="stops-empty">Nenhuma etapa registrada neste dia.</div>
      ) : (
        <table className="stops-table mortar-table mx-table">
          <thead>
            <tr>
              <th>Etapa</th>
              <th className="n">Vezes</th>
              <th className="n" title="Mediana de hoje">Típico</th>
              <th className="n" title="Diferença para o típico dos 7 dias anteriores">vs 7 dias</th>
              <th className="n">Total</th>
              <th className="n">%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const step = stepOf(process, item.step);
              // In time, not in percent: a wait of 10 s that became 2 min is "+1 min 50 s", which
              // anyone reads, where "+1100%" says nothing. Slower is worse for every step.
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
                      <span className="mortar-dot" style={{ background: STEP_KINDS[step.kind].color }} />
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
      )}
    </section>
  );
}
