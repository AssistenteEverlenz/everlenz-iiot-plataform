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

/**
 * The step numbers the mixer's PLC runs its two processes with (migration 046), and its alert
 * word (migration 049): each change is a row in mortar_process_steps. Which variables they are
 * is the device's own configuration (mortar_settings.mixer_config); a device not configured yet
 * is read by the first plant's names.
 */
type ProcessName = 'pesagem' | 'misturador' | 'alarme';
const DEFAULT_PROCESS_KEYS: Array<[string, ProcessName]> = [
  ['ProcessoPesagem', 'pesagem'],
  ['ProcessoMisturador', 'misturador'],
  ['StatusAlerta', 'alarme'],
];
type ProcessSetup = { keys: Array<[string, ProcessName]>; recipeKey: string | null };
type StepState = { id: string | null; step: number; lastAt: number };
/**
 * A silence this long ends the step at the last message heard. Shorter ones -- a network blip --
 * leave the step running: splitting it would count one step twice and halve its time.
 */
const STEP_SILENCE_MS = 10 * 60_000;

export class MortarTracker {
  private configs = new Map<string, { expiresAt: number; config: Config | null }>();
  private spoutRuntimes = new Map<string, SpoutRuntime>();
  private mixRuntimes = new Map<string, MixRuntime>();
  private steps = new Map<string, StepState>();
  private processSetups = new Map<string, { expiresAt: number; setup: ProcessSetup }>();
  /** Migration 046 not applied yet: steps are not written, and asked again later. */
  private stepsPausedUntil = new Map<string, number>();

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
    await this.observeSteps(device, tags, samples, receivedAt.getTime());
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

  /**
   * A step of the weighing or the mixer begins when its number changes: the row of the step
   * that ran until now is closed at this message and the new one opens. A long silence
   * (STEP_SILENCE_MS) closes the step at the last message heard, so a night with the HMI off is
   * not counted as the last step of the day.
   */
  private async observeSteps(
    device: Device,
    tags: TagConfig[],
    samples: { key: string; value: unknown }[],
    at: number,
  ) {
    const setup = await this.processSetup(device, tags);
    const published = setup.keys.filter(([key]) => samples.some((item) => item.key === key));
    if (!published.length) return;
    const recipe = recipeOf(
      samples.find((item) => item.key === (setup.recipeKey ?? 'ReceitaAtual'))?.value,
    );
    // Each process on its own: an alert word that cannot be kept yet (migration 049) must not
    // stop the steps from being kept.
    for (const [key, process] of published) {
      if (at < (this.stepsPausedUntil.get(process) ?? 0)) continue;
      try {
        const sample = samples.find((item) => item.key === key)!;
        const tag = tags.find((item) => item.key === key);
        const value = numberOf(tag ? convertTag(sample.value, tag) : sample.value);
        if (value == null) continue;
        const step = Math.round(value);
        const memo = `${device.id}:${process}`;
        let state = this.steps.get(memo);
        if (!state) {
          const open = (
            await this.db.query<{ id: string; step: number }>(
              `SELECT id,step FROM mortar_process_steps
               WHERE device_id=$1 AND process=$2 AND ended_at IS NULL
               ORDER BY started_at DESC LIMIT 1`,
              [device.id, process],
            )
          ).rows[0];
          state = open ? { id: open.id, step: Number(open.step), lastAt: at } : undefined;
        }
        const silent = state
          ? at - state.lastAt > Math.max(STEP_SILENCE_MS, this.offlineSeconds * 1000)
          : false;
        if (state && state.step === step && !silent) {
          state.lastAt = at;
          this.steps.set(memo, state);
          continue;
        }
        if (state?.id)
          await this.db.query('UPDATE mortar_process_steps SET ended_at=$2 WHERE id=$1', [
            state.id,
            new Date(silent ? state.lastAt : at),
          ]);
        const created = await this.db.query<{ id: string }>(
          `INSERT INTO mortar_process_steps(tenant_id,device_id,process,step,recipe,started_at)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [device.tenant_id, device.id, process, step, recipe, new Date(at)],
        );
        this.steps.set(memo, { id: created.rows[0].id, step, lastAt: at });
      } catch (error) {
        // A migration not applied yet, most likely: try again in a minute, and say why.
        this.stepsPausedUntil.set(process, at + 60_000);
        console.warn(
          JSON.stringify({
            event: 'mortar_steps_failed',
            deviceId: device.id,
            process,
            error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          }),
        );
      }
    }
  }

  /** Which variables are the device's steps and alerts, kept 30 s like the mortar settings. */
  private async processSetup(device: Device, tags: TagConfig[]): Promise<ProcessSetup> {
    const cached = this.processSetups.get(device.id);
    if (cached && cached.expiresAt > Date.now()) return cached.setup;
    const keyOf = (id: unknown) =>
      (typeof id === 'string' && tags.find((tag) => tag.id === id)?.key) || null;
    let setup: ProcessSetup = { keys: DEFAULT_PROCESS_KEYS, recipeKey: null };
    try {
      const row = (
        await this.db.query<{
          config: {
            weighing?: { tagId?: string | null };
            mixing?: { tagId?: string | null };
            alarms?: { tagId?: string | null };
          } | null;
          recipe_tag_id: string | null;
        }>(
          `SELECT to_jsonb(ms)->'mixer_config' config,recipe_tag_id FROM mortar_settings ms
           WHERE tenant_id=$1 AND device_id=$2`,
          [device.tenant_id, device.id],
        )
      ).rows[0];
      const config = row?.config;
      setup = {
        recipeKey: keyOf(row?.recipe_tag_id),
        keys: config
          ? (
              [
                [keyOf(config.weighing?.tagId), 'pesagem'],
                [keyOf(config.mixing?.tagId), 'misturador'],
                [keyOf(config.alarms?.tagId), 'alarme'],
              ] as Array<[string | null, ProcessName]>
            ).filter((item): item is [string, ProcessName] => item[0] != null)
          : DEFAULT_PROCESS_KEYS,
      };
    } catch {
      // Migration 037 not applied: the first plant's names.
    }
    this.processSetups.set(device.id, { expiresAt: Date.now() + 30_000, setup });
    return setup;
  }

  private async observeSpout(
    device: Device,
    config: Config,
    spout: Spout,
    read: (key: string | null) => unknown,
    at: number,
  ) {
    const previous = this.spoutRuntimes.get(spout.id) ?? (await this.loadSpout(spout.id));
    const { runtime, deltas, stops } = attributeSpout(
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
    for (const stop of stops)
      await this.db.query(
        `INSERT INTO bagging_stops(tenant_id,device_id,spout_id,state,started_at,ended_at,seconds,recipe)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          device.tenant_id,
          device.id,
          spout.id,
          stop.state,
          new Date(stop.startedAt),
          new Date(stop.endedAt),
          stop.seconds,
          stop.recipe,
        ],
      );
    await this.db.query(
      `INSERT INTO bagging_runtime(spout_id,tenant_id,device_id,last_at,last_count,last_increment_at,enabled,running,recipe,stop_started_at,stop_state,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT(spout_id) DO UPDATE SET last_at=EXCLUDED.last_at,last_count=EXCLUDED.last_count,
         last_increment_at=EXCLUDED.last_increment_at,enabled=EXCLUDED.enabled,
         running=EXCLUDED.running,recipe=EXCLUDED.recipe,stop_started_at=EXCLUDED.stop_started_at,
         stop_state=EXCLUDED.stop_state,updated_at=now()`,
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
        runtime.stopStartedAt ? new Date(runtime.stopStartedAt) : null,
        runtime.stopState ?? null,
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
        stop_started_at: Date | string | null;
        stop_state: 'idle' | 'off' | null;
      }>(
        'SELECT last_at,last_count,last_increment_at,enabled,running,recipe,stop_started_at,stop_state FROM bagging_runtime WHERE spout_id=$1',
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
          stopStartedAt: row.stop_started_at ? new Date(row.stop_started_at).getTime() : null,
          stopState: row.stop_state,
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
          lot_number: string | null;
          lot_recipe: string | null;
        }>(
          'SELECT last_at,last_count,scale_peak,lot_number,lot_recipe FROM mix_runtime WHERE device_id=$1',
          [device.id],
        )
      ).rows[0];
      previous = row
        ? {
            lastAt: new Date(row.last_at).getTime(),
            lastCount: row.last_count == null ? null : Number(row.last_count),
            scalePeak: row.scale_peak == null ? null : Number(row.scale_peak),
            lotNumber: row.lot_number,
            lotRecipe: row.lot_recipe,
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
        `INSERT INTO mix_batches(tenant_id,device_id,finished_at,recipe,batches,materials,total_kg,scale_kg,lot_number)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        [
          device.tenant_id,
          device.id,
          new Date(batch.at),
          batch.recipe,
          batch.batches,
          JSON.stringify(batch.materials),
          batch.totalKg,
          batch.scaleKg,
          batch.lotNumber,
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
        `INSERT INTO mix_runtime(device_id,tenant_id,last_at,last_count,scale_peak,lot_number,lot_recipe,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT(device_id) DO UPDATE SET last_at=EXCLUDED.last_at,last_count=EXCLUDED.last_count,
           scale_peak=EXCLUDED.scale_peak,lot_number=EXCLUDED.lot_number,lot_recipe=EXCLUDED.lot_recipe,
           updated_at=now()`,
        [
          device.id,
          device.tenant_id,
          new Date(runtime.lastAt),
          runtime.lastCount,
          runtime.scalePeak,
          runtime.lotNumber ?? null,
          runtime.lotRecipe ?? null,
        ],
      );
    this.mixRuntimes.set(device.id, runtime);
  }
}
