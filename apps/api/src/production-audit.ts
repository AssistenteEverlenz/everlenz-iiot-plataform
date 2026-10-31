import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import {
  addDays,
  BUCKET_SECONDS,
  counterLimit,
  expandShifts,
  plantDate,
  plantInstant,
  productiveWindows,
} from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';
import { loadConfig, loadShifts, recountPeriod, recountProduction } from './shift-production.js';

/**
 * The production check (migration 055): the platform as the detective of its own counts.
 *
 * On 28/10/2026 a second HMI on Cerâmica Capixaba's credential made one shift read 6 million
 * pieces, and nobody would have known but for a month that came out at 22,000 t. Every four
 * hours, and whenever the master presses "Verificar dados", each line is checked for:
 *
 *  - recount: a closed day whose stored count differs from a recount of the readings (only
 *    while the readings exist, three days): the recount applies the counter limit, so a day
 *    the limit would have saved is corrected by counting it again;
 *  - jump: a bucket that climbed more than any line can in the time it had;
 *  - late_burst: production arriving at once after the HMI was offline. It is real (the PLC
 *    kept counting), only the time is wrong: the correction spreads it over the shift time of
 *    the gap, which may be the day before;
 *  - suspicious: a bucket far above what the line usually makes, but possible; the master
 *    decides;
 *  - report_mismatch: a day whose shift rows do not add up to its buckets.
 *
 * What is certain is corrected on its own (recount where the limit refused steps, report
 * rows); the rest waits for the master with the correction proposed. Each correction keeps
 * the values before and after.
 */

type Access = ReturnType<typeof createAccessControl>;
type Counter = 'pieces' | 'pallets' | 'tons';
type Totals = Record<Counter, number>;
export type AnomalyKind =
  'refused_step' | 'recount' | 'jump' | 'late_burst' | 'suspicious' | 'report_mismatch';

interface Finding {
  kind: Exclude<AnomalyKind, 'refused_step'>;
  counter: Counter | 'all';
  windowStart: Date;
  windowEnd: Date;
  productionDate: string;
  amount: number;
  details: Record<string, unknown>;
  autoFix: boolean;
}

const BUCKET_MS = BUCKET_SECONDS * 1000;
/** A silence this long before a big bucket makes it a late arrival, not a jump. */
const LATE_GAP_MS = 15 * 60 * 1000;
/** Far above the line's own busy buckets (95th percentile, so a few bursts cannot raise it). */
const SUSPICIOUS_FACTOR = 4;
const MINIMUM: Totals = { pieces: 200, pallets: 4, tons: 1 };
/** How far back the scheduled check looks; the master can ask for up to 62 days. */
const SCHEDULED_DAYS = 14;

const missingTable = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '42P01';
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const zero = (): Totals => ({ pieces: 0, pallets: 0, tons: 0 });

/** A day differs when the gap is beyond rounding: 1 % or a few units, whichever is larger. */
function differs(a: Totals, b: Totals) {
  const beyond = (x: number, y: number, floor: number) =>
    Math.abs(x - y) > Math.max(floor, Math.max(Math.abs(x), Math.abs(y)) * 0.01);
  return (
    beyond(a.pieces, b.pieces, 50) || beyond(a.pallets, b.pallets, 1) || beyond(a.tons, b.tons, 0.5)
  );
}

function percentile(values: number[], share: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}

type BucketRow = {
  bucket: number;
  totals: Totals;
  active: number;
};

async function storedBuckets(
  db: Database,
  tenantId: string,
  deviceId: string,
  from: Date,
  until: Date,
): Promise<BucketRow[]> {
  const rows = await db.query<{
    bucket: Date;
    pieces: number;
    pallets: number;
    tons: number;
    active: number;
  }>(
    `SELECT bucket,sum(pieces)::float8 pieces,sum(pallets)::float8 pallets,sum(tons)::float8 tons,
       sum(producing_s+idle_s+manual_s)::float8 active
     FROM production_buckets WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4
     GROUP BY bucket ORDER BY bucket`,
    [tenantId, deviceId, from, until],
  );
  return rows.rows.map((row) => ({
    bucket: new Date(row.bucket).getTime(),
    totals: { pieces: Number(row.pieces), pallets: Number(row.pallets), tons: Number(row.tons) },
    active: Number(row.active),
  }));
}

function byDay(rows: Array<{ bucket: number; totals: Totals }>) {
  const days = new Map<string, Totals>();
  for (const row of rows) {
    const date = plantDate(new Date(row.bucket));
    const day = days.get(date) ?? zero();
    day.pieces += row.totals.pieces;
    day.pallets += row.totals.pallets;
    day.tons += row.totals.tons;
    days.set(date, day);
  }
  return days;
}

/** Everything wrong with one line's counts between two closed plant days. */
export async function auditDevice(
  db: Database,
  tenantId: string,
  deviceId: string,
  from: string,
  to: string,
): Promise<Finding[]> {
  const config = await loadConfig(db, tenantId, deviceId);
  if (!config || (!config.blocks_tag_id && !config.pallets_tag_id)) return [];
  const counters: Counter[] = [
    ...(config.blocks_tag_id ? (['pieces'] as const) : []),
    ...(config.pallets_tag_id ? (['pallets'] as const) : []),
    ...(config.tons_total_tag_id ? (['tons'] as const) : []),
  ];
  const start = plantInstant(from, '00:00');
  const until = plantInstant(addDays(to, 1), '00:00');
  const findings: Finding[] = [];
  const recounted = new Set<string>();

  // 1. Days the readings still cover: count them again and compare.
  const recount = await recountProduction(db, tenantId, deviceId, { from: start, until });
  const stored = await storedBuckets(db, tenantId, deviceId, start, until);
  const storedDays = byDay(stored);
  if (recount) {
    // Only days the readings cover hour by hour: the pruning removes old periods piece by
    // piece, and a recount over a hole would read as a day without production.
    const sampled = await db.query<{ at: Date }>(
      `SELECT DISTINCT date_trunc('hour',received_at) AS at FROM telemetry_samples
       WHERE tenant_id=$1 AND device_id=$2 AND received_at>=$3 AND received_at<$4`,
      [tenantId, deviceId, start, until],
    );
    const hours = new Set(sampled.rows.map((row) => new Date(row.at).getTime()));
    const covered = (date: string) =>
      stored
        .filter((row) => plantDate(new Date(row.bucket)) === date)
        .filter((row) => row.active > 0 || row.totals.pieces > 0 || row.totals.pallets > 0)
        .every((row) => hours.has(Math.floor(row.bucket / 3600000) * 3600000));
    // Only whole days: the first reading's own day starts before the readings do.
    const firstDay = addDays(plantDate(new Date(recount.firstAt)), 1);
    const recountDays = byDay(
      recount.deltas.map((delta) => ({
        bucket: delta.bucket,
        totals: { pieces: delta.pieces, pallets: delta.pallets, tons: delta.tons },
      })),
    );
    for (let date = firstDay > from ? firstDay : from; date <= to; date = addDays(date, 1)) {
      if (!covered(date)) continue;
      const before = storedDays.get(date) ?? zero();
      const after = recountDays.get(date) ?? zero();
      if (!differs(before, after)) {
        recounted.add(date);
        continue;
      }
      const refused = recount.rejected.filter((step) => plantDate(new Date(step.at)) === date);
      recounted.add(date);
      findings.push({
        kind: 'recount',
        counter: 'all',
        windowStart: plantInstant(date, '00:00'),
        windowEnd: plantInstant(addDays(date, 1), '00:00'),
        productionDate: date,
        amount: round(before.pieces - after.pieces),
        details: {
          stored: mapTotals(before),
          recount: mapTotals(after),
          refused: refused.length,
          refusedFirst: refused[0] ? new Date(refused[0].at).toISOString() : null,
        },
        // The limit explains the difference: counting again is the same rule the line now
        // runs under, so it is applied without asking.
        autoFix: refused.length > 0,
      });
    }
  }

  // 2. Days only the buckets are left of: impossible, late and unusual buckets.
  const history = await storedBuckets(
    db,
    tenantId,
    deviceId,
    new Date(start.getTime() - 30 * 86400000),
    until,
  );
  const busiest = Object.fromEntries(
    counters.map((counter) => [
      counter,
      percentile(
        history.map((row) => row.totals[counter]).filter((value) => value > 0),
        0.95,
      ),
    ]),
  ) as Totals;
  const typical = Object.fromEntries(
    counters.map((counter) => [
      counter,
      percentile(
        history.map((row) => row.totals[counter]).filter((value) => value > 0),
        0.5,
      ),
    ]),
  ) as Totals;
  const { shifts } = await loadShifts(db, tenantId, config.site_id);
  const windows = expandShifts(shifts, addDays(from, -2), to).flatMap(productiveWindows);
  let lastSeen: number | null = null;
  for (const row of history) {
    const seenBefore = lastSeen;
    if (row.active > 0 || row.totals.pieces > 0 || row.totals.pallets > 0) lastSeen = row.bucket;
    if (row.bucket < start.getTime()) continue;
    const date = plantDate(new Date(row.bucket));
    // A day the recount will correct is left to it. A day the recount confirms has the right
    // quantities, but production that arrived late still sits at the wrong time.
    if (findings.some((item) => item.kind === 'recount' && item.productionDate === date)) continue;
    const confirmed = recounted.has(date);
    const gap = seenBefore == null ? 0 : Math.max(0, row.bucket - (seenBefore + BUCKET_MS));
    const seconds = (gap + BUCKET_MS) / 1000;
    const late = gap >= LATE_GAP_MS;
    let burst = false;
    for (const counter of counters) {
      const value = row.totals[counter];
      if (value <= 0) continue;
      const unusual = value > Math.max(busiest[counter] * SUSPICIOUS_FACTOR, MINIMUM[counter]);
      if (confirmed) {
        if (late && unusual) burst = true;
        continue;
      }
      if (value > counterLimit(counter, seconds)) {
        findings.push({
          kind: 'jump',
          counter,
          windowStart: new Date(row.bucket),
          windowEnd: new Date(row.bucket + BUCKET_MS),
          productionDate: date,
          amount: round(value),
          details: {
            value: round(value),
            limit: round(counterLimit(counter, seconds)),
            typical: round(typical[counter]),
            busiest: round(busiest[counter]),
            gapMinutes: Math.round(gap / 60000),
            proposed: round(typical[counter]),
          },
          autoFix: false,
        });
      } else if (late && unusual) burst = true;
      else if (unusual)
        findings.push({
          kind: 'suspicious',
          counter,
          windowStart: new Date(row.bucket),
          windowEnd: new Date(row.bucket + BUCKET_MS),
          productionDate: date,
          amount: round(value),
          details: {
            value: round(value),
            typical: round(typical[counter]),
            busiest: round(busiest[counter]),
            proposed: round(typical[counter]),
          },
          autoFix: false,
        });
    }
    if (burst && seenBefore != null) {
      // The shift time inside the silence, bucket by bucket: where the production really was.
      const gapStart = seenBefore + BUCKET_MS;
      const targets: number[] = [];
      for (let at = gapStart; at < row.bucket; at += BUCKET_MS)
        if (windows.some((window) => at >= window.start.getTime() && at < window.end.getTime()))
          targets.push(at);
      findings.push({
        kind: 'late_burst',
        counter: 'all',
        windowStart: new Date(row.bucket),
        windowEnd: new Date(row.bucket + BUCKET_MS),
        productionDate: date,
        amount: round(row.totals.pieces || row.totals.pallets),
        details: {
          value: mapTotals(row.totals),
          offlineFrom: new Date(gapStart).toISOString(),
          gapMinutes: Math.round(gap / 60000),
          targets: targets.length,
          targetDates: [...new Set(targets.map((at) => plantDate(new Date(at))))],
          busiest: mapTotals(busiest),
        },
        autoFix: false,
      });
    }
  }

  // 3. Shift rows that no longer add up to their buckets. A day someone removed rows from is
  // the master's choice and stays as it is.
  const reports = await db.query<{
    production_date: string;
    pieces: number;
    pallets: number;
    tons: number;
    removed: number;
  }>(
    `SELECT to_char(production_date,'YYYY-MM-DD') production_date,
       coalesce(sum(pieces) FILTER (WHERE deleted_at IS NULL),0)::float8 pieces,
       coalesce(sum(pallets) FILTER (WHERE deleted_at IS NULL),0)::float8 pallets,
       coalesce(sum(tons) FILTER (WHERE deleted_at IS NULL),0)::float8 tons,
       count(*) FILTER (WHERE deleted_at IS NOT NULL)::int removed
     FROM shift_reports WHERE tenant_id=$1 AND device_id=$2 AND source='auto'
       AND production_date BETWEEN $3 AND $4
     GROUP BY production_date`,
    [tenantId, deviceId, from, to],
  );
  const reportDays = new Map(reports.rows.map((row) => [row.production_date, row]));
  const fixedByRecount = new Set(
    findings.filter((item) => item.kind === 'recount').map((item) => item.productionDate),
  );
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (fixedByRecount.has(date)) continue;
    const report = reportDays.get(date);
    if (report?.removed) continue;
    const reported: Totals = {
      pieces: Number(report?.pieces ?? 0),
      pallets: Number(report?.pallets ?? 0),
      tons: Number(report?.tons ?? 0),
    };
    const counted = storedDays.get(date) ?? zero();
    if (!differs(reported, counted)) continue;
    findings.push({
      kind: 'report_mismatch',
      counter: 'all',
      windowStart: plantInstant(date, '00:00'),
      windowEnd: plantInstant(addDays(date, 1), '00:00'),
      productionDate: date,
      amount: round(reported.pieces - counted.pieces),
      details: { reported: mapTotals(reported), buckets: mapTotals(counted) },
      // The rows are written from the buckets; writing them again is what the close does.
      autoFix: true,
    });
  }
  return findings;
}

function mapTotals(totals: Totals) {
  return {
    pieces: round(totals.pieces, 1),
    pallets: round(totals.pallets, 1),
    tons: round(totals.tons),
  };
}

/**
 * Stores what the check found. A finding already corrected or accepted is never reopened; an
 * open one the check no longer finds (the data was fixed meanwhile) is closed.
 */
async function storeFindings(
  db: Database,
  tenantId: string,
  deviceId: string,
  from: string,
  to: string,
  findings: Finding[],
) {
  const ids: Array<{ id: string; autoFix: boolean }> = [];
  for (const finding of findings) {
    const row = await db.query<{ id: string; status: string }>(
      `INSERT INTO production_anomalies(tenant_id,device_id,kind,counter,window_start,window_end,
         production_date,amount,details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(device_id,kind,counter,window_start) DO UPDATE SET
         amount=CASE WHEN production_anomalies.status='open' THEN EXCLUDED.amount ELSE production_anomalies.amount END,
         details=CASE WHEN production_anomalies.status='open' THEN EXCLUDED.details ELSE production_anomalies.details END,
         detected_at=CASE WHEN production_anomalies.status='open' THEN now() ELSE production_anomalies.detected_at END
       RETURNING id::text,status`,
      [
        tenantId,
        deviceId,
        finding.kind,
        finding.counter,
        finding.windowStart,
        finding.windowEnd,
        finding.productionDate,
        finding.amount,
        JSON.stringify({ ...finding.details, autoFix: finding.autoFix }),
      ],
    );
    if (row.rows[0]?.status === 'open') ids.push({ id: row.rows[0].id, autoFix: finding.autoFix });
  }
  await db.query(
    `UPDATE production_anomalies SET status='fixed',resolved_at=now(),
       resolution='{"by":"verificação","note":"não aparece mais"}'::jsonb
     WHERE tenant_id=$1 AND device_id=$2 AND status='open' AND kind<>'refused_step'
       AND production_date BETWEEN $3 AND $4 AND NOT (id::text = ANY($5::text[]))`,
    [tenantId, deviceId, from, to, ids.map((item) => item.id)],
  );
  return ids;
}

type AnomalyRow = {
  id: string;
  tenant_id: string;
  device_id: string;
  kind: AnomalyKind;
  counter: Counter | 'all';
  window_start: Date;
  window_end: Date;
  production_date: string | null;
  amount: number;
  details: Record<string, unknown>;
  status: 'open' | 'fixed' | 'accepted';
};

async function bucketsOf(db: Database, row: AnomalyRow) {
  return (
    await db.query<{ product_code: string; pieces: number; pallets: number; tons: number }>(
      `SELECT product_code,pieces::float8 pieces,pallets::float8 pallets,tons::float8 tons
       FROM production_buckets WHERE tenant_id=$1 AND device_id=$2 AND bucket=$3`,
      [row.tenant_id, row.device_id, row.window_start],
    )
  ).rows.map((item) => ({
    product: item.product_code,
    pieces: Number(item.pieces),
    pallets: Number(item.pallets),
    tons: Number(item.tons),
  }));
}

/** Whole units split as evenly as they go: 17 pallets over 9 buckets is 2,2,2,2,2,2,2,2,1. */
function split(value: number, parts: number, whole: boolean) {
  if (!whole) return Array.from({ length: parts }, () => value / parts);
  const base = Math.floor(value / parts);
  let left = Math.round(value - base * parts);
  return Array.from({ length: parts }, () => base + (left-- > 0 ? 1 : 0));
}

/**
 * Applies the correction a finding proposes and records what changed. Returns the days whose
 * totals moved.
 */
export async function fixAnomaly(db: Database, row: AnomalyRow) {
  const date = row.production_date ?? plantDate(new Date(row.window_start));
  if (row.kind === 'recount') {
    await recountPeriod(db, row.tenant_id, row.device_id, date, date);
    return { dates: [date], change: { recount: row.details.recount } };
  }
  if (row.kind === 'report_mismatch') {
    await recountPeriod(db, row.tenant_id, row.device_id, date, date, { rebuild: false });
    return { dates: [date], change: { reports: row.details.buckets } };
  }
  const before = await bucketsOf(db, row);
  if (row.kind === 'jump' || row.kind === 'suspicious') {
    const counter = row.counter as Counter;
    const current = before.reduce((sum, item) => sum + item[counter], 0);
    const proposed = Number(row.details.proposed ?? 0);
    const factor = current > 0 ? Math.min(1, proposed / current) : 0;
    const config = await loadConfig(db, row.tenant_id, row.device_id);
    // Tons worked out from the pieces follow them; a tons counter of its own stays.
    const tonsFollow = counter === 'pieces' && !config?.tons_total_tag_id;
    for (const item of before)
      await db.query(
        `UPDATE production_buckets SET ${counter}=$5${tonsFollow ? ',tons=tons*$6' : ''}
         WHERE tenant_id=$1 AND device_id=$2 AND bucket=$3 AND product_code=$4`,
        [
          row.tenant_id,
          row.device_id,
          row.window_start,
          item.product,
          counter === 'tons' ? item[counter] * factor : Math.round(item[counter] * factor),
          ...(tonsFollow ? [factor] : []),
        ],
      );
    await recountPeriod(db, row.tenant_id, row.device_id, date, date, { rebuild: false });
    return { dates: [date], change: { before, factor: round(factor, 4) } };
  }
  if (row.kind === 'late_burst') {
    const config = await loadConfig(db, row.tenant_id, row.device_id);
    if (!config) return { dates: [], change: {} };
    const { shifts } = await loadShifts(db, row.tenant_id, config.site_id);
    const gapStart = new Date(String(row.details.offlineFrom)).getTime();
    const windows = expandShifts(shifts, addDays(plantDate(new Date(gapStart)), -1), date).flatMap(
      productiveWindows,
    );
    const targets: number[] = [];
    for (let at = gapStart; at < new Date(row.window_start).getTime(); at += BUCKET_MS)
      if (windows.some((window) => at >= window.start.getTime() && at < window.end.getTime()))
        targets.push(at);
    if (!targets.length) return { dates: [], change: {} };
    // The late bucket keeps one share, the shift buckets of the silence get the rest.
    const slots = [...targets, new Date(row.window_start).getTime()];
    await db.transaction(async (sql) => {
      for (const item of before) {
        const pieces = split(item.pieces, slots.length, true);
        const pallets = split(item.pallets, slots.length, true);
        const tons = split(item.tons, slots.length, false);
        for (const [index, at] of slots.entries())
          await sql.query(
            `INSERT INTO production_buckets(tenant_id,device_id,bucket,product_code,pieces,pallets,tons,
               producing_s,idle_s,manual_s)
             VALUES($1,$2,$3,$4,$5,$6,$7,0,0,0)
             ON CONFLICT(device_id,bucket,product_code) DO UPDATE SET
               pieces=CASE WHEN production_buckets.bucket=$8 THEN EXCLUDED.pieces ELSE production_buckets.pieces+EXCLUDED.pieces END,
               pallets=CASE WHEN production_buckets.bucket=$8 THEN EXCLUDED.pallets ELSE production_buckets.pallets+EXCLUDED.pallets END,
               tons=CASE WHEN production_buckets.bucket=$8 THEN EXCLUDED.tons ELSE production_buckets.tons+EXCLUDED.tons END`,
            [
              row.tenant_id,
              row.device_id,
              new Date(at),
              item.product,
              pieces[index],
              pallets[index],
              tons[index],
              row.window_start,
            ],
          );
      }
    });
    const dates = [...new Set(slots.map((at) => plantDate(new Date(at))))].sort();
    await recountPeriod(db, row.tenant_id, row.device_id, dates[0], dates.at(-1)!, {
      rebuild: false,
    });
    return { dates, change: { before, spreadOver: targets.length } };
  }
  return { dates: [], change: {} };
}

async function resolve(
  db: Database,
  row: AnomalyRow,
  action: 'fix' | 'accept',
  by: { id: string | null; label: string },
) {
  const outcome = action === 'fix' ? await fixAnomaly(db, row) : { dates: [], change: {} };
  await db.query(
    `UPDATE production_anomalies SET status=$2,resolved_at=now(),resolved_by=$3,resolution=$4
     WHERE id=$1`,
    [
      row.id,
      action === 'fix' ? 'fixed' : 'accepted',
      by.id,
      JSON.stringify({ by: by.label, action, ...outcome }),
    ],
  );
  return outcome;
}

async function loadAnomaly(db: Database, tenantId: string, id: string) {
  const result = await db.query<AnomalyRow>(
    `SELECT id::text,tenant_id,device_id,kind,counter,window_start,window_end,
       to_char(production_date,'YYYY-MM-DD') production_date,amount::float8 amount,details,status
     FROM production_anomalies WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  return result.rows[0] ?? null;
}

/** Checks one line over a period, stores the findings and applies the certain corrections. */
export async function checkDevice(
  db: Database,
  tenantId: string,
  deviceId: string,
  from: string,
  to: string,
) {
  const findings = await auditDevice(db, tenantId, deviceId, from, to);
  const stored = await storeFindings(db, tenantId, deviceId, from, to, findings);
  let fixed = 0;
  for (const item of stored.filter((entry) => entry.autoFix)) {
    const row = await loadAnomaly(db, tenantId, item.id);
    if (!row || row.status !== 'open') continue;
    await resolve(db, row, 'fix', { id: null, label: 'verificação automática' });
    fixed += 1;
  }
  return { found: findings.length, fixed };
}

/** The scheduled pass: every line with production configured, the last two weeks. */
export async function runProductionAudit(
  db: Database,
  log: { info: (entry: object) => void; warn: (entry: object) => void },
) {
  const devices = await db.query<{ tenant_id: string; device_id: string }>(
    `SELECT ps.tenant_id,ps.device_id FROM production_settings ps
     JOIN devices d ON d.id=ps.device_id AND d.tenant_id=ps.tenant_id AND d.archived_at IS NULL
     WHERE ps.blocks_tag_id IS NOT NULL OR ps.pallets_tag_id IS NOT NULL`,
  );
  const to = addDays(plantDate(new Date()), -1);
  const from = addDays(to, -(SCHEDULED_DAYS - 1));
  for (const device of devices.rows) {
    try {
      const result = await checkDevice(db, device.tenant_id, device.device_id, from, to);
      if (result.found)
        log.info({ event: 'production_audit', deviceId: device.device_id, ...result });
    } catch (error) {
      if (missingTable(error)) return;
      log.warn({
        event: 'production_audit_failed',
        deviceId: device.device_id,
        message: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    }
  }
}

export function registerProductionAuditRoutes(app: FastifyInstance, db: Database, access: Access) {
  const uuid = z.string().uuid();

  const list = async (tenantId: string, deviceId: string, from: string, to: string) => {
    try {
      const rows = await db.query<
        AnomalyRow & {
          detected_at: Date;
          resolved_at: Date | null;
          resolution: unknown;
          occurrences: number;
        }
      >(
        `SELECT id::text,tenant_id,device_id,kind,counter,window_start,window_end,
           to_char(coalesce(production_date,(window_start AT TIME ZONE 'America/Sao_Paulo')::date),'YYYY-MM-DD') production_date,
           amount::float8 amount,details,status,occurrences,detected_at,resolved_at,resolution
         FROM production_anomalies
         WHERE tenant_id=$1 AND device_id=$2
           AND window_start>=$3 AND window_start<$4
         ORDER BY window_start DESC LIMIT 300`,
        [tenantId, deviceId, plantInstant(from, '00:00'), plantInstant(addDays(to, 1), '00:00')],
      );
      return rows.rows;
    } catch (error) {
      if (missingTable(error)) return [];
      throw error;
    }
  };

  const period = z.object({ from: z.iso.date(), to: z.iso.date() });

  app.get('/api/devices/:id/production-anomalies', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = period.parse(req.query);
    return list(access.principal(req).tenantId, id, query.from, query.to);
  });

  app.post('/api/devices/:id/production-audit', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const body = period.parse(req.body);
    // Today is still running: it is checked once it closes.
    const to = body.to < plantDate(new Date()) ? body.to : addDays(plantDate(new Date()), -1);
    if (to < body.from) return reply.code(400).send({ error: 'Escolha dias já encerrados' });
    if (addDays(body.from, 62) < to)
      return reply.code(400).send({ error: 'Verifique no máximo 62 dias por vez' });
    const current = access.principal(req);
    const result = await checkDevice(db, current.tenantId, id, body.from, to);
    await recordAudit(db, req, current, {
      action: 'production.audit',
      targetType: 'device',
      targetId: id,
      summary: { from: body.from, to, ...result },
    });
    return { ...result, anomalies: await list(current.tenantId, id, body.from, to) };
  });

  app.post('/api/production-anomalies/:id/resolve', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const body = z.object({ action: z.enum(['fix', 'accept']) }).parse(req.body);
    const current = access.principal(req);
    const row = await loadAnomaly(db, current.tenantId, id);
    if (!row) return reply.code(404).send({ error: 'Aviso não encontrado' });
    if (!(await access.requireDevice(req, reply, row.device_id))) return;
    if (row.status !== 'open') return reply.code(409).send({ error: 'Este aviso já foi tratado' });
    if (body.action === 'fix' && row.kind === 'refused_step')
      return reply
        .code(400)
        .send({ error: 'A trava já segurou este salto; não há o que corrigir' });
    if (body.action === 'fix' && row.kind === 'late_burst' && !Number(row.details.targets))
      return reply
        .code(400)
        .send({ error: 'Não há horário de turno no intervalo para onde levar esta produção' });
    const outcome = await resolve(db, row, body.action, { id: current.id, label: current.email });
    await recordAudit(db, req, current, {
      action: body.action === 'fix' ? 'production.anomaly_fix' : 'production.anomaly_accept',
      targetType: 'device',
      targetId: row.device_id,
      summary: { anomaly: row.id, kind: row.kind, date: row.production_date, ...outcome },
    });
    return outcome;
  });
}
