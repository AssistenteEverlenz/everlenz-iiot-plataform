import type { Database } from '@iiot/database';
import { plantDate, plantInstant } from '@iiot/shared';
import { HAS_READINGS_SQL } from './shift-production.js';

// Retention: readings are the raw material of the live shift and of a recount; once a period is
// closed its history is kept as a photo (production_photos), plus the 5-minute production
// buckets, the hourly rollups and the shift reports, which stay forever. So:
//   - readings older than the grace period go, never before every closed period they belong to
//     has its photo (a shift that could not be photographed yet holds its readings back);
//   - raw MQTT copies (only diagnosis and problems since migration 027) go after a week.
// Deletes run in small batches so they never hold the ingestion back.

export const READINGS_GRACE_DAYS = 3;
export const RAW_KEEP_DAYS = 7;
const DAY_MS = 86_400_000;
const BATCH = 5_000;
const MAX_BATCHES = 40;

/** How far back this device's readings may go: the grace period, or its oldest unphotographed period. */
async function deviceCutoff(db: Database, deviceId: string, grace: Date, now: Date) {
  const blockers = await db.query<{ shift_start: Date | null; day: string | null }>(
    `SELECT
       (SELECT min(r.planned_start) FROM shift_reports r
        WHERE r.device_id=$1 AND r.source='auto' AND r.deleted_at IS NULL
          AND r.kind IN ('shift','off_shift') AND r.planned_end<$2
          AND NOT EXISTS (SELECT 1 FROM production_photos p WHERE p.device_id=r.device_id
            AND p.kind=r.kind AND p.period_start=r.planned_start AND p.period_end=r.planned_end)
          AND ${HAS_READINGS_SQL('r.device_id', 'r.planned_start', 'r.planned_end')}) AS shift_start,
       (SELECT min(r.production_date)::text FROM shift_reports r
        WHERE r.device_id=$1 AND r.source='auto' AND r.deleted_at IS NULL AND r.kind='shift'
          AND r.production_date<$3
          AND NOT EXISTS (SELECT 1 FROM production_photos p WHERE p.device_id=r.device_id
            AND p.kind='day' AND p.production_date=r.production_date)
          AND ${HAS_READINGS_SQL('r.device_id', 'r.planned_start', 'r.planned_end')}) AS day`,
    [deviceId, grace, plantDate(now)],
  );
  let cutoff = grace.getTime();
  const { shift_start: shiftStart, day } = blockers.rows[0] ?? {};
  if (shiftStart) cutoff = Math.min(cutoff, new Date(shiftStart).getTime());
  if (day) cutoff = Math.min(cutoff, plantInstant(day, '00:00').getTime());
  return new Date(cutoff);
}

async function deleteInBatches(db: Database, sql: string, params: unknown[]) {
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const result = await db.query(sql, params);
    removed += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < BATCH) break;
  }
  return removed;
}

export async function pruneReadings(db: Database, now = new Date()) {
  const grace = new Date(now.getTime() - READINGS_GRACE_DAYS * DAY_MS);
  const devices = await db.query<{ id: string }>('SELECT id FROM devices');
  let readings = 0;
  for (const device of devices.rows) {
    const cutoff = await deviceCutoff(db, device.id, grace, now);
    readings += await deleteInBatches(
      db,
      `DELETE FROM telemetry_samples WHERE id IN (
         SELECT id FROM telemetry_samples WHERE device_id=$1 AND timestamp<$2 LIMIT ${BATCH})`,
      [device.id, cutoff],
    );
  }
  const raw = await deleteInBatches(
    db,
    `DELETE FROM mqtt_messages_raw WHERE id IN (
       SELECT id FROM mqtt_messages_raw WHERE received_at<$1 LIMIT ${BATCH})`,
    [new Date(now.getTime() - RAW_KEEP_DAYS * DAY_MS)],
  );
  return { readings, raw };
}
