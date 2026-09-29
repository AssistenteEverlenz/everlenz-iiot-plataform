import type { Database } from '@iiot/database';
import {
  addDays,
  DEFAULT_SHIFTS,
  env,
  expandShifts,
  plantDate,
  type ShiftDefinition,
} from '@iiot/shared';

/**
 * Every stop of the line, written as it happens (migration 032).
 *
 * The 5-minute buckets already say how many seconds a machine spent stopped, but never how many
 * times it stopped, and seconds cannot be turned back into a count. Readings are pruned after
 * three days, so whatever is not recorded now is lost: this runs on the same minute timer as the
 * shift close, opens a stop when the line goes quiet and closes it when the counter moves again.
 */
export type StopState = 'idle' | 'manual' | 'offline';

type RuntimeRow = {
  tenant_id: string;
  device_id: string;
  site_id: string;
  last_at: Date | string | null;
  last_increment_at: Date | string | null;
  auto: boolean | null;
  product_code: string | null;
  idle_seconds: number | null;
};

/**
 * What a machine is doing now, and since when. The same reading of the runtime the operations
 * page makes, kept here so the recorder never disagrees with what the plant sees on screen.
 */
export function stateOf(row: RuntimeRow, now: Date) {
  const lastAt = row.last_at ? new Date(row.last_at).getTime() : 0;
  if (!lastAt) return { state: 'unknown' as const, since: null };
  if (now.getTime() - lastAt > env.DEVICE_OFFLINE_SECONDS * 1000)
    return { state: 'offline' as const, since: new Date(lastAt) };
  if (row.auto === false) return { state: 'manual' as const, since: null };
  const increment = row.last_increment_at ? new Date(row.last_increment_at).getTime() : lastAt;
  const idleAfter = increment + Number(row.idle_seconds ?? 60) * 1000;
  if (now.getTime() > idleAfter) return { state: 'idle' as const, since: new Date(idleAfter) };
  return { state: 'producing' as const, since: new Date(increment) };
}

/** Is this instant inside a scheduled break? A break is not a failure and is counted apart. */
function insidePause(definitions: ShiftDefinition[], at: Date) {
  const occurrences = expandShifts(definitions, addDays(plantDate(at), -1), plantDate(at));
  return occurrences.some(
    (occurrence) =>
      occurrence.start <= at &&
      at < occurrence.end &&
      occurrence.breaks.some((pause) => pause.start <= at && at < pause.end),
  );
}

export async function recordStops(db: Database, now = new Date()) {
  const runtime = await db.query<RuntimeRow>(
    `SELECT d.tenant_id, d.id AS device_id, d.site_id,
            pr.last_at, pr.last_increment_at, pr.auto, pr.product_code,
            ps.idle_seconds
     FROM devices d
     LEFT JOIN production_runtime pr ON pr.device_id=d.id AND pr.tenant_id=d.tenant_id
     LEFT JOIN production_settings ps ON ps.device_id=d.id AND ps.tenant_id=d.tenant_id
     WHERE d.archived_at IS NULL AND d.enabled=true`,
  );
  if (!runtime.rows.length) return { opened: 0, closed: 0 };

  const shiftRows = await db.query<{
    site_id: string;
    id: string;
    name: string;
    weekdays: number[];
    start_time: string;
    end_time: string;
    breaks: Array<{ start: string; end: string }>;
  }>(
    `SELECT site_id,id,name,weekdays,start_time,end_time,breaks FROM site_shifts
     WHERE site_id=ANY($1::uuid[]) ORDER BY sort_order,start_time`,
    [[...new Set(runtime.rows.map((row) => row.site_id))]],
  );
  const schedule = new Map<string, ShiftDefinition[]>();
  for (const row of shiftRows.rows) {
    const entries = schedule.get(row.site_id) ?? [];
    entries.push({
      id: row.id,
      name: row.name,
      weekdays: row.weekdays.map(Number),
      start: row.start_time,
      end: row.end_time,
      breaks: Array.isArray(row.breaks) ? row.breaks : [],
    });
    schedule.set(row.site_id, entries);
  }

  const open = await db.query<{ device_id: string; started_at: Date | string; state: string }>(
    'SELECT device_id,started_at,state FROM production_stops WHERE ended_at IS NULL',
  );
  const openBy = new Map(open.rows.map((row) => [row.device_id, row]));

  let opened = 0;
  let closed = 0;
  for (const row of runtime.rows) {
    const { state, since } = stateOf(row, now);
    const current = openBy.get(row.device_id);

    if (state === 'producing' || state === 'unknown') {
      // The counter moved again: the stop ended when it moved, not when this job noticed.
      if (!current) continue;
      const startedAt = new Date(current.started_at);
      const endedAt = since && since > startedAt ? since : now;
      await db.query(
        `UPDATE production_stops
         SET ended_at=$2, seconds=EXTRACT(EPOCH FROM ($2::timestamptz - started_at))
         WHERE device_id=$1 AND ended_at IS NULL`,
        [row.device_id, endedAt],
      );
      closed += 1;
      continue;
    }

    // Still stopped. A state that changed (idle -> offline, say) closes one stop and opens the
    // next, so each row describes a single reason.
    if (current && current.state === state) continue;
    const startedAt = since ?? now;
    if (current) {
      await db.query(
        `UPDATE production_stops
         SET ended_at=$2, seconds=greatest(EXTRACT(EPOCH FROM ($2::timestamptz - started_at)), 0)
         WHERE device_id=$1 AND ended_at IS NULL`,
        [row.device_id, startedAt > new Date(current.started_at) ? startedAt : now],
      );
      closed += 1;
    }
    await db.query(
      `INSERT INTO production_stops(tenant_id,device_id,state,started_at,during_pause,product_code,production_date)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (device_id,started_at) DO NOTHING`,
      [
        row.tenant_id,
        row.device_id,
        state,
        startedAt,
        insidePause(schedule.get(row.site_id) ?? DEFAULT_SHIFTS, startedAt),
        row.product_code,
        plantDate(startedAt),
      ],
    );
    opened += 1;
  }
  return { opened, closed };
}
