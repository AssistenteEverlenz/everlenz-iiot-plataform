import type { Database } from '@iiot/database';
import {
  attribute,
  booleanOf,
  convertTag,
  numberOf,
  type Device,
  type Observation,
  type Runtime,
  type TagConfig,
  type TrackerConfig,
} from '@iiot/shared';

// Shift accounting at ingestion time: each message goes through the shared attribution step
// (packages/shared/src/production-attribution.ts) and its deltas are added to the 5-minute
// buckets. The API replays the same step over the stored telemetry to rebuild the buckets.
export {
  attribute,
  type BucketDelta,
  type Observation,
  type Runtime,
  type TrackerConfig,
} from '@iiot/shared';

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
