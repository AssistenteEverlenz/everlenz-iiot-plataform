import mqtt, { type MqttClient } from 'mqtt';
import { readFileSync } from 'node:fs';
import { env, mqttUrl } from '@iiot/shared';

// Commands the platform sends to equipment. Today only "Zerar contador": a boolean in the PLC
// that the HMI writes when it receives { "<variable>": 1 } on its command topic. The broker lets
// the "commander" user publish only on iiot/+/+/+/command, and each device read only the
// command topic named after its own MQTT user, so no one else can command a machine.

export type CommandPublisher = (topic: string, payload: Record<string, unknown>) => Promise<void>;

const CONNECT_TIMEOUT_MS = 8000;
let client: MqttClient | undefined;

function commander() {
  if (!env.MQTT_COMMAND_PASSWORD)
    throw new Error('O envio de comandos aos equipamentos não está configurado no servidor.');
  client ??= mqtt.connect(mqttUrl, {
    username: env.MQTT_COMMAND_USERNAME,
    password: env.MQTT_COMMAND_PASSWORD,
    clientId: `everlenz-api-commander-${process.pid}`,
    // MQTT 5 so a publish the broker refuses (ACL) comes back as an error instead of being
    // acknowledged and silently dropped, as MQTT 3.1.1 does.
    protocolVersion: 5,
    reconnectPeriod: 2000,
    connectTimeout: CONNECT_TIMEOUT_MS,
    rejectUnauthorized: true,
    ...(env.MQTT_CA_FILE ? { ca: readFileSync(env.MQTT_CA_FILE) } : {}),
  });
  return client;
}

function connected(connection: MqttClient) {
  if (connection.connected) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Broker MQTT indisponível para envio de comandos.'));
    }, CONNECT_TIMEOUT_MS);
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      connection.off('connect', onConnect);
      connection.off('error', onError);
    };
    connection.once('connect', onConnect);
    connection.once('error', onError);
  });
}

/** Publishes with QoS 1 and resolves once the broker has accepted the message. */
export const publishCommand: CommandPublisher = async (topic, payload) => {
  const connection = commander();
  await connected(connection);
  await connection.publishAsync(topic, JSON.stringify(payload), { qos: 1, retain: false });
};
