import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';

type Access = ReturnType<typeof createAccessControl>;
const uuid = z.uuid();

// Laboratory (master only): shows, on the plant's real data, what the platform would keep once
// the readings of a closed shift are discarded. Nothing here writes: it measures the storage
// and assembles the "shift photo" (the board, the charts and the minute curve of one closed
// shift) exactly from the routes the history modal reads, so both sides can be compared.

const FOUR_HOURS_MS = 4 * 3600 * 1000;

export function registerLabRoutes(app: FastifyInstance, db: Database, access: Access) {
  // The same routes the history modal calls, as the same user: the photo is what they return.
  async function read(req: FastifyRequest, url: string) {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: {
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(req.headers['x-forwarded-for']
          ? { 'x-forwarded-for': String(req.headers['x-forwarded-for']) }
          : {}),
      },
    });
    if (response.statusCode !== 200) throw new Error(`${url} → ${response.statusCode}`);
    return response.json() as unknown;
  }

  app.get('/api/lab/devices/:id/storage', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { tenantId } = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [hours, totals] = await Promise.all([
      db.query<{ hour: Date; samples: number; raw: number }>(
        `WITH hours AS (
           SELECT generate_series(date_trunc('hour',now())-interval '47 hours',date_trunc('hour',now()),interval '1 hour') AS slot
         )
         SELECT h.slot AS hour,
           (SELECT count(*) FROM telemetry_samples s WHERE s.tenant_id=$1 AND s.device_id=$2
              AND s.received_at>=h.slot AND s.received_at<h.slot+interval '1 hour')::int samples,
           (SELECT count(*) FROM mqtt_messages_raw r WHERE r.tenant_id=$1 AND r.device_id=$2
              AND r.received_at>=h.slot AND r.received_at<h.slot+interval '1 hour')::int raw
         FROM hours h ORDER BY h.slot`,
        [tenantId, id],
      ),
      db.query<{
        samples: number;
        raw: number;
        rollups: number;
        buckets: number;
        reports: number;
        first_sample: Date | null;
      }>(
        `SELECT
           (SELECT count(*) FROM telemetry_samples WHERE tenant_id=$1 AND device_id=$2)::int samples,
           (SELECT count(*) FROM mqtt_messages_raw WHERE tenant_id=$1 AND device_id=$2)::int raw,
           (SELECT count(*) FROM telemetry_hourly_rollups WHERE tenant_id=$1 AND device_id=$2)::int rollups,
           (SELECT count(*) FROM production_buckets WHERE tenant_id=$1 AND device_id=$2)::int buckets,
           (SELECT count(*) FROM shift_reports WHERE tenant_id=$1 AND device_id=$2)::int reports,
           (SELECT min(received_at) FROM telemetry_samples WHERE tenant_id=$1 AND device_id=$2) first_sample`,
        [tenantId, id],
      ),
    ]);
    return { hours: hours.rows, totals: totals.rows[0] };
  });

  // The photo of one closed shift: what the history modal shows, read once and kept as a value.
  app.get('/api/lab/devices/:id/snapshot', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { tenantId } = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const query = z
      .object({
        date: z.iso.date(),
        kind: z.enum(['shift', 'day', 'off_shift']).default('shift'),
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
      })
      .parse(req.query);
    const started = Date.now();
    const params = new URLSearchParams({
      date: query.date,
      kind: query.kind,
      start: query.start,
      end: query.end,
    });
    const window = `&from=${encodeURIComponent(query.start)}&to=${encodeURIComponent(query.end)}`;
    const [detail, charts] = await Promise.all([
      read(req, `/api/devices/${id}/production-detail?${params}`),
      read(req, `/api/devices/${id}/shift-detail?mode=${query.kind === 'day' ? 'day' : 'shift'}${window}`),
    ]);
    // The minute curve of the whole shift, in the 4-hour windows the zoom route accepts.
    const minutes: Array<{ t: string; value: number }> = [];
    const from = new Date(query.start).getTime();
    const to = new Date(query.end).getTime();
    for (let cursor = from; cursor < to; cursor += FOUR_HOURS_MS) {
      const end = Math.min(to, cursor + FOUR_HOURS_MS);
      const part = (await read(
        req,
        `/api/devices/${id}/shift-minutes?from=${encodeURIComponent(new Date(cursor).toISOString())}&to=${encodeURIComponent(new Date(end).toISOString())}`,
      )) as { minutes: Array<{ t: string; value: number }> };
      for (const item of part.minutes)
        if (!minutes.length || minutes.at(-1)!.t !== item.t) minutes.push(item);
    }
    const liveMs = Date.now() - started;
    const photo = { detail, charts, minutes };
    const readings = await db.query<{ count: number }>(
      `SELECT count(*)::int count FROM telemetry_samples
       WHERE tenant_id=$1 AND device_id=$2 AND received_at>=$3 AND received_at<$4`,
      [tenantId, id, new Date(query.start), new Date(query.end)],
    );
    return {
      photo,
      bytes: Buffer.byteLength(JSON.stringify(photo)),
      liveMs,
      readings: readings.rows[0].count,
    };
  });

  // One variable of one day, as it would be charted with every reading and with only the hourly
  // summary that stays after the readings are discarded.
  app.get('/api/lab/devices/:id/variable', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { tenantId } = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const query = z.object({ tagId: uuid, from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).parse(req.query);
    const [full, hourly] = await Promise.all([
      db.query<{ t: Date; value: number }>(
        `SELECT timestamp t,value_number value FROM telemetry_samples
         WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3 AND value_number IS NOT NULL
           AND timestamp>=$4 AND timestamp<$5 ORDER BY timestamp LIMIT 20000`,
        [tenantId, id, query.tagId, new Date(query.from), new Date(query.to)],
      ),
      db.query<{ t: Date; average: number; minimum: number; maximum: number; last: number }>(
        `SELECT bucket t,sum(value_sum)/nullif(sum(sample_count),0) average,min(value_min) minimum,
           max(value_max) maximum,(array_agg(last_value ORDER BY last_at DESC))[1] last
         FROM telemetry_hourly_rollups
         WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3 AND bucket>=$4 AND bucket<$5
         GROUP BY bucket ORDER BY bucket`,
        [tenantId, id, query.tagId, new Date(query.from), new Date(query.to)],
      ),
    ]);
    return { full: full.rows, hourly: hourly.rows };
  });
}
