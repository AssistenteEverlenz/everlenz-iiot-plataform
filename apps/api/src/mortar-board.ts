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
};
type Link = { recipe: string; name: string; nominal_kg: number; standard_rate: number | null };

function occurrenceJson(item: ShiftOccurrence) {
  return {
    shiftId: item.shiftId,
    name: item.name,
    productionDate: item.productionDate,
    start: item.start.toISOString(),
    end: item.end.toISOString(),
    plannedSeconds: item.plannedSeconds,
  };
}

/** Which stretch of time the board reads: a shift of the day, or the whole day. */
async function windowOf(
  db: Database,
  tenantId: string,
  siteId: string,
  query: { mode: 'shift' | 'day'; date?: string; shift?: string },
  now: Date,
) {
  const today = plantDate(now);
  const date = query.date ?? today;
  const { shifts, isDefault } = await loadShifts(db, tenantId, siteId);
  const occurrences = expandShifts(shifts, addDays(date, -1), addDays(date, 1));
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
  const span: TimeWindow = chosen.length
    ? { start: chosen[0].start, end: chosen[chosen.length - 1].end }
    : { start: plantInstant(date, '00:00'), end: plantInstant(addDays(date, 1), '00:00') };
  const windows = chosen.length
    ? chosen.flatMap((item) => productiveWindows(item))
    : [{ start: span.start, end: span.end }];
  return { date, today, isDefault, ofDate, chosen, span, windows };
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
) {
  return (
    await db.query<Bucket>(
      `SELECT bucket,spout_id,recipe,bags::float bags,running_s::float running_s,idle_s::float idle_s,off_s::float off_s
       FROM bagging_buckets WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4
         AND ($5::uuid IS NULL OR spout_id=$5)
       ORDER BY bucket`,
      [tenantId, deviceId, span.start, span.end, spout],
    )
  ).rows;
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
    rated += Number(row.bags);
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
    const { date, today, isDefault, ofDate, chosen, span, windows } = await windowOf(
      db,
      tenantId,
      device.site_id,
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
      loadBuckets(db, tenantId, id, span, spoutFilter),
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

    const target = perShift == null || spoutFilter ? null : perShift * Math.max(1, chosen.length);
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
    for (let at = span.start.getTime(); at <= span.end.getTime(); at += STEP_MS) {
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
      if (at < span.end.getTime()) {
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
      start: new Date(span.start.getTime() - days * 86_400_000),
      end: new Date(span.end.getTime() - days * 86_400_000),
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

    // Stops of the window, and the ones going on now.
    const stopList = stops.rows.map((row) => ({
      spoutId: row.spout_id,
      state: row.state,
      startedAt: new Date(row.started_at).toISOString(),
      endedAt: new Date(row.ended_at).toISOString(),
      seconds: Number(row.seconds),
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
            seconds: (now.getTime() - new Date(row.stop_started_at).getTime()) / 1000,
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
        state: nowState(live),
        product: live?.recipe ? (product.get(live.recipe)?.name ?? live.recipe) : null,
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
        span: { start: span.start.toISOString(), end: span.end.toISOString() },
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
    const { chosen, span } = await windowOf(db, tenantId, device.site_id, query, now);
    const [spouts, product, buckets] = await Promise.all([
      db.query<{ id: string; name: string }>(
        'SELECT id,name FROM bagging_spouts WHERE tenant_id=$1 AND device_id=$2 ORDER BY position',
        [tenantId, id],
      ),
      loadLinks(db, tenantId),
      loadBuckets(db, tenantId, id, span, query.spout ?? null),
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
   * Production lots: each lot is a run of batches of one recipe, and the bags filled from its
   * first batch until the next lot started belong to it.
   */
  app.get('/api/devices/:id/mortar/lots', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = z
      .object({
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const to = query.to ?? plantDate(new Date());
    const from = query.from && query.from <= to ? query.from : to;
    const start = plantInstant(from, '00:00');
    const end = plantInstant(addDays(to, 1), '00:00');
    const lots = await db.query<{
      lot_number: string;
      recipe: string;
      batches: number;
      kg: number;
      scale_kg: number | null;
      started_at: Date;
      last_at: Date;
    }>(
      `SELECT lot_number,min(recipe) recipe,sum(batches)::int batches,sum(total_kg)::float kg,
              sum(scale_kg)::float scale_kg,min(finished_at) started_at,max(finished_at) last_at
       FROM mix_batches WHERE tenant_id=$1 AND device_id=$2 AND lot_number IS NOT NULL
         AND finished_at>=$3 AND finished_at<$4
       GROUP BY lot_number ORDER BY min(finished_at)`,
      [tenantId, id, start, end],
    );
    // The lot that started after the last one of the period closes it.
    const after = await db.query<{ started_at: Date }>(
      `SELECT min(finished_at) started_at FROM mix_batches
       WHERE tenant_id=$1 AND device_id=$2 AND finished_at>=$3 AND lot_number IS NOT NULL`,
      [tenantId, id, end],
    );
    const product = await loadLinks(db, tenantId);
    const result = [];
    for (const [index, lot] of lots.rows.entries()) {
      const lotStart = new Date(lot.started_at);
      const lotEnd = lots.rows[index + 1]
        ? new Date(lots.rows[index + 1].started_at)
        : after.rows[0]?.started_at
          ? new Date(after.rows[0].started_at)
          : new Date();
      const bagged = await db.query<{ recipe: string; bags: number }>(
        `SELECT recipe,sum(bags)::float bags FROM bagging_buckets
         WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4 AND bags>0
         GROUP BY recipe ORDER BY sum(bags) DESC`,
        [tenantId, id, new Date(Math.floor(lotStart.getTime() / STEP_MS) * STEP_MS), lotEnd],
      );
      const products = new Map<string, { name: string; bags: number; kg: number | null }>();
      for (const row of bagged.rows) {
        const link = product.get(row.recipe);
        const key = link?.name ?? row.recipe;
        const entry = products.get(key) ?? { name: key, bags: 0, kg: link ? 0 : null };
        entry.bags += Number(row.bags);
        if (link && entry.kg != null) entry.kg += Number(row.bags) * Number(link.nominal_kg);
        products.set(key, entry);
      }
      const baggedKg = [...products.values()].reduce((total, item) => total + (item.kg ?? 0), 0);
      const mixed = lot.scale_kg ? Number(lot.scale_kg) : Number(lot.kg);
      result.push({
        lot: lot.lot_number,
        recipe: lot.recipe,
        batches: Number(lot.batches),
        mixedKg: mixed,
        startedAt: lotStart.toISOString(),
        lastBatchAt: new Date(lot.last_at).toISOString(),
        baggedUntil: lotEnd.toISOString(),
        bags: [...products.values()].reduce((total, item) => total + item.bags, 0),
        baggedKg,
        products: [...products.values()],
      });
    }
    return { from, to, lots: result.reverse() };
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
