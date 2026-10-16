import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';
import { adherenceOf, type Window } from './shift-adherence.js';
import { loadShiftsFor } from './shift-production.js';

/**
 * "Turno previsto × real" for a mortar line: the ceramic rule (shift-adherence.ts) read from the
 * bagger. The line produces while any spout fills bags, so the line is stopped only where every
 * spout is stopped at once -- idle, disabled, or silent (no reading at all in a five-minute block).
 *
 * The spout recorder opens an idle stop when the idle limit runs out after the last bag, so the
 * line really left at the last bag: an idle stop is moved back by that limit. A disabled spout
 * stops the moment the operator turns it off.
 */
const REACH_MS = 3 * 3600_000;
const BUCKET_MS = 300_000;
/** A five-minute block with less than this much time accounted is a spout with no readings. */
const SILENT_SECONDS = 60;

/** The union of intervals, sorted and merged. */
function union(items: Window[]) {
  const sorted = [...items]
    .filter((item) => item.end.getTime() > item.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Window[] = [];
  for (const item of sorted) {
    const last = out.at(-1);
    if (last && item.start.getTime() <= last.end.getTime()) {
      if (item.end.getTime() > last.end.getTime()) last.end = item.end;
    } else out.push({ start: item.start, end: item.end });
  }
  return out;
}

/** Where two sorted unions overlap. */
function intersect(a: Window[], b: Window[]) {
  const out: Window[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start.getTime(), b[j].start.getTime());
    const end = Math.min(a[i].end.getTime(), b[j].end.getTime());
    if (end > start) out.push({ start: new Date(start), end: new Date(end) });
    if (a[i].end.getTime() < b[j].end.getTime()) i += 1;
    else j += 1;
  }
  return out;
}

export async function loadMortarAdherence(
  db: Database,
  tenantId: string,
  deviceId: string,
  occurrences: Awaited<ReturnType<typeof loadShiftsFor>>,
  now: Date,
) {
  if (!occurrences.length) return null;
  const from = new Date(Math.min(...occurrences.map((item) => item.start.getTime())) - REACH_MS);
  const to = new Date(
    Math.min(now.getTime(), Math.max(...occurrences.map((item) => item.end.getTime())) + REACH_MS),
  );
  const spouts = (
    await db.query<{ id: string }>(
      'SELECT id FROM bagging_spouts WHERE tenant_id=$1 AND device_id=$2',
      [tenantId, deviceId],
    )
  ).rows;
  if (!spouts.length) return null;
  const settings = (
    await db.query<{ idle_seconds: number }>(
      'SELECT idle_seconds FROM mortar_settings WHERE tenant_id=$1 AND device_id=$2',
      [tenantId, deviceId],
    )
  ).rows[0];
  const idleMs = (settings?.idle_seconds ?? 120) * 1000;

  // A device with no reading before the window ends has nothing to say yet.
  const first = await db.query<{ at: Date | null }>(
    'SELECT min(bucket) at FROM bagging_buckets WHERE tenant_id=$1 AND device_id=$2',
    [tenantId, deviceId],
  );
  if (!first.rows[0]?.at || new Date(first.rows[0].at) > to) return null;

  const stops = await db.query<{
    spout_id: string;
    state: string;
    started_at: Date;
    ended_at: Date;
  }>(
    `SELECT spout_id,state,started_at,ended_at FROM bagging_stops
     WHERE tenant_id=$1 AND device_id=$2 AND started_at < $4 AND ended_at > $3`,
    [tenantId, deviceId, from, to],
  );
  const open = await db.query<{
    spout_id: string;
    stop_started_at: Date | null;
    stop_state: string | null;
  }>(
    'SELECT spout_id,stop_started_at,stop_state FROM bagging_runtime WHERE tenant_id=$1 AND device_id=$2',
    [tenantId, deviceId],
  );
  const buckets = await db.query<{ spout_id: string; bucket: Date; seconds: number }>(
    `SELECT spout_id,bucket,sum(running_s+idle_s+off_s)::float seconds FROM bagging_buckets
     WHERE tenant_id=$1 AND device_id=$2 AND bucket >= $3 AND bucket < $4
     GROUP BY spout_id,bucket`,
    [tenantId, deviceId, new Date(from.getTime() - BUCKET_MS), to],
  );

  const back = (state: string, start: Date) =>
    state === 'idle' ? new Date(start.getTime() - idleMs) : start;
  // The last block still filling is not a silence yet.
  const lastWhole = Math.floor((now.getTime() - BUCKET_MS) / BUCKET_MS) * BUCKET_MS;
  let line: Window[] | null = null;
  for (const spout of spouts) {
    const stopped: Window[] = stops.rows
      .filter((row) => row.spout_id === spout.id)
      .map((row) => ({
        start: back(row.state, new Date(row.started_at)),
        end: new Date(row.ended_at),
      }));
    const live = open.rows.find((row) => row.spout_id === spout.id);
    if (live?.stop_started_at)
      stopped.push({ start: back(live.stop_state ?? 'idle', new Date(live.stop_started_at)), end: now });
    const heard = new Set(
      buckets.rows
        .filter((row) => row.spout_id === spout.id && Number(row.seconds) >= SILENT_SECONDS)
        .map((row) => new Date(row.bucket).getTime()),
    );
    for (
      let at = Math.floor(from.getTime() / BUCKET_MS) * BUCKET_MS;
      at < Math.min(to.getTime(), lastWhole);
      at += BUCKET_MS
    )
      if (!heard.has(at)) stopped.push({ start: new Date(at), end: new Date(at + BUCKET_MS) });
    const own = union(stopped);
    line = line ? intersect(line, own) : own;
  }
  return adherenceOf(
    occurrences,
    (line ?? []).map((item) => ({ ...item, state: 'idle' })),
    now,
  );
}

export function registerMortarAdherenceRoutes(
  app: FastifyInstance,
  db: Database,
  access: ReturnType<typeof createAccessControl>,
) {
  app.get('/api/devices/:id/mortar/adherence', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = z
      .object({
        date: z.iso.date(),
        start: z.iso.datetime().optional(),
        end: z.iso.datetime().optional(),
      })
      .parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const device = (
      await db.query<{ site_id: string }>('SELECT site_id FROM devices WHERE tenant_id=$1 AND id=$2', [
        tenantId,
        id,
      ])
    ).rows[0];
    if (!device) return reply.code(404).send({ error: 'Device not found' });
    const startAt = query.start ? new Date(query.start).getTime() : Number.NEGATIVE_INFINITY;
    const endAt = query.end ? new Date(query.end).getTime() : Number.POSITIVE_INFINITY;
    const occurrences = (await loadShiftsFor(db, tenantId, device.site_id, query.date)).filter(
      (item) =>
        item.productionDate === query.date &&
        item.start.getTime() < endAt &&
        item.end.getTime() > startAt,
    );
    return {
      adherence: await loadMortarAdherence(db, tenantId, id, occurrences, new Date()),
    };
  });
}
