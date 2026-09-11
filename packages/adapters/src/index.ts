import { z } from 'zod';
import {
  decodePayload,
  type MqttMessage,
  type NormalizedTelemetry,
  type Device,
  type TopicMapping,
} from '@iiot/shared';

export interface MqttAdapter {
  name: string;
  canHandle(message: MqttMessage): boolean;
  parse(message: MqttMessage): NormalizedTelemetry[];
}
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const genericSchema = z.object({
  timestamp: z.iso.datetime({ offset: true }).optional(),
  values: z.record(z.string().min(1), scalar),
});
export class GenericJsonAdapter implements MqttAdapter {
  name = 'GenericJsonAdapter';
  canHandle(message: MqttMessage) {
    return genericSchema.safeParse(decodePayload(message.payload).json).success;
  }
  parse(message: MqttMessage) {
    const data = genericSchema.parse(decodePayload(message.payload).json);
    return Object.entries(data.values).map(([key, value]) => ({
      key,
      value,
      timestamp: data.timestamp ? new Date(data.timestamp) : message.receivedAt,
    }));
  }
}
// HAIWELL_FORMAT_HYPOTHESIS: not a verified A7 protocol. Replace only after a real RAW capture.
const haiwellSchema = z
  .record(z.string(), scalar)
  .refine((v) => typeof v._terminalTime === 'string' && typeof v._groupName === 'string');
export class HaiwellAdapter implements MqttAdapter {
  name = 'HaiwellAdapter';
  canHandle(message: MqttMessage) {
    return haiwellSchema.safeParse(decodePayload(message.payload).json).success;
  }
  parse(message: MqttMessage) {
    const data = haiwellSchema.parse(decodePayload(message.payload).json);
    // Until device timezone/format is verified, only accept timestamps with an explicit timezone.
    const validTime = z.iso.datetime({ offset: true }).safeParse(data._terminalTime);
    const timestamp = validTime.success ? new Date(validTime.data) : message.receivedAt;
    return Object.entries(data)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, value]) => ({
        key,
        value,
        timestamp,
        quality: validTime.success ? 'good' : 'timestamp_fallback',
      }));
  }
}
// Weintek EasyBuilder Pro, content format "JSON (Simple)" (MQTT User Manual, Content format):
//   { "d": { "QuantidadePaletes": [5], "Motor": [true] }, "ts": "2017-04-18T17:36:52.501856" }
// Without "Use top-level key d" the addresses sit at the top level beside "ts". Every value
// is an array (one element per address element); a single-element array is the value itself.
// "ts" carries no offset: the HMI writes it in the zone chosen under Timestamp, and the
// platform instructions ask for "UTC Time", so an offset-less ts is read as UTC.
const weintekValue = z.array(scalar).min(1);
const weintekValues = z.record(z.string().min(1), weintekValue);
const weintekSchema = z.union([
  z.object({ d: weintekValues, ts: z.string().optional() }),
  z
    .record(z.string(), z.union([weintekValue, z.string()]))
    .refine((v) => Object.entries(v).some(([key, value]) => key !== 'ts' && Array.isArray(value))),
]);
// An HMI clock this far from the arrival time is wrong, not late: the EasyBuilder Pro
// simulator was seen stamping messages 11 hours behind even with "UTC Time" selected.
// Such samples take the arrival time instead of landing hours outside every dashboard window.
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
function weintekTimestamp(ts: unknown, fallback: Date) {
  if (typeof ts !== 'string') return { timestamp: fallback, quality: 'timestamp_fallback' };
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(ts) ? ts : `${ts}Z`;
  const parsed = new Date(withZone);
  if (
    Number.isNaN(parsed.getTime()) ||
    Math.abs(parsed.getTime() - fallback.getTime()) > MAX_CLOCK_SKEW_MS
  )
    return { timestamp: fallback, quality: 'timestamp_fallback' };
  return { timestamp: parsed, quality: 'good' };
}
export class WeintekAdapter implements MqttAdapter {
  name = 'WeintekAdapter';
  canHandle(message: MqttMessage) {
    return weintekSchema.safeParse(decodePayload(message.payload).json).success;
  }
  parse(message: MqttMessage) {
    const data = weintekSchema.parse(decodePayload(message.payload).json) as Record<
      string,
      unknown
    >;
    const values = ('d' in data && data.d && typeof data.d === 'object' ? data.d : data) as Record<
      string,
      unknown
    >;
    const { timestamp, quality } = weintekTimestamp(data.ts, message.receivedAt);
    return Object.entries(values)
      .filter(([key, value]) => key !== 'ts' && Array.isArray(value))
      .map(([key, value]) => ({
        key,
        // Multi-element addresses (arrays, strings split in words) keep only the first element.
        value: (value as Array<string | number | boolean>)[0],
        timestamp,
        quality,
      }));
  }
}
export class UnknownAdapter implements MqttAdapter {
  name = 'UnknownAdapter';
  canHandle() {
    return true;
  }
  parse(): NormalizedTelemetry[] {
    return [];
  }
}
export const adapters: Record<string, MqttAdapter> = {
  generic: new GenericJsonAdapter(),
  haiwell: new HaiwellAdapter(),
  weintek: new WeintekAdapter(),
  // Delta DIAScreen "JSON (General)" is the same layout (DIAScreen manual V1.6.0, MQTT
  // Settings: { "d": { "A1": [0] }, "ts": "2024-06-13 15:20:47" }), only with a space
  // before the time; the Weintek reader already covers it.
  delta: new WeintekAdapter(),
};

export function matchesTopic(pattern: string, topic: string): boolean {
  const p = pattern.split('/'),
    t = topic.split('/');
  if (topic.startsWith('$') && (p[0] === '#' || p[0] === '+')) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return i === p.length - 1;
    if (i >= t.length || (p[i] !== '+' && p[i] !== t[i])) return false;
  }
  return p.length === t.length;
}
export interface ResolutionStrategy {
  resolve(topic: string, devices: Device[], mappings: TopicMapping[]): string[];
}
export class DeviceResolver {
  constructor(private extra: ResolutionStrategy[] = []) {}
  resolve(topic: string, devices: Device[], mappings: TopicMapping[]): Device | null {
    const candidates = new Set<string>();
    for (const m of mappings) {
      const mappedTopic = m.kind === 'haiwell' ? `data/${m.topic}` : m.topic;
      if (m.kind === 'pattern' ? matchesTopic(mappedTopic, topic) : mappedTopic === topic)
        candidates.add(m.device_id);
    }
    const parts = topic.split('/');
    if (parts.length === 5 && parts[0] === 'iiot') {
      for (const d of devices)
        if (d.tenant_slug === parts[1] && d.site_slug === parts[2] && d.slug === parts[3])
          candidates.add(d.id);
    }
    for (const strategy of this.extra)
      for (const id of strategy.resolve(topic, devices, mappings)) candidates.add(id);
    // Ambiguous mappings are quarantined instead of selecting a tenant arbitrarily.
    if (candidates.size > 1) throw new Error('Ambiguous device topic mapping');
    return devices.find((d) => candidates.has(d.id) && d.enabled) ?? null;
  }
}
