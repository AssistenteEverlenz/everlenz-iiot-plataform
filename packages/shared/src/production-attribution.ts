import { BUCKET_SECONDS } from './shifts.js';

// Shift accounting step, shared by the ingestor (live, message by message) and the API
// (rebuilding the buckets from the stored telemetry). Every message tells how long the machine
// spent since the previous one and in which state, and how many pieces, pallets and tons it
// added; both go into 5-minute buckets (migration 018).
//
// States, as agreed with the plant owner:
//  * producing: in automatic and the piece counter moved within `idle_seconds`;
//  * idle: in automatic and the counter has not moved for longer than that (counted from the
//    moment the idle limit ran out);
//  * manual: out of automatic;
//  * offline: no message for longer than DEVICE_OFFLINE_SECONDS; that gap is attributed to no
//    state, and reports derive it as planned time minus the other three.

export interface TrackerConfig {
  piecesKey: string | null;
  palletsKey: string | null;
  tonsKey: string | null;
  autoKey: string | null;
  idleSeconds: number;
  weightPerUnitKg: number | null;
  /** Weight per piece published by the HMI (recipe); overrides weightPerUnitKg when present. */
  weightKey?: string | null;
}
export interface Runtime {
  lastAt: number;
  lastPieces: number | null;
  lastPallets: number | null;
  lastTons: number | null;
  lastIncrementAt: number | null;
  auto: boolean | null;
  productCode: string | null;
}
export interface Observation {
  at: number;
  pieces: number | null;
  pallets: number | null;
  tons: number | null;
  auto: boolean | null;
  productCode: string;
  /** Weight per piece (kg) read in this message, if the device publishes it. */
  weightKg?: number | null;
}
export interface BucketDelta {
  bucket: number;
  productCode: string;
  pieces: number;
  pallets: number;
  tons: number;
  producing: number;
  idle: number;
  manual: number;
}

const BUCKET_MS = BUCKET_SECONDS * 1000;

/**
 * Counter increment and the reading to compare the next one with. A reset (the counter falls
 * to less than half of what it was, e.g. 7852 → 12 at the start of a shift) counts from zero
 * again. A small step back (5672 → 5620: an unstable reading or a manual correction) counts
 * nothing and keeps the higher reading, or the pieces would be counted twice on the way up.
 */
export function counterStep(previous: number | null, next: number | null) {
  if (previous == null || next == null) return { delta: 0, reading: next ?? previous };
  if (next >= previous) return { delta: next - previous, reading: next };
  if (next <= previous / 2) return { delta: Math.max(next, 0), reading: next };
  return { delta: 0, reading: previous };
}

export function numberOf(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function booleanOf(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (/^(1|true|on|sim)$/i.test(value.trim())) return true;
    if (/^(0|false|off|n[aã]o)$/i.test(value.trim())) return false;
  }
  return null;
}

/** Pure step: what one observation adds, and the state to carry to the next one. */
export function attribute(
  runtime: Runtime | null,
  observation: Observation,
  config: TrackerConfig,
  offlineSeconds: number,
): { runtime: Runtime; deltas: BucketDelta[] } {
  if (!runtime)
    return {
      runtime: {
        lastAt: observation.at,
        lastPieces: observation.pieces,
        lastPallets: observation.pallets,
        lastTons: observation.tons,
        lastIncrementAt: observation.at,
        auto: observation.auto,
        productCode: observation.productCode,
      },
      deltas: [],
    };
  const buckets = new Map<string, BucketDelta>();
  const entry = (at: number, productCode: string) => {
    const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    const key = `${bucket}|${productCode}`;
    let delta = buckets.get(key);
    if (!delta) {
      delta = {
        bucket,
        productCode,
        pieces: 0,
        pallets: 0,
        tons: 0,
        producing: 0,
        idle: 0,
        manual: 0,
      };
      buckets.set(key, delta);
    }
    return delta;
  };
  const addTime = (from: number, to: number, state: 'producing' | 'idle' | 'manual') => {
    // Time up to this message belongs to the product that was running during it.
    const product = runtime.productCode ?? observation.productCode;
    for (let cursor = from; cursor < to;) {
      const bucketEnd = (Math.floor(cursor / BUCKET_MS) + 1) * BUCKET_MS;
      const end = Math.min(to, bucketEnd);
      entry(cursor, product)[state] += (end - cursor) / 1000;
      cursor = end;
    }
  };

  const gap = observation.at - runtime.lastAt;
  if (gap > 0 && gap <= offlineSeconds * 1000) {
    if (runtime.auto === false) addTime(runtime.lastAt, observation.at, 'manual');
    else {
      const idleFrom = (runtime.lastIncrementAt ?? runtime.lastAt) + config.idleSeconds * 1000;
      const split = Math.min(Math.max(idleFrom, runtime.lastAt), observation.at);
      addTime(runtime.lastAt, split, 'producing');
      addTime(split, observation.at, 'idle');
    }
  }

  const piecesStep = counterStep(runtime.lastPieces, observation.pieces);
  const palletsStep = counterStep(runtime.lastPallets, observation.pallets);
  const tonsStep = counterStep(runtime.lastTons, observation.tons);
  const pieces = config.piecesKey ? piecesStep.delta : 0;
  const pallets = config.palletsKey ? palletsStep.delta : 0;
  const weight =
    observation.weightKg != null && observation.weightKg > 0
      ? observation.weightKg
      : config.weightPerUnitKg;
  const tons = config.tonsKey ? tonsStep.delta : weight ? (pieces * weight) / 1000 : 0;
  if (pieces || pallets || tons) {
    const delta = entry(observation.at, observation.productCode);
    delta.pieces += pieces;
    delta.pallets += pallets;
    delta.tons += tons;
  }
  const counted = config.piecesKey ? pieces > 0 : pallets > 0;
  return {
    runtime: {
      lastAt: Math.max(runtime.lastAt, observation.at),
      lastPieces: piecesStep.reading,
      lastPallets: palletsStep.reading,
      lastTons: tonsStep.reading,
      lastIncrementAt: counted ? observation.at : runtime.lastIncrementAt,
      auto: observation.auto ?? runtime.auto,
      productCode: observation.productCode,
    },
    deltas: [...buckets.values()].filter(
      (delta) =>
        delta.pieces ||
        delta.pallets ||
        delta.tons ||
        delta.producing ||
        delta.idle ||
        delta.manual,
    ),
  };
}
