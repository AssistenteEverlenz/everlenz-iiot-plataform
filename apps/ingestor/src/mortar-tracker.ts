import type { Database } from '@iiot/database';
import {
  attributeMix,
  attributeSpout,
  booleanOf,
  convertTag,
  numberOf,
  recipeOf,
  type Device,
  type MixRuntime,
  type SpoutRuntime,
  type TagConfig,
} from '@iiot/shared';

/**
 * Mortar accounting at ingestion time (migration 037): bags per spout and recipe in 5-minute
 * buckets, and one row per mixing batch. Devices without mortar settings cost one cached query
 * every 30 s and nothing else, so the ceramic plants never notice this exists.
 */
type Spout = {
  id: string;
  countKey: string | null;
  recipeKey: string | null;
  runningKey: string | null;
  enabledKey: string | null;
};
type Config = {
  idleSeconds: number;
  spouts: Spout[];
  mix: null | {
    countKey: string | null;
    recipeKey: string | null;
    scaleKey: string | null;
    materials: Array<{ label: string; key: string | null }>;
  };
};

export class MortarTracker {
  private configs = new Map<string, { expiresAt: number; config: Config | null }>();
  private spoutRuntimes = new Map<string, SpoutRuntime>();
  private mixRuntimes = new Map<string, MixRuntime>();

  constructor(
    private db: Database,
    private offlineSeconds: number,
  ) {}

  private async config(device: Device, tags: TagConfig[]): Promise<Config | null> {
    const cached = this.configs.get(device.id);
    if (cached && cached.expiresAt > Date.now()) return cached.config;
    const keyOf = (id: unknown) =>
      (typeof id === 'string' && tags.find((tag) => tag.id === id)?.key) || null;
    let config: Config | null = null;
    try {
      const settings = await this.db.query<{
        mix_enabled: boolean;
        recipe_tag_id: string | null;
        batch_count_tag_id: string | null;
        scale_tag_id: string | null;
        materials: Array<{ label?: string; tagId?: string }> | null;
        bagging_enabled: boolean;
        idle_seconds: number;
      }>(
        `SELECT mix_enabled,recipe_tag_id,batch_count_tag_id,scale_tag_id,materials,bagging_enabled,idle_seconds
         FROM mortar_settings WHERE tenant_id=$1 AND device_id=$2`,
        [device.tenant_id, device.id],
      );
      const row = settings.rows[0];
      if (row && (row.mix_enabled || row.bagging_enabled)) {
        const spouts = row.bagging_enabled
          ? (
              await this.db.query<{
                id: string;
                count_tag_id: string | null;
                recipe_tag_id: string | null;
                running_tag_id: string | null;
                enabled_tag_id: string | null;
              }>(
                `SELECT id,count_tag_id,recipe_tag_id,running_tag_id,enabled_tag_id FROM bagging_spouts
                 WHERE tenant_id=$1 AND device_id=$2 ORDER BY position`,
                [device.tenant_id, device.id],
              )
            ).rows
              .map((spout) => ({
                id: spout.id,
                countKey: keyOf(spout.count_tag_id),
                recipeKey: keyOf(spout.recipe_tag_id),
                runningKey: keyOf(spout.running_tag_id),
                enabledKey: keyOf(spout.enabled_tag_id),
              }))
              .filter((spout) => spout.countKey)
          : [];
        const mix =
          row.mix_enabled && keyOf(row.batch_count_tag_id)
            ? {
                countKey: keyOf(row.batch_count_tag_id),
                recipeKey: keyOf(row.recipe_tag_id),
                scaleKey: keyOf(row.scale_tag_id),
                materials: (row.materials ?? []).map((item) => ({
                  label: String(item.label ?? 'Material'),
                  key: keyOf(item.tagId),
                })),
              }
            : null;
        if (spouts.length || mix) config = { idleSeconds: row.idle_seconds ?? 120, spouts, mix };
      }
    } catch {
      // Migration 037 not applied yet: behave as a plant without mortar settings.
      config = null;
    }
    this.configs.set(device.id, { expiresAt: Date.now() + 30_000, config });
    return config;
  }

  async observe(
    device: Device,
    tags: TagConfig[],
    samples: { key: string; value: unknown }[],
    receivedAt: Date,
  ) {
    const config = await this.config(device, tags);
    if (!config) return;
    const present = (key: string | null) => key != null && samples.some((item) => item.key === key);
    const read = (key: string | null) => {
      if (!key) return undefined;
      const sample = samples.find((item) => item.key === key);
      const tag = tags.find((item) => item.key === key);
      return sample && tag ? convertTag(sample.value, tag) : sample?.value;
    };
    // Server time: HMI clocks drift, and the gaps must be measured on one clock.
    const at = receivedAt.getTime();
    for (const spout of config.spouts)
      if (present(spout.countKey)) await this.observeSpout(device, config, spout, read, at);
    if (config.mix && present(config.mix.countKey))
      await this.observeMix(device, config.mix, read, at);
  }

  private async observeSpout(
    device: Device,
    config: Config,
    spout: Spout,
    read: (key: string | null) => unknown,
    at: number,
  ) {
    const previous = this.spoutRuntimes.get(spout.id) ?? (await this.loadSpout(spout.id));
    const { runtime, deltas } = attributeSpout(
      previous,
      {
        at,
        count: numberOf(read(spout.countKey)),
        recipe: recipeOf(read(spout.recipeKey)),
        enabled: spout.enabledKey ? booleanOf(read(spout.enabledKey)) : null,
        running: spout.runningKey ? booleanOf(read(spout.runningKey)) : null,
      },
      config.idleSeconds,
      this.offlineSeconds,
    );
    if (deltas.length) {
      const values: unknown[] = [];
      const tuples = deltas.map((delta) => {
        const row = [
          device.tenant_id,
          device.id,
          spout.id,
          new Date(delta.bucket),
          delta.recipe,
          delta.bags,
          delta.running,
          delta.idle,
          delta.off,
        ];
        return `(${row.map((value) => (values.push(value), `$${values.length}`)).join(',')})`;
      });
      await this.db.query(
        `INSERT INTO bagging_buckets(tenant_id,device_id,spout_id,bucket,recipe,bags,running_s,idle_s,off_s)
         VALUES ${tuples.join(',')}
         ON CONFLICT(spout_id,bucket,recipe) DO UPDATE SET
           bags=bagging_buckets.bags+EXCLUDED.bags,
           running_s=bagging_buckets.running_s+EXCLUDED.running_s,
           idle_s=bagging_buckets.idle_s+EXCLUDED.idle_s,
           off_s=bagging_buckets.off_s+EXCLUDED.off_s`,
        values,
      );
    }
    await this.db.query(
      `INSERT INTO bagging_runtime(spout_id,tenant_id,device_id,last_at,last_count,last_increment_at,enabled,running,recipe,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT(spout_id) DO UPDATE SET last_at=EXCLUDED.last_at,last_count=EXCLUDED.last_count,
         last_increment_at=EXCLUDED.last_increment_at,enabled=EXCLUDED.enabled,
         running=EXCLUDED.running,recipe=EXCLUDED.recipe,updated_at=now()`,
      [
        spout.id,
        device.tenant_id,
        device.id,
        new Date(runtime.lastAt),
        runtime.lastCount,
        runtime.lastIncrementAt ? new Date(runtime.lastIncrementAt) : null,
        runtime.enabled,
        runtime.running,
        runtime.recipe,
      ],
    );
    // Only after both writes: a failed write re-attributes the same interval next time.
    this.spoutRuntimes.set(spout.id, runtime);
  }

  private async loadSpout(spoutId: string): Promise<SpoutRuntime | null> {
    const row = (
      await this.db.query<{
        last_at: Date | string;
        last_count: number | null;
        last_increment_at: Date | string | null;
        enabled: boolean | null;
        running: boolean | null;
        recipe: string | null;
      }>(
        'SELECT last_at,last_count,last_increment_at,enabled,running,recipe FROM bagging_runtime WHERE spout_id=$1',
        [spoutId],
      )
    ).rows[0];
    return row
      ? {
          lastAt: new Date(row.last_at).getTime(),
          lastCount: row.last_count == null ? null : Number(row.last_count),
          lastIncrementAt: row.last_increment_at ? new Date(row.last_increment_at).getTime() : null,
          enabled: row.enabled,
          running: row.running,
          recipe: row.recipe,
        }
      : null;
  }

  private async observeMix(
    device: Device,
    mix: NonNullable<Config['mix']>,
    read: (key: string | null) => unknown,
    at: number,
  ) {
    let previous = this.mixRuntimes.get(device.id) ?? null;
    if (!previous) {
      const row = (
        await this.db.query<{
          last_at: Date | string;
          last_count: number | null;
          scale_peak: number | null;
        }>('SELECT last_at,last_count,scale_peak FROM mix_runtime WHERE device_id=$1', [device.id])
      ).rows[0];
      previous = row
        ? {
            lastAt: new Date(row.last_at).getTime(),
            lastCount: row.last_count == null ? null : Number(row.last_count),
            scalePeak: row.scale_peak == null ? null : Number(row.scale_peak),
          }
        : null;
    }
    const { runtime, batch } = attributeMix(previous, {
      at,
      count: numberOf(read(mix.countKey)),
      recipe: recipeOf(read(mix.recipeKey)),
      scale: numberOf(read(mix.scaleKey)),
      materials: mix.materials.map((item) => ({ label: item.label, kg: numberOf(read(item.key)) })),
    });
    if (batch)
      await this.db.query(
        `INSERT INTO mix_batches(tenant_id,device_id,finished_at,recipe,batches,materials,total_kg,scale_kg)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          device.tenant_id,
          device.id,
          new Date(batch.at),
          batch.recipe,
          batch.batches,
          JSON.stringify(batch.materials),
          batch.totalKg,
          batch.scaleKg,
        ],
      );
    // The scale peak changes with every dosing message; it is only worth a write when it moved.
    if (
      batch ||
      !previous ||
      runtime.scalePeak !== previous.scalePeak ||
      runtime.lastCount !== previous.lastCount
    )
      await this.db.query(
        `INSERT INTO mix_runtime(device_id,tenant_id,last_at,last_count,scale_peak,updated_at)
         VALUES($1,$2,$3,$4,$5,now())
         ON CONFLICT(device_id) DO UPDATE SET last_at=EXCLUDED.last_at,last_count=EXCLUDED.last_count,
           scale_peak=EXCLUDED.scale_peak,updated_at=now()`,
        [
          device.id,
          device.tenant_id,
          new Date(runtime.lastAt),
          runtime.lastCount,
          runtime.scalePeak,
        ],
      );
    this.mixRuntimes.set(device.id, runtime);
  }
}
