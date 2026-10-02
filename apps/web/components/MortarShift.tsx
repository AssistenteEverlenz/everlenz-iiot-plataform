'use client';

import { useContext, useMemo, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
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
import { usePlatform } from './PlatformShell';
import { Gauge, ShiftCurve, stateInfo, type BoardData } from './ShiftBoard';
import { MortarColors, clock, duration, integer, percent, perBag, tons } from './mortarShared';

/**
 * The bagging board of a mortar plant, built from the ceramic production board's own pieces
 * (ShiftBoard.tsx): the same head, the same clickable figures with the pencil on the target, the
 * same health line, the S-curve with its zoom and state-painted area, the availability gauge with
 * the share of each state, and the timeline. What is new is only what bagging has and a brick
 * press does not: several spouts, read together, one by one, or side by side.
 */
type SpoutRow = {
  id: string;
  name: string;
  bags: number;
  kg: number;
  actual: number;
  runningS: number;
  idleS: number;
  offS: number;
  pacePerHour: number | null;
  secondsPerBag: number | null;
  availability: number | null;
  performance: number | null;
  effectiveness: number | null;
  stops: number;
  stopSeconds: number;
  state: string;
  product: string | null;
};
type Stop = {
  spoutId: string;
  state: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  product: string | null;
  open: boolean;
};
type MortarBoard = {
  span: { start: string; end: string };
  plannedSeconds: number;
  remainingSeconds: number;
  metric: 'bags' | 'tons';
  totals: { bags: number; kg: number; actual: number };
  time: {
    producing: number;
    idle: number;
    disabled: number;
    offline: number;
    elapsedProductive: number;
  };
  utilization: number | null;
  performance: number | null;
  effectiveness: number | null;
  target: null | {
    value: number;
    perShift: number | null;
    actual: number;
    plannedToNow: number;
    projected: number;
    ratePerHour: number;
    requiredPerHour: number | null;
    health: 'achieved' | 'on_track' | 'at_risk' | 'off_track' | 'missed' | null;
  };
  pacePerHour: number;
  curve: Array<{
    t: string;
    planned: number | null;
    actual: number | null;
    projected: number | null;
  }>;
  timeline: Array<{ t: string; state: string; mix: Record<string, number> }>;
  stops: { count: number; seconds: number; longest: number; list: Stop[] };
};
export type MortarBoardResponse = {
  configured: boolean;
  mode: 'shift' | 'day';
  date: string;
  today: string;
  status: 'running' | 'finished' | 'upcoming';
  defaultShifts: boolean;
  now: string;
  state: string;
  product: string | null;
  shifts: Array<{ shiftId: string; name: string; start: string; end: string }>;
  available: Array<{ shiftId: string; name: string; start: string; end: string }>;
  board: MortarBoard;
  compare: { label: string; actual: Array<number | null> } | null;
  spouts: SpoutRow[];
  spoutCurves: Record<string, Array<number | null>> | null;
};
type Focus = 'produced' | 'target' | 'projection' | 'pace' | 'efficiency' | 'stops';

const STATE_LIST = ['producing', 'idle', 'disabled', 'offline'] as const;
const label = (state: string) =>
  state === 'producing' ? 'Ensacando' : (stateInfo[state]?.label ?? state);

export function MortarShiftBoard({
  deviceId,
  date,
  spoutId,
  spoutName,
  children,
}: {
  deviceId: string;
  /** The plant day the board reads. */
  date: string;
  /** One spout only, when the board opens from a spout. */
  spoutId?: string;
  spoutName?: string;
  /** What goes right under the figures: the spout cards, on the line's board. */
  children?: ReactNode;
}) {
  const { user } = usePlatform();
  const palette = useContext(MortarColors);
  const [mode, setMode] = useState<'shift' | 'day'>('shift');
  const [shift, setShift] = useState('');
  const [against, setAgainst] = useState<'' | 'yesterday' | 'week'>('');
  // Which curve the board draws: the line, one spout, or the spouts side by side.
  const [focusSpout, setFocusSpout] = useState<string>('line');
  const [detail, setDetail] = useState<Focus | null>(null);
  const [editing, setEditing] = useState(false);
  const spout = spoutId ?? (focusSpout !== 'line' && focusSpout !== 'compare' ? focusSpout : '');
  const response = usePoll<MortarBoardResponse>(
    `/devices/${deviceId}/mortar/board?mode=${mode}&date=${date}&compare=${against || 'none'}` +
      (shift && mode === 'shift' ? `&shift=${shift}` : '') +
      (spout ? `&spout=${spout}` : ''),
    30000,
  );
  const data = response.data;
  if (!data)
    return <div className="shift-board-empty">{response.error ?? 'Carregando o turno…'}</div>;
  if (!data.configured)
    return (
      <div className="shift-board-empty">
        <strong>Ensaque sem bicos configurados</strong>
        <span>Abra o lápis do card e escolha as variáveis de cada bico.</span>
      </div>
    );

  const board = data.board;
  const tonsMetric = board.metric === 'tons';
  const unit = tonsMetric ? 't' : 'sacos';
  const decimals = tonsMetric ? 1 : 0;
  const fmt = (value: number | null | undefined) =>
    value == null || !Number.isFinite(value)
      ? '—'
      : value.toLocaleString('pt-BR', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
  const target = board.target;
  const shownSpout = spoutId ? data.spouts.find((item) => item.id === spoutId) : null;
  const pickedSpout = !spoutId && spout ? data.spouts.find((item) => item.id === spout) : null;
  const title =
    (spoutName ? `Bico ${spoutName} · ` : pickedSpout ? `Bico ${pickedSpout.name} · ` : '') +
    (data.mode === 'day'
      ? `Dia ${data.date.split('-').reverse().slice(0, 2).join('/')} · ${data.shifts.length} turno${data.shifts.length === 1 ? '' : 's'}`
      : data.shifts[0]
        ? `${data.shifts[0].name} · ${clock(data.shifts[0].start)}–${clock(data.shifts[0].end)}`
        : 'Sem turno');
  const statusText =
    data.status === 'running'
      ? `termina em ${duration((new Date(board.span.end).getTime() - new Date(data.now).getTime()) / 1000)}`
      : data.status === 'finished'
        ? data.mode === 'day'
          ? 'dia encerrado'
          : 'turno encerrado'
        : `começa às ${clock(board.span.start)}`;
  const live = data.status === 'running';

  // The health line, in the ceramic board's words.
  const health = (() => {
    if (!target?.health) return null;
    const pct = target.value > 0 ? (target.actual / target.value) * 100 : 0;
    switch (target.health) {
      case 'achieved':
        return `Meta atingida: ${fmt(target.actual)} de ${fmt(target.value)} ${unit}.`;
      case 'missed':
        return `Fechou em ${fmt(target.actual)} de ${fmt(target.value)} ${unit} (${pct.toFixed(0)}% da meta).`;
      case 'on_track':
        return `No ritmo atual fecha em ${fmt(target.projected)} ${unit} — ${((target.projected / target.value) * 100).toFixed(0)}% da meta.`;
      default:
        return `Para bater ${fmt(target.value)} ${unit} precisa de ${fmt(target.requiredPerHour ?? 0)} ${unit}/h até ${clock(board.span.end)}; o ritmo atual é ${fmt(target.ratePerHour)} ${unit}/h. Projeção: ${fmt(target.projected)} ${unit}.`;
    }
  })();
  const tone =
    target?.health === 'achieved' || target?.health === 'on_track'
      ? 'good'
      : target?.health === 'at_risk'
        ? 'warn'
        : target?.health
          ? 'bad'
          : 'none';
  const opens = (focus: Focus) => ({
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => setDetail(focus),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') setDetail(focus);
    },
    title: 'Ver como foi durante o turno',
  });
  // The ceramic curve, fed the mortar board in its own shape.
  const curveBoard = { ...board, metric: 'blocks' } as unknown as BoardData;
  const spoutsInView = spout ? 1 : Math.max(1, data.spouts.length);
  const stopShare = board.time.elapsedProductive
    ? board.stops.seconds / spoutsInView / board.time.elapsedProductive
    : null;
  const allBags = data.spouts.reduce((sum, item) => sum + item.bags, 0);
  const allRunning = data.spouts.reduce((sum, item) => sum + item.runningS, 0);

  return (
    <div className="shift-board mortar-board">
      <div className="shift-board-head">
        <div>
          <strong>{title}</strong>
          <span>
            {statusText}
            {data.product ? ` · produto ${data.product}` : ''}
            {data.defaultShifts ? ' · turno padrão (cadastre os turnos em Produção)' : ''}
          </span>
        </div>
        <div className="shift-head-tools">
          <div className="shift-field">
            <span>Comparar com</span>
            <span className="widget-period" role="group" aria-label="Comparar com">
              {(
                [
                  ['yesterday', 'Ontem'],
                  ['week', 'Semana passada'],
                ] as const
              ).map(([key, text]) => (
                <button
                  key={key}
                  type="button"
                  className={against === key ? 'active' : ''}
                  // The pill that is on turns the comparison off, as on the ceramic board.
                  onClick={() => setAgainst(against === key ? '' : key)}
                >
                  {text}
                </button>
              ))}
            </span>
          </div>
          {live && (
            <span
              className="shift-state"
              style={{ '--state': stateInfo[data.state]?.color } as React.CSSProperties}
            >
              <i />
              {label(data.state)}
            </span>
          )}
          {mode === 'shift' && data.available.length > 1 && (
            <div className="shift-mode shift-pick" role="group" aria-label="Turno">
              {data.available.map((item) => (
                <button
                  key={item.shiftId}
                  className={(shift || data.shifts[0]?.shiftId) === item.shiftId ? 'active' : ''}
                  onClick={() => setShift(item.shiftId)}
                >
                  {item.name}
                </button>
              ))}
            </div>
          )}
          <div className="shift-mode" role="group" aria-label="Período">
            <button className={mode === 'shift' ? 'active' : ''} onClick={() => setMode('shift')}>
              Turno
            </button>
            <button className={mode === 'day' ? 'active' : ''} onClick={() => setMode('day')}>
              Dia
            </button>
          </div>
        </div>
      </div>

      <div className="shift-kpis">
        <div className="shift-kpi hero clickable" {...opens('produced')}>
          <span>Produzido</span>
          <b>
            {fmt(board.totals.actual)} <small>{unit}</small>
          </b>
          <em>
            {integer(board.totals.bags)} sacos · {tons(board.totals.kg)} t
          </em>
        </div>
        {!spout && (
          <div className="shift-kpi clickable" {...opens('target')}>
            <span className="shift-kpi-title">
              Meta
              {user.role === 'master' && (
                <button
                  type="button"
                  className="kpi-edit"
                  title="Editar a meta do turno"
                  aria-label="Editar a meta do turno"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditing(true);
                  }}
                >
                  ✎
                </button>
              )}
            </span>
            {target ? (
              <>
                <b>
                  {fmt(target.value)} <small>{unit}</small>
                </b>
                <em>
                  esperado agora {fmt(target.plannedToNow)} · feito {fmt(target.actual)}
                </em>
              </>
            ) : (
              <>
                <b className="muted">Sem meta</b>
                <em>{user.role === 'master' ? 'defina no lápis ✎' : 'sem meta definida'}</em>
              </>
            )}
          </div>
        )}
        <div className="shift-kpi clickable" {...opens('projection')}>
          <span>Projeção de fechamento</span>
          <b>
            {fmt(target ? target.projected : board.pacePerHour * (board.plannedSeconds / 3600))}{' '}
            <small>{unit}</small>
          </b>
          <em>
            {target
              ? `${((target.projected / target.value) * 100).toFixed(0)}% da meta`
              : 'no ritmo do período'}
          </em>
        </div>
        <div className="shift-kpi clickable" {...opens('pace')}>
          <span>Ritmo</span>
          <b>
            {fmt(board.pacePerHour)} <small>{unit}/h</small>
          </b>
          <em>
            {target?.requiredPerHour != null && board.remainingSeconds > 0
              ? `necessário ${fmt(target.requiredPerHour)} ${unit}/h`
              : `por hora do turno · tempo por saco ${perBag(
                  shownSpout?.secondsPerBag ?? (allBags ? allRunning / allBags : null),
                )}`}
          </em>
        </div>
        <div className="shift-kpi clickable" {...opens('efficiency')}>
          <span>Eficiência</span>
          <b>{percent(board.effectiveness ?? board.utilization, 1)}</b>
          <em>
            disponível {percent(board.utilization, 0)} × desempenho{' '}
            {board.performance == null ? 'sem ritmo padrão' : percent(board.performance, 0)}
          </em>
        </div>
        <div className="shift-kpi clickable" {...opens('stops')}>
          <span>Paradas</span>
          <b>{integer(board.stops.count)}</b>
          <em>
            {board.stops.count
              ? `${duration(board.stops.seconds)} parados · ${percent(stopShare, 0)} do tempo`
              : 'nenhuma no período'}
          </em>
        </div>
      </div>

      {health && <div className={`shift-health ${tone}`}>{health}</div>}

      {children}

      {!spoutId && data.spouts.length > 1 && (
        <div className="mortar-curve-pick">
          <span>Curva de</span>
          <span className="widget-period" role="group" aria-label="Curva de">
            <button
              type="button"
              className={focusSpout === 'line' ? 'active' : ''}
              onClick={() => setFocusSpout('line')}
            >
              Linha toda
            </button>
            {data.spouts.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={focusSpout === item.id ? 'active' : ''}
                onClick={() => setFocusSpout(item.id)}
              >
                <i style={{ background: palette.spout(index) }} /> Bico {item.name}
              </button>
            ))}
            <button
              type="button"
              className={focusSpout === 'compare' ? 'active' : ''}
              onClick={() => setFocusSpout('compare')}
            >
              Comparar bicos
            </button>
          </span>
        </div>
      )}

      {focusSpout === 'compare' && !spoutId ? (
        <SpoutComparison data={data} fmt={fmt} unit={unit} />
      ) : (
        <div className="shift-body">
          <div className="shift-curve">
            <div className="shift-section-title">
              Curva S · {unit} acumulados
              <span className="shift-legend">
                {target && (
                  <>
                    <i className="planned" /> planejado{' '}
                  </>
                )}
                <i className="actual" /> realizado (área = estado dos bicos){' '}
                {live && (
                  <>
                    <i className="projected" /> projeção
                  </>
                )}
                {data.compare && (
                  <>
                    {' '}
                    <i className="compared" /> {data.compare.label}
                  </>
                )}
              </span>
            </div>
            <div className="shift-chart">
              <ShiftCurve
                board={curveBoard}
                unit={{ unit, name: unit, decimals }}
                compare={data.compare}
              />
            </div>
          </div>
          <MortarAvailability board={board} />
        </div>
      )}

      <div className="shift-timeline" aria-label="Linha do tempo">
        {board.timeline.map((segment) => (
          <span
            key={segment.t}
            style={{ background: stateInfo[segment.state]?.color ?? stateInfo.unknown.color }}
            title={`${clock(segment.t)} · ${label(segment.state)}`}
          />
        ))}
      </div>
      <div className="shift-timeline-axis">
        <span>{clock(board.span.start)}</span>
        <span>{clock(board.span.end)}</span>
      </div>
      <div className="shift-timeline-legend">
        {[...new Set(board.timeline.map((segment) => segment.state))].map((state) => (
          <span key={state}>
            <i style={{ background: stateInfo[state]?.color }} />
            {label(state)}
          </span>
        ))}
      </div>

      {editing && (
        <TargetEditor
          deviceId={deviceId}
          metric={board.metric}
          perShift={target?.perShift ?? null}
          onClose={() => {
            setEditing(false);
            void response.refresh();
          }}
        />
      )}
      {detail && (
        <ModalPortal>
          <MortarDetailModal
            deviceId={deviceId}
            focus={detail}
            mode={mode}
            date={date}
            shift={shift}
            spout={spout}
            board={data}
            onClose={() => setDetail(null)}
          />
        </ModalPortal>
      )}
    </div>
  );
}

/** How the spouts spent the period, beside the curve, as the ceramic board shows the machine. */
function MortarAvailability({ board }: { board: MortarBoard }) {
  const elapsed = board.time.elapsedProductive;
  return (
    <div className="shift-availability">
      <div className="shift-section-title">
        <span>Disponibilidade dos bicos</span>
      </div>
      <Gauge value={board.utilization} />
      <small className="shift-gauge-caption">ensacando ÷ (ensacando + ociosa)</small>
      <ul className="shift-states">
        {STATE_LIST.filter((state) => state !== 'disabled' || board.time.disabled >= 60).map(
          (state) => {
            const seconds = board.time[state] ?? 0;
            return (
              <li key={state}>
                <i style={{ background: stateInfo[state].color }} />
                <span>{label(state)}</span>
                <b>{duration(seconds)}</b>
                <em>{elapsed > 0 ? `${Math.round((seconds / elapsed) * 100)}%` : '—'}</em>
              </li>
            );
          },
        )}
      </ul>
    </div>
  );
}

/**
 * The spouts side by side: their curves on one chart, and a table that ranks them by what the
 * owner compares -- bags, pace, time per bag, availability, performance, efficiency, stops.
 */
function SpoutComparison({
  data,
  fmt,
  unit,
}: {
  data: MortarBoardResponse;
  fmt: (value: number | null | undefined) => string;
  unit: string;
}) {
  const palette = useContext(MortarColors);
  const rows = useMemo(
    () =>
      data.board.curve.map((point, index) => ({
        label: clock(point.t),
        ...Object.fromEntries(
          data.spouts.map((spout) => [spout.id, data.spoutCurves?.[spout.id]?.[index] ?? null]),
        ),
      })),
    [data],
  );
  const drawing = useFirstDraw(rows.length > 0);
  const best = (pick: (spout: SpoutRow) => number | null, lowest = false) => {
    const values = data.spouts
      .map((spout) => ({ id: spout.id, value: pick(spout) }))
      .filter((item): item is { id: string; value: number } => item.value != null);
    if (values.length < 2) return null;
    return values.sort((a, b) => (lowest ? a.value - b.value : b.value - a.value))[0].id;
  };
  const leaders = {
    bags: best((s) => s.bags),
    pace: best((s) => s.pacePerHour),
    perBag: best((s) => s.secondsPerBag, true),
    availability: best((s) => s.availability),
    performance: best((s) => s.performance),
    effectiveness: best((s) => s.effectiveness),
    stops: best((s) => s.stops, true),
  };
  const cell = (id: string, key: keyof typeof leaders, text: string) => (
    <td className={`n ${leaders[key] === id ? 'mortar-leader' : ''}`}>{text}</td>
  );
  return (
    <div className="mortar-compare">
      <div className="shift-section-title">
        Bicos lado a lado · sacos acumulados de cada um
        <span className="shift-legend">
          {data.spouts.map((spout, index) => (
            <span key={spout.id} className="mortar-legend-item">
              <i style={{ background: palette.spout(index) }} /> Bico {spout.name}
            </span>
          ))}
        </span>
      </div>
      <div className="shift-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid
              stroke="#e6eef0"
              strokeOpacity={0.35}
              strokeDasharray="3 5"
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: '#71868d' }}
              tickLine={false}
              axisLine={false}
              minTickGap={28}
            />
            <YAxis
              width={44}
              tick={{ fontSize: 10, fill: '#71868d' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => integer(value)}
            />
            <Tooltip
              formatter={(value, name) => [
                `${integer(Number(value))} sacos`,
                `Bico ${data.spouts.find((spout) => spout.id === name)?.name ?? ''}`,
              ]}
            />
            {data.spouts.map((spout, index) => (
              <Line
                key={spout.id}
                dataKey={spout.id}
                type="monotone"
                stroke={palette.spout(index)}
                strokeWidth={2.5}
                dot={false}
                connectNulls={false}
                isAnimationActive={drawing}
                animationDuration={700}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <table className="stops-table mortar-table mortar-ranking">
        <thead>
          <tr>
            <th>Bico</th>
            <th className="n">Produzido</th>
            <th className="n">Ritmo</th>
            <th className="n">Por saco</th>
            <th className="n">Disponível</th>
            <th className="n">Desempenho</th>
            <th className="n">Eficiência</th>
            <th className="n">Paradas</th>
          </tr>
        </thead>
        <tbody>
          {data.spouts.map((spout, index) => (
            <tr key={spout.id}>
              <td>
                <span className="mortar-dot" style={{ background: palette.spout(index) }} />
                <b>Bico {spout.name}</b>
                {spout.product && <small className="muted"> · {spout.product}</small>}
              </td>
              {cell(spout.id, 'bags', `${fmt(spout.actual)} ${unit}`)}
              {cell(
                spout.id,
                'pace',
                spout.pacePerHour == null ? '—' : `${integer(spout.pacePerHour)} sacos/h`,
              )}
              {cell(spout.id, 'perBag', perBag(spout.secondsPerBag))}
              {cell(spout.id, 'availability', percent(spout.availability, 0))}
              {cell(spout.id, 'performance', percent(spout.performance, 0))}
              {cell(spout.id, 'effectiveness', percent(spout.effectiveness, 0))}
              {cell(spout.id, 'stops', `${spout.stops} · ${duration(spout.stopSeconds)}`)}
            </tr>
          ))}
        </tbody>
      </table>
      <small className="shift-note">
        Em destaque, o melhor bico de cada coluna. Eficiência = disponível × desempenho; o
        desempenho compara os sacos feitos com o ritmo padrão de cada produto.
      </small>
    </div>
  );
}

function TargetEditor({
  deviceId,
  metric,
  perShift,
  onClose,
}: {
  deviceId: string;
  metric: 'bags' | 'tons';
  perShift: number | null;
  onClose: () => void;
}) {
  const [unit, setUnit] = useState(metric);
  const [value, setValue] = useState(perShift == null ? '' : String(perShift).replace('.', ','));
  const [error, setError] = useState('');
  const save = async (clear = false) => {
    const number = Number(value.replace(',', '.'));
    if (!clear && !(number > 0)) return setError('Informe a meta de um turno.');
    try {
      await mutate(`/devices/${deviceId}/mortar/target`, 'PATCH', {
        metric: unit,
        perShift: clear ? null : number,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar');
    }
  };
  return (
    <ModalPortal>
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div className="modal-card compact-modal" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-title">
            <div>
              <div className="eyebrow">META DO ENSAQUE</div>
              <h2>Meta por turno</h2>
            </div>
            <button type="button" className="icon-button" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="form-grid">
            <div className="field full-field">
              Unidade
              <span className="widget-period" role="group" aria-label="Unidade">
                <button
                  type="button"
                  className={unit === 'bags' ? 'active' : ''}
                  onClick={() => setUnit('bags')}
                >
                  Sacos
                </button>
                <button
                  type="button"
                  className={unit === 'tons' ? 'active' : ''}
                  onClick={() => setUnit('tons')}
                >
                  Toneladas
                </button>
              </span>
            </div>
            <label className="field full-field">
              Meta de um turno
              <input
                inputMode="decimal"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={unit === 'bags' ? 'ex.: 6000' : 'ex.: 140'}
              />
              <small>A meta do dia é a soma dos turnos do dia.</small>
            </label>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            {perShift != null && (
              <button type="button" onClick={() => void save(true)}>
                Tirar a meta
              </button>
            )}
            <button type="button" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="primary-button" onClick={() => void save()}>
              Salvar meta
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

// ---------------------------------------------------------------------------------------------
// What is behind each number, period by period, in the ceramic detail modal's layout.

type Detail = {
  span: { start: string; end: string; until: string } | null;
  shiftName: string;
  metric: 'bags' | 'tons';
  step: number;
  spouts: Array<{ id: string; name: string }>;
  periods: Array<{
    t: string;
    bags: number;
    kg: number;
    running: number;
    idle: number;
    off: number;
    spouts: Record<string, { bags: number; running: number; idle: number; off: number }>;
  }>;
};
const TITLES: Record<Focus, string> = {
  produced: 'Produção durante o turno',
  target: 'Meta durante o turno',
  projection: 'Projeção de fechamento',
  pace: 'Ritmo e tempo por saco',
  efficiency: 'Eficiência dos bicos',
  stops: 'Paradas dos bicos',
};
const STEPS = [5, 10, 15, 30, 60];

function MortarDetailModal({
  deviceId,
  focus,
  mode,
  date,
  shift,
  spout,
  board,
  onClose,
}: {
  deviceId: string;
  focus: Focus;
  mode: 'shift' | 'day';
  date: string;
  shift: string;
  spout: string;
  board: MortarBoardResponse;
  onClose: () => void;
}) {
  const palette = useContext(MortarColors);
  const [step, setStep] = useState(60);
  const detail = usePoll<Detail>(
    `/devices/${deviceId}/mortar/detail?mode=${mode}&date=${date}&step=${step}` +
      (shift && mode === 'shift' ? `&shift=${shift}` : '') +
      (spout ? `&spout=${spout}` : ''),
    60000,
  );
  const data = detail.data;
  const tonsMetric = (data?.metric ?? board.board.metric) === 'tons';
  const unit = tonsMetric ? 't' : 'sacos';
  const fmt = (n: number | null | undefined) =>
    n == null || !Number.isFinite(n)
      ? '—'
      : n.toLocaleString('pt-BR', {
          minimumFractionDigits: tonsMetric ? 1 : 0,
          maximumFractionDigits: tonsMetric ? 1 : 0,
        });
  const spouts = useMemo(
    () => data?.spouts.filter((item) => !spout || item.id === spout) ?? [],
    [data, spout],
  );
  const colorOf = (id: string) =>
    palette.spout(
      Math.max(
        0,
        (data?.spouts ?? []).findIndex((item) => item.id === id),
      ),
    );
  const rows = useMemo(() => {
    let cumulative = 0;
    const target = board.board.target;
    const planned = board.board.plannedSeconds;
    const spanStart = new Date(board.board.span.start).getTime();
    const stepSeconds = (data?.step ?? 60) * 60;
    return (data?.periods ?? []).map((period) => {
      const amount = tonsMetric ? period.kg / 1000 : period.bags;
      cumulative += amount;
      const shown = Math.max(1, spouts.length);
      const row: Record<string, number | string | null> = {
        label: clock(period.t),
        value: amount,
        cumulative,
        // What the period made, scaled to an hour.
        pace: amount / (stepSeconds / 3600),
        running: period.running / 60 / shown,
        idle: period.idle / 60 / shown,
        planned:
          target && planned
            ? Math.min(
                target.value,
                (target.value * ((new Date(period.t).getTime() - spanStart) / 1000 + stepSeconds)) /
                  planned,
              )
            : null,
      };
      for (const item of spouts) {
        const own = period.spouts[item.id];
        row['bags_' + item.id] = own?.bags ?? 0;
        row['sec_' + item.id] =
          own && own.bags >= 3 && own.running > 0
            ? Math.round((own.running / own.bags) * 10) / 10
            : null;
        row['avail_' + item.id] =
          own && own.running + own.idle > 0
            ? Math.round((own.running / (own.running + own.idle)) * 1000) / 10
            : null;
      }
      return row;
    });
  }, [data, spouts, board, tonsMetric]);
  const best = [...rows].sort((a, b) => Number(b.value) - Number(a.value))[0];
  const total = rows.at(-1)?.cumulative ?? 0;
  const axis = { stroke: 'var(--detail-axis)', fontSize: 12 } as const;
  const showStops = focus === 'stops';
  const stops = board.board.stops;
  const spoutName = (id: string) => board.spouts.find((item) => item.id === id)?.name ?? '';

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card detail-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">DETALHE DO {mode === 'day' ? 'DIA' : 'TURNO'}</div>
            <h2>{TITLES[focus]}</h2>
            {data?.span && (
              <p className="shifts-help">
                {data.shiftName} · {clock(data.span.start)} às {clock(data.span.end)} · atualizado
                até {clock(data.span.until)}
              </p>
            )}
          </div>
          <div className="detail-step">
            <label htmlFor="mortar-detail-step">Dividir por</label>
            <select
              id="mortar-detail-step"
              value={step}
              onChange={(event) => setStep(Number(event.target.value))}
            >
              {STEPS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 60 ? '1 hora' : `${minutes} min`}
                </option>
              ))}
            </select>
            <button type="button" className="icon-button" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        {detail.error && <div className="form-error">{detail.error}</div>}
        {!data && <p>Carregando…</p>}

        {data && !showStops && (
          <div className="detail-summary">
            <div>
              <span>Total no período</span>
              <b>
                {fmt(Number(total))} <small>{unit}</small>
              </b>
            </div>
            <div>
              <span>Melhor período</span>
              <b>
                {best ? best.label : '—'} <small>{best ? fmt(Number(best.value)) : ''}</small>
              </b>
            </div>
            <div>
              <span>Ritmo médio</span>
              <b>
                {fmt(board.board.pacePerHour)} <small>{unit}/h</small>
              </b>
            </div>
            <div>
              <span>{focus === 'efficiency' ? 'Eficiência' : 'Disponibilidade'}</span>
              <b>
                {percent(
                  focus === 'efficiency'
                    ? (board.board.effectiveness ?? board.board.utilization)
                    : board.board.utilization,
                  1,
                )}{' '}
                <small>{focus === 'efficiency' ? 'disponível × desempenho' : 'dos bicos'}</small>
              </b>
            </div>
          </div>
        )}

        {data && (focus === 'produced' || focus === 'target' || focus === 'projection') && (
          <>
            <div className="detail-section">
              <strong>
                Acumulado ao longo do período
                {board.board.target ? ' · contra a meta' : ''}
              </strong>
              <div className="detail-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows}>
                    <CartesianGrid
                      stroke="var(--detail-grid)"
                      strokeDasharray="3 6"
                      vertical={false}
                    />
                    <XAxis dataKey="label" {...axis} />
                    <YAxis {...axis} width={56} />
                    <Tooltip
                      formatter={(n, name) => [
                        `${fmt(Number(n))} ${unit}`,
                        name === 'planned' ? 'meta' : 'acumulado',
                      ]}
                    />
                    {board.board.target && (
                      <Line
                        type="monotone"
                        dataKey="planned"
                        stroke="#8a9ca2"
                        strokeDasharray="5 5"
                        dot={false}
                      />
                    )}
                    <Line
                      type="monotone"
                      dataKey="cumulative"
                      stroke="var(--brand-accent, #12b8a6)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="detail-section">
              <strong>Produção por período, por bico</strong>
              <div className="detail-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rows}>
                    <CartesianGrid
                      stroke="var(--detail-grid)"
                      strokeDasharray="3 6"
                      vertical={false}
                    />
                    <XAxis dataKey="label" {...axis} />
                    <YAxis {...axis} width={48} />
                    <Tooltip
                      formatter={(n, name) => [
                        `${integer(Number(n))} sacos`,
                        `Bico ${spouts.find((item) => 'bags_' + item.id === name)?.name ?? ''}`,
                      ]}
                    />
                    {spouts.map((item, index) => (
                      <Bar
                        key={item.id}
                        dataKey={'bags_' + item.id}
                        stackId="s"
                        fill={colorOf(item.id)}
                        radius={index === spouts.length - 1 ? [4, 4, 0, 0] : undefined}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}

        {data && focus === 'pace' && (
          <>
            <div className="detail-section">
              <strong>Ritmo por período · {unit}/h da linha</strong>
              <div className="detail-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rows}>
                    <CartesianGrid
                      stroke="var(--detail-grid)"
                      strokeDasharray="3 6"
                      vertical={false}
                    />
                    <XAxis dataKey="label" {...axis} />
                    <YAxis {...axis} width={48} />
                    <Tooltip formatter={(n) => [`${fmt(Number(n))} ${unit}/h`, 'ritmo']} />
                    <Bar dataKey="pace" fill="#3d7f96" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="detail-section">
              <strong>
                Tempo por saco de cada bico · segundos para encher um saco, sem as paradas
              </strong>
              <div className="detail-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows}>
                    <CartesianGrid
                      stroke="var(--detail-grid)"
                      strokeDasharray="3 6"
                      vertical={false}
                    />
                    <XAxis dataKey="label" {...axis} />
                    <YAxis
                      {...axis}
                      width={48}
                      domain={['auto', 'auto']}
                      tickFormatter={(n: number) => Math.round(n) + ' s'}
                    />
                    <Tooltip
                      formatter={(n, name) => [
                        perBag(Number(n)),
                        `Bico ${spouts.find((item) => 'sec_' + item.id === name)?.name ?? ''}`,
                      ]}
                    />
                    {spouts.map((item) => (
                      <Line
                        key={item.id}
                        type="monotone"
                        dataKey={'sec_' + item.id}
                        stroke={colorOf(item.id)}
                        strokeWidth={2}
                        dot={{ r: 2 }}
                        connectNulls={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="stops-spent-legend">
                {spouts.map((item) => (
                  <span key={item.id}>
                    <i style={{ background: colorOf(item.id) }} /> Bico {item.name}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        {data && focus === 'efficiency' && (
          <>
            <div className="detail-section">
              <strong>
                Disponibilidade de cada bico por período · % do tempo habilitado ensacando
              </strong>
              <div className="detail-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows}>
                    <CartesianGrid
                      stroke="var(--detail-grid)"
                      strokeDasharray="3 6"
                      vertical={false}
                    />
                    <XAxis dataKey="label" {...axis} />
                    <YAxis
                      {...axis}
                      width={48}
                      domain={[0, 100]}
                      tickFormatter={(n: number) => n + '%'}
                    />
                    <Tooltip
                      formatter={(n, name) => [
                        `${Number(n).toLocaleString('pt-BR')}%`,
                        `Bico ${spouts.find((item) => 'avail_' + item.id === name)?.name ?? ''}`,
                      ]}
                    />
                    {spouts.map((item) => (
                      <Line
                        key={item.id}
                        type="monotone"
                        dataKey={'avail_' + item.id}
                        stroke={colorOf(item.id)}
                        strokeWidth={2}
                        dot={{ r: 2 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="detail-section">
              <strong>Os bicos no período</strong>
              <table className="detail-table">
                <thead>
                  <tr>
                    <th>Bico</th>
                    <th className="n">Disponível</th>
                    <th className="n">Desempenho</th>
                    <th className="n">Eficiência</th>
                    <th className="n">Ritmo</th>
                    <th className="n">Por saco</th>
                  </tr>
                </thead>
                <tbody>
                  {board.spouts
                    .filter((item) => !spout || item.id === spout)
                    .map((item) => (
                      <tr key={item.id}>
                        <td>
                          <span className="mortar-dot" style={{ background: colorOf(item.id) }} />
                          Bico {item.name}
                        </td>
                        <td className="n">{percent(item.availability, 1)}</td>
                        <td className="n">{percent(item.performance, 1)}</td>
                        <td className="n">
                          <b>{percent(item.effectiveness, 1)}</b>
                        </td>
                        <td className="n">
                          {item.pacePerHour == null ? '—' : `${integer(item.pacePerHour)} sacos/h`}
                        </td>
                        <td className="n">{perBag(item.secondsPerBag)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <p className="shifts-help">
                Disponível: tempo ensacando ÷ tempo habilitado. Desempenho: sacos feitos ÷ sacos que
                o ritmo padrão de cada produto faria no tempo ensacando (Ações → Produtos e
                receitas). Eficiência: um vezes o outro. A qualidade entra quando o CLP contar os
                sacos rejeitados.
              </p>
            </div>
          </>
        )}

        {showStops && (
          <>
            <div className="detail-summary">
              <div>
                <span>Paradas</span>
                <b>{integer(stops.count)}</b>
              </div>
              <div>
                <span>Tempo parado</span>
                <b>{duration(stops.seconds)}</b>
              </div>
              <div>
                <span>Maior parada</span>
                <b className="bad">{duration(stops.longest)}</b>
              </div>
              <div>
                <span>Parada média</span>
                <b>{stops.count ? duration(stops.seconds / stops.count) : '—'}</b>
              </div>
            </div>
            <div className="detail-section">
              <strong>Por bico</strong>
              <table className="detail-table">
                <tbody>
                  {board.spouts
                    .filter((item) => !spout || item.id === spout)
                    .map((item) => (
                      <tr key={item.id}>
                        <td>
                          <span className="mortar-dot" style={{ background: colorOf(item.id) }} />
                          Bico {item.name}
                        </td>
                        <td className="n">{item.stops} paradas</td>
                        <td className="n">{duration(item.stopSeconds)} parado</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="detail-section">
              <strong>Cada parada, da mais recente para a mais antiga</strong>
              <div className="scroll">
                <table className="detail-table">
                  <thead>
                    <tr>
                      <th>Bico</th>
                      <th>Início</th>
                      <th>Fim</th>
                      <th className="n">Duração</th>
                      <th>Motivo</th>
                      <th>Produto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stops.list.map((stop) => (
                      <tr key={stop.spoutId + stop.startedAt}>
                        <td>
                          <span
                            className="mortar-dot"
                            style={{ background: colorOf(stop.spoutId) }}
                          />
                          {spoutName(stop.spoutId)}
                        </td>
                        <td>{clock(stop.startedAt)}</td>
                        <td>{stop.open ? <b>agora</b> : clock(stop.endedAt)}</td>
                        <td className="n">{duration(stop.seconds)}</td>
                        <td>{stop.state === 'off' ? 'Desabilitada' : 'Ociosa'}</td>
                        <td>{stop.product ?? '—'}</td>
                      </tr>
                    ))}
                    {!stops.list.length && (
                      <tr>
                        <td colSpan={6}>Nenhuma parada no período.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {data && !showStops && (
          <div className="detail-section">
            <strong>Como os bicos passaram cada período</strong>
            <div className="scroll">
              <table className="detail-table">
                <thead>
                  <tr>
                    <th>{step >= 60 ? 'Hora' : 'Período'}</th>
                    <th className="n">Produzido</th>
                    <th className="n">Acumulado</th>
                    <th className="n">Ensacando</th>
                    <th className="n">Ociosa</th>
                    <th className="n">Ritmo</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={String(row.label)}>
                      <td>{row.label}</td>
                      <td className="n">{fmt(Number(row.value))}</td>
                      <td className="n">{fmt(Number(row.cumulative))}</td>
                      <td className="n">{Math.round(Number(row.running))} min</td>
                      <td className="n">{Math.round(Number(row.idle))} min</td>
                      <td className="n">
                        {fmt(Number(row.pace))} {unit}/h
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={6}>Sem produção registrada no período.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
