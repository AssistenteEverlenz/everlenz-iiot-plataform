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
import { DayCalendar } from './DayCalendar';
import { FormulaInput } from './FormulaInput';
import { Gauge, ShiftCurve, stateInfo, type BoardData } from './ShiftBoard';
import {
  DEFAULT_MORTAR_UTILIZATION,
  MORTAR_UTILIZATION_VARIABLES,
  mortarUtilizationCaption,
  mortarUtilizationError,
  mortarUtilizationFrom,
  mortarUtilizationValues,
} from './mortarUtilization';
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
  /** The plant's own availability formula (argamassa.horas_*); null is the default. */
  utilizationFormula?: string | null;
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

/**
 * What the board can be compared with, in the words of the ceramic board and of every other card:
 * the running day (when a past one is open), the median of a period, or one chosen day.
 */
type Comparison = '' | 'today' | '7d' | 'week' | 'month' | 'year' | 'custom';
const COMPARISONS: Array<[Comparison, string]> = [
  ['today', 'Hoje'],
  ['7d', '7 dias'],
  ['week', 'Semana'],
  ['month', 'Mês'],
  ['year', 'Ano'],
  ['custom', 'Personalizado'],
];
/** How many days back the median reads; the calendar ones count the days so far. */
function medianDays(against: Comparison) {
  const now = new Date();
  const days =
    against === '7d'
      ? 7
      : against === 'week'
        ? ((now.getDay() + 6) % 7) + 1
        : against === 'month'
          ? now.getDate()
          : against === 'year'
            ? Math.round((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000) +
              1
            : 0;
  return days ? Math.min(400, Math.max(2, days)) : 0;
}
const isoDay = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

export function MortarShiftBoard({
  deviceId,
  date,
  onDate,
  spoutId,
  spoutName,
  children,
}: {
  deviceId: string;
  /** The plant day the board reads. */
  date: string;
  /** Picks another day; absent where the day is fixed (a spout opened from the board). */
  onDate?: (date: string) => void;
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
  const [against, setAgainst] = useState<Comparison>('');
  const [againstDay, setAgainstDay] = useState('');
  const [pickingDay, setPickingDay] = useState(false);
  // Which curve the board draws: the line, one spout, or the spouts side by side.
  const [focusSpout, setFocusSpout] = useState<string>('line');
  const [detail, setDetail] = useState<Focus | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingFormula, setEditingFormula] = useState(false);
  // Both charts zoom together when a compared day is drawn under this one.
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const spout = spoutId ?? (focusSpout !== 'line' && focusSpout !== 'compare' ? focusSpout : '');
  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - 86400000));
  const median = medianDays(against);
  // The compared day: one picked on the calendar, or today while a past day is open.
  const comparedDay =
    against === 'custom' ? againstDay : against === 'today' && date !== today ? today : '';
  const query = (day: string) =>
    `/devices/${deviceId}/mortar/board?mode=${mode}&date=${day}` +
    (shift && mode === 'shift' ? `&shift=${shift}` : '') +
    (spout ? `&spout=${spout}` : '');
  const response = usePoll<MortarBoardResponse>(
    query(date) + (median ? `&compare=median&days=${median}` : ''),
    30000,
  );
  const below = usePoll<MortarBoardResponse>(comparedDay ? query(comparedDay) : null, 60000);
  const days = usePoll<{ days: string[] }>(`/devices/${deviceId}/mortar/days`, 600000);
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
  const other = comparedDay ? (below.data?.board ?? null) : null;
  const otherLabel = comparedDay
    ? comparedDay === today
      ? 'hoje'
      : comparedDay.split('-').reverse().slice(0, 2).join('/')
    : '';
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
  const opens = (focus: Focus) => ({
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => setDetail(focus),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') setDetail(focus);
    },
    title: 'Ver como foi durante o turno',
  });
  const spoutsInView = spout ? 1 : Math.max(1, data.spouts.length);
  const stopShare = board.time.elapsedProductive
    ? board.stops.seconds / spoutsInView / board.time.elapsedProductive
    : null;
  const allBags = data.spouts.reduce((sum, item) => sum + item.bags, 0);
  const allRunning = data.spouts.reduce((sum, item) => sum + item.runningS, 0);
  const secondsPerBag = shownSpout?.secondsPerBag ?? (allBags ? allRunning / allBags : null);

  // Where the period stands against its target, in one sentence and one colour.
  const ratio = target && target.value > 0 ? target.actual / target.value : null;
  const projectedRatio = target && target.value > 0 ? target.projected / target.value : null;
  const tone =
    target?.health === 'achieved' || target?.health === 'on_track'
      ? 'good'
      : target?.health === 'at_risk'
        ? 'warn'
        : target?.health
          ? 'bad'
          : 'none';
  const verdict = !target?.health
    ? null
    : target.health === 'achieved'
      ? 'Meta atingida'
      : target.health === 'missed'
        ? `Fechou em ${percent(ratio, 0)} da meta`
        : target.health === 'on_track'
          ? `No ritmo, fecha em ${percent(projectedRatio, 0)} da meta`
          : `Precisa de ${fmt(target.requiredPerHour ?? 0)} ${unit}/h para bater a meta`;

  const dayField = onDate && (
    <div className="shift-field">
      <span>Dia</span>
      <span className="shift-field-controls">
        <span className="widget-period" role="group" aria-label="Dia">
          <button
            type="button"
            className={date === today && !pickingDay ? 'active' : ''}
            onClick={() => {
              setPickingDay(false);
              onDate(today);
            }}
          >
            Hoje
          </button>
          <button
            type="button"
            className={date === yesterday && !pickingDay ? 'active' : ''}
            onClick={() => {
              setPickingDay(false);
              onDate(yesterday);
            }}
          >
            Ontem
          </button>
          <button
            type="button"
            className={pickingDay || (date !== today && date !== yesterday) ? 'active' : ''}
            onClick={() => setPickingDay(true)}
          >
            Personalizado
          </button>
        </span>
        {(pickingDay || (date !== today && date !== yesterday)) && (
          <DayCalendar value={date} available={days.data?.days ?? []} onPick={onDate} />
        )}
      </span>
    </div>
  );
  const compareField = (
    <div className="shift-field">
      <span>Comparar com</span>
      <span className="shift-field-controls">
        <span className="widget-period" role="group" aria-label="Comparar com">
          {COMPARISONS.map(([value, text]) => (
            <button
              key={value}
              type="button"
              className={against === value ? 'active' : ''}
              disabled={value === 'today' && date === today}
              title={
                value === 'today' && date === today ? 'O quadro já está mostrando hoje' : undefined
              }
              // The pill that is on turns the comparison off, as on the other cards.
              onClick={() => {
                setAgainst(against === value ? '' : value);
                setAgainstDay('');
                setZoom(null);
              }}
            >
              {text}
            </button>
          ))}
        </span>
        {against === 'custom' && (
          <DayCalendar
            value={againstDay}
            available={(days.data?.days ?? []).filter((day) => day !== date)}
            onPick={(day) => {
              setAgainstDay(day);
              setZoom(null);
            }}
          />
        )}
      </span>
    </div>
  );

  return (
    <div className={`shift-board mortar-board${other ? ' comparing' : ''}`}>
      <div className="mortar-board-head">
        <div className="mortar-board-title">
          <strong>{title}</strong>
          <span>
            {statusText}
            {data.product ? ` · produto ${data.product}` : ''}
            {data.defaultShifts ? ' · turno padrão (cadastre os turnos em Produção)' : ''}
          </span>
        </div>
        <div className="mortar-board-switches">
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
      <div className="mortar-board-filters">
        {dayField}
        {compareField}
      </div>

      {/* The period in one block: what was made against the target, where it should be by now
          and where it closes; beside it, the three figures that explain it. */}
      <div className="mortar-summary">
        <div className={`mortar-hero ${tone}`}>
          <div className="mortar-hero-top clickable" {...opens('produced')}>
            <span>Produzido</span>
            <b>
              {fmt(board.totals.actual)} <small>{unit}</small>
            </b>
            <em>
              {tonsMetric ? `${integer(board.totals.bags)} sacos` : `${tons(board.totals.kg)} t`}
              {other && (
                <i className="mortar-against">
                  {otherLabel}: {fmt(other.totals.actual)}
                </i>
              )}
            </em>
          </div>
          {target ? (
            <>
              <div
                className="mortar-progress"
                role="img"
                aria-label={`Feito ${percent(ratio, 0)} da meta`}
              >
                <i style={{ width: `${Math.min(100, (ratio ?? 0) * 100)}%` }} />
                {projectedRatio != null && live && (
                  <u
                    className="projected"
                    style={{ left: `${Math.min(100, projectedRatio * 100)}%` }}
                    title={`Projeção: ${fmt(target.projected)} ${unit}`}
                  />
                )}
                {live && target.value > 0 && (
                  <u
                    className="expected"
                    style={{
                      left: `${Math.min(100, (target.plannedToNow / target.value) * 100)}%`,
                    }}
                    title={`Esperado agora: ${fmt(target.plannedToNow)} ${unit}`}
                  />
                )}
              </div>
              <div className="mortar-hero-facts">
                <span className="clickable" {...opens('target')}>
                  Meta <b>{fmt(target.value)}</b>
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
                {live && (
                  <span>
                    Esperado agora <b>{fmt(target.plannedToNow)}</b>
                  </span>
                )}
                <span className="clickable" {...opens('projection')}>
                  {live ? 'Projeção' : 'Fechou'}{' '}
                  <b>{fmt(live ? target.projected : target.actual)}</b>
                </span>
                {verdict && <em className={`mortar-verdict ${tone}`}>{verdict}</em>}
              </div>
            </>
          ) : (
            <div className="mortar-hero-facts">
              {!spout && (
                <span>
                  Sem meta
                  {user.role === 'master' && (
                    <button
                      type="button"
                      className="kpi-edit"
                      title="Definir a meta do turno"
                      aria-label="Definir a meta do turno"
                      onClick={() => setEditing(true)}
                    >
                      ✎
                    </button>
                  )}
                </span>
              )}
              <span className="clickable" {...opens('projection')}>
                {live ? 'Projeção' : 'Fechou'}{' '}
                <b>
                  {fmt(
                    live ? board.pacePerHour * (board.plannedSeconds / 3600) : board.totals.actual,
                  )}
                </b>
              </span>
            </div>
          )}
        </div>
        <div className="mortar-tiles">
          <div className="shift-kpi clickable" {...opens('pace')}>
            <span>Ritmo</span>
            <b>
              {fmt(board.pacePerHour)} <small>{unit}/h</small>
            </b>
            <em>{perBag(secondsPerBag)} por saco</em>
            {other && (
              <i className="mortar-against">
                {otherLabel}: {fmt(other.pacePerHour)} {unit}/h
              </i>
            )}
          </div>
          <div className="shift-kpi clickable" {...opens('efficiency')}>
            <span>Eficiência</span>
            <b>{percent(board.effectiveness ?? board.utilization, 1)}</b>
            <em>
              {percent(board.utilization, 0)} disp. ×{' '}
              {board.performance == null
                ? 'sem ritmo padrão'
                : `${percent(board.performance, 0)} desemp.`}
            </em>
            {other && (
              <i className="mortar-against">
                {otherLabel}: {percent(other.effectiveness ?? other.utilization, 1)}
              </i>
            )}
          </div>
          <div className="shift-kpi clickable" {...opens('stops')}>
            <span>Paradas</span>
            <b>{integer(board.stops.count)}</b>
            <em>
              {board.stops.count
                ? `${duration(board.stops.seconds)} · ${percent(stopShare, 0)} do tempo`
                : 'nenhuma no período'}
            </em>
            {other && (
              <i className="mortar-against">
                {otherLabel}: {integer(other.stops.count)}
              </i>
            )}
          </div>
        </div>
      </div>

      {children}

      <div className="mortar-curve-block">
        <div className="mortar-curve-head">
          <strong>
            {focusSpout === 'compare' && !spoutId
              ? 'Bicos lado a lado · sacos acumulados de cada um'
              : `Curva S · ${unit} acumulados`}
          </strong>
          {!spoutId && data.spouts.length > 1 && (
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
                  <i className="mortar-swatch" style={{ background: palette.spout(index) }} /> Bico{' '}
                  {item.name}
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
          )}
        </div>

        {focusSpout === 'compare' && !spoutId ? (
          <SpoutComparison data={data} fmt={fmt} unit={unit} />
        ) : (
          <>
            <div className="shift-body">
              <div className="shift-curve">
                <div className="shift-chart">
                  <ShiftCurve
                    board={{ ...board, metric: 'blocks' } as unknown as BoardData}
                    unit={{ unit, name: unit, decimals }}
                    compare={data.compare}
                    view={other ? zoom : undefined}
                    onView={other ? setZoom : undefined}
                    syncId={other ? `mortar-${deviceId}` : undefined}
                  />
                </div>
                <div className="shift-legend mortar-curve-legend">
                  {target && (
                    <>
                      <i className="planned" /> planejado{' '}
                    </>
                  )}
                  <i className="actual" /> realizado (área = estado dos bicos){' '}
                  {live && (
                    <>
                      <i className="projected" /> projeção{' '}
                    </>
                  )}
                  {data.compare && (
                    <>
                      <i className="compared" /> {data.compare.label}
                    </>
                  )}
                </div>
              </div>
              <MortarAvailability
                board={board}
                onEdit={user.role === 'master' ? () => setEditingFormula(true) : undefined}
              />
            </div>
            {other && (
              <div className="shift-compare">
                <div className="shift-section-title">
                  {otherLabel}
                  <small> · dia comparado</small>
                </div>
                <div className="shift-body">
                  <div className="shift-curve">
                    <div className="shift-chart shift-compare-chart">
                      <ShiftCurve
                        board={{ ...other, metric: 'blocks' } as unknown as BoardData}
                        unit={{ unit, name: unit, decimals }}
                        view={zoom}
                        onView={setZoom}
                        syncId={`mortar-${deviceId}`}
                      />
                    </div>
                  </div>
                  <MortarAvailability board={other} label={otherLabel} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

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
      {editingFormula && (
        <ModalPortal>
          <MortarUtilizationModal
            deviceId={deviceId}
            formula={board.utilizationFormula ?? null}
            time={board.time}
            onClose={(saved) => {
              setEditingFormula(false);
              if (saved) void response.refresh();
            }}
          />
        </ModalPortal>
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

/**
 * How the spouts spent the period, beside the curve, as the ceramic board shows the machine:
 * the gauge (by default or by the plant's own formula, set on the pencil) and the share of each
 * state of the time elapsed.
 */
function MortarAvailability({
  board,
  label: caption,
  onEdit,
}: {
  board: MortarBoard;
  label?: string;
  /** Opens the choice of formula; absent on a compared day and for those who cannot change it. */
  onEdit?: () => void;
}) {
  const elapsed = board.time.elapsedProductive;
  return (
    <div className="shift-availability">
      <div className="shift-section-title">
        <span>
          Disponibilidade dos bicos
          {caption && <small> · {caption}</small>}
        </span>
        {onEdit && (
          <button
            type="button"
            className="kpi-edit"
            title="Escolher como a disponibilidade é calculada"
            aria-label="Escolher como a disponibilidade é calculada"
            onClick={onEdit}
          >
            ✎
          </button>
        )}
      </div>
      <Gauge value={board.utilization} />
      <small className="shift-gauge-caption">
        {mortarUtilizationCaption(board.utilizationFormula)}
      </small>
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

/** The availability formula, in the ceramic utilization modal's words and layout. */
function MortarUtilizationModal({
  deviceId,
  formula,
  time,
  onClose,
}: {
  deviceId: string;
  formula: string | null;
  time: MortarBoard['time'];
  onClose: (saved: boolean) => void;
}) {
  const [custom, setCustom] = useState(Boolean(formula));
  const [text, setText] = useState(formula ?? DEFAULT_MORTAR_UTILIZATION);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const values = mortarUtilizationValues(time);
  const options = Object.entries(MORTAR_UTILIZATION_VARIABLES).map(([name, description]) => ({
    name,
    description,
    value: (values[name] ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 }),
  }));
  const problem = custom ? mortarUtilizationError(text) : null;
  const preview = problem ? null : mortarUtilizationFrom(custom ? text : null, time);
  async function save() {
    setSaving(true);
    setError('');
    try {
      await mutate(`/devices/${deviceId}/mortar/utilization`, 'PATCH', {
        formula: custom ? text : null,
      });
      onClose(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => !saving && onClose(false)}>
      <div
        className="modal-card utilization-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-title">
          <div>
            <div className="eyebrow">DISPONIBILIDADE DOS BICOS</div>
            <h2>Como calcular</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={saving}
            onClick={() => onClose(false)}
          >
            ×
          </button>
        </div>
        <div className="utilization-options">
          <label className={`utilization-option ${custom ? '' : 'active'}`}>
            <input type="radio" checked={!custom} onChange={() => setCustom(false)} />
            <span>
              <b>Padrão</b>
              <small>
                Ensacando ÷ (ensacando + ociosa). Bico desabilitado na IHM não pesa contra a linha.
              </small>
            </span>
          </label>
          <label className={`utilization-option ${custom ? 'active' : ''}`}>
            <input type="radio" checked={custom} onChange={() => setCustom(true)} />
            <span>
              <b>Fórmula própria</b>
              <small>Uma conta sua sobre os tempos do período. O resultado é o próprio %.</small>
            </span>
          </label>
        </div>
        {custom && (
          <div className="utilization-builder">
            <FormulaInput
              value={text}
              options={options}
              placeholder={DEFAULT_MORTAR_UTILIZATION}
              onChange={setText}
            />
            <small>
              Digite o nome de um tempo e escolha na lista. Ex.: argamassa.horas_ensacando /
              (argamassa.horas_ensacando + argamassa.horas_paradas) * 100
            </small>
          </div>
        )}
        <div className="utilization-preview">
          <span>
            {problem ?? (custom ? 'resultado da sua fórmula' : 'ensacando ÷ (ensacando + ociosa)')}
          </span>
          <b>
            {preview == null
              ? '—'
              : `${(preview * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`}
          </b>
          <small>no período aberto no quadro</small>
        </div>
        <div className="notice full-field">
          <b>Vale para este equipamento</b>
          Muda a disponibilidade e a eficiência no quadro, nos bicos e no comparativo.
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={() => onClose(false)}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving || Boolean(problem)}
            onClick={() => void save()}
          >
            {saving && <span className="button-spinner" />}
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
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
      <div className="mortar-compare-legend">
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
