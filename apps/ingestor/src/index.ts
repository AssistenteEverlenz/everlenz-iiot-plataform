import mqtt from 'mqtt';
import { createServer } from 'node:http';
import { env, logger, mqttUrl, mqttOptions, decodePayload } from '@iiot/shared';
import { database, pool } from '@iiot/database';
import { IngestionPipeline } from './pipeline.js';
import { ingestionHealth } from './health.js';
const log = logger('ingestor');
const pipeline = new IngestionPipeline(database);
let processingSchemaPromise: Promise<void> | undefined;
function ensureProcessingSchema() {
  processingSchemaPromise ??= (async () => {
    await database.query(
      'ALTER TABLE mqtt_messages_raw ADD COLUMN IF NOT EXISTS processed_at timestamptz',
    );
    await database.query(
      "CREATE INDEX IF NOT EXISTS raw_pending_received ON mqtt_messages_raw(received_at) WHERE processing_status='pending'",
    );
  })().catch((error) => {
    processingSchemaPromise = undefined;
    throw error;
  });
  return processingSchemaPromise;
}
let subscribed = false;
let stopping = false;
let lastFailure: string | null = null;
let databaseConnected: boolean | undefined;
function databaseState(connected: boolean) {
  if (connected !== databaseConnected)
    log[connected ? 'info' : 'error']({
      event: connected ? 'database_reconnected' : 'database_disconnected',
    });
  databaseConnected = connected;
}
const client = mqtt.connect(mqttUrl, {
  ...mqttOptions(),
  clientId: env.MQTT_CLIENT_ID,
  clean: false,
  protocolVersion: 4,
});
const filters = env.MQTT_DISCOVERY_MODE
  ? ['#']
  : env.MQTT_TOPIC_FILTER.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
if (!filters.length) throw new Error('MQTT_TOPIC_FILTER must not be empty');
client.on('connect', async () => {
  log.info({ event: 'mqtt_connected' });
  try {
    // Explicitly remove the persistent discovery subscription when returning to normal mode.
    if (!env.MQTT_DISCOVERY_MODE) await client.unsubscribeAsync('#');
    await client.subscribeAsync(filters, { qos: 1 });
    subscribed = true;
    log.info({ event: 'subscribed', filters, discovery: env.MQTT_DISCOVERY_MODE });
  } catch (error) {
    log.error({ event: 'subscribe_failed', error: String(error) });
  }
});
client.on('offline', () => {
  subscribed = false;
  log.warn({ event: 'mqtt_disconnected' });
});
client.on('close', () => {
  subscribed = false;
});
client.on('error', (error) => log.error({ event: 'mqtt_error', error: error.message }));
// MQTT.js processes handleMessage serially and calls its callback before acknowledging QoS 1.
// Holding the callback during a database outage applies backpressure; no unbounded JS queue.
client.handleMessage = (packet, done) => {
  const message = {
    topic: packet.topic,
    payload: Buffer.from(packet.payload),
    qos: packet.qos,
    retain: packet.retain,
    receivedAt: new Date(),
  };
  const started = Date.now();
  log.info({
    event: 'mqtt_message_received',
    topic: message.topic,
    qos: message.qos,
    retain: message.retain,
    bytes: message.payload.length,
  });
  if (env.MQTT_DISCOVERY_MODE) {
    const raw = decodePayload(message.payload);
    log.info({
      event: 'discovery_message',
      topic: message.topic,
      qos: message.qos,
      retain: message.retain,
      receivedAt: message.receivedAt,
      encoding: raw.text === null ? 'binary' : 'utf8',
      jsonDetected: raw.json !== null,
      bytes: message.payload.length,
    });
  }
  void (async () => {
    while (!stopping) {
      try {
        await ensureProcessingSchema();
        const result = await pipeline.ingest(message);
        lastFailure = null;
        databaseState(true);
        log.info({
          event: 'message_processed',
          topic: message.topic,
          duration: Date.now() - started,
          ...result,
        });
        done();
        return;
      } catch (error) {
        lastFailure = 'Storage unavailable';
        databaseState(false);
        log.error({
          event: 'storage_retry',
          topic: message.topic,
          error: error instanceof Error ? error.name : 'StorageError',
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    done(new Error('Ingestor shutting down before persistence'));
  })();
};
const statusTimer = setInterval(() => {
  void database
    .query(
      "UPDATE device_status SET online=false,updated_at=now() WHERE online=true AND last_message_at < now()-($1::int * interval '1 second')",
      [env.DEVICE_OFFLINE_SECONDS],
    )
    .catch((error: Error) => log.error({ event: 'status_update_failed', error: error.message }));
}, 5000);
const health = createServer(async (req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end();
    return;
  }
  let db = false;
  try {
    await database.query('SELECT 1');
    db = true;
  } catch {
    /* reported below */
  }
  databaseState(db);
  const state = ingestionHealth({
    mqtt: client.connected,
    subscribed,
    database: db,
    stopping,
    storageFailure: !!lastFailure,
  });
  res.writeHead(state.ready ? 200 : 503, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      ...state,
      discovery: env.MQTT_DISCOVERY_MODE,
      lastFailure,
    }),
  );
});
health.listen(env.INGESTOR_HEALTH_PORT, '0.0.0.0');
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(statusTimer);
  health.close();
  log.info({ event: 'shutdown' });
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  await client.endAsync(false);
  await pool.end();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
