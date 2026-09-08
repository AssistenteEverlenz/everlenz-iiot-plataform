import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { mqttPublicUrl, mqttOptions, env } from '../packages/shared/src/index.js';
import { database, pool } from '../packages/database/src/index.js';
import { simulatedMessage } from '../apps/simulator/src/messages.js';
const client = await mqtt.connectAsync(mqttPublicUrl, {
  ...mqttOptions(true),
  reconnectPeriod: 0,
  clientId: `e2e-${Date.now()}`,
});
try {
  for (const mode of ['generic', 'haiwell'] as const) {
    const message = simulatedMessage(mode, 3);
    const start = new Date();
    await client.publishAsync(message.topic, message.payload, { qos: 1 });
    let found = false;
    for (let i = 0; i < 40; i++) {
      const result = await database.query<{
        id: string;
        processing_status: string;
        samples: number;
      }>(
        `SELECT r.id,r.processing_status,count(s.id)::int samples FROM mqtt_messages_raw r LEFT JOIN telemetry_samples s ON s.raw_message_id=r.id WHERE r.topic=$1 AND r.payload_hex=$2 AND r.received_at >= $3 GROUP BY r.id ORDER BY r.id DESC LIMIT 1`,
        [message.topic, Buffer.from(message.payload).toString('hex'), start],
      );
      if (result.rows[0]?.processing_status === 'processed' && result.rows[0].samples === 4) {
        found = true;
        console.log(`${mode}: MQTT -> RAW #${result.rows[0].id} -> 4 samples OK`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(found, `${mode}: message did not reach storage within 20s`);
  }
  const api = `http://127.0.0.1:${env.API_PORT}`;
  assert.equal((await fetch(`${api}/health`)).status, 200);
  const devices = (await (await fetch(`${api}/api/devices`)).json()) as { id: string }[];
  assert.ok(devices.length >= 2);
  const web = `http://127.0.0.1:${process.env.WEB_PORT ?? 3000}`;
  for (const path of [
    '/',
    '/devices',
    `/devices/${devices[0].id}`,
    '/mqtt-inspector',
    '/api/mqtt/topics',
  ])
    assert.equal((await fetch(`${web}${path}`)).status, 200);
  console.log('API health, devices, frontend routes and proxy OK');
} finally {
  await client.endAsync();
  await pool.end();
}
