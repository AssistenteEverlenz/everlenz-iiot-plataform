import { counterStep } from './production-attribution.js';
import { BUCKET_SECONDS } from './shifts.js';

// Mortar accounting step (migration 037), the bagging and mixing counterpart of
// production-attribution.ts. Pure, so the ingestor runs it live and tests run it on paper.
//
// A spout (bico) is in one of three states between two messages:
//  * running: its bag counter moved within `idle_seconds`;
//  * idle: enabled, but no bag for longer than that (counted from the moment the limit ran out);
//  * off: the operator disabled it on the HMI (HABILITA ENSAC). A spout nobody uses that day is
//    not a stopped spout, and must not drag the line's availability down.
// A gap longer than the offline limit is attributed to no state, as on the ceramic board.

const BUCKET_MS = BUCKET_SECONDS * 1000;

/** Recipe recorded when the HMI sends none, so no bag is ever dropped. */
export const NO_RECIPE = 'SEM RECEITA';

export interface SpoutRuntime {
  lastAt: number;
  lastCount: number | null;
  lastIncrementAt: number | null;
  enabled: boolean | null;
  running: boolean | null;
  recipe: string | null;
  /** The stop going on now, if the spout is stopped: when it began and why. */
  stopStartedAt?: number | null;
  stopState?: 'idle' | 'off' | null;
}
export interface SpoutObservation {
  at: number;
  count: number | null;
  recipe: string | null;
  enabled: boolean | null;
  running: boolean | null;
}
export interface SpoutDelta {
  bucket: number;
  recipe: string;
  bags: number;
  running: number;
  idle: number;
  off: number;
}

/** A stop that ended in this message: written once, like a ceramic stop. */
export interface SpoutStop {
  state: 'idle' | 'off';
  startedAt: number;
  endedAt: number;
  seconds: number;
  recipe: string | null;
}

export function recipeOf(value: unknown) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 120) : null;
}

export function attributeSpout(
  runtime: SpoutRuntime | null,
  observation: SpoutObservation,
  idleSeconds: number,
  offlineSeconds: number,
): { runtime: SpoutRuntime; deltas: SpoutDelta[]; stops: SpoutStop[] } {
  if (!runtime)
    return {
      runtime: {
        lastAt: observation.at,
        lastCount: observation.count,
        lastIncrementAt: observation.at,
        enabled: observation.enabled,
        running: observation.running,
        recipe: observation.recipe,
        stopStartedAt: null,
        stopState: null,
      },
      deltas: [],
      stops: [],
    };
  const buckets = new Map<string, SpoutDelta>();
  const entry = (at: number, recipe: string) => {
    const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    const key = `${bucket}|${recipe}`;
    let delta = buckets.get(key);
    if (!delta) {
      delta = { bucket, recipe, bags: 0, running: 0, idle: 0, off: 0 };
      buckets.set(key, delta);
    }
    return delta;
  };
  // Time and bags up to this message belong to the recipe that was on the spout during it.
  const recipe = runtime.recipe ?? observation.recipe ?? NO_RECIPE;
  const addTime = (from: number, to: number, state: 'running' | 'idle' | 'off') => {
    for (let cursor = from; cursor < to;) {
      const end = Math.min(to, (Math.floor(cursor / BUCKET_MS) + 1) * BUCKET_MS);
      entry(cursor, recipe)[state] += (end - cursor) / 1000;
      cursor = end;
    }
  };

  const step = counterStep(runtime.lastCount, observation.count);
  const gap = observation.at - runtime.lastAt;
  if (gap > 0 && gap <= offlineSeconds * 1000) {
    if (runtime.enabled === false && !step.delta) addTime(runtime.lastAt, observation.at, 'off');
    else {
      // Bags in this message mean the spout was filling all along.
      const lastBag = step.delta ? observation.at : (runtime.lastIncrementAt ?? runtime.lastAt);
      const split = Math.min(
        Math.max(lastBag + idleSeconds * 1000, runtime.lastAt),
        observation.at,
      );
      addTime(runtime.lastAt, split, 'running');
      addTime(split, observation.at, 'idle');
    }
  }
  if (step.delta) entry(observation.at, recipe).bags += step.delta;

  // Stops, as they happen. A stop opens when the idle limit runs out (or the operator disables
  // the spout), and closes when the next bag comes out; a silence longer than the offline limit
  // closes it where the messages stopped, since nobody knows what happened after.
  const stops: SpoutStop[] = [];
  let stopStartedAt = runtime.stopStartedAt ?? null;
  let stopState = runtime.stopState ?? null;
  const close = (at: number) => {
    if (stopStartedAt == null || !stopState) return;
    if (at > stopStartedAt)
      stops.push({
        state: stopState,
        startedAt: stopStartedAt,
        endedAt: at,
        seconds: (at - stopStartedAt) / 1000,
        recipe,
      });
    stopStartedAt = null;
    stopState = null;
  };
  if (gap > offlineSeconds * 1000) close(runtime.lastAt);
  const enabled = observation.enabled ?? runtime.enabled;
  if (step.delta) close(observation.at);
  else if (enabled === false) {
    if (stopState === 'idle') close(observation.at);
    if (stopState == null) {
      stopState = 'off';
      stopStartedAt = runtime.enabled === false ? runtime.lastAt : observation.at;
    }
  } else {
    if (stopState === 'off') close(observation.at);
    const idleFrom = (runtime.lastIncrementAt ?? runtime.lastAt) + idleSeconds * 1000;
    if (stopState == null && observation.at > idleFrom) {
      stopState = 'idle';
      stopStartedAt = Math.max(idleFrom, gap > offlineSeconds * 1000 ? observation.at : 0);
    }
  }

  return {
    runtime: {
      lastAt: Math.max(runtime.lastAt, observation.at),
      lastCount: step.reading,
      lastIncrementAt: step.delta ? observation.at : runtime.lastIncrementAt,
      enabled: observation.enabled ?? runtime.enabled,
      running: observation.running ?? runtime.running,
      recipe: observation.recipe ?? runtime.recipe,
      stopStartedAt,
      stopState,
    },
    deltas: [...buckets.values()].filter(
      (delta) => delta.bags || delta.running || delta.idle || delta.off,
    ),
    stops,
  };
}

export interface MixRuntime {
  lastAt: number;
  lastCount: number | null;
  /** Heaviest scale reading since the last batch: what was really dosed into the hopper. */
  scalePeak: number | null;
  /** The lot being made: the recipe it was started with. */
  lotNumber?: string | null;
  lotRecipe?: string | null;
}
export interface MixObservation {
  at: number;
  count: number | null;
  recipe: string | null;
  scale: number | null;
  /** The recipe's weight of each material for one batch, as the HMI shows it now. */
  materials: Array<{ label: string; kg: number | null }>;
}
export interface MixBatch {
  at: number;
  recipe: string;
  batches: number;
  materials: Array<{ label: string; kg: number }>;
  totalKg: number;
  scaleKg: number | null;
  lotNumber: string;
}

/** A lot's number: the plant date and time it started, "261001-0715". Readable and unique. */
export function lotNumberOf(at: number) {
  const local = new Date(at - 3 * 3600_000);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(local.getUTCFullYear() % 100)}${two(local.getUTCMonth() + 1)}${two(local.getUTCDate())}-${two(local.getUTCHours())}${two(local.getUTCMinutes())}`;
}

/**
 * The batch counter moved: write the batches with the recipe's weights. The weights are the
 * recipe's (the HMI's "peso desejado"), so 3 batches of a recipe asking 500 kg of sand consumed
 * 1500 kg of sand; the scale peak, when there is one, says what was really dosed in total.
 */
export function attributeMix(
  runtime: MixRuntime | null,
  observation: MixObservation,
): { runtime: MixRuntime; batch: MixBatch | null } {
  const peak =
    observation.scale != null && observation.scale > 0
      ? Math.max(runtime?.scalePeak ?? 0, observation.scale)
      : (runtime?.scalePeak ?? null);
  if (!runtime)
    return {
      runtime: {
        lastAt: observation.at,
        lastCount: observation.count,
        scalePeak: peak,
        lotNumber: null,
        lotRecipe: null,
      },
      batch: null,
    };
  const step = counterStep(runtime.lastCount, observation.count);
  const next = {
    lastAt: Math.max(runtime.lastAt, observation.at),
    lastCount: step.reading,
    lotNumber: runtime.lotNumber ?? null,
    lotRecipe: runtime.lotRecipe ?? null,
  };
  if (!step.delta) return { runtime: { ...next, scalePeak: peak }, batch: null };
  const batches = Math.round(step.delta);
  if (batches <= 0) return { runtime: { ...next, scalePeak: peak }, batch: null };
  // A new lot when the recipe changed or the counter was reset for a new run of batches.
  const recipe = observation.recipe ?? NO_RECIPE;
  const reset =
    observation.count != null && runtime.lastCount != null && observation.count < runtime.lastCount;
  const lotNumber =
    !runtime.lotNumber || reset || recipe !== runtime.lotRecipe
      ? lotNumberOf(observation.at)
      : runtime.lotNumber;
  const materials = observation.materials.map((item) => ({
    label: item.label,
    kg: Math.max(item.kg ?? 0, 0) * batches,
  }));
  return {
    // The cycle closed: the next batch starts measuring its own peak.
    runtime: { ...next, scalePeak: null, lotNumber, lotRecipe: recipe },
    batch: {
      at: observation.at,
      recipe,
      batches,
      materials,
      totalKg: materials.reduce((sum, item) => sum + item.kg, 0),
      // A single batch only: a peak cannot be split between batches that arrived together.
      scaleKg: batches === 1 && peak ? peak : null,
      lotNumber,
    },
  };
}
