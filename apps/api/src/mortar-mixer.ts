import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';
import { resolveMixerConfig, type MixerConfig } from '../../web/components/mortarMixerConfig.js';

/**
 * The mixer board of a mortar plant (migration 046): the run going on now, the scale against
 * the recipe, the times the recipe programs, the day's batches and the scale's work curve.
 *
 * It reads the variables the HMI publishes under the documented names (mortar-setup.ts):
 * the ones the mixer settings point at (recipe, batch counter, scale, materials) and, by key,
 * BateladasDesejadas, PesoDesejadoTotal, TempoMistura, TempoDescarga, ModoAutomatico and
 * InicioCiclo. A variable the plant does not publish leaves its place empty.
 *
 * The scale says only what it can: dosing while it climbs, loaded near the recipe's total, empty
 * otherwise. Mixing and discharging need the PLC's own step or timers, and wait for them.
 */
const PLANT_OFFSET_MS = 3 * 3600_000;
/** The work curve keeps one point per this many seconds: the heaviest reading in it. */
const CURVE_STEP_S = 30;
/** Readings older than this are not "now". */
const STALE_MS = 2 * 60_000;

type Value = { key: string; value: number | string | boolean | null; at: Date | null };

/** The processes kept in mortar_process_steps: the two of the mixer, and its alert word. */
type Process = 'pesagem' | 'misturador' | 'alarme';

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * One process through the day (migration 046): its steps as segments of the day, the step it is
 * in now, and for each step how often it ran and how long it took -- against the typical time of
 * the seven days before, so a step that is slower than usual stands out.
 */
async function processDay(
  db: Database,
  deviceId: string,
  process: Process,
  dayStart: Date,
  dayEnd: Date,
  now: Date,
  /** The step a cycle starts at (the configuration's), for the cycle time. */
  cycleStep: number | null = null,
) {
  const rows = (
    await db.query<{
      step: number;
      started_at: Date;
      ended_at: Date | null;
      recipe: string | null;
    }>(
      `SELECT step,started_at,ended_at,recipe FROM mortar_process_steps
       WHERE device_id=$1 AND process=$2 AND started_at < $4 AND coalesce(ended_at,$5) > $3
       ORDER BY started_at`,
      [deviceId, process, dayStart, dayEnd, now],
    )
  ).rows;
  const ever = rows.length
    ? true
    : (
        await db.query(
          'SELECT 1 FROM mortar_process_steps WHERE device_id=$1 AND process=$2 LIMIT 1',
          [deviceId, process],
        )
      ).rows.length > 0;
  if (!ever) return null;
  const end = Math.min(dayEnd.getTime(), now.getTime());
  const segments = rows.map((row) => {
    const started = new Date(row.started_at).getTime();
    const ended = row.ended_at ? new Date(row.ended_at).getTime() : end;
    return {
      step: Number(row.step),
      start: new Date(Math.max(started, dayStart.getTime())).toISOString(),
      end: new Date(Math.min(ended, dayEnd.getTime())).toISOString(),
      seconds: Math.max(0, (ended - started) / 1000),
      open: !row.ended_at,
      recipe: row.recipe,
      startedToday: started >= dayStart.getTime(),
    };
  });
  const last = rows.at(-1);
  const current =
    last && !last.ended_at
      ? { step: Number(last.step), since: new Date(last.started_at).toISOString() }
      : null;

  const steps = new Map<number, number[]>();
  const totals = new Map<number, number>();
  for (const segment of segments) {
    const clipped = (new Date(segment.end).getTime() - new Date(segment.start).getTime()) / 1000;
    totals.set(segment.step, (totals.get(segment.step) ?? 0) + Math.max(0, clipped));
    // Only finished runs that began today say how long the step takes.
    if (!segment.open && segment.startedToday)
      steps.set(segment.step, [...(steps.get(segment.step) ?? []), segment.seconds]);
  }
  const before = (
    await db.query<{ step: number; seconds: number }>(
      `SELECT step,extract(epoch FROM ended_at-started_at)::float seconds FROM mortar_process_steps
       WHERE device_id=$1 AND process=$2 AND started_at >= $3 AND started_at < $4 AND ended_at IS NOT NULL`,
      [deviceId, process, new Date(dayStart.getTime() - 7 * 86_400_000), dayStart],
    )
  ).rows;
  const typical = new Map<number, number[]>();
  for (const row of before)
    typical.set(Number(row.step), [...(typical.get(Number(row.step)) ?? []), Number(row.seconds)]);
  const allSteps = [...new Set([...totals.keys(), ...typical.keys()])].sort((a, b) => a - b);

  const starts = segments
    .filter((segment) => cycleStep != null && segment.step === cycleStep && segment.startedToday)
    .map((segment) => new Date(segment.start).getTime());
  const gaps: number[] = [];
  for (let at = 1; at < starts.length; at += 1) {
    const gap = (starts[at] - starts[at - 1]) / 1000;
    if (gap > 0 && gap < 2 * 3600) gaps.push(gap);
  }

  return {
    current,
    segments: segments.map(({ startedToday: _, ...segment }) => segment),
    cycles: starts.length,
    cycleSeconds: median(gaps),
    steps: allSteps.map((step) => {
      const runs = steps.get(step) ?? [];
      return {
        step,
        runs: runs.length,
        total: totals.get(step) ?? 0,
        median: median(runs),
        max: runs.length ? Math.max(...runs) : null,
        typical: median(typical.get(step) ?? []),
      };
    }),
  };
}

const stepSchema = z.object({
  value: z.number().int().min(-32768).max(65535),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(['work', 'prep', 'wait', 'off']),
  material: z.string().trim().max(40).nullable().optional(),
  timer: z.enum(['mix', 'discharge']).nullable().optional(),
  cycle: z.boolean().optional(),
});
const configSchema = z.object({
  tags: z.record(z.string(), z.uuid().nullable()),
  weighing: z.object({ tagId: z.uuid().nullable(), steps: z.array(stepSchema).max(64) }),
  mixing: z.object({ tagId: z.uuid().nullable(), steps: z.array(stepSchema).max(64) }),
  alarms: z.object({
    tagId: z.uuid().nullable(),
    codes: z
      .array(
        z.object({
          value: z.number().int().min(-32768).max(65535),
          label: z.string().trim().min(1).max(80),
          kind: z.enum(['material', 'equipment', 'process', 'info']),
          material: z.string().trim().max(40).nullable().optional(),
        }),
      )
      .max(128),
  }),
});

export function registerMortarMixerRoutes(
  app: FastifyInstance,
  db: Database,
  access: ReturnType<typeof createAccessControl>,
) {
  /*
   * The mixer's configuration (migration 049): the variables of each role, the steps of its two
   * processes and the codes of its alert word, as this device's PLC is programmed. Read as
   * resolved (the first plant's model and names until someone saves one) so the editor opens
   * filled; saved whole.
   */
  app.get('/api/devices/:id/mortar/mixer-config', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const tenantId = access.principal(req).tenantId;
    const row = (
      await db.query<{ mixer_config: MixerConfig | null }>(
        `SELECT to_jsonb(mortar_settings)->'mixer_config' mixer_config FROM mortar_settings
         WHERE tenant_id=$1 AND device_id=$2`,
        [tenantId, id],
      )
    ).rows[0];
    const tags = (
      await db.query<{ id: string; key: string }>(
        'SELECT id,key FROM tags WHERE tenant_id=$1 AND device_id=$2 AND enabled=true',
        [tenantId, id],
      )
    ).rows;
    const byKey = (key: string) => tags.find((tag) => tag.key === key)?.id ?? null;
    return {
      saved: Boolean(row?.mixer_config),
      config: resolveMixerConfig(row?.mixer_config, byKey),
    };
  });

  app.put('/api/devices/:id/mortar/mixer-config', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const body = configSchema.parse(req.body);
    // Every variable must be this device's: a foreign id would read another plant.
    const ids = [
      ...Object.values(body.tags),
      body.weighing.tagId,
      body.mixing.tagId,
      body.alarms.tagId,
    ].filter((value): value is string => !!value);
    if (ids.length) {
      const owned = await db.query<{ id: string }>(
        'SELECT id FROM tags WHERE tenant_id=$1 AND device_id=$2 AND id=ANY($3::uuid[])',
        [current.tenantId, id, [...new Set(ids)]],
      );
      if (owned.rows.length !== new Set(ids).size)
        return reply.code(400).send({ error: 'Variável não pertence a este equipamento' });
    }
    const column = (
      await db.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name='mortar_settings' AND column_name='mixer_config' LIMIT 1`,
      )
    ).rows.length;
    if (!column)
      return reply
        .code(409)
        .send({ error: 'A configuração do misturador precisa da migração 049 aplicada no banco.' });
    await db.query(
      `INSERT INTO mortar_settings(device_id,tenant_id,mixer_config,updated_at)
       VALUES($1,$2,$3::jsonb,now())
       ON CONFLICT(device_id) DO UPDATE SET mixer_config=EXCLUDED.mixer_config,updated_at=now()`,
      [id, current.tenantId, JSON.stringify(body)],
    );
    await recordAudit(db, req, current, {
      action: 'mortar.mixer_config',
      targetType: 'device',
      targetId: id,
      summary: {
        weighingSteps: body.weighing.steps.length,
        mixingSteps: body.mixing.steps.length,
        alarms: body.alarms.codes.length,
      },
    });
    return { ok: true };
  });

  app.get('/api/devices/:id/mortar/mixer', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = z.object({ date: z.iso.date() }).parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const now = new Date();

    const settings = (
      await db.query<{
        recipe_tag_id: string | null;
        batch_count_tag_id: string | null;
        scale_tag_id: string | null;
        materials: Array<{ label?: string; tagId?: string }> | null;
        mix_enabled: boolean;
        mixer_config: MixerConfig | null;
      }>(
        `SELECT recipe_tag_id,batch_count_tag_id,scale_tag_id,materials,mix_enabled,
           to_jsonb(mortar_settings)->'mixer_config' mixer_config
         FROM mortar_settings WHERE tenant_id=$1 AND device_id=$2`,
        [tenantId, id],
      )
    ).rows[0];
    const tags = (
      await db.query<{ id: string; key: string }>(
        'SELECT id,key FROM tags WHERE tenant_id=$1 AND device_id=$2 AND enabled=true',
        [tenantId, id],
      )
    ).rows;
    const byKey = (key: string) => tags.find((tag) => tag.key === key)?.id ?? null;
    // The device's own configuration, or the first plant's model and names (migration 049).
    const config = resolveMixerConfig(settings?.mixer_config, byKey);
    const role = (name: keyof MixerConfig['tags']) => config.tags[name] ?? null;
    const timerStep = (timer: 'mix' | 'discharge') =>
      config.mixing.steps.find((item) => item.timer === timer)?.value ?? null;
    const cycleStep = (steps: MixerConfig['mixing']['steps']) =>
      steps.find((item) => item.cycle)?.value ?? null;
    const ids = {
      recipe: settings?.recipe_tag_id ?? byKey('ReceitaAtual'),
      count: settings?.batch_count_tag_id ?? byKey('ContagemBateladas'),
      scale: settings?.scale_tag_id ?? byKey('PesoBalanca'),
      asked: role('asked'),
      total: role('total'),
      mixTime: role('mixTimer'),
      dischargeTime: role('dischargeTimer'),
      // The recipe's own setpoints, when the PLC publishes them; else they are learnt below.
      mixSetpoint: role('mixSetpoint'),
      dischargeSetpoint: role('dischargeSetpoint'),
      automatic: role('automatic'),
      alarm: config.alarms.tagId,
    };
    const materials = (settings?.materials ?? []).map((item) => ({
      label: String(item.label ?? 'Material'),
      tagId: item.tagId ?? null,
    }));
    const wanted = [...Object.values(ids), ...materials.map((item) => item.tagId)].filter(
      (value): value is string => !!value,
    );

    // The newest reading of each variable, one index lookup per tag (as /latest does).
    const latest = new Map<string, Value>();
    if (wanted.length) {
      const rows = await db.query<{
        tag_id: string;
        key: string;
        timestamp: Date | null;
        value_number: number | null;
        value_text: string | null;
        value_boolean: boolean | null;
      }>(
        `SELECT t.id tag_id,t.key,s.timestamp,s.value_number,s.value_text,s.value_boolean
         FROM tags t LEFT JOIN LATERAL (
           SELECT timestamp,value_number,value_text,value_boolean FROM telemetry_samples x
           WHERE x.tag_id=t.id AND x.tenant_id=t.tenant_id ORDER BY x.timestamp DESC,x.id DESC LIMIT 1
         ) s ON true
         WHERE t.tenant_id=$1 AND t.device_id=$2 AND t.id=ANY($3::uuid[])`,
        [tenantId, id, wanted],
      );
      for (const row of rows.rows)
        latest.set(row.tag_id, {
          key: row.key,
          value: row.value_number ?? row.value_text ?? row.value_boolean,
          at: row.timestamp ? new Date(row.timestamp) : null,
        });
    }
    const number = (tagId: string | null) => {
      const value = tagId ? latest.get(tagId)?.value : null;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    const flag = (tagId: string | null) => {
      const value = tagId ? latest.get(tagId)?.value : null;
      return typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : null;
    };
    const text = (tagId: string | null) => {
      const value = tagId ? latest.get(tagId)?.value : null;
      return value == null || value === '' ? null : String(value);
    };
    const updatedAt = [...latest.values()]
      .map((item) => item.at?.getTime() ?? 0)
      .reduce((max, at) => Math.max(max, at), 0);

    /**
     * Where a stopwatch stopped in the last finished runs of its step: the time the recipe
     * programs. The median of the last five, so one run cut short does not change it.
     */
    const learnt = new Map<string, number | null>();
    const learntSetpoint = async (step: number | null, tagId: string | null) => {
      if (!tagId || step == null) return null;
      const key = `${step}:${tagId}`;
      if (learnt.has(key)) return learnt.get(key)!;
      let value: number | null = null;
      try {
        const peaks = (
          await db.query<{ peak: number | null }>(
            `SELECT (SELECT max(s.value_number) FROM telemetry_samples s
                     WHERE s.tenant_id=$1 AND s.tag_id=$2
                       AND s.timestamp >= p.started_at AND s.timestamp <= p.ended_at + interval '30 seconds')::float peak
             FROM mortar_process_steps p
             WHERE p.device_id=$3 AND p.process='misturador' AND p.step=$4 AND p.ended_at IS NOT NULL
             ORDER BY p.started_at DESC LIMIT 5`,
            [tenantId, tagId, id, step],
          )
        ).rows
          .map((row) => (row.peak == null ? null : Number(row.peak)))
          .filter((peak): peak is number => peak != null && peak > 0)
          .sort((a, b) => a - b);
        value = peaks.length ? peaks[Math.floor(peaks.length / 2)] : null;
      } catch {
        value = null;
      }
      learnt.set(key, value);
      return value;
    };

    // The plant day, and the scale through it.
    const dayStart = new Date(Date.parse(`${query.date}T00:00:00Z`) + PLANT_OFFSET_MS);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const curve = ids.scale
      ? (
          await db.query<{ at: Date; kg: number }>(
            `SELECT to_timestamp(floor(extract(epoch FROM timestamp)/${CURVE_STEP_S})*${CURVE_STEP_S}) at,
               max(value_number)::float kg
             FROM telemetry_samples WHERE tenant_id=$1 AND tag_id=$2 AND timestamp >= $3 AND timestamp < $4
               AND value_number IS NOT NULL
             GROUP BY 1 ORDER BY 1`,
            [tenantId, ids.scale, dayStart, dayEnd],
          )
        ).rows.map((row) => ({ at: new Date(row.at).toISOString(), kg: Number(row.kg) }))
      : [];
    // Recent readings say whether the scale is climbing now.
    const recent = ids.scale
      ? (
          await db.query<{ at: Date; kg: number }>(
            `SELECT timestamp at,value_number::float kg FROM telemetry_samples
             WHERE tenant_id=$1 AND tag_id=$2 AND timestamp > $3 AND value_number IS NOT NULL
             ORDER BY timestamp`,
            [tenantId, ids.scale, new Date(now.getTime() - 3 * 60_000)],
          )
        ).rows
      : [];

    const batches = (
      await db.query<{
        finished_at: Date;
        recipe: string;
        batches: number;
        total_kg: number;
        scale_kg: number | null;
        lot_number: string | null;
      }>(
        `SELECT finished_at,recipe,batches::int batches,total_kg::float total_kg,scale_kg::float scale_kg,lot_number
         FROM mix_batches WHERE tenant_id=$1 AND device_id=$2 AND finished_at >= $3 AND finished_at < $4
         ORDER BY finished_at`,
        [tenantId, id, dayStart, dayEnd],
      )
    ).rows;
    // A cycle is the time from one batch to the next; a gap over two hours is a stop, not a cycle.
    const gaps: number[] = [];
    for (let at = 1; at < batches.length; at += 1) {
      const gap =
        new Date(batches[at].finished_at).getTime() -
        new Date(batches[at - 1].finished_at).getTime();
      if (gap > 0 && gap < 2 * 3600_000) gaps.push(gap / 1000);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;

    const scale = number(ids.scale);
    const recipeKg = materials.reduce((sum, item) => sum + (number(item.tagId) ?? 0), 0);
    const target = number(ids.total) ?? (recipeKg > 0 ? recipeKg : null);
    const live = updatedAt > 0 && now.getTime() - updatedAt < STALE_MS;
    const first = recent[0] ? Number(recent[0].kg) : null;
    const last = recent.at(-1) ? Number(recent.at(-1)!.kg) : null;
    const climbing =
      first != null && last != null && last - first > Math.max(5, (target ?? 0) * 0.01);
    const scaleState: 'dosing' | 'loaded' | 'empty' | null =
      !live || scale == null
        ? null
        : climbing
          ? 'dosing'
          : target && scale >= target * 0.9
            ? 'loaded'
            : target && scale > target * 0.05
              ? 'dosing'
              : 'empty';

    // The two processes, when the HMI publishes their steps (and migration 046 keeps them).
    let processes: Record<'pesagem' | 'misturador', Awaited<ReturnType<typeof processDay>>> | null = null;
    try {
      processes = {
        pesagem: await processDay(
          db,
          id,
          'pesagem',
          dayStart,
          dayEnd,
          now,
          cycleStep(config.weighing.steps),
        ),
        misturador: await processDay(
          db,
          id,
          'misturador',
          dayStart,
          dayEnd,
          now,
          cycleStep(config.mixing.steps),
        ),
      };
    } catch {
      processes = null;
    }

    // The alert word, kept like the steps (migration 049): what is on now and the day's alerts.
    let alerts: Awaited<ReturnType<typeof processDay>> = null;
    try {
      alerts = ids.alarm ? await processDay(db, id, 'alarme', dayStart, dayEnd, now) : null;
    } catch {
      alerts = null;
    }

    return {
      configured: Boolean(settings?.mix_enabled),
      processes,
      // What the board names and colours the steps and alerts with: the device's configuration.
      catalog: {
        pesagem: config.weighing.steps,
        misturador: config.mixing.steps,
        alarmes: config.alarms.codes,
      },
      alerts,
      live,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      recipe: text(ids.recipe),
      count: number(ids.count),
      asked: number(ids.asked),
      automatic: flag(ids.automatic),

      scale,
      target,
      scaleState,
      materials: materials.map((item) => ({ label: item.label, kg: number(item.tagId) })),
      /*
       * TempoMistura and TempoDescarga are the PLC's stopwatches (Bella Massa, 2026-10-16): they
       * count up while the step runs and stop at the recipe's time, so "97 s" is how long it has
       * mixed, not what it should. What the recipe programs comes from its own variable when the
       * PLC publishes one, else from where the stopwatch stopped in the last finished runs.
       */
      mix: {
        elapsed: number(ids.mixTime),
        programmed:
          number(ids.mixSetpoint) ?? (await learntSetpoint(timerStep('mix'), ids.mixTime)),
        source: number(ids.mixSetpoint) != null ? 'plc' : 'learnt',
      },
      discharge: {
        elapsed: number(ids.dischargeTime),
        programmed:
          number(ids.dischargeSetpoint) ??
          (await learntSetpoint(timerStep('discharge'), ids.dischargeTime)),
        source: number(ids.dischargeSetpoint) != null ? 'plc' : 'learnt',
      },
      mixSeconds: number(ids.mixSetpoint) ?? (await learntSetpoint(timerStep('mix'), ids.mixTime)),
      dischargeSeconds:
        number(ids.dischargeSetpoint) ??
        (await learntSetpoint(timerStep('discharge'), ids.dischargeTime)),
      day: {
        date: query.date,
        start: dayStart.toISOString(),
        batches: batches.reduce((sum, row) => sum + Number(row.batches), 0),
        kg: batches.reduce((sum, row) => sum + Number(row.total_kg), 0),
        cycleSeconds: median,
        lastAt: batches.at(-1) ? new Date(batches.at(-1)!.finished_at).toISOString() : null,
        list: batches.map((row) => ({
          at: new Date(row.finished_at).toISOString(),
          recipe: row.recipe,
          batches: Number(row.batches),
          kg: Number(row.total_kg),
          scaleKg: row.scale_kg == null ? null : Number(row.scale_kg),
          lot: row.lot_number,
        })),
      },
      curve,
    };
  });
}
