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
