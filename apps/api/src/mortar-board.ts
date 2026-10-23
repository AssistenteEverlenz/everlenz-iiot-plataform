import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import {
  addDays,
  env,
  expandShifts,
  plantDate,
  plantInstant,
  productiveSecondsIn,
  productiveWindows,
  type ShiftOccurrence,
  type TimeWindow,
} from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';
import { loadShifts } from './shift-production.js';
import { chartSpanOf, effectiveShifts, type EffectiveOccurrence } from './effective-shifts.js';
import { reconcile, type Campaign } from './mortar-reconcile.js';
import {
  mortarUtilizationError,
  mortarUtilizationFrom,
} from '../../web/components/mortarUtilization.js';

/**
 * The bagging board of a mortar plant (migrations 037 and 040), shaped like the ceramic
 * production board (apps/api/src/shift-production.ts) so the web reuses its curve, gauge and
 * timeline as they are: the shift or the day of the line -- or of one spout -- against its
 * target, the S-curve painted by what the spouts were doing, the projection, and the same
 * window of an earlier day to compare.
 *
 * States, in the ceramic board's words: producing (a spout filling), idle (enabled, no bag for
 * longer than the idle limit), disabled (switched off on the HMI) and offline (no message).
 */
const uuid = z.uuid();
const STEP_MS = 5 * 60 * 1000;

type Bucket = {
  bucket: Date;
  spout_id: string;
  recipe: string;
  bags: number;
  running_s: number;
  idle_s: number;
  off_s: number;
  /** Share of the bucket inside the shifts as worked: the time states count only that part. */
  weight?: number;
};
type Link = { recipe: string; name: string; nominal_kg: number; standard_rate: number | null };

const registeredOf = (item: ShiftOccurrence) =>
  'planned' in item ? (item as EffectiveOccurrence).planned : { start: item.start, end: item.end };
const isExtra = (item: ShiftOccurrence) => 'extra' in item && (item as EffectiveOccurrence).extra;

function occurrenceJson(item: ShiftOccurrence) {
  return {
    shiftId: item.shiftId,
    name: item.name,
    productionDate: item.productionDate,
    start: item.start.toISOString(),
    end: item.end.toISOString(),
    plannedSeconds: item.plannedSeconds,
    // The registered window, and whether the line worked past it (effective-shifts.ts).
    plannedStart: registeredOf(item).start.toISOString(),
    plannedEnd: registeredOf(item).end.toISOString(),
    extra: isExtra(item),
  };
}

/**
 * Which stretch of time the board reads: a shift of the day as the line worked it (stretched to
 * the production around it, effective-shifts.ts), or the whole calendar day -- every bag of it,
 * with the time states read over the day's shifts as worked.
 */
async function windowOf(
  db: Database,
  tenantId: string,
  siteId: string,
  deviceId: string,
  query: { mode: 'shift' | 'day'; date?: string; shift?: string },
  now: Date,
) {
  const today = plantDate(now);
  const date = query.date ?? today;
  const { shifts, isDefault } = await loadShifts(db, tenantId, siteId);
  const occurrences = await effectiveShifts(db, {
    tenantId,
    siteId,
    deviceId,
    occurrences: expandShifts(shifts, addDays(date, -1), addDays(date, 1)),
    dates: { from: addDays(date, -1), to: date < today ? date : today },
    now,
    source: 'mortar',
  });
  const ofDate = occurrences.filter((item) => item.productionDate === date);
  const running = occurrences.find((item) => item.start <= now && now < item.end) ?? null;
  let chosen: ShiftOccurrence[] = [];
  if (query.mode === 'day') chosen = ofDate;
  else {
    const named = query.shift ? ofDate.find((item) => item.shiftId === query.shift) : null;
    const current = running?.productionDate === date ? running : null;
    const last = [...ofDate].reverse().find((item) => item.end <= now) ?? null;
    const one = named ?? current ?? last ?? ofDate[0];
    chosen = one ? [one] : [];
  }
  const wholeDay = {
    start: plantInstant(date, '00:00'),
    end: plantInstant(addDays(date, 1), '00:00'),
  };
  const span: TimeWindow =
    query.mode === 'day' || !chosen.length
      ? wholeDay
      : { start: chosen[0].start, end: chosen[chosen.length - 1].end };
  // No shift and nothing made: no working time at all, not a whole day of idleness.
  const windows = chosen.flatMap((item) => productiveWindows(item));
  // What the chart draws: on the day view, the hours worked (chartSpanOf).
  const chart = query.mode === 'day' ? chartSpanOf(chosen, wholeDay) : span;
  return { date, today, isDefault, ofDate, chosen, span, windows, chart };
}

async function loadLinks(db: Database, tenantId: string) {
  const rows = await db.query<Link>(
    `SELECT l.recipe,p.name,p.nominal_kg::float nominal_kg,p.standard_rate::float standard_rate
     FROM mortar_recipe_links l JOIN mortar_products p ON p.id=l.product_id WHERE l.tenant_id=$1`,
    [tenantId],
  );
  return new Map(rows.rows.map((row) => [row.recipe, row]));
}

async function loadBuckets(
  db: Database,
  tenantId: string,
  deviceId: string,
  span: TimeWindow,
  spout: string | null,
  /** The shifts as worked: given, the time of each bucket counts only inside them. */
  windows?: TimeWindow[],
) {
  const rows = (
    await db.query<Bucket>(
      `SELECT bucket,spout_id,recipe,bags::float bags,running_s::float running_s,idle_s::float idle_s,off_s::float off_s
       FROM bagging_buckets WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4
         AND ($5::uuid IS NULL OR spout_id=$5)
       ORDER BY bucket`,
      [tenantId, deviceId, span.start, span.end, spout],
    )
  ).rows;
  if (!windows) return rows;
  // Bags count wherever they were made; the time states only inside the shifts, so a spout left
  // enabled through the night is not a night of idleness.
  return rows.map((row) => {
    const start = new Date(row.bucket);
    const weight = productiveSecondsIn(windows, start, new Date(start.getTime() + 300_000)) / 300;
    return {
      ...row,
      running_s: Number(row.running_s) * weight,
      idle_s: Number(row.idle_s) * weight,
      off_s: Number(row.off_s) * weight,
      weight,
    };
  });
}

/** Availability, performance and their product for a set of buckets. */
function efficiencyOf(rows: Bucket[], product: Map<string, Link>) {
  const running = rows.reduce((total, row) => total + Number(row.running_s), 0);
  const idle = rows.reduce((total, row) => total + Number(row.idle_s), 0);
  let expected = 0;
  let rated = 0;
  for (const row of rows) {
    const rate = product.get(row.recipe)?.standard_rate;
    if (!rate) continue;
    expected += (Number(row.running_s) / 3600) * Number(rate);
    rated += Number(row.bags) * (row.weight ?? 1);
  }
  const availability = running + idle > 0 ? running / (running + idle) : null;
  const performance = expected > 0 ? rated / expected : null;
  return {
    availability,
    performance,
    effectiveness: availability != null && performance != null ? availability * performance : null,
  };
}

const baseQuery = z.object({
  mode: z.enum(['shift', 'day']).default('shift'),
  shift: z.string().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  spout: uuid.optional(),
});

export function registerMortarBoardRoutes(
  app: FastifyInstance,
  db: Database,
  access: ReturnType<typeof createAccessControl>,
) {
  async function context(tenantId: string, deviceId: string) {
    const device = (
      await db.query<{ site_id: string }>(
        'SELECT site_id FROM devices WHERE tenant_id=$1 AND id=$2',
        [tenantId, deviceId],
      )
    ).rows[0];
    const settings = (
      await db.query<{
        target_metric: 'bags' | 'tons' | null;
        target_per_shift: number | null;
        idle_seconds: number | null;
        utilization_formula: string | null;
      }>(
        `SELECT target_metric,target_per_shift,idle_seconds,to_jsonb(m)->>'utilization_formula' utilization_formula
         FROM mortar_settings m WHERE tenant_id=$1 AND device_id=$2`,
        [tenantId, deviceId],
      )
    ).rows[0];
    return { device, settings };
  }

  app.get('/api/devices/:id/mortar/board', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = baseQuery
      .extend({
        compare: z.enum(['none', 'yesterday', 'week', 'day', 'median']).default('none'),
        against: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        days: z.coerce.number().int().min(2).max(400).default(7),
      })
      .parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const { device, settings } = await context(tenantId, id);
    if (!device) return reply.code(404).send({ error: 'Device not found' });
    const metric = settings?.target_metric ?? 'bags';
    const perShift = settings?.target_per_shift == null ? null : Number(settings.target_per_shift);
    const now = new Date();
    const { date, today, isDefault, ofDate, chosen, span, windows, chart } = await windowOf(
      db,
      tenantId,
      device.site_id,
      id,
      query,
      now,
    );
    const planned = productiveSecondsIn(windows, span.start, span.end);
    const until = new Date(Math.min(now.getTime(), span.end.getTime()));
    const elapsedProductive = productiveSecondsIn(windows, span.start, until);
    const status = now < span.start ? 'upcoming' : now >= span.end ? 'finished' : 'running';
    const spoutFilter = query.spout ?? null;

    const [spouts, product, buckets, stops, runtime] = await Promise.all([
      db.query<{ id: string; name: string; position: number }>(
        'SELECT id,name,position FROM bagging_spouts WHERE tenant_id=$1 AND device_id=$2 ORDER BY position',
        [tenantId, id],
      ),
      loadLinks(db, tenantId),
      loadBuckets(db, tenantId, id, span, spoutFilter, windows),
      db.query<{
        spout_id: string;
        state: string;
        started_at: Date;
        ended_at: Date;
        seconds: number;
        recipe: string | null;
      }>(
        `SELECT spout_id,state,started_at,ended_at,seconds::float seconds,recipe FROM bagging_stops
         WHERE tenant_id=$1 AND device_id=$2 AND started_at<$4 AND ended_at>$3
           AND ($5::uuid IS NULL OR spout_id=$5)
         ORDER BY started_at`,
        [tenantId, id, span.start, span.end, spoutFilter],
      ),
      db.query<{
        spout_id: string;
        last_at: Date;
        last_increment_at: Date | null;
        enabled: boolean | null;
        recipe: string | null;
        stop_started_at: Date | null;
        stop_state: string | null;
      }>(
        `SELECT spout_id,last_at,last_increment_at,enabled,recipe,stop_started_at,stop_state
         FROM bagging_runtime WHERE tenant_id=$1 AND device_id=$2`,
        [tenantId, id],
      ),
    ]);
    const kgOf = (recipe: string, bags: number) => {
      const link = product.get(recipe);
      return link ? bags * Number(link.nominal_kg) : 0;
    };
    const inMetric = (bags: number, kg: number) => (metric === 'tons' ? kg / 1000 : bags);

    // What a spout is doing now, read the way the ceramic board reads a machine.
    const idleMs = (settings?.idle_seconds ?? 120) * 1000;
    const nowState = (row: (typeof runtime.rows)[number] | undefined) => {
      if (!row) return 'unknown';
      if (now.getTime() - new Date(row.last_at).getTime() > env.DEVICE_OFFLINE_SECONDS * 1000)
        return 'offline';
      if (row.enabled === false) return 'disabled';
      const bag = row.last_increment_at ? new Date(row.last_increment_at).getTime() : 0;
      return now.getTime() - bag <= idleMs ? 'producing' : 'idle';
    };
    const liveRows = runtime.rows.filter((row) => !spoutFilter || row.spout_id === spoutFilter);
    // The line produces while any spout does; it is idle while an enabled one waits.
    const lineState = liveRows.some((row) => nowState(row) === 'producing')
      ? 'producing'
      : liveRows.some((row) => nowState(row) === 'idle')
        ? 'idle'
        : liveRows.some((row) => nowState(row) === 'disabled')
          ? 'disabled'
          : liveRows.length
            ? 'offline'
            : 'unknown';

    // Five-minute slots, each with its bags and how the spouts spent it.
    const slots = new Map<
      number,
      {
        bags: number;
        kg: number;
        running: number;
        idle: number;
        off: number;
        spouts: Record<string, number>;
      }
    >();
    for (const row of buckets) {
      const at = new Date(row.bucket).getTime();
      const slot = slots.get(at) ?? { bags: 0, kg: 0, running: 0, idle: 0, off: 0, spouts: {} };
      slot.bags += Number(row.bags);
      slot.kg += kgOf(row.recipe, Number(row.bags));
      slot.running += Number(row.running_s);
      slot.idle += Number(row.idle_s);
      slot.off += Number(row.off_s);
      slot.spouts[row.spout_id] = (slot.spouts[row.spout_id] ?? 0) + Number(row.bags);
      slots.set(at, slot);
    }

    const bags = buckets.reduce((total, row) => total + Number(row.bags), 0);
    const kg = buckets.reduce((total, row) => total + kgOf(row.recipe, Number(row.bags)), 0);
    const actual = inMetric(bags, kg);
    const runningS = buckets.reduce((total, row) => total + Number(row.running_s), 0);
    const idleS = buckets.reduce((total, row) => total + Number(row.idle_s), 0);
    const offS = buckets.reduce((total, row) => total + Number(row.off_s), 0);
    // The line's time is counted once, not once per spout: each state's share of the spouts'
    // time, applied to the productive time elapsed. What no spout reported is silence.
    const spoutCount = spoutFilter ? 1 : Math.max(1, spouts.rows.length);
    const reported = (runningS + idleS + offS) / spoutCount;
    const scale = reported > elapsedProductive && reported > 0 ? elapsedProductive / reported : 1;
    const time = {
      producing: (runningS / spoutCount) * scale,
      idle: (idleS / spoutCount) * scale,
      disabled: (offS / spoutCount) * scale,
      offline: Math.max(0, elapsedProductive - reported * scale),
      elapsedProductive,
    };
    const formula = settings?.utilization_formula?.trim() || null;
    const availabilityOf = (times: {
      producing: number;
      idle: number;
      disabled: number;
      offline?: number;
    }) =>
      formula
        ? mortarUtilizationFrom(formula, { ...times, elapsedProductive })
        : times.producing + times.idle > 0
          ? times.producing / (times.producing + times.idle)
          : null;
    const base = efficiencyOf(buckets, product);
    const lineAvailability = availabilityOf(time);
    const efficiency = {
      availability: lineAvailability,
      performance: base.performance,
      effectiveness:
        lineAvailability != null && base.performance != null
          ? lineAvailability * base.performance
          : null,
    };

    // The target belongs to the registered shifts: an extra shift has none.
    const registeredCount = chosen.filter((item) => !isExtra(item)).length;
    const target =
      perShift == null || spoutFilter || !registeredCount ? null : perShift * registeredCount;
    const pace = elapsedProductive > 0 ? actual / elapsedProductive : 0;
    const remaining = Math.max(0, planned - elapsedProductive);
    const projected = status === 'upcoming' ? 0 : actual + pace * remaining;
    const plannedToNow = target != null && planned ? (target * elapsedProductive) / planned : 0;
    const requiredPerHour =
      target != null && remaining > 0 ? Math.max(0, target - actual) / (remaining / 3600) : null;
    const health =
      target == null
        ? null
        : status === 'finished'
          ? actual >= target
            ? 'achieved'
            : 'missed'
          : actual >= target
            ? 'achieved'
            : projected >= target
              ? 'on_track'
              : projected >= target * 0.9
                ? 'at_risk'
                : 'off_track';

    // The curve and the timeline, one point every five minutes.
    let doneBags = 0;
    let doneKg = 0;
    const perSpoutDone: Record<string, number> = {};
    const curve: Array<{
      t: string;
      planned: number | null;
      actual: number | null;
      projected: number | null;
    }> = [];
    const timeline: Array<{ t: string; state: string; mix: Record<string, number> }> = [];
    const spoutCurves: Record<string, Array<number | null>> = {};
    for (const spout of spouts.rows) spoutCurves[spout.id] = [];
    // The points sit on the five-minute slots: a shift that started with the line (06:26, as
    // worked) begins at its slot, or no slot is ever found and the curve stays at zero.
    const firstAt = Math.floor(chart.start.getTime() / STEP_MS) * STEP_MS;
    // Bags made before the chart's first point are carried in: the curve ends at the total.
    for (const [at, slot] of slots)
      if (at < firstAt - STEP_MS) {
        doneBags += slot.bags;
        doneKg += slot.kg;
        for (const [spoutId, value] of Object.entries(slot.spouts))
          perSpoutDone[spoutId] = (perSpoutDone[spoutId] ?? 0) + value;
      }
    for (let at = firstAt; at <= chart.end.getTime(); at += STEP_MS) {
      const instant = new Date(at);
      const past = at <= now.getTime();
      const slot = slots.get(at - STEP_MS);
      if (slot) {
        doneBags += slot.bags;
        doneKg += slot.kg;
        for (const [spoutId, value] of Object.entries(slot.spouts))
          perSpoutDone[spoutId] = (perSpoutDone[spoutId] ?? 0) + value;
      }
      for (const spout of spouts.rows)
        spoutCurves[spout.id].push(past ? (perSpoutDone[spout.id] ?? 0) : null);
      curve.push({
        t: instant.toISOString(),
        planned:
          target == null || !planned
            ? null
            : (target * productiveSecondsIn(windows, span.start, instant)) / planned,
        actual: past ? inMetric(doneBags, doneKg) : null,
        projected:
          status === 'running' && at >= until.getTime() - STEP_MS
            ? actual + pace * productiveSecondsIn(windows, until, instant)
            : null,
      });
      if (at < chart.end.getTime()) {
        const next = slots.get(at);
        const total = next ? next.running + next.idle + next.off : 0;
        const inPause = productiveSecondsIn(windows, instant, new Date(at + STEP_MS)) === 0;
        timeline.push({
          t: instant.toISOString(),
          state:
            at >= now.getTime()
              ? 'outside'
              : inPause && !total
                ? 'pause'
                : !next || total === 0
                  ? 'offline'
                  : next.running >= next.idle && next.running >= next.off
                    ? 'producing'
                    : next.idle >= next.off
                      ? 'idle'
                      : 'disabled',
          mix: next ? { producing: next.running, idle: next.idle, disabled: next.off } : {},
        });
      }
    }

    // Another day drawn behind this one, by position in the window, as the ceramic board does:
    // one earlier day (yesterday, a week ago, a day chosen on the calendar), or the median of
    // the last N days, where only the days that reached a point count at that point.
    const cumulativeOf = (rows: Bucket[], offset: number) => {
      const bySlot = new Map<number, { bags: number; kg: number }>();
      for (const row of rows) {
        const at = new Date(row.bucket).getTime() + offset;
        const entry = bySlot.get(at) ?? { bags: 0, kg: 0 };
        entry.bags += Number(row.bags);
        entry.kg += kgOf(row.recipe, Number(row.bags));
        bySlot.set(at, entry);
      }
      let b = 0;
      let k = 0;
      return curve.map((point) => {
        const slot = bySlot.get(new Date(point.t).getTime() - STEP_MS);
        if (slot) {
          b += slot.bags;
          k += slot.kg;
        }
        return inMetric(b, k);
      });
    };
    const shifted = (days: number) => ({
      start: new Date(chart.start.getTime() - days * 86_400_000),
      end: new Date(chart.end.getTime() - days * 86_400_000),
    });
    let compare: { label: string; actual: Array<number | null> } | null = null;
    if (query.compare === 'median') {
      const curves: Array<Array<number | null>> = [];
      const all = await loadBuckets(
        db,
        tenantId,
        id,
        { start: shifted(query.days).start, end: shifted(1).end },
        spoutFilter,
      );
      for (let back = 1; back <= query.days; back += 1) {
        const window = shifted(back);
        const rows = all.filter((row) => {
          const at = new Date(row.bucket).getTime();
          return at >= window.start.getTime() && at < window.end.getTime();
        });
        if (rows.some((row) => Number(row.bags) > 0))
          curves.push(cumulativeOf(rows, back * 86_400_000));
      }
      if (curves.length)
        compare = {
          label: `mediana de ${curves.length} dias`,
          actual: curve.map((_, at) => {
            const values = curves
              .map((day) => day[at])
              .filter((value): value is number => typeof value === 'number')
              .sort((a, b) => a - b);
            if (!values.length) return null;
            const middle = Math.floor(values.length / 2);
            return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
          }),
        };
    } else if (query.compare !== 'none') {
      const back =
        query.compare === 'week'
          ? 7
          : query.compare === 'day' && query.against
            ? Math.round(
                (plantInstant(date, '00:00').getTime() -
                  plantInstant(query.against, '00:00').getTime()) /
                  86_400_000,
              )
            : 1;
      if (back !== 0) {
        const rows = await loadBuckets(db, tenantId, id, shifted(back), spoutFilter);
        if (rows.length)
          compare = {
            label:
              query.compare === 'week'
                ? 'semana passada'
                : query.compare === 'day' && query.against
                  ? query.against.split('-').reverse().slice(0, 2).join('/')
                  : 'ontem',
            actual: cumulativeOf(rows, back * 86_400_000),
          };
      }
    }

    // Stops of the window, and the ones going on now: each counted only for its part inside the
    // shifts as worked, so a spout left enabled overnight is not a night of stops.
    const insideShifts = (start: Date, end: Date) => productiveSecondsIn(windows, start, end);
    const stopList = stops.rows
      .filter((row) => insideShifts(new Date(row.started_at), new Date(row.ended_at)) > 0)
      .map((row) => ({
        spoutId: row.spout_id,
        state: row.state,
        startedAt: new Date(row.started_at).toISOString(),
        endedAt: new Date(row.ended_at).toISOString(),
        seconds: insideShifts(new Date(row.started_at), new Date(row.ended_at)),
        product: row.recipe ? (product.get(row.recipe)?.name ?? null) : null,
        open: false,
      }));
    if (status === 'running')
      for (const row of liveRows)
        if (row.stop_started_at && row.stop_state && nowState(row) !== 'offline')
          stopList.push({
            spoutId: row.spout_id,
            state: row.stop_state,
            startedAt: new Date(row.stop_started_at).toISOString(),
            endedAt: now.toISOString(),
            seconds: insideShifts(new Date(row.stop_started_at), now),
            product: row.recipe ? (product.get(row.recipe)?.name ?? null) : null,
            open: true,
          });
    const idleStops = stopList.filter((stop) => stop.state === 'idle');

    // Each spout on its own, for the comparison between them.
    const perSpout = spouts.rows.map((spout) => {
      const rows = buckets.filter((row) => row.spout_id === spout.id);
      const spoutBags = rows.reduce((total, row) => total + Number(row.bags), 0);
      const spoutKg = rows.reduce((total, row) => total + kgOf(row.recipe, Number(row.bags)), 0);
      const running = rows.reduce((total, row) => total + Number(row.running_s), 0);
      const live = runtime.rows.find((row) => row.spout_id === spout.id);
      const own = idleStops.filter((stop) => stop.spoutId === spout.id);
      return {
        id: spout.id,
        name: spout.name,
        bags: spoutBags,
        kg: spoutKg,
        actual: inMetric(spoutBags, spoutKg),
        runningS: running,
        idleS: rows.reduce((total, row) => total + Number(row.idle_s), 0),
        offS: rows.reduce((total, row) => total + Number(row.off_s), 0),
        pacePerHour: running > 0 ? spoutBags / (running / 3600) : null,
        secondsPerBag: spoutBags > 0 ? running / spoutBags : null,
        ...(() => {
          const own = efficiencyOf(rows, product);
          const availability = availabilityOf({
            producing: running,
            idle: rows.reduce((total, row) => total + Number(row.idle_s), 0),
            disabled: rows.reduce((total, row) => total + Number(row.off_s), 0),
          });
          return {
            availability,
            performance: own.performance,
            effectiveness:
              availability != null && own.performance != null
                ? availability * own.performance
                : null,
          };
        })(),
        stops: own.length,
        stopSeconds: own.reduce((total, stop) => total + stop.seconds, 0),
        longestStop: own.reduce((most, stop) => Math.max(most, stop.seconds), 0),
        state: nowState(live),
        recipe: live?.recipe ?? null,
        product: live?.recipe ? (product.get(live.recipe)?.name ?? live.recipe) : null,
        lastBagAt: live?.last_increment_at ? new Date(live.last_increment_at).toISOString() : null,
        // What the spout filled in the window, recipe by recipe: the spout cards read these.
        products: [...new Set(rows.map((row) => row.recipe))]
          .map((recipe) => {
            const own = rows.filter((row) => row.recipe === recipe);
            const bags = own.reduce((total, row) => total + Number(row.bags), 0);
            const runningS = own.reduce((total, row) => total + Number(row.running_s), 0);
            return {
              recipe,
              product: product.get(recipe)?.name ?? null,
              bags,
              kg: product.get(recipe) ? kgOf(recipe, bags) : null,
              runningS,
              secondsPerBag: bags > 0 ? runningS / bags : null,
            };
          })
          .filter((item) => item.bags > 0)
          .sort((a, b) => b.bags - a.bags),
      };
    });

    return {
      configured: spouts.rows.length > 0,
      mode: query.mode,
      date,
      today,
      status,
      defaultShifts: isDefault,
      now: now.toISOString(),
      state: lineState,
      product: spoutFilter
        ? (perSpout.find((item) => item.id === spoutFilter)?.product ?? null)
        : null,
      shifts: chosen.map(occurrenceJson),
      available: ofDate.map(occurrenceJson),
      board: {
        span: { start: chart.start.toISOString(), end: chart.end.toISOString() },
        plannedSeconds: planned,
        remainingSeconds: remaining,
        metric,
        totals: { bags, kg, actual },
        time,
        utilization: efficiency.availability,
        utilizationFormula: formula,
        performance: efficiency.performance,
        effectiveness: efficiency.effectiveness,
        target:
          target == null
            ? null
            : {
                value: target,
                perShift,
                actual,
                plannedToNow,
                projected,
                ratePerHour: pace * 3600,
                requiredPerHour,
                health,
              },
        pacePerHour: pace * 3600,
        curve,
        timeline,
        stops: {
          count: idleStops.length,
          seconds: idleStops.reduce((total, stop) => total + stop.seconds, 0),
          longest: idleStops.reduce((most, stop) => Math.max(most, stop.seconds), 0),
          list: stopList.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        },
      },
      compare,
      spouts: perSpout,
      spoutCurves: spoutFilter ? null : spoutCurves,
    };
  });

  /**
   * What is behind each number of the board, period by period (5 minutes to 1 hour), like the
   * ceramic shift detail: bags, time in each state and the time per bag of every spout.
   */
  app.get('/api/devices/:id/mortar/detail', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = baseQuery
      .extend({
        step: z.coerce
          .number()
          .int()
          .refine((value) => [5, 10, 15, 30, 60].includes(value))
          .default(60),
      })
      .parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const { device, settings } = await context(tenantId, id);
    if (!device) return reply.code(404).send({ error: 'Device not found' });
    const metric = settings?.target_metric ?? 'bags';
    const now = new Date();
    const { chosen, span, windows } = await windowOf(db, tenantId, device.site_id, id, query, now);
    const [spouts, product, buckets] = await Promise.all([
      db.query<{ id: string; name: string }>(
        'SELECT id,name FROM bagging_spouts WHERE tenant_id=$1 AND device_id=$2 ORDER BY position',
        [tenantId, id],
      ),
      loadLinks(db, tenantId),
      loadBuckets(db, tenantId, id, span, query.spout ?? null, windows),
    ]);
    const stepMs = query.step * 60_000;
    type Period = {
      bags: number;
      kg: number;
      running: number;
      idle: number;
      off: number;
      spouts: Record<string, { bags: number; running: number; idle: number; off: number }>;
    };
    const periods = new Map<number, Period>();
    const until = Math.min(now.getTime(), span.end.getTime());
    for (let at = span.start.getTime(); at < until; at += stepMs)
      periods.set(at, { bags: 0, kg: 0, running: 0, idle: 0, off: 0, spouts: {} });
    for (const row of buckets) {
      const offset = new Date(row.bucket).getTime() - span.start.getTime();
      const at = span.start.getTime() + Math.floor(offset / stepMs) * stepMs;
      const period = periods.get(at);
      if (!period) continue;
      const bags = Number(row.bags);
      period.bags += bags;
      period.kg += (product.get(row.recipe)?.nominal_kg ?? 0) * bags;
      period.running += Number(row.running_s);
      period.idle += Number(row.idle_s);
      period.off += Number(row.off_s);
      const own = period.spouts[row.spout_id] ?? { bags: 0, running: 0, idle: 0, off: 0 };
      own.bags += bags;
      own.running += Number(row.running_s);
      own.idle += Number(row.idle_s);
      own.off += Number(row.off_s);
      period.spouts[row.spout_id] = own;
    }
    return {
      span: chosen.length
        ? {
            start: span.start.toISOString(),
            end: span.end.toISOString(),
            until: new Date(until).toISOString(),
          }
        : null,
      shiftName: query.mode === 'day' ? 'Dia' : (chosen[0]?.name ?? 'Turno'),
      metric,
      step: query.step,
      spouts: spouts.rows,
      periods: [...periods.entries()].map(([at, period]) => ({
        t: new Date(at).toISOString(),
        ...period,
      })),
    };
  });

  // How the availability is counted: the default, or the plant's own formula.
  app.patch('/api/devices/:id/mortar/utilization', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const body = z.object({ formula: z.string().max(500).nullable() }).parse(req.body);
    const formula = body.formula?.trim() || null;
    const problem = formula ? mortarUtilizationError(formula) : null;
    if (problem) return reply.code(400).send({ error: problem });
    const current = access.principal(req);
    await db.query(
      `INSERT INTO mortar_settings(device_id,tenant_id,utilization_formula,updated_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(device_id) DO UPDATE SET utilization_formula=EXCLUDED.utilization_formula,
         updated_at=now()`,
      [id, current.tenantId, formula],
    );
    await recordAudit(db, req, current, {
      action: 'mortar.utilization',
      targetType: 'device',
      targetId: id,
      summary: { formula },
    });
    return { ok: true };
  });

  /** The plant days with bags, for the calendar of the board. */
  app.get('/api/devices/:id/mortar/days', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const rows = await db.query<{ day: string }>(
      `SELECT DISTINCT to_char(bucket - interval '3 hours','YYYY-MM-DD') AS day FROM bagging_buckets
       WHERE tenant_id=$1 AND device_id=$2 AND bags>0 AND bucket > now() - interval '400 days'
       ORDER BY 1 DESC`,
      [access.principal(req).tenantId, id],
    );
    return { days: rows.rows.map((row) => row.day) };
  });

  // The target, per shift, in bags or tons (masters only).
  app.patch('/api/devices/:id/mortar/target', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const body = z
      .object({
        metric: z.enum(['bags', 'tons']),
        perShift: z.number().positive().max(1_000_000).nullable(),
      })
      .parse(req.body);
    await db.query(
      `INSERT INTO mortar_settings(device_id,tenant_id,target_metric,target_per_shift,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(device_id) DO UPDATE SET target_metric=EXCLUDED.target_metric,
         target_per_shift=EXCLUDED.target_per_shift,updated_at=now()`,
      [id, current.tenantId, body.metric, body.perShift],
    );
    await recordAudit(db, req, current, {
      action: 'mortar.target',
      targetType: 'device',
      targetId: id,
      summary: body,
    });
    return { ok: true };
  });

  /**
   * Every batch and bag of a period followed through the silo (mortar-reconcile.ts): three days
   * before it, so the silo carried in is known, and up to now, so what left after it is too.
   */
  async function loadReconcile(tenantId: string, deviceId: string, from: string, to: string) {
    const start = plantInstant(from, '00:00');
    const end = plantInstant(addDays(to, 1), '00:00');
    const lookback = plantInstant(addDays(from, -3), '00:00');
    const now = new Date();
    const [batches, bagged, product] = await Promise.all([
      db.query<{
        lot_number: string;
        finished_at: Date;
        recipe: string;
        batches: number;
        total_kg: number;
        kg: number;
      }>(
        `SELECT lot_number,finished_at,recipe,batches,total_kg::float total_kg,
                coalesce(scale_kg,total_kg)::float kg
         FROM mix_batches WHERE tenant_id=$1 AND device_id=$2 AND lot_number IS NOT NULL
           AND finished_at>=$3 AND finished_at<$4
         ORDER BY finished_at`,
        [tenantId, deviceId, lookback, now],
      ),
      db.query<{ bucket: Date; recipe: string; bags: number }>(
        `SELECT bucket,recipe,sum(bags)::float bags FROM bagging_buckets
         WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4 AND bags>0
         GROUP BY bucket,recipe ORDER BY bucket`,
        [tenantId, deviceId, lookback, now],
      ),
      loadLinks(db, tenantId),
    ]);
    const result = reconcile({
      batches: batches.rows.map((row) => {
        const link = product.get(row.recipe);
        return {
          lot: row.lot_number,
          at: new Date(row.finished_at).getTime(),
          recipe: row.recipe,
          product: link?.name ?? null,
          nominalKg: link ? Number(link.nominal_kg) : null,
          kg: Number(row.kg),
          recipeKg: Number(row.total_kg),
          batches: Number(row.batches),
        };
      }),
      bags: bagged.rows.map((row) => {
        const link = product.get(row.recipe);
        return {
          at: new Date(row.bucket).getTime(),
          recipe: row.recipe,
          product: link?.name ?? null,
          nominalKg: link ? Number(link.nominal_kg) : null,
          bags: Number(row.bags),
        };
      }),
      period: { start: start.getTime(), end: end.getTime() },
    });
    return { result, start, end, now, recipeOf: new Map(batches.rows.map((row) => [row.lot_number, row.recipe])), product, batches: batches.rows };
  }
  const iso = (at: number | null) => (at == null ? null : new Date(at).toISOString());
  const campaignJson = (item: Campaign) => ({
    id: item.id,
    mix: item.mix,
    products: item.products,
    nominalKg: item.nominalKg,
    lots: item.lots,
    batches: item.batches,
    mixedKg: item.mixedKg,
    recipeKg: item.recipeKg,
    bags: item.bags,
    baggedKg: item.baggedKg,
    startedAt: iso(item.startedAt),
    lastBatchAt: iso(item.lastBatchAt),
    firstBagAt: iso(item.firstBagAt),
    lastBagAt: iso(item.lastBagAt),
    offline: item.offline,
    open: item.open,
    causes: item.causes,
  });
  const periodQuery = z.object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  });

  /**
   * Why mixed and bagged differ in a period: the bridge from one to the other, each step with
   * the campaigns that make it, and the recipes that reached the spouts without a product.
   */
  app.get('/api/devices/:id/mortar/reconcile', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = periodQuery.parse(req.query);
    const to = query.to ?? plantDate(new Date());
    const from = query.from && query.from <= to ? query.from : to;
    const { result, start, end } = await loadReconcile(access.principal(req).tenantId, id, from, to);
    const touched = new Set(result.bridge.flatMap((item) => item.sources.map((source) => source.campaign)));
    return {
      from,
      to,
      mixedKg: result.mixedKg,
      baggedKg: result.baggedKg,
      bridge: result.bridge.map((item) => ({
        ...item,
        sources: item.sources.map((source) => ({ ...source, at: iso(source.at) })),
      })),
      campaigns: result.campaigns
        .filter(
          (item) =>
            touched.has(item.id) ||
            (item.startedAt < end.getTime() && (item.lastBagAt ?? item.lastBatchAt) >= start.getTime()),
        )
        .map(campaignJson),
      unlinked: result.unlinked
        .filter((item) => item.bagsInPeriod > 0)
        .map((item) => ({ ...item, first: iso(item.first), last: iso(item.last) })),
    };
  });

  /**
   * Production lots: each lot is a run of batches of one recipe (the HMI's lot number), and its
   * bags are the ones that went through the silo from it (mortar-lots.ts); each carries the
   * campaign it belongs to and why that campaign's mixed and bagged differ (mortar-reconcile.ts).
   */
  app.get('/api/devices/:id/mortar/lots', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = periodQuery.parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const to = query.to ?? plantDate(new Date());
    const from = query.from && query.from <= to ? query.from : to;
    const { result, start, end, now, recipeOf, product, batches } = await loadReconcile(tenantId, id, from, to);
    const campaigns = new Map(result.campaigns.map((item) => [item.id, item]));
    const lots = new Map<string, { batches: number; kg: number; recipeKg: number; startedAt: number; lastAt: number }>();
    for (const row of batches) {
      const at = new Date(row.finished_at).getTime();
      const lot = lots.get(row.lot_number) ?? { batches: 0, kg: 0, recipeKg: 0, startedAt: at, lastAt: at };
      lot.batches += Number(row.batches);
      lot.kg += Number(row.kg);
      lot.recipeKg += Number(row.total_kg);
      lot.lastAt = at;
      lots.set(row.lot_number, lot);
    }
    const list = [...lots.entries()]
      .filter(([, lot]) => lot.startedAt >= start.getTime() && lot.startedAt < end.getTime())
      .map(([number, lot]) => {
        const recipe = recipeOf.get(number) ?? '';
        const link = product.get(recipe);
        const share = result.allocated.get(number);
        const owner = campaigns.get(result.lotCampaign.get(number) ?? '');
        return {
          lot: number,
          recipe,
          product: link?.name ?? null,
          batches: lot.batches,
          mixedKg: lot.kg,
          recipeKg: lot.recipeKg,
          startedAt: iso(lot.startedAt)!,
          lastBatchAt: iso(lot.lastAt)!,
          baggedFrom: iso(share?.firstBagAt ?? null),
          baggedUntil: iso(Math.min(share?.lastBagAt ?? now.getTime(), now.getTime()))!,
          bags: share?.bags ?? 0,
          expectedBags: share?.expectedBags ?? null,
          baggedKg: share?.kg ?? 0,
          products: link && share && share.bags > 0 ? [{ name: link.name, bags: share.bags, kg: share.kg }] : [],
          campaign: owner ? campaignJson(owner) : null,
        };
      })
      .sort((x, y) => y.startedAt.localeCompare(x.startedAt));
    return { from, to, lots: list };
  });

  /**
   * The day mixed against the day bagged, product by product: the batches and their mass, the
   * bags and theirs (bags x the product's bag weight). A day rarely closes to zero: the buffer
   * silo carries mass across midnight, so a product mixed late is bagged the next morning.
   */
  app.get('/api/devices/:id/mortar/day-balance', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const { date } = z.object({ date: z.iso.date() }).parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const start = plantInstant(date, '00:00');
    const end = plantInstant(addDays(date, 1), '00:00');
    const [mixed, bagged, product] = await Promise.all([
      db.query<{ recipe: string; batches: number; kg: number }>(
        `SELECT recipe,sum(batches)::int batches,sum(coalesce(scale_kg,total_kg))::float kg
         FROM mix_batches WHERE tenant_id=$1 AND device_id=$2 AND finished_at>=$3 AND finished_at<$4
         GROUP BY recipe`,
        [tenantId, id, start, end],
      ),
      db.query<{ recipe: string; bags: number }>(
        `SELECT recipe,sum(bags)::float bags FROM bagging_buckets
         WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4 AND bags>0
         GROUP BY recipe`,
        [tenantId, id, start, end],
      ),
      loadLinks(db, tenantId),
    ]);
    const rows = new Map<
      string,
      { product: string; linked: boolean; batches: number; mixedKg: number; bags: number; baggedKg: number | null }
    >();
    const rowOf = (recipe: string) => {
      const link = product.get(recipe);
      const key = link?.name ?? recipe;
      const row = rows.get(key) ?? {
        product: key,
        linked: Boolean(link),
        batches: 0,
        mixedKg: 0,
        bags: 0,
        baggedKg: link ? 0 : null,
      };
      rows.set(key, row);
      return { row, link };
    };
    for (const item of mixed.rows) {
      const { row } = rowOf(item.recipe);
      row.batches += Number(item.batches);
      row.mixedKg += Number(item.kg);
    }
    for (const item of bagged.rows) {
      const { row, link } = rowOf(item.recipe);
      row.bags += Number(item.bags);
      if (link && row.baggedKg != null) row.baggedKg += Number(item.bags) * Number(link.nominal_kg);
    }
    const list = [...rows.values()].sort((a, b) => b.mixedKg + (b.baggedKg ?? 0) - (a.mixedKg + (a.baggedKg ?? 0)));
    return {
      date,
      products: list,
      totals: {
        batches: list.reduce((total, row) => total + row.batches, 0),
        mixedKg: list.reduce((total, row) => total + row.mixedKg, 0),
        bags: list.reduce((total, row) => total + row.bags, 0),
        baggedKg: list.reduce((total, row) => total + (row.baggedKg ?? 0), 0),
        unlinkedBags: list.filter((row) => !row.linked).reduce((total, row) => total + row.bags, 0),
      },
    };
  });

  // What each raw material costs per ton (masters edit; everyone with the device reads).
  app.get('/api/mortar/prices', async (req) => {
    const rows = await db.query<{ label: string; price_per_ton: number }>(
      'SELECT label,price_per_ton::float price_per_ton FROM mortar_material_prices WHERE tenant_id=$1 ORDER BY label',
      [access.principal(req).tenantId],
    );
    return {
      prices: rows.rows.map((row) => ({ label: row.label, pricePerTon: row.price_per_ton })),
    };
  });
  app.put('/api/mortar/prices', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const body = z
      .object({
        prices: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(40),
              pricePerTon: z.number().min(0).max(1_000_000),
            }),
          )
          .max(20),
      })
      .parse(req.body);
    await db.transaction(async (sql) => {
      await sql.query('DELETE FROM mortar_material_prices WHERE tenant_id=$1', [current.tenantId]);
      for (const price of body.prices)
        await sql.query(
          'INSERT INTO mortar_material_prices(tenant_id,label,price_per_ton) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [current.tenantId, price.label, price.pricePerTon],
        );
      await recordAudit(sql, req, current, {
        action: 'mortar.prices',
        targetType: 'tenant',
        targetId: current.tenantId,
        summary: { prices: body.prices.length },
      });
    });
    return { ok: true };
  });
}
