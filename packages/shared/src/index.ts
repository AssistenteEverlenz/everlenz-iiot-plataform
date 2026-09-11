import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import pino from 'pino';
import { z } from 'zod';

if (process.env.NODE_ENV !== 'production' && process.env.IIOT_LOAD_ENV !== 'false') {
  // Works from source, bundles and pnpm-injected packages; never depends on node_modules layout.
  let directory = process.cwd();
  while (!existsSync(join(directory, 'pnpm-workspace.yaml')) && dirname(directory) !== directory)
    directory = dirname(directory);
  if (existsSync(join(directory, 'pnpm-workspace.yaml')))
    config({ path: join(directory, '.env'), quiet: true });
}
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const env = z
  .object({
    POSTGRES_HOST: z.string().default('127.0.0.1'),
    POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
    POSTGRES_DB: z.string().default('iiot'),
    POSTGRES_USER: z.string().default('iiot'),
    POSTGRES_PASSWORD: z.string().default(''),
    MQTT_HOST: z.string().default('127.0.0.1'),
    MQTT_INTERNAL_HOST: z.string().optional(),
    MQTT_PUBLIC_HOST: z.string().optional(),
    MQTT_TLS_PORT: z.coerce.number().int().positive().default(8883),
    MQTT_PORT: z.coerce.number().int().positive().default(1883),
    MQTT_PROTOCOL: z.enum(['mqtt', 'mqtts']).default('mqtt'),
    MQTT_USERNAME: z.string().default('ingestor'),
    MQTT_PASSWORD: z.string().default(''),
    MQTT_SIMULATOR_USERNAME: z.string().default('simulator'),
    MQTT_SIMULATOR_PASSWORD: z.string().default(''),
    MQTT_CA_FILE: z.string().optional(),
    MQTT_DISCOVERY_MODE: bool.default(false),
    MQTT_TOPIC_FILTER: z.string().default('iiot/+/+/+/telemetry,data/POC/group1/A7-001'),
    MQTT_CLIENT_ID: z.string().default('everlenz-ingestor'),
    MQTT_PROVISION_DIR: z.string().optional(),
    // Broker user the API publishes equipment commands with ("Zerar contador" on the PLC).
    // Without a password the platform only reads, as before.
    MQTT_COMMAND_USERNAME: z.string().default('commander'),
    MQTT_COMMAND_PASSWORD: z.string().default(''),
    SIMULATOR_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
    API_PORT: z.coerce.number().int().positive().default(3001),
    INGESTOR_HEALTH_PORT: z.coerce.number().int().positive().default(3002),
    INGESTOR_HEALTH_URL: z.url().default('http://127.0.0.1:3002/health'),
    DEVICE_OFFLINE_SECONDS: z.coerce.number().int().positive().default(30),
    DEV_TENANT_ID: z.uuid().default('11111111-1111-4111-8111-111111111111'),
    OPERATOR_RAW_ACCESS: bool.default(false),
  })
  .parse(process.env);

export const mqttUrl = `${env.MQTT_PROTOCOL}://${env.MQTT_INTERNAL_HOST || env.MQTT_HOST}:${env.MQTT_PORT}`;
export const mqttPublicUrl = `${env.MQTT_PROTOCOL}://${env.MQTT_PUBLIC_HOST || env.MQTT_HOST}:${env.MQTT_PROTOCOL === 'mqtts' ? env.MQTT_TLS_PORT : env.MQTT_PORT}`;
export function mqttOptions(simulator = false) {
  return {
    username: simulator ? env.MQTT_SIMULATOR_USERNAME : env.MQTT_USERNAME,
    password: simulator ? env.MQTT_SIMULATOR_PASSWORD : env.MQTT_PASSWORD,
    reconnectPeriod: 2000,
    connectTimeout: 10000,
    rejectUnauthorized: true,
    ...(env.MQTT_CA_FILE ? { ca: readFileSync(env.MQTT_CA_FILE) } : {}),
  };
}
export function logger(service: string) {
  return pino({
    level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (level) => ({ level }) },
    redact: [
      'password',
      'DATABASE_URL',
      'SUPABASE_SECRET_KEY',
      'POSTGRES_PASSWORD',
      'MQTT_PASSWORD',
      'MQTT_SIMULATOR_PASSWORD',
      'MQTT_COMMAND_PASSWORD',
      'req.headers.authorization',
    ],
  });
}

const passwordParameters = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('base64url');
  const derived = await derivePassword(password, salt, 64, passwordParameters);
  return `scrypt$${passwordParameters.N}$${passwordParameters.r}$${passwordParameters.p}$${salt}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, salt, expected] = encoded.split('$');
  if (algorithm !== 'scrypt' || !n || !r || !p || !salt || !expected) return false;
  const expectedBuffer = Buffer.from(expected, 'base64url');
  const derived = await derivePassword(password, salt, expectedBuffer.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return derived.length === expectedBuffer.length && timingSafeEqual(derived, expectedBuffer);
}

export function sessionToken() {
  return randomBytes(32).toString('base64url');
}

export function sessionTokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function temporaryPassword(length = 18) {
  // No "%": HMI software reads it as a placeholder marker (EasyBuilder Pro: %0, %2, %%), so a
  // generated MQTT password containing it can reach the broker altered and be refused.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  const bytes = randomBytes(length);
  const body = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  return `A9!${body.slice(3)}`;
}

/**
 * MQTT password for a device: letters and digits only. HMI software mangles symbols in its
 * password fields (EasyBuilder read "%" as a placeholder; DIAScreen is suspected with "!" and
 * "$"), and the credential is typed or pasted into those fields. 12 characters: the Delta
 * DOP-100 password field holds at most 16, and 12 from 57 unambiguous ones give about 70
 * bits, far beyond what guessing over the network can reach against the broker.
 */
export function deviceSecret(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  // Rejection sampling keeps every character equally likely (256 is not a multiple of 57).
  const limit = 256 - (256 % alphabet.length);
  let secret = '';
  while (secret.length < length)
    for (const byte of randomBytes(length))
      if (byte < limit && secret.length < length) secret += alphabet[byte % alphabet.length];
  return secret;
}

function derivePassword(
  password: string,
  salt: string,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(password, salt, length, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}
export type DataType = 'number' | 'boolean' | 'string';
export interface TagConfig {
  id: string;
  key: string;
  data_type: DataType;
  scale_multiplier: number;
  scale_offset: number;
  enabled: boolean;
}
export interface MqttMessage {
  topic: string;
  payload: Buffer;
  qos: number;
  retain: boolean;
  receivedAt: Date;
}
export interface NormalizedTelemetry {
  key: string;
  value: unknown;
  timestamp: Date;
  quality?: string;
}
export interface Device {
  id: string;
  tenant_id: string;
  site_id: string;
  slug: string;
  tenant_slug: string;
  site_slug: string;
  adapter_type: string;
  enabled: boolean;
}
export interface TopicMapping {
  device_id: string;
  kind: 'exact' | 'pattern' | 'haiwell';
  topic: string;
}
export function decodePayload(payload: Buffer) {
  let text: string | null = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    /* binary is retained verbatim as hex */
  }
  let json: unknown = null;
  if (text !== null) {
    try {
      json = JSON.parse(text);
    } catch {
      /* raw non-JSON is valid input */
    }
  }
  return { text, hex: payload.toString('hex'), json };
}
export function convertTag(value: unknown, tag: TagConfig): number | boolean | string {
  if (tag.data_type === 'string') {
    if (!['string', 'number', 'boolean'].includes(typeof value))
      throw new Error(`Invalid string: ${tag.key}`);
    return String(value);
  }
  if (tag.data_type === 'boolean') {
    if ([true, 1, '1', 'true'].includes(value as string)) return true;
    if ([false, 0, '0', 'false'].includes(value as string)) return false;
    throw new Error(`Invalid boolean: ${tag.key}`);
  }
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
  )
    throw new Error(`Invalid number: ${tag.key}`);
  const n = Number(value) * Number(tag.scale_multiplier) + Number(tag.scale_offset);
  if (!Number.isFinite(n)) throw new Error(`Non-finite number: ${tag.key}`);
  return n;
}
