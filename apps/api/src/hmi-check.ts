import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import { counterStep } from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';
import { rebuildProductionBuckets } from './shift-production.js';

// "Conferir com a IHM": the HMI counter is the reference. From the last time it started from
// zero, what the HMI counted is compared with what the hourly rollups (the charts and counter
// cards) added up, hour by hour. Adjusting rewrites those hours from the stored readings with
// the counter rule of the production board, where a small step back (an unstable reading) is
// not a reset. The rollup trigger itself is left as it is.

type Access = ReturnType<typeof createAccessControl>;
type Executor = Pick<Database, 'query'>;
const uuid = z.uuid();
const LOOKBACK_DAYS = 7;
const HOUR_MS = 3600 * 1000;

interface Sample {
  at: number;
  value: number;
  product: string;
  site: string;
}
interface RollupRow {
  bucket: number;
  product: string;
  site: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  firstValue: number;
  firstAt: number;
  lastValue: number;
  lastAt: number;
  delta: number;
}

async function loadSamples(sql: Executor, tenantId: string, deviceId: string, tagId: string) {
  const result = await sql.query<{
    timestamp: Date | string;
    value_number: number;
    product_code: string;
    site_id: string;
  }>(
    `SELECT timestamp,value_number,product_code,site_id FROM telemetry_samples
     WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3 AND value_number IS NOT NULL
       AND timestamp>=$4
     ORDER BY timestamp,id`,
    [tenantId, deviceId, tagId, new Date(Date.now() - LOOKBACK_DAYS * 24 * HOUR_MS)],
  );
  return result.rows.map(
    (row): Sample => ({
      at: new Date(row.timestamp).getTime(),
      value: Number(row.value_number),
      product: row.product_code,
      site: row.site_id,
    }),
  );
}

/** Where the HMI counter last started from zero, and what it has counted since. */
function analyse(samples: Sample[]) {
  const last = samples.at(-1);
  if (!last) return null;
  let reading: number | null = null;
  let resetIndex = -1;
  samples.forEach((sample, index) => {
    if (reading != null && sample.value < reading && sample.value <= reading / 2) resetIndex = index;
    reading = counterStep(reading, sample.value).reading;
  });
  return resetIndex >= 0
    ? { since: samples[resetIndex].at, reset: true, hmiValue: last.value, hmiCount: last.value }
    : {
        since: samples[0].at,
        reset: false,
        hmiValue: last.value,
        hmiCount: last.value - samples[0].value,
      };
}

/** Hourly rollups of the samples from `fromHour` on, with the production board's counter rule. */
function rebuildHours(samples: Sample[], fromHour: number) {
  const rows = new Map<string, RollupRow>();
  let reading: number | null = null;
  for (const sample of samples) {
    const step = counterStep(reading, sample.value);
    reading = step.reading;
    if (sample.at < fromHour) continue;
    const bucket = Math.floor(sample.at / HOUR_MS) * HOUR_MS;
    const key = `${bucket}|${sample.product}`;
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        bucket,
        product: sample.product,
        site: sample.site,
        count: 1,
        sum: sample.value,
        min: sample.value,
        max: sample.value,
        firstValue: sample.value,
        firstAt: sample.at,
        lastValue: sample.value,
        lastAt: sample.at,
        delta: step.delta,
      });
      continue;
    }
    row.count += 1;
    row.sum += sample.value;
    row.min = Math.min(row.min, sample.value);
    row.max = Math.max(row.max, sample.value);
    row.lastValue = sample.value;
    row.lastAt = sample.at;
    row.delta += step.delta;
  }
  return [...rows.values()];
}

export async function check(sql: Executor, tenantId: string, deviceId: string, tagId: string) {
  const samples = await loadSamples(sql, tenantId, deviceId, tagId);
  const analysis = analyse(samples);
  if (!analysis) return { empty: true as const };
  // Every whole hour of the stored readings is compared, not only the time since the last reset:
  // an error before a recipe change (which resets the HMI counter) must be found too. The
  // readings of the first, partial hour only give the recount its starting point.
  const fromHour = Math.floor(samples[0].at / HOUR_MS) * HOUR_MS + HOUR_MS;
  const rebuilt = rebuildHours(samples, fromHour);
  const stored = await sql.query<{ bucket: Date | string; positive_delta: number }>(
    `SELECT bucket,positive_delta FROM telemetry_hourly_rollups
     WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3 AND bucket>=$4`,
    [tenantId, deviceId, tagId, new Date(fromHour)],
  );
  const hours = new Map<number, { platform: number; correct: number }>();
  const hour = (at: number) => {
    const entry = hours.get(at) ?? { platform: 0, correct: 0 };
    hours.set(at, entry);
    return entry;
  };
  for (const row of stored.rows)
    hour(new Date(row.bucket).getTime()).platform += Number(row.positive_delta);
  for (const row of rebuilt) hour(row.bucket).correct += row.delta;
  let platformCount = 0;
  let correctCount = 0;
  for (const entry of hours.values()) {
    platformCount += entry.platform;
    correctCount += entry.correct;
  }
  // The production board counts the same counter when it is the device's pieces or pallets.
  const settings = await sql.query<{ blocks_tag_id: string | null; pallets_tag_id: string | null }>(
    'SELECT blocks_tag_id,pallets_tag_id FROM production_settings WHERE tenant_id=$1 AND device_id=$2',
    [tenantId, deviceId],
  );
  const role =
    settings.rows[0]?.blocks_tag_id === tagId
      ? 'pieces'
      : settings.rows[0]?.pallets_tag_id === tagId
        ? 'pallets'
        : null;
  let production: { label: string; value: number } | null = null;
  if (role) {
    const sum = await sql.query<{ total: number | null }>(
      `SELECT sum(${role}) total FROM production_buckets
       WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3`,
      [tenantId, deviceId, new Date(fromHour)],
    );
    production = {
      label: role === 'pieces' ? 'Quadro de produção (peças)' : 'Quadro de produção (paletes)',
      value: Number(sum.rows[0]?.total ?? 0),
    };
  }
  return {
    empty: false as const,
    since: new Date(analysis.since).toISOString(),
    windowStart: new Date(fromHour).toISOString(),
    reset: analysis.reset,
    hmiValue: analysis.hmiValue,
    hmiCount: analysis.hmiCount,
    platformCount,
    correctCount,
    difference: platformCount - correctCount,
    hours: [...hours.entries()]
      .filter(([, entry]) => Math.abs(entry.platform - entry.correct) >= 0.5)
      .sort(([a], [b]) => a - b)
      .map(([at, entry]) => ({
        hour: new Date(at).toISOString(),
        platform: entry.platform,
        correct: entry.correct,
      })),
    production,
    role,
    rebuilt,
    fromHour,
  };
}

export function registerHmiCheckRoutes(app: FastifyInstance, db: Database, access: Access) {
  const findTag = (tenantId: string, deviceId: string, tagId: string) =>
    db.query<{ key: string; name: string | null; data_type: string }>(
      'SELECT key,name,data_type FROM tags WHERE tenant_id=$1 AND device_id=$2 AND id=$3',
      [tenantId, deviceId, tagId],
    );
  const publicView = (
    tag: { key: string; name: string | null },
    result: Awaited<ReturnType<typeof check>>,
  ) => {
    if (result.empty) return { key: tag.key, name: tag.name, empty: true };
    const { rebuilt: _rebuilt, fromHour: _fromHour, role: _role, ...view } = result;
    return { key: tag.key, name: tag.name, ...view };
  };

  app.get('/api/devices/:id/tags/:tagId/hmi-check', async (req, reply) => {
    const { id, tagId } = z.object({ id: uuid, tagId: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const tenantId = access.principal(req).tenantId;
    const tag = await findTag(tenantId, id, tagId);
    if (!tag.rows[0]) return reply.code(404).send({ error: 'Variable not found' });
    if (tag.rows[0].data_type !== 'number')
      return reply.code(400).send({ error: 'Só contadores numéricos podem ser conferidos.' });
    return publicView(tag.rows[0], await check(db, tenantId, id, tagId));
  });

  app.post('/api/devices/:id/tags/:tagId/hmi-check', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id, tagId } = z.object({ id: uuid, tagId: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const tag = await findTag(current.tenantId, id, tagId);
    if (!tag.rows[0]) return reply.code(404).send({ error: 'Variable not found' });
    if (tag.rows[0].data_type !== 'number')
      return reply.code(400).send({ error: 'Só contadores numéricos podem ser conferidos.' });
    const outcome = await db.transaction(async (sql) => {
      // The rollup trigger locks this row for every new reading: holding it keeps new
      // readings waiting until the rewritten hours are in place.
      await sql.query(
        'SELECT 1 FROM telemetry_numeric_state WHERE device_id=$1 AND tag_id=$2 FOR UPDATE',
        [id, tagId],
      );
      const before = await check(sql, current.tenantId, id, tagId);
      if (before.empty) return null;
      await sql.query(
        `DELETE FROM telemetry_hourly_rollups
         WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3 AND bucket>=$4`,
        [current.tenantId, id, tagId, new Date(before.fromHour)],
      );
      for (let index = 0; index < before.rebuilt.length; index += 300) {
        const values: unknown[] = [];
        const tuples = before.rebuilt.slice(index, index + 300).map((row) => {
          const item = [
            current.tenantId,
            row.site,
            id,
            tagId,
            row.product,
            new Date(row.bucket),
            row.count,
            row.sum,
            row.min,
            row.max,
            row.firstValue,
            new Date(row.firstAt),
            row.lastValue,
            new Date(row.lastAt),
            row.delta,
          ];
          return `(${item.map((value) => (values.push(value), `$${values.length}`)).join(',')})`;
        });
        await sql.query(
          `INSERT INTO telemetry_hourly_rollups(
             tenant_id,site_id,device_id,tag_id,product_code,bucket,sample_count,value_sum,
             value_min,value_max,first_value,first_at,last_value,last_at,positive_delta
           ) VALUES ${tuples.join(',')}`,
          values,
        );
      }
      await recordAudit(sql, req, current, {
        action: 'tag.hmi_adjust',
        targetType: 'tag',
        targetId: tagId,
        summary: {
          key: tag.rows[0].key,
          since: before.since,
          hmiCount: before.hmiCount,
          platformBefore: before.platformCount,
          platformAfter: before.correctCount,
          hours: before.hours.length,
        },
      });
      return before;
    });
    if (!outcome) return reply.code(400).send({ error: 'Sem leituras dessa variável para conferir.' });
    // The production board recounts the same period when this is its counter.
    if (outcome.role)
      await rebuildProductionBuckets(db, current.tenantId, id, { from: new Date(outcome.fromHour) });
    return publicView(tag.rows[0], await check(db, current.tenantId, id, tagId));
  });
}
