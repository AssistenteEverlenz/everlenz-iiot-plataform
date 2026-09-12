import type { Database } from '@iiot/database';
import { BUCKET_SECONDS, convertTag, type Device, type TagConfig } from '@iiot/shared';

// Shift accounting at ingestion time. Every message tells how long the machine spent since the
// previous one and in which state, and how many pieces, pallets and tons it added; both go into
// 5-minute buckets (migration 018). Boards and shift reports read the buckets, never raw samples.
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

/** Counter increment; a counter that went back (reset) counts from zero again. */
function counterDelta(previous: number | null, next: number | null) {
  if (previous == null || next == null) return 0;
  return next >= previous ? next - previous : Math.max(next, 0);
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

  const pieces = config.piecesKey ? counterDelta(runtime.lastPieces, observation.pieces) : 0;
  const pallets = config.palletsKey ? counterDelta(runtime.lastPallets, observation.pallets) : 0;
  const weight =
    observation.weightKg != null && observation.weightKg > 0
      ? observation.weightKg
      : config.weightPerUnitKg;
  const tons = config.tonsKey
    ? counterDelta(runtime.lastTons, observation.tons)
    : weight
      ? (pieces * weight) / 1000
      : 0;
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
      lastPieces: observation.pieces ?? runtime.lastPieces,
      lastPallets: observation.pallets ?? runtime.lastPallets,
      lastTons: observation.tons ?? runtime.lastTons,
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

function numberOf(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function booleanOf(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (/^(1|true|on|sim)$/i.test(value.trim())) return true;
    if (/^(0|false|off|n[aã]o)$/i.test(value.trim())) return false;
  }
  return null;
}

export class ProductionTracker {
  private configs = new Map<string, { expiresAt: number; config: TrackerConfig | null }>();
  private runtimes = new Map<string, Runtime>();

  constructor(
    private db: Database,
    private offlineSeconds: number,
  ) {}

  private async config(device: Device, tags: TagConfig[]) {
    const cached = this.configs.get(device.id);
    if (cached && cached.expiresAt > Date.now()) return cached.config;
    const result = await this.db.query<{
      blocks_tag_id: string | null;
      pallets_tag_id: string | null;
      tons_total_tag_id: string | null;
      auto_tag_id: string | null;
      idle_seconds: number | null;
      weight_per_unit_kg: number | null;
      weight_tag_id: string | null;
    }>(
      `SELECT blocks_tag_id,pallets_tag_id,tons_total_tag_id,auto_tag_id,idle_seconds,weight_per_unit_kg,
         weight_tag_id
       FROM production_settings WHERE tenant_id=$1 AND device_id=$2`,
      [device.tenant_id, device.id],
    );
    const row = result.rows[0];
    const keyOf = (id: string | null | undefined) =>
      (id && tags.find((tag) => tag.id === id)?.key) || null;
    const config: TrackerConfig | null =
      row && (keyOf(row.blocks_tag_id) || keyOf(row.pallets_tag_id))
        ? {
            piecesKey: keyOf(row.blocks_tag_id),
            palletsKey: keyOf(row.pallets_tag_id),
            tonsKey: keyOf(row.tons_total_tag_id),
            autoKey: keyOf(row.auto_tag_id),
            idleSeconds: row.idle_seconds ?? 60,
            weightPerUnitKg: row.weight_per_unit_kg == null ? null : Number(row.weight_per_unit_kg),
            weightKey: keyOf(row.weight_tag_id),
          }
        : null;
    this.configs.set(device.id, { expiresAt: Date.now() + 15_000, config });
    return config;
  }

  private async runtime(device: Device) {
    const cached = this.runtimes.get(device.id);
    if (cached) return cached;
    const result = await this.db.query<{
      last_at: Date | string;
      last_pieces: number | null;
      last_pallets: number | null;
      last_tons: number | null;
      last_increment_at: Date | string | null;
      auto: boolean | null;
      product_code: string | null;
    }>(
      `SELECT last_at,last_pieces,last_pallets,last_tons,last_increment_at,auto,product_code
       FROM production_runtime WHERE device_id=$1`,
      [device.id],
    );
    const row = result.rows[0];
    return row
      ? {
          lastAt: new Date(row.last_at).getTime(),
          lastPieces: row.last_pieces,
          lastPallets: row.last_pallets,
          lastTons: row.last_tons,
          lastIncrementAt: row.last_increment_at ? new Date(row.last_increment_at).getTime() : null,
          auto: row.auto,
          productCode: row.product_code,
        }
      : null;
  }

  async observe(
    device: Device,
    tags: TagConfig[],
    samples: { key: string; value: unknown }[],
    productCode: string,
    receivedAt: Date,
  ) {
    const config = await this.config(device, tags);
    if (!config) return;
    const read = (key: string | null) => {
      if (!key) return undefined;
      const sample = samples.find((item) => item.key === key);
      const tag = tags.find((item) => item.key === key);
      return sample && tag ? convertTag(sample.value, tag) : sample?.value;
    };
    const observation: Observation = {
      // Server time: HMI clocks drift, and the gaps must be measured on one clock.
      at: receivedAt.getTime(),
      pieces: numberOf(read(config.piecesKey)),
      pallets: numberOf(read(config.palletsKey)),
      tons: numberOf(read(config.tonsKey)),
      auto: config.autoKey ? booleanOf(read(config.autoKey)) : null,
      productCode,
      weightKg: numberOf(read(config.weightKey ?? null)),
    };
    const previous = await this.runtime(device);
    const { runtime, deltas } = attribute(previous, observation, config, this.offlineSeconds);
    if (deltas.length) {
      const values: unknown[] = [];
      const tuples = deltas.map((delta) => {
        const row = [
          device.tenant_id,
          device.id,
          new Date(delta.bucket),
          delta.productCode,
          delta.pieces,
          delta.pallets,
          delta.tons,
          delta.producing,
          delta.idle,
          delta.manual,
        ];
        return `(${row.map((value) => (values.push(value), `$${values.length}`)).join(',')})`;
      });
      await this.db.query(
        `INSERT INTO production_buckets(tenant_id,device_id,bucket,product_code,pieces,pallets,tons,producing_s,idle_s,manual_s)
         VALUES ${tuples.join(',')}
         ON CONFLICT(device_id,bucket,product_code) DO UPDATE SET
           pieces=production_buckets.pieces+EXCLUDED.pieces,
           pallets=production_buckets.pallets+EXCLUDED.pallets,
           tons=production_buckets.tons+EXCLUDED.tons,
           producing_s=production_buckets.producing_s+EXCLUDED.producing_s,
           idle_s=production_buckets.idle_s+EXCLUDED.idle_s,
           manual_s=production_buckets.manual_s+EXCLUDED.manual_s`,
        values,
      );
    }
    await this.db.query(
      `INSERT INTO production_runtime(device_id,tenant_id,last_at,last_pieces,last_pallets,last_tons,last_increment_at,auto,product_code,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT(device_id) DO UPDATE SET last_at=EXCLUDED.last_at,last_pieces=EXCLUDED.last_pieces,
         last_pallets=EXCLUDED.last_pallets,last_tons=EXCLUDED.last_tons,
         last_increment_at=EXCLUDED.last_increment_at,auto=EXCLUDED.auto,
         product_code=EXCLUDED.product_code,updated_at=now()`,
      [
        device.id,
        device.tenant_id,
        new Date(runtime.lastAt),
        runtime.lastPieces,
        runtime.lastPallets,
        runtime.lastTons,
        runtime.lastIncrementAt ? new Date(runtime.lastIncrementAt) : null,
        runtime.auto,
        runtime.productCode,
      ],
    );
    // Only after both writes: a failed write re-attributes the same interval next time.
    this.runtimes.set(device.id, runtime);
  }
}
