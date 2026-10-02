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

/**
 * The bagging board of a mortar plant (migrations 037 and 040): the shift or the day of the line
 * (or of one spout), against its target, the way the ceramic production board reads a shift.
 *
 * The curve is built from the 5-minute bagging buckets: the bags piling up, each stretch painted
 * by what the spouts were doing, the target spread over the productive time (breaks excluded),
 * the projection at the pace held so far, and the same window of an earlier day to compare.
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

export function registerMortarBoardRoutes(
  app: FastifyInstance,
  db: Database,
  access: ReturnType<typeof createAccessControl>,
) {
  app.get('/api/devices/:id/mortar/board', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = z
      .object({
        mode: z.enum(['shift', 'day']).default('shift'),
        shift: z.string().optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        spout: uuid.optional(),
        compare: z.enum(['none', 'yesterday', 'week']).default('yesterday'),
      })
      .parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const device = (
      await db.query<{ site_id: string }>(
        'SELECT site_id FROM devices WHERE tenant_id=$1 AND id=$2',
        [tenantId, id],
      )
    ).rows[0];
    if (!device) return reply.code(404).send({ error: 'Device not found' });
    const settings = (
      await db.query<{
        target_metric: 'bags' | 'tons' | null;
        target_per_shift: number | null;
        idle_seconds: number | null;
      }>(
        'SELECT target_metric,target_per_shift,idle_seconds FROM mortar_settings WHERE tenant_id=$1 AND device_id=$2',
        [tenantId, id],
      )
    ).rows[0];
    const metric = settings?.target_metric ?? 'bags';
    const perShift = settings?.target_per_shift == null ? null : Number(settings.target_per_shift);

    const now = new Date();
    const today = plantDate(now);
    const date = query.date ?? today;
    const { shifts, isDefault } = await loadShifts(db, tenantId, device.site_id);
    const occurrences = expandShifts(shifts, addDays(date, -1), addDays(date, 1));
    const ofDate = occurrences.filter((item) => item.productionDate === date);
    const running = occurrences.find((item) => item.start <= now && now < item.end) ?? null;

    // Which stretch of time the board reads.
    let chosen: ShiftOccurrence[] = [];
    if (query.mode === 'day') chosen = ofDate;
    else {
      const named = query.shift ? ofDate.find((item) => item.shiftId === query.shift) : null;
      const current = date === today ? running : null;
      const last = [...ofDate].reverse().find((item) => item.end <= now) ?? null;
      const one = named ?? (current?.productionDate === date ? current : null) ?? last ?? ofDate[0];
      chosen = one ? [one] : [];
    }
    const span: TimeWindow = chosen.length
      ? { start: chosen[0].start, end: chosen[chosen.length - 1].end }
      : { start: plantInstant(date, '00:00'), end: plantInstant(addDays(date, 1), '00:00') };
    const windows = chosen.length
      ? chosen.flatMap((item) => productiveWindows(item))
      : [{ start: span.start, end: span.end }];
    const planned = productiveSecondsIn(windows, span.start, span.end);
    const until = new Date(Math.min(now.getTime(), span.end.getTime()));
    const elapsedProductive = productiveSecondsIn(windows, span.start, until);
    const status = now < span.start ? 'upcoming' : now >= span.end ? 'finished' : 'running';

    const [spouts, links, buckets, stops, runtime] = await Promise.all([
      db.query<{ id: string; name: string; position: number }>(
        'SELECT id,name,position FROM bagging_spouts WHERE tenant_id=$1 AND device_id=$2 ORDER BY position',
        [tenantId, id],
      ),
      db.query<{ recipe: string; name: string; nominal_kg: number; standard_rate: number | null }>(
        `SELECT l.recipe,p.name,p.nominal_kg::float nominal_kg,p.standard_rate::float standard_rate
         FROM mortar_recipe_links l JOIN mortar_products p ON p.id=l.product_id WHERE l.tenant_id=$1`,
        [tenantId],
      ),
      db.query<Bucket>(
        `SELECT bucket,spout_id,recipe,bags::float bags,running_s::float running_s,idle_s::float idle_s,off_s::float off_s
         FROM bagging_buckets WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4
           AND ($5::uuid IS NULL OR spout_id=$5)
         ORDER BY bucket`,
        [tenantId, id, span.start, span.end, query.spout ?? null],
      ),
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
        [tenantId, id, span.start, span.end, query.spout ?? null],
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
         FROM bagging_runtime WHERE tenant_id=$1 AND device_id=$2 AND ($3::uuid IS NULL OR spout_id=$3)`,
        [tenantId, id, query.spout ?? null],
      ),
    ]);
    const product = new Map(links.rows.map((row) => [row.recipe, row]));
    const kgOf = (recipe: string, bags: number) => {
      const link = product.get(recipe);
      return link ? bags * Number(link.nominal_kg) : 0;
    };
    const inMetric = (bags: number, kg: number) => (metric === 'tons' ? kg / 1000 : bags);

    // The curve, one point every five minutes from the start of the span to its end.
    const slots = new Map<
      number,
      { bags: number; kg: number; running: number; idle: number; off: number }
    >();
    for (const row of buckets.rows) {
      const at = new Date(row.bucket).getTime();
      const slot = slots.get(at) ?? { bags: 0, kg: 0, running: 0, idle: 0, off: 0 };
      slot.bags += Number(row.bags);
      slot.kg += kgOf(row.recipe, Number(row.bags));
      slot.running += Number(row.running_s);
      slot.idle += Number(row.idle_s);
      slot.off += Number(row.off_s);
      slots.set(at, slot);
    }
    const target = perShift == null ? null : perShift * Math.max(1, chosen.length);
    let doneBags = 0;
    let doneKg = 0;
    const points: Array<{
      t: string;
      actual: number | null;
      planned: number | null;
      state: string;
      productive: boolean;
    }> = [];
    for (let at = span.start.getTime(); at <= span.end.getTime(); at += STEP_MS) {
      const slot = slots.get(at - STEP_MS);
      if (slot) {
        doneBags += slot.bags;
        doneKg += slot.kg;
      }
      const time = slot ? slot.running + slot.idle + slot.off : 0;
      const state =
        !slot || time === 0
          ? at - STEP_MS < now.getTime()
            ? 'offline'
            : 'future'
          : slot.running >= slot.idle && slot.running >= slot.off
            ? 'running'
            : slot.idle >= slot.off
              ? 'idle'
              : 'off';
      const instant = new Date(at);
      points.push({
        t: instant.toISOString(),
        actual: at <= now.getTime() ? inMetric(doneBags, doneKg) : null,
        planned:
          target == null || !planned
            ? null
            : (target * productiveSecondsIn(windows, span.start, instant)) / planned,
        state: at <= now.getTime() ? state : 'future',
        productive: productiveSecondsIn(windows, new Date(at - STEP_MS), instant) > 0,
      });
    }

    // Totals of the span.
    const sum = (key: keyof Omit<Bucket, 'bucket' | 'spout_id' | 'recipe'>) =>
      buckets.rows.reduce((total, row) => total + Number(row[key]), 0);
    const bags = sum('bags');
    const kg = buckets.rows.reduce((total, row) => total + kgOf(row.recipe, Number(row.bags)), 0);
    const runningS = sum('running_s');
    const idleS = sum('idle_s');
    const offS = sum('off_s');
    const actual = inMetric(bags, kg);
    // The pace held in productive time so far, carried over the productive time left.
    const pace = elapsedProductive > 0 ? actual / elapsedProductive : 0;
    const remaining = Math.max(0, planned - elapsedProductive);
    const projected = actual + pace * remaining;
    if (status === 'running')
      for (const point of points)
        if (point.actual == null)
          (point as typeof point & { projected?: number }).projected =
            actual + pace * productiveSecondsIn(windows, until, new Date(point.t));

    // Performance: bags made against the bags the standard pace of each product would make in
    // the time the spouts were filling.
    let expected = 0;
    for (const row of buckets.rows) {
      const rate = product.get(row.recipe)?.standard_rate;
      if (rate) expected += (Number(row.running_s) / 3600) * Number(rate);
    }
    const ratedBags = buckets.rows
      .filter((row) => product.get(row.recipe)?.standard_rate)
      .reduce((total, row) => total + Number(row.bags), 0);
    const performance = expected > 0 ? ratedBags / expected : null;
    const availability = runningS + idleS > 0 ? runningS / (runningS + idleS) : null;

    // The same window of an earlier day, to compare.
    let compare: Array<number | null> | null = null;
    let compareLabel: string | null = null;
    if (query.compare !== 'none') {
      const shiftDays = query.compare === 'week' ? 7 : 1;
      const offset = shiftDays * 86_400_000;
      const past = await db.query<{ bucket: Date; recipe: string; bags: number }>(
        `SELECT bucket,recipe,sum(bags)::float bags FROM bagging_buckets
         WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4
           AND ($5::uuid IS NULL OR spout_id=$5)
         GROUP BY bucket,recipe ORDER BY bucket`,
        [
          tenantId,
          id,
          new Date(span.start.getTime() - offset),
          new Date(span.end.getTime() - offset),
          query.spout ?? null,
        ],
      );
      if (past.rows.length) {
        const bySlot = new Map<number, { bags: number; kg: number }>();
        for (const row of past.rows) {
          const at = new Date(row.bucket).getTime() + offset;
          const entry = bySlot.get(at) ?? { bags: 0, kg: 0 };
          entry.bags += Number(row.bags);
          entry.kg += kgOf(row.recipe, Number(row.bags));
          bySlot.set(at, entry);
        }
        let b = 0;
        let k = 0;
        compare = points.map((point) => {
          const slot = bySlot.get(new Date(point.t).getTime() - STEP_MS);
          if (slot) {
            b += slot.bags;
            k += slot.kg;
          }
          return inMetric(b, k);
        });
        compareLabel = query.compare === 'week' ? 'Mesmo dia da semana passada' : 'Ontem';
      }
    }

    // Stops of the span, and the one going on now.
    const idleMs = (settings?.idle_seconds ?? 120) * 1000;
    const nowState = (row: (typeof runtime.rows)[number]) => {
      if (now.getTime() - new Date(row.last_at).getTime() > env.DEVICE_OFFLINE_SECONDS * 1000)
        return 'offline';
      if (row.enabled === false) return 'off';
      const bag = row.last_increment_at ? new Date(row.last_increment_at).getTime() : 0;
      return now.getTime() - bag <= idleMs ? 'running' : 'idle';
    };
    const stopList = stops.rows.map((row) => ({
      spoutId: row.spout_id,
      state: row.state,
      startedAt: new Date(row.started_at).toISOString(),
      endedAt: new Date(row.ended_at).toISOString(),
      seconds: Number(row.seconds),
      recipe: row.recipe,
      product: row.recipe ? (product.get(row.recipe)?.name ?? null) : null,
      open: false,
    }));
    if (status === 'running')
      for (const row of runtime.rows)
        if (row.stop_started_at && row.stop_state && nowState(row) !== 'offline')
          stopList.push({
            spoutId: row.spout_id,
            state: row.stop_state,
            startedAt: new Date(row.stop_started_at).toISOString(),
            endedAt: now.toISOString(),
            seconds: (now.getTime() - new Date(row.stop_started_at).getTime()) / 1000,
            recipe: row.recipe,
            product: row.recipe ? (product.get(row.recipe)?.name ?? null) : null,
            open: true,
          });
    const idleStops = stopList.filter((stop) => stop.state === 'idle');

    const perSpout = spouts.rows
      .filter((spout) => !query.spout || spout.id === query.spout)
      .map((spout) => {
        const rows = buckets.rows.filter((row) => row.spout_id === spout.id);
        const spoutBags = rows.reduce((total, row) => total + Number(row.bags), 0);
        const spoutKg = rows.reduce((total, row) => total + kgOf(row.recipe, Number(row.bags)), 0);
        const live = runtime.rows.find((row) => row.spout_id === spout.id);
        const own = stopList.filter((stop) => stop.spoutId === spout.id && stop.state === 'idle');
        return {
          id: spout.id,
          name: spout.name,
          bags: spoutBags,
          kg: spoutKg,
          actual: inMetric(spoutBags, spoutKg),
          runningS: rows.reduce((total, row) => total + Number(row.running_s), 0),
          idleS: rows.reduce((total, row) => total + Number(row.idle_s), 0),
          offS: rows.reduce((total, row) => total + Number(row.off_s), 0),
          stops: own.length,
          stopSeconds: own.reduce((total, stop) => total + stop.seconds, 0),
          state: live ? nowState(live) : 'unknown',
          recipe: live?.recipe ?? null,
          product: live?.recipe ? (product.get(live.recipe)?.name ?? null) : null,
        };
      });

    return {
      mode: query.mode,
      date,
      today,
      status,
      defaultShifts: isDefault,
      now: now.toISOString(),
      span: { start: span.start.toISOString(), end: span.end.toISOString() },
      shifts: chosen.map(occurrenceJson),
      available: ofDate.map(occurrenceJson),
      metric,
      target:
        target == null
          ? null
          : {
              perShift,
              value: target,
              expectedNow: planned ? (target * elapsedProductive) / planned : 0,
              projected,
              ratio: target ? projected / target : null,
            },
      totals: {
        bags,
        kg,
        actual,
        runningS,
        idleS,
        offS,
        plannedSeconds: planned,
        elapsedProductive,
        pacePerHour: pace * 3600,
        projected,
        availability,
        performance,
        effectiveness:
          availability != null && performance != null ? availability * performance : null,
        stops: idleStops.length,
        stopSeconds: idleStops.reduce((total, stop) => total + stop.seconds, 0),
        longestStop: idleStops.reduce((most, stop) => Math.max(most, stop.seconds), 0),
      },
      points,
      compare,
      compareLabel,
      spouts: perSpout,
      stops: stopList.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    };
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
    const links = await db.query<{ recipe: string; name: string; nominal_kg: number }>(
      `SELECT l.recipe,p.name,p.nominal_kg::float nominal_kg
       FROM mortar_recipe_links l JOIN mortar_products p ON p.id=l.product_id WHERE l.tenant_id=$1`,
      [tenantId],
    );
    const product = new Map(links.rows.map((row) => [row.recipe, row]));
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
