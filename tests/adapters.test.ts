import { describe, it, expect } from 'vitest';
import {
  GenericJsonAdapter,
  HaiwellAdapter,
  DeviceResolver,
  matchesTopic,
  UnknownAdapter,
  WeintekAdapter,
  adapters,
} from '../packages/adapters/src/index.js';
import {
  convertTag,
  decodePayload,
  type MqttMessage,
  type Device,
  type TagConfig,
} from '../packages/shared/src/index.js';
const message = (payload: unknown, topic = 'data/POC/group1/A7-001'): MqttMessage => ({
  topic,
  payload: Buffer.from(JSON.stringify(payload)),
  qos: 1,
  retain: false,
  receivedAt: new Date('2026-01-01T12:00:00Z'),
});
const tag = (data_type: TagConfig['data_type']): TagConfig => ({
  id: 'tag',
  key: 'value',
  data_type,
  scale_multiplier: 1,
  scale_offset: 0,
  enabled: true,
});
describe('WeintekAdapter', () => {
  const adapter = new WeintekAdapter();
  it('takes the arrival time when the HMI clock is hours off', () => {
    // As captured from the EasyBuilder Pro simulator: ts 11 h behind the arrival time.
    const samples = adapter.parse(
      message({ QuantidadePaletes: [0], ts: '2026-01-01T01:00:00.422508' }),
    );
    expect(samples[0].timestamp.toISOString()).toBe('2026-01-01T12:00:00.000Z');
    expect(samples[0].quality).toBe('timestamp_fallback');
  });
  it('reads the EasyBuilder Pro JSON (Simple) layout with the top-level "d" key', () => {
    const payload = {
      d: { QuantidadePaletes: [5], Motor: [true], Receita: ['14x19x19'] },
      ts: '2026-01-01T11:59:58.123456',
    };
    expect(adapter.canHandle(message(payload))).toBe(true);
    const samples = adapter.parse(message(payload));
    expect(samples.map((s) => [s.key, s.value])).toEqual([
      ['QuantidadePaletes', 5],
      ['Motor', true],
      ['Receita', '14x19x19'],
    ]);
    // An offset-less ts is the HMI's UTC time.
    expect(samples[0].timestamp.toISOString()).toBe('2026-01-01T11:59:58.123Z');
    expect(samples[0].quality).toBe('good');
  });
  it('reads addresses at the top level and keeps the first element of multi-element values', () => {
    const samples = adapter.parse(
      message({ QuantidadePaletes: [7], Temperaturas: [61.5, 62, 63], ts: '2026-09-10T20:30:00Z' }),
    );
    expect(samples.map((s) => [s.key, s.value])).toEqual([
      ['QuantidadePaletes', 7],
      ['Temperaturas', 61.5],
    ]);
  });
  it('falls back to reception time without ts and refuses other layouts', () => {
    const samples = adapter.parse(message({ d: { QuantidadePaletes: [1] } }));
    expect(samples[0].timestamp.toISOString()).toBe('2026-01-01T12:00:00.000Z');
    expect(samples[0].quality).toBe('timestamp_fallback');
    expect(adapter.canHandle(message({ values: { n: 1 } }))).toBe(false);
    expect(adapter.canHandle(message({ _terminalTime: 'x', _groupName: 'g', n: '1' }))).toBe(false);
  });
});
describe('Delta DIAScreen JSON (General)', () => {
  it('reads the layout of the DIAScreen manual, with a space before the time', () => {
    // DIAScreen V1.6.0 manual, MQTT Settings: "d" top level, array values, "ts" with a space.
    const payload = { d: { QuantidadePaletes: [5], B1: [1] }, ts: '2026-01-01 11:59:58' };
    const delta = adapters.delta;
    expect(delta.canHandle(message(payload))).toBe(true);
    const samples = delta.parse(message(payload));
    expect(samples.map((s) => [s.key, s.value])).toEqual([
      ['QuantidadePaletes', 5],
      ['B1', 1],
    ]);
    expect(samples[0].timestamp.toISOString()).toBe('2026-01-01T11:59:58.000Z');
    expect(samples[0].quality).toBe('good');
  });
  it('takes the arrival time when the HMI sends its local time', () => {
    // A DOP HMI in Brazil stamps local time (UTC-3): three hours off the arrival time.
    const samples = adapters.delta.parse(
      message({ d: { QuantidadePaletes: [5] }, ts: '2026-01-01 09:00:00' }),
    );
    expect(samples[0].timestamp.toISOString()).toBe('2026-01-01T12:00:00.000Z');
    expect(samples[0].quality).toBe('timestamp_fallback');
  });
});
describe('GenericJsonAdapter', () => {
  const adapter = new GenericJsonAdapter();
  it('parses all scalar types and explicit timestamp', () => {
    expect(
      adapter
        .parse(message({ timestamp: '2026-01-01T10:00:00Z', values: { n: 2, s: '1', b: false } }))
        .map((s) => s.value),
    ).toEqual([2, '1', false]);
  });
  it('uses reception time when timestamp is absent', () => {
    const m = message({ values: { n: 1 } });
    expect(adapter.parse(m)[0].timestamp).toEqual(m.receivedAt);
  });
  it.each([
    null,
    [],
    { values: { x: null } },
    { values: { x: {} } },
    { values: { x: 2 }, timestamp: 'yesterday' },
    'garbage',
  ])('rejects invalid payload %j', (payload) => {
    expect(adapter.canHandle(message(payload))).toBe(false);
  });
});
describe('HaiwellAdapter / HAIWELL_FORMAT_HYPOTHESIS', () => {
  const adapter = new HaiwellAdapter();
  it('preserves numeric strings and excludes metadata', () => {
    expect(
      adapter
        .parse(
          message({
            _terminalTime: '2026-01-01T10:00:00Z',
            _groupName: 'g',
            status: '1',
            temperatura: '65.2',
          }),
        )
        .map((s) => [s.key, s.value]),
    ).toEqual([
      ['status', '1'],
      ['temperatura', '65.2'],
    ]);
  });
  it('flags unverified timestamp timezone', () => {
    const m = message({ _terminalTime: '2026-01-01 10:00:00', _groupName: 'g', n: '1' });
    expect(adapter.parse(m)[0]).toMatchObject({
      timestamp: m.receivedAt,
      quality: 'timestamp_fallback',
    });
  });
  it('reads the plain layout with TimeStamp, as captured from a real A7', () => {
    const payload = {
      QuantidadeBlocos: '0',
      TimeStamp: '2026-09-11T10:20:43-03:00',
      StatusLinha: '0',
      TonHora: '12.100000',
      QuantidadePaletes: '0',
      NomeReceita: '9x19x19',
    };
    expect(adapter.canHandle(message(payload))).toBe(true);
    const samples = adapter.parse(message(payload));
    expect(samples.map((s) => s.key)).toEqual([
      'QuantidadeBlocos',
      'StatusLinha',
      'TonHora',
      'QuantidadePaletes',
      'NomeReceita',
    ]);
    expect(samples[0].timestamp.toISOString()).toBe('2026-09-11T13:20:43.000Z');
    expect(samples[0].quality).toBe('good');
  });
  it('does not guess arbitrary JSON', () =>
    expect(adapter.canHandle(message({ foo: 'bar' }))).toBe(false));
  it('unknown fallback returns no telemetry', () =>
    expect(new UnknownAdapter().parse()).toEqual([]));
});
describe('Tag conversion', () => {
  it('uses configured types for the same string', () => {
    expect(convertTag('1', tag('number'))).toBe(1);
    expect(convertTag('1', tag('boolean'))).toBe(true);
    expect(convertTag('1', tag('string'))).toBe('1');
  });
  it('applies scale and offset only to numbers', () =>
    expect(convertTag('12.5', { ...tag('number'), scale_multiplier: 2, scale_offset: -5 })).toBe(
      20,
    ));
  it.each(['', null, {}, true, 'NaN', 'Infinity', '0xff', '2x'])(
    'rejects invalid numeric %j',
    (v) => expect(() => convertTag(v, tag('number'))).toThrow(),
  );
  it('keeps boolean false', () => expect(convertTag('0', tag('boolean'))).toBe(false));
  it('rejects ambiguous boolean', () => expect(() => convertTag('yes', tag('boolean'))).toThrow());
  it('preserves binary and JSON', () => {
    expect(decodePayload(Buffer.from([0xff, 0x00]))).toEqual({
      text: null,
      hex: 'ff00',
      json: null,
    });
    expect(decodePayload(Buffer.from('{"x":1}')).json).toEqual({ x: 1 });
  });
});
describe('DeviceResolver', () => {
  const d: Device = {
    id: 'd1',
    tenant_id: 't1',
    site_id: 's1',
    slug: 'a7',
    tenant_slug: 'acme',
    site_slug: 'lab',
    adapter_type: 'haiwell',
    enabled: true,
  };
  const other = { ...d, id: 'd2', tenant_id: 't2', tenant_slug: 'other' };
  const resolver = new DeviceResolver();
  it('resolves platform topic with full tenant/site/device', () => {
    expect(resolver.resolve('iiot/acme/lab/a7/telemetry', [d, other], [])?.id).toBe('d1');
    expect(resolver.resolve('iiot/other/lab/a7/telemetry', [d, other], [])?.id).toBe('d2');
  });
  it('resolves exact proprietary topic', () =>
    expect(
      resolver.resolve('vendor/x', [d], [{ device_id: 'd1', kind: 'exact', topic: 'vendor/x' }])
        ?.id,
    ).toBe('d1'));
  it('resolves pattern', () =>
    expect(
      resolver.resolve(
        'vendor/x/data',
        [d],
        [{ device_id: 'd1', kind: 'pattern', topic: 'vendor/+/data' }],
      )?.id,
    ).toBe('d1'));
  it('resolves Haiwell project/group/terminal', () =>
    expect(
      resolver.resolve('data/P/g/t', [d], [{ device_id: 'd1', kind: 'haiwell', topic: 'P/g/t' }])
        ?.id,
    ).toBe('d1'));
  it('quarantines ambiguous cross-tenant mapping', () =>
    expect(() =>
      resolver.resolve(
        'vendor/x',
        [d, other],
        [
          { device_id: 'd1', kind: 'pattern', topic: 'vendor/#' },
          { device_id: 'd2', kind: 'exact', topic: 'vendor/x' },
        ],
      ),
    ).toThrow('Ambiguous'));
  it('rejects disabled or unknown devices', () => {
    expect(
      resolver.resolve('iiot/acme/lab/a7/telemetry', [{ ...d, enabled: false }], []),
    ).toBeNull();
    expect(resolver.resolve('unknown', [d], [])).toBeNull();
  });
  it('can add a resolver strategy', () =>
    expect(new DeviceResolver([{ resolve: () => ['d1'] }]).resolve('custom', [d], [])?.id).toBe(
      'd1',
    ));
  it.each([
    ['a/#', 'a', true],
    ['a/+/b', 'a/x/b', true],
    ['a/+/b', 'a/x/y/b', false],
    ['a/#/c', 'a/b/c', false],
    ['#', '$SYS/test', false],
  ])('matches %s -> %s', (pattern, topic, expected) =>
    expect(matchesTopic(pattern as string, topic as string)).toBe(expected),
  );
});
