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
  /** A reading refused by the counter limit, kept to tell an intruder from a re-baseline. */
  pending?: Partial<Record<'pieces' | 'pallets' | 'tons', number | null>>;
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
 * The most a counter can climb in the time since the previous message, far above any line seen
 * (the fastest ceramic line makes ~3.6 pieces/s and a pallet every ~100 s). A step above it is
 * not production: on 28/10/2026 a second HMI published on Cerâmica Capixaba's credential with
 * its own counter (0 → 2962) between the real one's readings (~200,000), and every swap read as
 * a reset plus a 200,000-piece climb: 6 million pieces in ten minutes. A hand-edited pallet
 * counter (+38 in one reading) is the same kind of step. The refused reading is kept aside:
 * when the next one goes on from the old baseline, it was an intruder and the real counter
 * keeps counting; when it goes on from the refused one, the counter really was set to a new
 * value and that becomes the baseline. After an offline gap the allowance grows with the gap,
 * so the production the PLC kept counting while the HMI was away still comes in.
 */
export const COUNTER_LIMITS = {
  pieces: { base: 50, perSecond: 20 },
  pallets: { base: 2, perSecond: 1 / 30 },
  tons: { base: 0.5, perSecond: 0.05 },
} as const;
export type CounterName = keyof typeof COUNTER_LIMITS;
export interface RejectedStep {
  counter: CounterName;
  at: number;
  previous: number | null;
  reading: number | null;
  delta: number;
  seconds: number;
}
export function counterLimit(counter: CounterName, seconds: number) {
  const limit = COUNTER_LIMITS[counter];
  return limit.base + limit.perSecond * Math.max(seconds, 0);
}

/**
 * Counter increment and the reading to compare the next one with. A reset (the counter falls
 * to less than half of what it was, e.g. 7852 → 12 at the start of a shift) counts from zero
 * again. A small step back (5672 → 5620: an unstable reading or a manual correction) counts
 * nothing and keeps the higher reading, or the pieces would be counted twice on the way up.
 * A lone zero is never a new baseline: a Haiwell A7 published 17924, then 0, then 18032, and
 * counting from that zero added the whole counter as production. The zero is skipped, so the
 * reading that follows it is either the counter going on (18032: 108 pieces) or, if the HMI
 * really did reset, the first small reading, which then counts from zero as usual.
 */
export function counterStep(previous: number | null, next: number | null) {
  if (previous == null || next == null) return { delta: 0, reading: next ?? previous };
  if (next >= previous) return { delta: next - previous, reading: next };
  if (next === 0 && previous > 0) return { delta: 0, reading: previous };
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
): { runtime: Runtime; deltas: BucketDelta[]; rejected: RejectedStep[] } {
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
      rejected: [],
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

  const seconds = Math.max(gap, 0) / 1000;
  const rejected: RejectedStep[] = [];
  const pending: NonNullable<Runtime['pending']> = {};
  const guarded = (counter: CounterName, previous: number | null, next: number | null) => {
    const limit = counterLimit(counter, seconds);
    const step = counterStep(previous, next);
    if (step.delta <= limit) return step;
    const aside = runtime.pending?.[counter];
    if (aside != null) {
      const resumed = counterStep(aside, next);
      if (resumed.delta <= limit) return resumed;
    }
    rejected.push({
      counter,
      at: observation.at,
      previous,
      reading: next,
      delta: step.delta,
      seconds,
    });
    pending[counter] = next;
    return { delta: 0, reading: previous };
  };
  const piecesStep = guarded('pieces', runtime.lastPieces, observation.pieces);
  const palletsStep = guarded('pallets', runtime.lastPallets, observation.pallets);
  const tonsStep = guarded('tons', runtime.lastTons, observation.tons);
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
      ...(Object.keys(pending).length ? { pending } : {}),
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
    // Only configured counters: an unused signal stepping wildly is nobody's production.
    rejected: rejected.filter(
      (step) =>
        (step.counter === 'pieces' && config.piecesKey) ||
        (step.counter === 'pallets' && config.palletsKey) ||
        (step.counter === 'tons' && config.tonsKey),
    ),
  };
}
