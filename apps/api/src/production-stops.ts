import type { Database } from '@iiot/database';
import {
  addDays,
  attribute,
  DEFAULT_SHIFTS,
  env,
  expandShifts,
  plantDate,
  type Runtime,
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

type OpenStop = { state: string; started_at: Date | string };

/**
 * What one look at a machine does to its stops: close the open one (at this instant), open a new
 * one (from this instant), both, or nothing. The live recorder and the rebuild apply the same.
 */
export function stopTransition(
  current: OpenStop | undefined,
  state: ReturnType<typeof stateOf>['state'],
  since: Date | null,
  now: Date,
): { close: Date | null; open: { state: StopState; startedAt: Date } | null } {
  if (state === 'producing' || state === 'unknown') {
    // The counter moved again: the stop ended when it moved, not when this job noticed.
    if (!current) return { close: null, open: null };
    const startedAt = new Date(current.started_at);
    return { close: since && since > startedAt ? since : now, open: null };
  }
  // Still stopped. A state that changed (idle -> offline, say) closes one stop and opens the
  // next, so each row describes a single reason.
  if (current && current.state === state) return { close: null, open: null };
  let startedAt = since ?? now;
  let close: Date | null = null;
  if (current) {
    close = startedAt > new Date(current.started_at) ? startedAt : now;
    // The next reason starts where the last one ended, never before: "idle since" is worked out
    // from the last piece and can lie before a manual stop that was already open, which wrote
    // two overlapping stops for one (99 pairs in a week).
    startedAt = close;
  }
  return { close, open: { state, startedAt } };
}

async function loadSchedules(db: Database, siteIds: string[]) {
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
    [[...new Set(siteIds)]],
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
  return schedule;
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

  const schedule = await loadSchedules(
    db,
    runtime.rows.map((row) => row.site_id),
  );

  const open = await db.query<{ device_id: string; started_at: Date | string; state: string }>(
    'SELECT device_id,started_at,state FROM production_stops WHERE ended_at IS NULL',
  );
  const openBy = new Map(open.rows.map((row) => [row.device_id, row]));

  let opened = 0;
  let closed = 0;
  for (const row of runtime.rows) {
    const { state, since } = stateOf(row, now);
    const step = stopTransition(openBy.get(row.device_id), state, since, now);
    if (step.close) {
      await db.query(
        `UPDATE production_stops
         SET ended_at=$2, seconds=greatest(EXTRACT(EPOCH FROM ($2::timestamptz - started_at)), 0)
         WHERE device_id=$1 AND ended_at IS NULL`,
        [row.device_id, step.close],
      );
      closed += 1;
    }
    if (!step.open) continue;
    await db.query(
      `INSERT INTO production_stops(tenant_id,device_id,state,started_at,during_pause,product_code,production_date)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (device_id,started_at) DO NOTHING`,
      [
        row.tenant_id,
        row.device_id,
        step.open.state,
        step.open.startedAt,
        insidePause(schedule.get(row.site_id) ?? DEFAULT_SHIFTS, step.open.startedAt),
        row.product_code,
        plantDate(step.open.startedAt),
      ],
    );
    opened += 1;
  }
  return { opened, closed };
}

/**
 * The stops of a stretch the recorder missed, written again from the stored telemetry: the
 * messages are replayed through the same attribution as the ingestor, and the machine is looked
 * at once a minute as the recorder does, up to `to` (now, in practice). Every stop that started from
 * `from` on is replaced, including any the live recorder wrote meanwhile; the one open at `from`
 * keeps its start and gets its real end. Readings are kept three days
 * (retention.ts), so a gap can be rebuilt within that.
 */
export async function rebuildStops(db: Database, deviceId: string, from: Date, to: Date) {
  const device = (
    await db.query<{
      tenant_id: string;
      site_id: string;
      blocks_tag_id: string | null;
      pallets_tag_id: string | null;
      auto_tag_id: string | null;
      idle_seconds: number | null;
    }>(
      `SELECT d.tenant_id,d.site_id,ps.blocks_tag_id,ps.pallets_tag_id,ps.auto_tag_id,ps.idle_seconds
       FROM devices d JOIN production_settings ps ON ps.device_id=d.id AND ps.tenant_id=d.tenant_id
       WHERE d.id=$1`,
      [deviceId],
    )
  ).rows[0];
  if (!device || (!device.blocks_tag_id && !device.pallets_tag_id)) return null;
  // Tag ids stand in for keys: the attribution only asks whether each signal is configured.
  const config = {
    piecesKey: device.blocks_tag_id,
    palletsKey: device.pallets_tag_id,
    tonsKey: null,
    autoKey: device.auto_tag_id,
    idleSeconds: device.idle_seconds ?? 60,
    weightPerUnitKg: null,
    weightKey: null,
  };
  // Two hours of warm-up before `from`: the last piece and the link as they stood then.
  const WARM_MS = 2 * 3600_000;
  const messages = await db.query<{
    at: Date | string;
    product_code: string | null;
    pieces: number | null;
    pallets: number | null;
    auto: number | null;
  }>(
    `SELECT min(received_at) at,min(product_code) product_code,
       max(value_number) FILTER (WHERE tag_id=$2) pieces,
       max(value_number) FILTER (WHERE tag_id=$3) pallets,
       max(coalesce(value_number,CASE WHEN value_boolean THEN 1 WHEN NOT value_boolean THEN 0 END))
         FILTER (WHERE tag_id=$4) auto
     FROM telemetry_samples
     WHERE device_id=$1 AND received_at>=$5 AND received_at<$6
     GROUP BY raw_message_id ORDER BY 1`,
    [
      deviceId,
      device.blocks_tag_id,
      device.pallets_tag_id,
      device.auto_tag_id,
      new Date(from.getTime() - WARM_MS),
      to,
    ],
  );
  const number = (value: unknown) =>
    value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  // Readings are stored only when they change (migration 027): each signal holds its last value.
  const carried: { pieces: number | null; pallets: number | null; auto: boolean | null } = {
    pieces: null,
    pallets: null,
    auto: null,
  };
  let runtime: Runtime | null = null;
  let product: string | null = null;
  let next = 0;
  const advance = (until: number) => {
    for (; next < messages.rows.length; next += 1) {
      const item = messages.rows[next];
      const at = new Date(item.at).getTime();
      if (at > until) break;
      carried.pieces = number(item.pieces) ?? carried.pieces;
      carried.pallets = number(item.pallets) ?? carried.pallets;
      carried.auto = item.auto == null ? carried.auto : Number(item.auto) !== 0;
      product = item.product_code ?? product;
      runtime = attribute(
        runtime,
        { at, ...carried, tons: null, weightKg: null, productCode: product ?? 'Sem produto' },
        config,
        env.DEVICE_OFFLINE_SECONDS,
      ).runtime;
    }
  };

  // The stop open when the recorder went quiet: it started before `from` and had not ended then.
  const carriedIn = (
    await db.query<{ id: string; state: string; started_at: Date | string }>(
      `SELECT id,state,started_at FROM production_stops
       WHERE device_id=$1 AND started_at<$2 AND (ended_at IS NULL OR ended_at>$2)
       ORDER BY started_at DESC LIMIT 1`,
      [deviceId, from],
    )
  ).rows[0];
  type Row = { state: StopState; started_at: Date; ended_at: Date | null; product: string | null };
  const rows: Row[] = [];
  let current: (OpenStop & { row?: Row }) | undefined = carriedIn
    ? { state: carriedIn.state, started_at: carriedIn.started_at }
    : undefined;
  let carriedEnd: Date | null = null;
  const MINUTE = 60_000;
  for (let tick = Math.ceil(from.getTime() / MINUTE) * MINUTE; tick < to.getTime(); tick += MINUTE) {
    advance(tick);
    const now = new Date(tick);
    const live = runtime as Runtime | null;
    const { state, since } = live
      ? stateOf(
          {
            tenant_id: device.tenant_id,
            device_id: deviceId,
            site_id: device.site_id,
            last_at: new Date(live.lastAt),
            last_increment_at: live.lastIncrementAt ? new Date(live.lastIncrementAt) : null,
            auto: live.auto,
            product_code: product,
            idle_seconds: device.idle_seconds,
          },
          now,
        )
      : { state: 'unknown' as const, since: null };
    const step = stopTransition(current, state, since, now);
    if (step.close && current) {
      if (current.row) current.row.ended_at = step.close;
      else carriedEnd = step.close;
      current = undefined;
    }
    if (step.open) {
      const row: Row = { state: step.open.state, started_at: step.open.startedAt, ended_at: null, product };
      rows.push(row);
      current = { state: row.state, started_at: row.started_at, row };
    }
  }

  const schedule = (await loadSchedules(db, [device.site_id])).get(device.site_id) ?? DEFAULT_SHIFTS;
  await db.transaction(async (sql) => {
    await sql.query('DELETE FROM production_stops WHERE device_id=$1 AND started_at>=$2', [deviceId, from]);
    // The stop open at `from`: its real end, or still open when the replay did not close it.
    if (carriedIn)
      await sql.query(
        `UPDATE production_stops
         SET ended_at=$2::timestamptz,
           seconds=greatest(EXTRACT(EPOCH FROM ($2::timestamptz - started_at)), 0)
         WHERE id=$1`,
        [carriedIn.id, carriedEnd],
      );
    for (const row of rows)
      await sql.query(
        `INSERT INTO production_stops(tenant_id,device_id,state,started_at,ended_at,seconds,during_pause,
           product_code,production_date)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (device_id,started_at) DO NOTHING`,
        [
          device.tenant_id,
          deviceId,
          row.state,
          row.started_at,
          row.ended_at,
          row.ended_at ? Math.max(0, (row.ended_at.getTime() - row.started_at.getTime()) / 1000) : null,
          insidePause(schedule, row.started_at),
          row.product,
          plantDate(row.started_at),
        ],
      );
  });
  return { stops: rows.length, carriedIn: Boolean(carriedIn), carriedEnd };
}
