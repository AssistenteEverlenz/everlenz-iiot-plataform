import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import { addDays, plantDate, plantInstant } from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import {
  adherenceToleranceOf,
  currentState,
  loadConfig,
  loadShiftsFor,
  productionDetailData,
} from './shift-production.js';
import { loadAdherence } from './shift-adherence.js';

/**
 * The summary a panel opens with.
 *
 * The plants' people come back to the platform five to nine times a day, a minute each time,
 * on the phone, to ask the same question: how is production going. This answers it in one
 * screen before the panel: the day so far against the target, where it is heading, the machine
 * now, what changed since that person last looked, and today against yesterday at the same time.
 * Every number is the production board's own.
 */
type Access = ReturnType<typeof createAccessControl>;

/** A gap longer than this between two minutes on screen separates two visits. */
const VISIT_GAP_MS = 10 * 60_000;

/** When this person's previous visit ended, from the minutes the browser reports (migration 042). */
async function previousVisitEnd(db: Database, userId: string, now: Date) {
  try {
    const minutes = (
      await db.query<{ minute: Date }>(
        `SELECT minute FROM usage_minutes WHERE user_id=$1 AND minute <= $2 AND NOT tv
         ORDER BY minute DESC LIMIT 600`,
        [userId, now],
      )
    ).rows.map((row) => new Date(row.minute).getTime());
    // Walk back through the visit going on now; the first gap marks the previous one.
    let cursor = now.getTime();
    for (const minute of minutes) {
      if (cursor - minute > VISIT_GAP_MS) return new Date(minute);
      cursor = minute;
    }
  } catch {
    // Usage not recorded on this database (migration 042 not applied).
  }
  return null;
}

function inMetric(metric: string, row: { pieces: string; pallets: string; tons: string }) {
  if (metric === 'pallets') return Number(row.pallets);
  if (metric === 'tons') return Number(row.tons);
  if (metric === 'blocks') return Number(row.pieces);
  return Number(row.pieces) / 1000;
}

async function madeBetween(db: Database, deviceId: string, metric: string, from: Date, to: Date) {
  const result = await db.query<{ pieces: string; pallets: string; tons: string }>(
    `SELECT coalesce(sum(pieces),0) pieces,coalesce(sum(pallets),0) pallets,coalesce(sum(tons),0) tons
     FROM production_buckets WHERE device_id=$1 AND bucket >= $2 AND bucket < $3`,
    [deviceId, from, to],
  );
  return inMetric(metric, result.rows[0]);
}

/**
 * One machine's day so far, as the panel's summary shows it. With a person (current.id) it also
 * tells what changed since that person's last visit; the WhatsApp assistant calls it without one.
 */
export async function buildBriefing(
  db: Database,
  current: { tenantId: string; id: string | null },
  id: string,
  now = new Date(),
) {
    const config = await loadConfig(db, current.tenantId, id);
    if (!config || !(config.blocks_tag_id || config.pallets_tag_id)) return { configured: false as const };
    const today = plantDate(now);
    const [detail, device, state] = await Promise.all([
      productionDetailData(db, current.tenantId, id, config, { date: today, kind: 'day' }),
      db.query<{ name: string }>('SELECT name FROM devices WHERE tenant_id=$1 AND id=$2', [
        current.tenantId,
        id,
      ]),
      currentState(db, id, Number(config.idle_seconds ?? 60), now),
    ]);
    const board = detail.board;
    const metric = board.metric;

    // Producing since when: the end of the last stop, when there is one today.
    let since = state.since;
    if (state.state === 'producing') {
      const lastStop = await db.query<{ ended_at: Date | null }>(
        `SELECT ended_at FROM production_stops WHERE device_id=$1 AND ended_at IS NOT NULL
         ORDER BY ended_at DESC LIMIT 1`,
        [id],
      );
      since = lastStop.rows[0]?.ended_at ? new Date(lastStop.rows[0].ended_at).toISOString() : null;
    }

    const dayStart = plantInstant(today, '00:00');
    const [stops, previous] = await Promise.all([
      db.query<{ n: string }>(
        `SELECT count(*) n FROM production_stops
         WHERE device_id=$1 AND NOT during_pause AND started_at >= $2`,
        [id, dayStart],
      ),
      current.id ? previousVisitEnd(db, current.id, now) : Promise.resolve(null),
    ]);
    const made = await madeBetween(db, id, metric, dayStart, now);
    // Yesterday from midnight to the same time of day.
    const yesterdayStart = plantInstant(addDays(today, -1), '00:00');
    const yesterday = await madeBetween(
      db,
      id,
      metric,
      yesterdayStart,
      new Date(yesterdayStart.getTime() + (now.getTime() - dayStart.getTime())),
    );
    // The shift as registered against as it happened (shift-adherence.ts): when the line really
    // started, left for and came back from each pause, and stopped.
    const registered = (await loadShiftsFor(db, current.tenantId, config.site_id, today)).filter(
      (item) => item.productionDate === today,
    );
    const [adherence, tolerance] = await Promise.all([
      loadAdherence(db, id, registered, now),
      adherenceToleranceOf(db, current.tenantId, id),
    ]);
    let sinceVisit: { at: string; made: number; stops: number } | null = null;
    // Only a visit from the last day and a half is "since your last visit"; older is just news.
    if (previous && now.getTime() - previous.getTime() < 36 * 3600_000) {
      const stopped = await db.query<{ n: string }>(
        `SELECT count(*) n FROM production_stops
         WHERE device_id=$1 AND NOT during_pause AND started_at >= $2`,
        [id, previous],
      );
      sinceVisit = {
        at: previous.toISOString(),
        made: await madeBetween(db, id, metric, previous, now),
        stops: Number(stopped.rows[0]?.n ?? 0),
      };
    }

    return {
      configured: true as const,
      device: { id, name: device.rows[0]?.name ?? '' },
      now: now.toISOString(),
      shiftStatus: detail.status,
      shifts: detail.shifts.map((item) => ({ name: item.name, start: item.start, end: item.end })),
      metric,
      state: { state: state.state, since, product: state.product },
      made,
      totals: board.totals,
      target: board.target
        ? {
            value: board.target.value,
            actual: board.target.actual,
            plannedToNow: board.target.plannedToNow,
            projected: board.target.projected,
            requiredPerHour: board.target.requiredPerHour,
          }
        : null,
      pacePerHour: board.pacePerHour,
      utilization: board.utilization,
      stopped: {
        count: Number(stops.rows[0]?.n ?? 0),
        seconds: board.time.idle + board.time.manual + board.time.offline,
      },
      yesterday,
      sinceVisit,
      adherence,
      tolerance,
    };
}

export function registerBriefingRoutes(app: FastifyInstance, db: Database, access: Access) {
  app.get('/api/devices/:id/briefing', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    return buildBriefing(db, { tenantId: current.tenantId, id: current.id }, id);
  });
}
