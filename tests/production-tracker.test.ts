import { describe, expect, it } from 'vitest';
import {
  attribute,
  type Runtime,
  type TrackerConfig,
} from '../apps/ingestor/src/production-tracker.js';

const config: TrackerConfig = {
  piecesKey: 'QuantidadeBlocos',
  palletsKey: 'QuantidadePaletes',
  tonsKey: null,
  autoKey: 'Automatico',
  idleSeconds: 60,
  weightPerUnitKg: 2.5,
};
const T0 = Date.parse('2026-09-08T10:00:00Z');
const runtime = (patch: Partial<Runtime> = {}): Runtime => ({
  lastAt: T0,
  lastPieces: 100,
  lastPallets: 2,
  lastTons: null,
  lastIncrementAt: T0,
  auto: true,
  productCode: '14X19X29',
  ...patch,
});
const observe = (seconds: number, patch: Record<string, unknown> = {}) => ({
  at: T0 + seconds * 1000,
  pieces: 100,
  pallets: 2,
  tons: null,
  auto: true,
  productCode: '14X19X29',
  ...patch,
});
const sum = (
  deltas: ReturnType<typeof attribute>['deltas'],
  field: 'pieces' | 'producing' | 'idle' | 'manual' | 'tons' | 'pallets',
) => deltas.reduce((total, delta) => total + delta[field], 0);

describe('production tracker', () => {
  it('starts from the first message without inventing production', () => {
    const result = attribute(null, observe(0, { pieces: 5000 }), config, 30);
    expect(result.deltas).toHaveLength(0);
    expect(result.runtime.lastPieces).toBe(5000);
  });

  it('counts pieces, milheiros-ready, and tons from the weight per piece', () => {
    const result = attribute(runtime(), observe(3, { pieces: 112, pallets: 3 }), config, 30);
    expect(sum(result.deltas, 'pieces')).toBe(12);
    expect(sum(result.deltas, 'pallets')).toBe(1);
    expect(sum(result.deltas, 'tons')).toBeCloseTo(0.03);
    expect(sum(result.deltas, 'producing')).toBe(3);
    expect(result.runtime.lastIncrementAt).toBe(T0 + 3000);
  });

  it('turns idle once the counter stops for longer than the idle limit', () => {
    // Last piece at T0; this message 25 s after the previous one, 80 s after the last piece.
    const result = attribute(runtime({ lastAt: T0 + 55_000 }), observe(80), config, 30);
    expect(sum(result.deltas, 'producing')).toBe(5);
    expect(sum(result.deltas, 'idle')).toBe(20);
  });

  it('counts manual while out of automatic', () => {
    const result = attribute(runtime({ auto: false }), observe(10, { auto: false }), config, 30);
    expect(sum(result.deltas, 'manual')).toBe(10);
    expect(sum(result.deltas, 'producing')).toBe(0);
  });

  it('attributes no state to a silence longer than the offline limit', () => {
    const result = attribute(runtime(), observe(600, { pieces: 130 }), config, 30);
    expect(sum(result.deltas, 'producing') + sum(result.deltas, 'idle')).toBe(0);
    expect(sum(result.deltas, 'pieces')).toBe(30);
  });

  it('keeps counting after a counter reset', () => {
    const result = attribute(runtime({ lastPieces: 900 }), observe(3, { pieces: 4 }), config, 30);
    expect(sum(result.deltas, 'pieces')).toBe(4);
  });

  it('splits time across 5-minute buckets', () => {
    const start = Date.parse('2026-09-08T10:04:50Z');
    const result = attribute(
      runtime({ lastAt: start, lastIncrementAt: start }),
      { ...observe(0), at: start + 20_000, pieces: 101 },
      config,
      30,
    );
    const buckets = result.deltas.map((delta) => [
      new Date(delta.bucket).toISOString(),
      delta.producing,
    ]);
    expect(buckets).toEqual([
      ['2026-09-08T10:00:00.000Z', 10],
      ['2026-09-08T10:05:00.000Z', 10],
    ]);
  });
});
