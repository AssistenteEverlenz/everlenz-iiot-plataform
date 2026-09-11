import { createApp } from './app.js';
import { env } from '@iiot/shared';
import { database, pool } from '@iiot/database';
import { startLegacyMqttProxy, type LegacyDevice } from './legacy-mqtt.js';
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

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  app.log.info({ event: 'shutdown' });
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  legacyProxy?.close();
  await app.close();
  await pool.end();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
