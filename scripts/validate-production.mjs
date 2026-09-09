import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
// Structural validation only. Always uses fictional values and never contacts the database.
const binary = process.env.COMPOSE_BIN || 'docker';
const prefix = process.env.COMPOSE_BIN ? [] : ['compose'];
const result = spawnSync(
  binary,
  [
    ...prefix,
    '--env-file',
    '.env.example',
    '-f',
    'docker-compose.production.yml',
    'config',
    '--format',
    'json',
  ],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://validation:validation@unused.invalid/postgres',
      DATABASE_SSL_CA_PEM: '',
      MQTT_PASSWORD: 'validation-only',
      MQTT_SIMULATOR_PASSWORD: 'validation-only',
      MQTT_DEVICE_A7_PASSWORD: 'validation-only',
      IIOT_ADMIN_PASSWORD: 'validation-only',
      DEV_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    },
  },
);
if (result.error || result.status !== 0)
  throw new Error(
    'Compose validation failed; ensure Docker Compose is installed. No expanded configuration was printed.',
  );
const config = JSON.parse(result.stdout);
assert.deepEqual(Object.keys(config.services).sort(), ['api', 'ingestor', 'mosquitto', 'web']);
for (const name of ['api', 'ingestor', 'web']) {
  assert.ok(!config.services[name].ports?.length, `${name} must not publish host ports`);
  assert.ok(config.services[name].healthcheck);
}
assert.ok(!config.services.web.environment.DATABASE_URL);
assert.ok(!config.services.web.environment.MQTT_PASSWORD);
assert.ok(!config.services.api.environment.MQTT_PASSWORD);
assert.ok(!config.services.api.environment.MQTT_DEVICE_A7_PASSWORD);
assert.equal(config.services.mosquitto.environment.MQTT_DEVICE_A7_USERNAME, 'a7-001');
assert.equal(config.services.ingestor.environment.MQTT_INTERNAL_HOST, 'mosquitto');
assert.equal(config.services.ingestor.environment.MQTT_DISCOVERY_MODE, 'false');
assert.deepEqual(config.services.mosquitto.ports.map((p) => Number(p.target)).sort(), [1883, 8883]);
assert.equal(
  config.services.mosquitto.volumes.find((volume) => volume.target === '/mosquitto/certs').source,
  '/data/coolify/certificates/mqtt.everlenz.com.br',
);
console.log(
  'Production Compose valid: 4 services, no local database/simulator, internal HTTP ports, MQTT TCP/TLS, scoped secrets.',
);
