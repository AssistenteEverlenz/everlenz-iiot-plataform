import { createApp } from './app.js';
import { env } from '@iiot/shared';
import { database, pool } from '@iiot/database';
import { startLegacyMqttProxy, type LegacyDevice } from './legacy-mqtt.js';
import {
  backfillProduction,
  captureProductionPhotos,
  closeShiftReports,
} from './shift-production.js';
import { pruneReadings } from './retention.js';
const app = await createApp();
await app.listen({ port: env.API_PORT, host: process.env.API_HOST ?? '127.0.0.1' });

// Plain-MQTT compatibility port for legacy HMIs; closed unless MQTT_LEGACY_PORT is set.
// A release made on the device page reaches the port within the lookup cache's lifetime.
const LEGACY_LOOKUP_TTL_MS = 10000;
const legacyLookups = new Map<string, { at: number; device: LegacyDevice | null }>();
const legacyProxy = env.MQTT_LEGACY_PORT
  ? startLegacyMqttProxy({
      port: env.MQTT_LEGACY_PORT,
      upstreamHost: env.MQTT_INTERNAL_HOST || env.MQTT_HOST,
      upstreamPort: env.MQTT_PORT,
      async lookup(username) {
        const key = username.toLowerCase();
        const cached = legacyLookups.get(key);
        if (cached && Date.now() - cached.at < LEGACY_LOOKUP_TTL_MS) return cached.device;
        const result = await database.query<{
          id: string;
          tenant_id: string;
          legacy_plain_mqtt: boolean;
          legacy_allowed_ips: string[];
        }>(
          `SELECT id,tenant_id,legacy_plain_mqtt,legacy_allowed_ips FROM devices
           WHERE archived_at IS NULL AND COALESCE(mqtt_username,lower(device_code))=$1 LIMIT 1`,
          [key],
        );
        const row = result.rows[0];
        const device = row
          ? {
              deviceId: row.id,
              tenantId: row.tenant_id,
              legacy: row.legacy_plain_mqtt,
              allowedIps: row.legacy_allowed_ips ?? [],
            }
          : null;
        legacyLookups.set(key, { at: Date.now(), device });
        return device;
      },
      // The plant's public address changed and the HMI proved it has the device's password:
      // the address joins the device's list by itself, the newest five are kept, and the
      // release is written to the audit trail as done by the platform.
      async autoAllow(device, ip) {
        await database.query(
          `UPDATE devices
           SET legacy_allowed_ips=(
                 SELECT CASE WHEN array_length(kept,1) > 5
                   THEN kept[array_length(kept,1)-4:array_length(kept,1)] ELSE kept END
                 FROM (SELECT array_remove(legacy_allowed_ips,$3::text) || $3::text kept) list
               ),
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL`,
          [device.tenantId, device.deviceId, ip],
        );
        await database.query(
          'DELETE FROM device_legacy_attempts WHERE tenant_id=$1 AND device_id=$2 AND source_ip=$3',
          [device.tenantId, device.deviceId, ip],
        );
        await database.query(
          `INSERT INTO audit_log(tenant_id,actor_email,actor_role,action,target_type,target_id,
             summary,ip_address)
           VALUES($1,'plataforma','master','device.legacy_ip.auto_allow','device',$2,$3::jsonb,$4)`,
          [device.tenantId, device.deviceId, JSON.stringify({ ip }), ip],
        );
        // The proxy caches the device for a while: drop it so the new address is seen at once.
        legacyLookups.clear();
      },
      async recordAttempt(device, ip) {
        await database.query(
          `INSERT INTO device_legacy_attempts(tenant_id,device_id,source_ip) VALUES($1,$2,$3)
           ON CONFLICT(device_id,source_ip) DO UPDATE
           SET last_seen_at=now(),attempts=device_legacy_attempts.attempts+1`,
          [device.tenantId, device.deviceId, ip],
        );
      },
      log: { info: (entry) => app.log.info(entry), warn: (entry) => app.log.warn(entry) },
    })
  : null;

// Closes finished shifts into immutable reports (apps/api/src/shift-production.ts). Every 5
// minutes is enough: a report only has to exist before someone reads the history.
// The API log is not reachable from outside (only the ingestor's is): a background job that
// fails leaves its reason in the audit trail, where it can be read from the database.
async function recordJobFailure(job: string, error: unknown) {
  await database
    .query(
      `INSERT INTO audit_log(tenant_id,actor_email,actor_role,action,target_type,target_id,summary)
       SELECT id,'sistema@plataforma','master','system.job_failed','job',$1,$2::jsonb FROM tenants`,
      [
        job,
        JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : String(error) }),
      ],
    )
    .catch(() => undefined);
}

let closingShifts = false;
async function closeShifts() {
  if (closingShifts) return;
  closingShifts = true;
  try {
    const written = await closeShiftReports(database);
    if (written) app.log.info({ event: 'shift_reports_closed', written });
    // Right after the close, while the readings are there: the photo the history will read.
    const photos = await captureProductionPhotos(database);
    if (photos) app.log.info({ event: 'production_photos_taken', photos });
  } catch (error) {
    app.log.warn({
      event: 'shift_report_close_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    await recordJobFailure('close_and_photograph', error);
  } finally {
    closingShifts = false;
  }
}
// Every minute: when a shift ends, its row replaces the "em andamento" one in the history
// almost at once, instead of leaving the day without a row (and its target) for minutes.
const shiftTimer = setInterval(() => void closeShifts(), 60 * 1000);
shiftTimer.unref();
setTimeout(() => void closeShifts(), 20_000).unref();
// Production counted from all the stored telemetry, also for devices configured after it came.
setTimeout(
  () =>
    void backfillProduction(database, app.log).catch((error) =>
      app.log.warn({
        event: 'production_backfill_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
  40_000,
).unref();

// Readings of closed, photographed periods past the grace period, and old raw copies
// (apps/api/src/retention.ts). Every 15 minutes, in small batches.
let pruning = false;
async function prune() {
  if (pruning) return;
  pruning = true;
  try {
    const removed = await pruneReadings(database);
    if (removed.readings || removed.raw) app.log.info({ event: 'readings_pruned', ...removed });
  } catch (error) {
    app.log.warn({
      event: 'readings_prune_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    await recordJobFailure('prune_readings', error);
  } finally {
    pruning = false;
  }
}
setInterval(() => void prune(), 15 * 60 * 1000).unref();
setTimeout(() => void prune(), 5 * 60 * 1000).unref();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  app.log.info({ event: 'shutdown' });
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  clearInterval(shiftTimer);
  legacyProxy?.close();
  await app.close();
  await pool.end();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
