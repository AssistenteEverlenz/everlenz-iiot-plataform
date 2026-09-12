import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import {
  addDays,
  BUCKET_SECONDS,
  DEFAULT_SHIFTS,
  env,
  expandShifts,
  plantDate,
  plantInstant,
  productiveSecondsIn,
  productiveWindows,
  validateShifts,
  type ShiftDefinition,
  type ShiftOccurrence,
  type TimeWindow,
} from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';

// Production by shift (migration 018): the plant's shift calendar, the device's production
// configuration, the live shift board and the shift history. Everything reads the 5-minute
// production buckets the ingestor maintains; closed shifts are written once to shift_reports.

type Access = ReturnType<typeof createAccessControl>;
type Metric = 'milheiros' | 'tons' | 'blocks' | 'pallets';
type Health = 'achieved' | 'on_track' | 'at_risk' | 'off_track' | 'missed';
const uuid = z.uuid();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5][05]$/, 'Use HH:MM em múltiplos de 5 minutos');
const BUCKET_MS = BUCKET_SECONDS * 1000;
const RATE_WINDOW_SECONDS = 3600;

interface ProductionConfig {
  site_id: string;
  blocks_tag_id: string | null;
  pallets_tag_id: string | null;
  tons_total_tag_id: string | null;
  auto_tag_id: string | null;
  idle_seconds: number | null;
  weight_per_unit_kg: number | null;
  weight_tag_id: string | null;
  target_metric: Metric | null;
  target_per_shift: number | null;
}
interface BucketRow {
  bucket: Date | string;
  product_code: string;
  pieces: number;
  pallets: number;
  tons: number;
  producing_s: number;
  idle_s: number;
  manual_s: number;
}
interface Totals {
  pieces: number;
  pallets: number;
  tons: number;
}
export interface Summary extends Totals {
  producing: number;
  idle: number;
  manual: number;
  offline: number;
  elapsedProductive: number;
  products: Array<Totals & { product_code: string }>;
}

async function loadConfig(db: Database, tenantId: string, deviceId: string) {
  const result = await db.query<ProductionConfig>(
    `SELECT d.site_id,ps.blocks_tag_id,ps.pallets_tag_id,ps.tons_total_tag_id,ps.auto_tag_id,
       ps.idle_seconds,ps.weight_per_unit_kg,ps.weight_tag_id,ps.target_metric,ps.target_per_shift
     FROM devices d LEFT JOIN production_settings ps ON ps.device_id=d.id AND ps.tenant_id=d.tenant_id
     WHERE d.tenant_id=$1 AND d.id=$2 AND d.archived_at IS NULL`,
    [tenantId, deviceId],
  );
  return result.rows[0] ?? null;
}

export async function loadShifts(db: Database, tenantId: string, siteId: string) {
  const result = await db.query<{
    id: string;
    name: string;
    weekdays: number[];
    start_time: string;
    end_time: string;
    breaks: Array<{ start: string; end: string }>;
  }>(
    `SELECT id,name,weekdays,start_time,end_time,breaks FROM site_shifts
     WHERE tenant_id=$1 AND site_id=$2 ORDER BY sort_order,start_time,name`,
    [tenantId, siteId],
  );
  const shifts: ShiftDefinition[] = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    weekdays: row.weekdays.map(Number),
    start: row.start_time,
    end: row.end_time,
    breaks: Array.isArray(row.breaks) ? row.breaks : [],
  }));
  return shifts.length ? { shifts, isDefault: false } : { shifts: DEFAULT_SHIFTS, isDefault: true };
}

async function loadBuckets(db: Database, tenantId: string, deviceId: string, from: Date, to: Date) {
  return (
    await db.query<BucketRow>(
      `SELECT bucket,product_code,pieces,pallets,tons,producing_s,idle_s,manual_s
       FROM production_buckets WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4
       ORDER BY bucket`,
      [tenantId, deviceId, from, to],
    )
  ).rows;
}

/**
 * Production counts over the whole span (a piece made during a pause still counts for the
 * shift); state time only inside the productive windows, so pauses never spoil availability.
 */
export function summarize(
  buckets: BucketRow[],
  span: TimeWindow,
  windows: TimeWindow[],
  until: Date,
): Summary {
  const summary: Summary = {
    pieces: 0,
    pallets: 0,
    tons: 0,
    producing: 0,
    idle: 0,
    manual: 0,
    offline: 0,
    elapsedProductive: 0,
    products: [],
  };
  const products = new Map<string, Totals>();
  for (const row of buckets) {
    const start = new Date(row.bucket);
    if (start < span.start || start >= span.end) continue;
    const end = new Date(start.getTime() + BUCKET_MS);
    summary.pieces += Number(row.pieces);
    summary.pallets += Number(row.pallets);
    summary.tons += Number(row.tons);
    const product = products.get(row.product_code) ?? { pieces: 0, pallets: 0, tons: 0 };
    product.pieces += Number(row.pieces);
    product.pallets += Number(row.pallets);
    product.tons += Number(row.tons);
    products.set(row.product_code, product);
    const weight = productiveSecondsIn(windows, start, end) / BUCKET_SECONDS;
    summary.producing += Number(row.producing_s) * weight;
    summary.idle += Number(row.idle_s) * weight;
    summary.manual += Number(row.manual_s) * weight;
  }
  const end = new Date(Math.min(span.end.getTime(), until.getTime()));
  summary.elapsedProductive = productiveSecondsIn(windows, span.start, end);
  summary.offline = Math.max(
    0,
    summary.elapsedProductive - summary.producing - summary.idle - summary.manual,
  );
  summary.products = [...products.entries()]
    .map(([product_code, totals]) => ({ product_code, ...totals }))
    .sort((a, b) => b.pieces - a.pieces || b.pallets - a.pallets);
  return summary;
}

export function metricValue(totals: Totals, metric: Metric) {
  if (metric === 'milheiros') return totals.pieces / 1000;
  if (metric === 'tons') return totals.tons;
  if (metric === 'blocks') return totals.pieces;
  return totals.pallets;
}

function spanOf(occurrences: ShiftOccurrence[]) {
  return {
    start: new Date(Math.min(...occurrences.map((item) => item.start.getTime()))),
    end: new Date(Math.max(...occurrences.map((item) => item.end.getTime()))),
  };
}

/** Live numbers of one window (a shift, or all the shifts of a day). */
async function buildBoard(
  db: Database,
  tenantId: string,
  deviceId: string,
  config: ProductionConfig,
  occurrences: ShiftOccurrence[],
  fallbackSpan: TimeWindow,
  now: Date,
) {
  const span = occurrences.length ? spanOf(occurrences) : fallbackSpan;
  const windows = occurrences.flatMap(productiveWindows);
  const planned = occurrences.reduce((total, item) => total + item.plannedSeconds, 0);
  const until = new Date(Math.min(span.end.getTime(), now.getTime()));
  const buckets = await loadBuckets(
    db,
    tenantId,
    deviceId,
    new Date(Math.floor(span.start.getTime() / BUCKET_MS) * BUCKET_MS),
    new Date(until.getTime() + BUCKET_MS),
  );
  const summary = summarize(buckets, span, windows, now);
  const metric: Metric = config.target_metric ?? (config.blocks_tag_id ? 'milheiros' : 'pallets');
  const targetValue =
    config.target_metric && config.target_per_shift
      ? config.target_per_shift * Math.max(occurrences.length, 0)
      : null;

  // Cumulative curve by bucket end: planned (target spread over productive time), actual and,
  // after now, the projection at the pace of the last productive hour.
  const byBucket = new Map<number, Totals>();
  for (const row of buckets) {
    const at = new Date(row.bucket).getTime();
    if (at < span.start.getTime() || at >= span.end.getTime()) continue;
    const totals = byBucket.get(at) ?? { pieces: 0, pallets: 0, tons: 0 };
    totals.pieces += Number(row.pieces);
    totals.pallets += Number(row.pallets);
    totals.tons += Number(row.tons);
    byBucket.set(at, totals);
  }
  const actual = metricValue(summary, metric);
  const rateFrom = new Date(now.getTime() - RATE_WINDOW_SECONDS * 1000);
  const rateSeconds = productiveSecondsIn(windows, rateFrom, until);
  let recent = 0;
  for (const [at, totals] of byBucket)
    if (at + BUCKET_MS > rateFrom.getTime() && at < until.getTime())
      recent += metricValue(totals, metric);
  // Under 10 productive minutes of recent history the shift average is steadier.
  const ratePerSecond =
    rateSeconds >= 600
      ? recent / rateSeconds
      : summary.elapsedProductive > 0
        ? actual / summary.elapsedProductive
        : 0;
  const remaining = productiveSecondsIn(windows, until, span.end);
  const projected = actual + ratePerSecond * remaining;

  const curve: Array<{
    t: string;
    planned: number | null;
    actual: number | null;
    projected: number | null;
  }> = [];
  let cumulative = 0;
  const firstBucket = Math.floor(span.start.getTime() / BUCKET_MS) * BUCKET_MS;
  for (let at = firstBucket; at <= span.end.getTime(); at += BUCKET_MS) {
    const pointTime = new Date(Math.max(at, span.start.getTime()));
    const beforeNow = at <= now.getTime();
    if (at > firstBucket)
      cumulative += metricValue(
        byBucket.get(at - BUCKET_MS) ?? { pieces: 0, pallets: 0, tons: 0 },
        metric,
      );
    curve.push({
      t: pointTime.toISOString(),
      planned:
        targetValue && planned > 0
          ? (targetValue * productiveSecondsIn(windows, span.start, pointTime)) / planned
          : null,
      actual: beforeNow ? cumulative : null,
      projected:
        at >= until.getTime() - BUCKET_MS && at <= span.end.getTime()
          ? actual +
            ratePerSecond *
              productiveSecondsIn(windows, until, new Date(Math.max(at, until.getTime())))
          : null,
    });
  }
  // The last actual point is "now", not the start of the running bucket.
  const lastActual = [...curve].reverse().find((point) => point.actual != null);
  if (lastActual) lastActual.actual = actual;

  // Timeline: the dominant state of each bucket; pauses and time outside shifts marked apart.
  const statesByBucket = new Map<number, { producing: number; idle: number; manual: number }>();
  for (const row of buckets) {
    const at = new Date(row.bucket).getTime();
    const current = statesByBucket.get(at) ?? { producing: 0, idle: 0, manual: 0 };
    current.producing += Number(row.producing_s);
    current.idle += Number(row.idle_s);
    current.manual += Number(row.manual_s);
    statesByBucket.set(at, current);
  }
  const timeline: Array<{ t: string; state: string }> = [];
  for (let at = firstBucket; at < until.getTime(); at += BUCKET_MS) {
    const start = new Date(at);
    const end = new Date(Math.min(at + BUCKET_MS, until.getTime()));
    const productive = productiveSecondsIn(windows, start, end);
    if (productive < 1) {
      timeline.push({ t: start.toISOString(), state: occurrences.length ? 'pause' : 'outside' });
      continue;
    }
    const seconds = statesByBucket.get(at) ?? { producing: 0, idle: 0, manual: 0 };
    const offline = Math.max(0, productive - seconds.producing - seconds.idle - seconds.manual);
    const ranked = [
      ['producing', seconds.producing],
      ['idle', seconds.idle],
      ['manual', seconds.manual],
      ['offline', offline],
    ] as const;
    timeline.push({ t: start.toISOString(), state: [...ranked].sort((a, b) => b[1] - a[1])[0][0] });
  }

  let health: Health | null = null;
  if (targetValue) {
    if (actual >= targetValue) health = 'achieved';
    else if (span.end <= now) health = 'missed';
    else {
      const ratio = projected / targetValue;
      health = ratio >= 1 ? 'on_track' : ratio >= 0.9 ? 'at_risk' : 'off_track';
    }
  }
  return {
    span: { start: span.start.toISOString(), end: span.end.toISOString() },
    plannedSeconds: planned,
    remainingSeconds: remaining,
    metric,
    totals: {
      pieces: summary.pieces,
      milheiros: summary.pieces / 1000,
      pallets: summary.pallets,
      tons: summary.tons,
    },
    products: summary.products.map((product) => ({
      ...product,
      milheiros: product.pieces / 1000,
    })),
    time: {
      producing: summary.producing,
      idle: summary.idle,
      manual: summary.manual,
      offline: summary.offline,
      elapsedProductive: summary.elapsedProductive,
    },
    utilization:
      summary.producing + summary.idle > 0
        ? summary.producing / (summary.producing + summary.idle)
        : null,
    target: targetValue
      ? {
          value: targetValue,
          actual,
          plannedToNow: planned > 0 ? (targetValue * summary.elapsedProductive) / planned : 0,
          projected,
          ratePerHour: ratePerSecond * 3600,
          requiredPerHour:
            remaining > 0 ? Math.max(0, targetValue - actual) / (remaining / 3600) : null,
          health,
        }
      : null,
    pacePerHour: ratePerSecond * 3600,
    curve,
    timeline,
  };
}

async function currentState(db: Database, deviceId: string, idleSeconds: number, now: Date) {
  const result = await db.query<{
    last_at: Date | string;
    last_increment_at: Date | string | null;
    auto: boolean | null;
    product_code: string | null;
  }>(
    'SELECT last_at,last_increment_at,auto,product_code FROM production_runtime WHERE device_id=$1',
    [deviceId],
  );
  const row = result.rows[0];
  if (!row) return { state: 'unknown', product: null };
  const lastAt = new Date(row.last_at).getTime();
  if (now.getTime() - lastAt > env.DEVICE_OFFLINE_SECONDS * 1000)
    return { state: 'offline', product: row.product_code };
  if (row.auto === false) return { state: 'manual', product: row.product_code };
  const lastIncrement = row.last_increment_at ? new Date(row.last_increment_at).getTime() : lastAt;
  return {
    state: now.getTime() - lastIncrement > idleSeconds * 1000 ? 'idle' : 'producing',
    product: row.product_code,
  };
}

function occurrenceJson(occurrence: ShiftOccurrence) {
  return {
    shiftId: occurrence.shiftId,
    name: occurrence.name,
    productionDate: occurrence.productionDate,
    start: occurrence.start.toISOString(),
    end: occurrence.end.toISOString(),
    breaks: occurrence.breaks.map((pause) => ({
      start: pause.start.toISOString(),
      end: pause.end.toISOString(),
    })),
    plannedSeconds: occurrence.plannedSeconds,
  };
}

async function trackingSince(db: Database, deviceId: string) {
  const result = await db.query<{ first: Date | string | null }>(
    'SELECT min(bucket) first FROM production_buckets WHERE device_id=$1',
    [deviceId],
  );
  return result.rows[0]?.first ? new Date(result.rows[0].first) : null;
}

/**
 * Writes every finished shift of the last days that has no report yet, and per past day the
 * production made outside every shift. A shift that started before tracking began is skipped:
 * a partial shift would be recorded as a bad shift that never happened.
 */
export async function closeShiftReports(
  db: Database,
  now = new Date(),
  // "Recalcular período": one device, an explicit range of production dates.
  options: { deviceId?: string; fromDate?: string; toDate?: string } = {},
) {
  const devices = await db.query<ProductionConfig & { id: string; tenant_id: string }>(
    `SELECT d.id,d.tenant_id,d.site_id,ps.blocks_tag_id,ps.pallets_tag_id,ps.tons_total_tag_id,
       ps.auto_tag_id,ps.idle_seconds,ps.weight_per_unit_kg,ps.weight_tag_id,ps.target_metric,
       ps.target_per_shift
     FROM devices d JOIN production_settings ps ON ps.device_id=d.id AND ps.tenant_id=d.tenant_id
     WHERE d.archived_at IS NULL AND (ps.blocks_tag_id IS NOT NULL OR ps.pallets_tag_id IS NOT NULL)
       AND ($1::uuid IS NULL OR d.id=$1)`,
    [options.deviceId ?? null],
  );
  let written = 0;
  for (const device of devices.rows) {
    const since = await trackingSince(db, device.id);
    if (!since) continue;
    const { shifts } = await loadShifts(db, device.tenant_id, device.site_id);
    const today = plantDate(now);
    const fromDate = options.fromDate ?? addDays(today, -3);
    const lastDate = options.toDate && options.toDate < today ? options.toDate : today;
    // Deleted automatic rows count as done: a row someone removed is not written again.
    const existing = await db.query<{ kind: string; planned_start: Date | string }>(
      `SELECT kind,planned_start FROM shift_reports
       WHERE device_id=$1 AND production_date>=$2 AND source='auto'`,
      [device.id, fromDate],
    );
    const done = new Set(
      existing.rows.map((row) => `${row.kind}|${new Date(row.planned_start).getTime()}`),
    );
    const occurrences = expandShifts(shifts, addDays(fromDate, -1), lastDate);
    const insert = async (report: {
      kind: 'shift' | 'off_shift';
      shiftId: string | null;
      name: string;
      date: string;
      start: Date;
      end: Date;
      planned: number;
      summary: Summary;
    }) => {
      await db.query(
        `INSERT INTO shift_reports(tenant_id,device_id,site_id,kind,shift_id,shift_name,production_date,
           planned_start,planned_end,planned_seconds,pieces,pallets,tons,producing_s,idle_s,manual_s,
           offline_s,target_metric,target_value,products)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
         ON CONFLICT(device_id,kind,planned_start) WHERE source='auto' DO NOTHING`,
        [
          device.tenant_id,
          device.id,
          device.site_id,
          report.kind,
          report.shiftId,
          report.name,
          report.date,
          report.start,
          report.end,
          report.planned,
          report.summary.pieces,
          report.summary.pallets,
          report.summary.tons,
          report.summary.producing,
          report.summary.idle,
          report.summary.manual,
          report.summary.offline,
          report.kind === 'shift' ? device.target_metric : null,
          report.kind === 'shift' && device.target_metric ? device.target_per_shift : null,
          JSON.stringify(report.summary.products),
        ],
      );
      written += 1;
    };
    for (const occurrence of occurrences) {
      if (occurrence.productionDate < fromDate || occurrence.productionDate > lastDate) continue;
      if (occurrence.end.getTime() > now.getTime() - 60_000) continue;
      if (occurrence.start < since) continue;
      if (done.has(`shift|${occurrence.start.getTime()}`)) continue;
      const buckets = await loadBuckets(
        db,
        device.tenant_id,
        device.id,
        occurrence.start,
        occurrence.end,
      );
      await insert({
        kind: 'shift',
        shiftId: occurrence.shiftId,
        name: occurrence.name,
        date: occurrence.productionDate,
        start: occurrence.start,
        end: occurrence.end,
        planned: occurrence.plannedSeconds,
        summary: summarize(buckets, occurrence, productiveWindows(occurrence), occurrence.end),
      });
    }
    // Production outside every shift, one row per finished calendar day.
    for (let date = fromDate; date < today && date <= lastDate; date = addDays(date, 1)) {
      const dayStart = plantInstant(date, '00:00');
      const dayEnd = plantInstant(addDays(date, 1), '00:00');
      if (dayEnd < since || done.has(`off_shift|${dayStart.getTime()}`)) continue;
      const buckets = await loadBuckets(db, device.tenant_id, device.id, dayStart, dayEnd);
      const inShift = (at: Date) =>
        occurrences.some((occurrence) => at >= occurrence.start && at < occurrence.end);
      const outside = buckets.filter((row) => !inShift(new Date(row.bucket)));
      const whole = { start: dayStart, end: dayEnd };
      const summary = summarize(outside, whole, [whole], dayEnd);
      await insert({
        kind: 'off_shift',
        shiftId: null,
        name: 'Fora de turno',
        date,
        start: dayStart,
        end: dayEnd,
        planned: 0,
        summary: { ...summary, offline: 0, elapsedProductive: 0 },
      });
    }
  }
  return written;
}

export function registerShiftProductionRoutes(app: FastifyInstance, db: Database, access: Access) {
  app.get('/api/sites/:id/shifts', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const tenantId = access.principal(req).tenantId;
    const site = await db.query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2', [
      tenantId,
      id,
    ]);
    if (!site.rows.length) return reply.code(404).send({ error: 'Site not found' });
    return loadShifts(db, tenantId, id);
  });

  // Replaces the plant's whole calendar at once, so a half-edited set of shifts never exists.
  app.put('/api/sites/:id/shifts', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        shifts: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(60),
              weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
              start: time,
              end: time,
              breaks: z
                .array(z.object({ start: time, end: time }))
                .max(12)
                .default([]),
            }),
          )
          .max(6),
      })
      .parse(req.body);
    const current = access.principal(req);
    const site = await db.query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2', [
      current.tenantId,
      id,
    ]);
    if (!site.rows.length) return reply.code(404).send({ error: 'Site not found' });
    const shifts: ShiftDefinition[] = body.shifts.map((shift) => ({
      id: null,
      ...shift,
      weekdays: [...new Set(shift.weekdays)].sort(),
    }));
    const problem = validateShifts(shifts);
    if (problem) return reply.code(400).send({ error: problem });
    await db.transaction(async (sql) => {
      await sql.query('DELETE FROM site_shifts WHERE tenant_id=$1 AND site_id=$2', [
        current.tenantId,
        id,
      ]);
      for (const [index, shift] of shifts.entries())
        await sql.query(
          `INSERT INTO site_shifts(tenant_id,site_id,name,weekdays,start_time,end_time,breaks,sort_order)
           VALUES($1,$2,$3,$4::smallint[],$5,$6,$7::jsonb,$8)`,
          [
            current.tenantId,
            id,
            shift.name,
            shift.weekdays,
            shift.start,
            shift.end,
            JSON.stringify(shift.breaks),
            index,
          ],
        );
      await recordAudit(sql, req, current, {
        action: 'site.shifts.update',
        targetType: 'site',
        targetId: id,
        summary: { shifts: shifts.map((shift) => `${shift.name} ${shift.start}-${shift.end}`) },
      });
    });
    return loadShifts(db, current.tenantId, id);
  });

  app.get('/api/devices/:id/production-config', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const config = await loadConfig(db, access.principal(req).tenantId, id);
    if (!config) return reply.code(404).send({ error: 'Device not found' });
    return config;
  });

  app.patch('/api/devices/:id/production-config', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const body = z
      .object({
        piecesTagId: uuid.nullable(),
        palletsTagId: uuid.nullable(),
        autoTagId: uuid.nullable(),
        idleSeconds: z.number().int().min(5).max(3600),
        weightPerUnitKg: z.number().positive().max(1000).nullable(),
        // Weight per piece read from the HMI (recipe weight); the fixed value is the fallback.
        weightTagId: uuid.nullable().default(null),
        targetMetric: z.enum(['milheiros', 'tons', 'blocks', 'pallets']).nullable(),
        targetPerShift: z.number().positive().max(1e9).nullable(),
      })
      .parse(req.body);
    if (!body.piecesTagId && !body.palletsTagId)
      return reply.code(400).send({ error: 'Escolha o contador de peças ou o de paletes.' });
    if (body.targetMetric && !body.targetPerShift)
      return reply.code(400).send({ error: 'Informe o valor da meta por turno.' });
    if (body.targetMetric === 'tons' && !body.weightPerUnitKg && !body.weightTagId)
      return reply
        .code(400)
        .send({ error: 'Meta em toneladas precisa do peso por peça (variável ou valor fixo).' });
    const current = access.principal(req);
    const tagIds = [body.piecesTagId, body.palletsTagId, body.autoTagId, body.weightTagId].filter(
      (tag): tag is string => Boolean(tag),
    );
    const owned = await db.query<{ count: number }>(
      'SELECT count(*)::int count FROM tags WHERE tenant_id=$1 AND device_id=$2 AND id=ANY($3::uuid[])',
      [current.tenantId, id, [...new Set(tagIds)]],
    );
    if (owned.rows[0].count !== new Set(tagIds).size)
      return reply.code(400).send({ error: 'Every variable must belong to this device' });
    await db.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO production_settings(device_id,tenant_id,blocks_tag_id,pallets_tag_id,auto_tag_id,
           idle_seconds,weight_per_unit_kg,target_metric,target_per_shift,weight_tag_id,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         ON CONFLICT(device_id) DO UPDATE SET blocks_tag_id=EXCLUDED.blocks_tag_id,
           pallets_tag_id=EXCLUDED.pallets_tag_id,auto_tag_id=EXCLUDED.auto_tag_id,
           idle_seconds=EXCLUDED.idle_seconds,weight_per_unit_kg=EXCLUDED.weight_per_unit_kg,
           target_metric=EXCLUDED.target_metric,target_per_shift=EXCLUDED.target_per_shift,
           weight_tag_id=EXCLUDED.weight_tag_id,updated_at=now()`,
        [
          id,
          current.tenantId,
          body.piecesTagId,
          body.palletsTagId,
          body.autoTagId,
          body.idleSeconds,
          body.weightPerUnitKg,
          body.targetMetric,
          body.targetMetric ? body.targetPerShift : null,
          body.weightTagId,
        ],
      );
      await recordAudit(sql, req, current, {
        action: 'device.production_config.update',
        targetType: 'device',
        targetId: id,
        summary: body,
      });
    });
    return loadConfig(db, current.tenantId, id);
  });

  // The live shift board. mode=shift follows the running shift (or the last / next one);
  // mode=day adds up every shift of the current production day.
  app.get('/api/devices/:id/shift-board', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const { mode } = z.object({ mode: z.enum(['shift', 'day']).default('shift') }).parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const config = await loadConfig(db, tenantId, id);
    if (!config) return reply.code(404).send({ error: 'Device not found' });
    const now = new Date();
    const { shifts, isDefault } = await loadShifts(db, tenantId, config.site_id);
    const today = plantDate(now);
    // A week ahead, so on a weekend the board still shows Monday's shift as the next one.
    const occurrences = expandShifts(shifts, addDays(today, -1), addDays(today, 7));
    const running = occurrences.find((item) => item.start <= now && now < item.end) ?? null;
    const next = occurrences.find((item) => item.start > now) ?? null;
    const last =
      [...occurrences]
        .reverse()
        .find((item) => item.end <= now && now.getTime() - item.end.getTime() < 12 * 3600 * 1000) ??
      null;
    const state = await currentState(db, id, config.idle_seconds ?? 60, now);
    const configured = Boolean(config.blocks_tag_id || config.pallets_tag_id);
    const base = {
      configured,
      missing: [...(configured ? [] : ['counter']), ...(config.auto_tag_id ? [] : ['auto'])],
      mode,
      defaultShifts: isDefault,
      now: now.toISOString(),
      state: state.state,
      product: state.product,
      next: next ? occurrenceJson(next) : null,
    };
    if (mode === 'day') {
      const date = running?.productionDate ?? today;
      const dayOccurrences = occurrences.filter((item) => item.productionDate === date);
      const board = await buildBoard(
        db,
        tenantId,
        id,
        config,
        dayOccurrences,
        {
          start: plantInstant(date, '00:00'),
          end: plantInstant(addDays(date, 1), '00:00'),
        },
        now,
      );
      return {
        ...base,
        status: running ? 'running' : dayOccurrences.length ? 'between' : 'no_shift',
        productionDate: date,
        shifts: dayOccurrences.map(occurrenceJson),
        board,
      };
    }
    const selected = running ?? last ?? next;
    if (!selected)
      return { ...base, status: 'no_shift', productionDate: today, shifts: [], board: null };
    const board = await buildBoard(db, tenantId, id, config, [selected], selected, now);
    return {
      ...base,
      status: running ? 'running' : selected === last ? 'finished' : 'upcoming',
      productionDate: selected.productionDate,
      shifts: [occurrenceJson(selected)],
      board,
    };
  });

  // History: closed shifts (and off-shift days) of a period, plus the running shift as a
  // provisional row so today's table is never empty mid-shift.
  app.get('/api/devices/:id/shift-reports', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = z
      .object({
        from: z.iso.date(),
        to: z.iso.date(),
      })
      .parse(req.query);
    if (query.to < query.from) return reply.code(400).send({ error: 'Período inválido' });
    if (addDays(query.from, 400) < query.to)
      return reply.code(400).send({ error: 'Consulte no máximo 400 dias por vez' });
    const tenantId = access.principal(req).tenantId;
    const config = await loadConfig(db, tenantId, id);
    if (!config) return reply.code(404).send({ error: 'Device not found' });
    const reports = await db.query(
      `SELECT id,kind,shift_id,shift_name,production_date::text production_date,planned_start,planned_end,
         planned_seconds,pieces,pallets,tons,producing_s,idle_s,manual_s,offline_s,target_metric,
         target_value,products,closed_at,source
       FROM shift_reports WHERE tenant_id=$1 AND device_id=$2 AND production_date BETWEEN $3 AND $4
         AND deleted_at IS NULL
       ORDER BY planned_start DESC,closed_at DESC LIMIT 3000`,
      [tenantId, id, query.from, query.to],
    );
    const now = new Date();
    const { shifts, isDefault } = await loadShifts(db, tenantId, config.site_id);
    const today = plantDate(now);
    const running = expandShifts(shifts, addDays(today, -1), today).find(
      (item) => item.start <= now && now < item.end,
    );
    let open = null;
    if (running && running.productionDate >= query.from && running.productionDate <= query.to) {
      const buckets = await loadBuckets(db, tenantId, id, running.start, now);
      const summary = summarize(buckets, running, productiveWindows(running), now);
      open = {
        id: 'open',
        kind: 'shift',
        open: true,
        shift_id: running.shiftId,
        shift_name: running.name,
        production_date: running.productionDate,
        planned_start: running.start,
        planned_end: running.end,
        planned_seconds: running.plannedSeconds,
        pieces: summary.pieces,
        pallets: summary.pallets,
        tons: summary.tons,
        producing_s: summary.producing,
        idle_s: summary.idle,
        manual_s: summary.manual,
        offline_s: summary.offline,
        target_metric: config.target_metric,
        target_value: config.target_metric ? config.target_per_shift : null,
        products: summary.products,
      };
    }
    return {
      reports: open ? [open, ...reports.rows] : reports.rows,
      defaultShifts: isDefault,
      shiftNames: shifts.map((shift) => shift.name),
      targetMetric: config.target_metric,
    };
  });

  // "Gerar parcial agora": a snapshot of the running shift up to this moment, kept as a manual
  // row. The target is prorated to the planned time elapsed so the percentage stays fair.
  app.post('/api/devices/:id/shift-reports/snapshot', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const config = await loadConfig(db, current.tenantId, id);
    if (!config) return reply.code(404).send({ error: 'Device not found' });
    const now = new Date();
    const { shifts } = await loadShifts(db, current.tenantId, config.site_id);
    const today = plantDate(now);
    const running = expandShifts(shifts, addDays(today, -1), today).find(
      (item) => item.start <= now && now < item.end,
    );
    if (!running)
      return reply.code(400).send({ error: 'Nenhum turno em andamento agora para gerar a parcial.' });
    const windows = productiveWindows(running);
    const buckets = await loadBuckets(db, current.tenantId, id, running.start, now);
    const summary = summarize(buckets, running, windows, now);
    const planned = Math.round(productiveSecondsIn(windows, running.start, now));
    const clockNow = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
    const target =
      config.target_metric && config.target_per_shift && running.plannedSeconds > 0
        ? (config.target_per_shift * planned) / running.plannedSeconds
        : null;
    const inserted = await db.transaction(async (sql) => {
      const row = await sql.query<{ id: string }>(
        `INSERT INTO shift_reports(tenant_id,device_id,site_id,kind,source,shift_id,shift_name,
           production_date,planned_start,planned_end,planned_seconds,pieces,pallets,tons,
           producing_s,idle_s,manual_s,offline_s,target_metric,target_value,products)
         VALUES($1,$2,$3,'shift','manual',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
         RETURNING id`,
        [
          current.tenantId,
          id,
          config.site_id,
          running.shiftId,
          `${running.name} (parcial até ${clockNow})`,
          running.productionDate,
          running.start,
          now,
          planned,
          summary.pieces,
          summary.pallets,
          summary.tons,
          summary.producing,
          summary.idle,
          summary.manual,
          summary.offline,
          target == null ? null : config.target_metric,
          target,
          JSON.stringify(summary.products),
        ],
      );
      await recordAudit(sql, req, current, {
        action: 'shift_report.snapshot',
        targetType: 'device',
        targetId: id,
        summary: { shift: running.name, until: now.toISOString(), pieces: summary.pieces },
      });
      return row.rows[0].id;
    });
    return { id: inserted };
  });

  // "Recalcular período": rebuilds the automatic rows of a range from the production buckets,
  // for instance after wrong readings were wiped. Deleted automatic rows come back too.
  app.post('/api/devices/:id/shift-reports/recalculate', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const body = z.object({ from: z.iso.date(), to: z.iso.date() }).parse(req.body);
    if (body.to < body.from) return reply.code(400).send({ error: 'Período inválido' });
    if (addDays(body.from, 62) < body.to)
      return reply.code(400).send({ error: 'Recalcule no máximo 62 dias por vez' });
    const current = access.principal(req);
    await db.query(
      `DELETE FROM shift_reports WHERE tenant_id=$1 AND device_id=$2 AND source='auto'
       AND production_date BETWEEN $3 AND $4`,
      [current.tenantId, id, body.from, body.to],
    );
    const written = await closeShiftReports(db, new Date(), {
      deviceId: id,
      fromDate: body.from,
      toDate: body.to,
    });
    await recordAudit(db, req, current, {
      action: 'shift_report.recalculate',
      targetType: 'device',
      targetId: id,
      summary: { ...body, written },
    });
    return { written };
  });

  // Removing rows hides them (automatic ones are then not written again by the close).
  app.delete('/api/devices/:id/shift-reports', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const body = z.object({ ids: z.array(uuid).min(1).max(500) }).parse(req.body);
    const current = access.principal(req);
    const removed = await db.transaction(async (sql) => {
      const result = await sql.query(
        `UPDATE shift_reports SET deleted_at=now()
         WHERE tenant_id=$1 AND device_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL`,
        [current.tenantId, id, body.ids],
      );
      await recordAudit(sql, req, current, {
        action: 'shift_report.delete',
        targetType: 'device',
        targetId: id,
        summary: { ids: body.ids, removed: result.rowCount ?? 0 },
      });
      return result.rowCount ?? 0;
    });
    return { removed };
  });
}
