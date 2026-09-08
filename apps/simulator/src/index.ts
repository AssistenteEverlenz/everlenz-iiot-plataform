import mqtt from 'mqtt';
import { env, logger, mqttPublicUrl, mqttOptions } from '@iiot/shared';
import { simulatedMessage } from './messages.js';
const mode = process.argv[2] ?? process.env.SIMULATOR_MODE ?? 'haiwell';
if (mode !== 'haiwell' && mode !== 'generic') throw new Error('Mode must be haiwell or generic');
const log = logger('simulator');
const client = mqtt.connect(mqttPublicUrl, {
  ...mqttOptions(true),
  clientId: `simulator-${mode}-${process.pid}`,
});
client.on('error', (error) => log.error({ event: 'mqtt_error', error: error.message }));
let step = 0,
  timer: NodeJS.Timeout | undefined;
async function publish() {
  if (!client.connected) return;
  const message = simulatedMessage(mode as 'haiwell' | 'generic', step++);
  try {
    await client.publishAsync(message.topic, message.payload, { qos: 1, retain: false });
    log.info({ event: 'published', topic: message.topic, step });
  } catch (error) {
    log.error({ event: 'publish_failed', error: String(error) });
  }
}
client.on('connect', () => {
  if (!timer) {
    void publish();
    timer = setInterval(() => void publish(), env.SIMULATOR_INTERVAL_MS);
  }
});
async function shutdown() {
  clearInterval(timer);
  await client.endAsync();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
