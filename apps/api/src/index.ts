import { createApp } from './app.js';
import { env } from '@iiot/shared';
import { database, pool } from '@iiot/database';
import { startLegacyMqttProxy, type LegacyDevice } from './legacy-mqtt.js';
import { backfillProduction, closeShiftReports } from './shift-production.js';
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
let closingShifts = false;
async function closeShifts() {
  if (closingShifts) return;
  closingShifts = true;
  try {
    const written = await closeShiftReports(database);
    if (written) app.log.info({ event: 'shift_reports_closed', written });
  } catch (error) {
    app.log.warn({
      event: 'shift_report_close_failed',
      message: error instanceof Error ? error.message : String(error),
    });
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
