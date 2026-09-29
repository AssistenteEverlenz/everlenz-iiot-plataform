import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { recordStops } from '../apps/api/src/production-stops.js';

async function base() {
  const { db } = await memoryDatabase();
  await migrate(db);
  await seed(db);
  await db.query(
    `INSERT INTO production_settings(device_id,tenant_id,idle_seconds) VALUES($1,$2,60)
     ON CONFLICT (device_id) DO UPDATE SET idle_seconds=60`,
    [HAIWELL, TENANT],
  );
  return db;
}

async function runtime(db: Awaited<ReturnType<typeof base>>, lastAt: Date, increment: Date, auto = true) {
  await db.query(
    `INSERT INTO production_runtime(tenant_id,device_id,last_at,last_increment_at,auto,product_code)
     VALUES($1,$2,$3,$4,$5,'BLOCO A')
     ON CONFLICT (device_id) DO UPDATE SET last_at=$3,last_increment_at=$4,auto=$5`,
    [TENANT, HAIWELL, lastAt, increment, auto],
  );
}

const stops = async (db: Awaited<ReturnType<typeof base>>) =>
  (
    await db.query<{ state: string; started_at: Date; ended_at: Date | null; seconds: number | null }>(
      'SELECT state,started_at,ended_at,seconds FROM production_stops ORDER BY started_at',
    )
  ).rows;

describe('production stops', () => {
  it('opens a stop when the counter goes quiet and closes it when it moves again', async () => {
    const db = await base();
    const now = new Date('2026-09-29T14:00:00Z');

    // Producing: nothing to record.
    await runtime(db, now, now);
    expect(await recordStops(db, now)).toEqual({ opened: 0, closed: 0 });
    expect(await stops(db)).toHaveLength(0);

    // The counter has not moved for five minutes: one stop, starting when the idle limit ran out.
    const quiet = new Date(now.getTime() + 5 * 60_000);
    await runtime(db, quiet, now);
    expect(await recordStops(db, quiet)).toEqual({ opened: 1, closed: 0 });
    const [open] = await stops(db);
    expect(open.state).toBe('idle');
    expect(open.ended_at).toBeNull();
    // Started one idle period after the last piece, not when the job noticed.
    expect(open.started_at.toISOString()).toBe(new Date(now.getTime() + 60_000).toISOString());

    // A second pass while still stopped must not open another. The machine keeps reporting, so
    // its reason stays "idle".
    const later = new Date(quiet.getTime() + 20_000);
    await runtime(db, later, now);
    expect(await recordStops(db, later)).toEqual({ opened: 0, closed: 0 });
    expect(await stops(db)).toHaveLength(1);

    // The counter moves: the stop closes at the moment it moved.
    const back = new Date(quiet.getTime() + 2 * 60_000);
    await runtime(db, back, back);
    expect(await recordStops(db, back)).toEqual({ opened: 0, closed: 1 });
    const [done] = await stops(db);
    expect(done.ended_at?.toISOString()).toBe(back.toISOString());
    expect(Math.round(Number(done.seconds))).toBe(6 * 60);
  });

  it('counts a change of reason as a new stop', async () => {
    const db = await base();
    const start = new Date('2026-09-29T14:00:00Z');
    await runtime(db, start, start);
    await recordStops(db, start);

    // Idle first.
    const idle = new Date(start.getTime() + 5 * 60_000);
    await runtime(db, idle, start);
    await recordStops(db, idle);

    // Then the machine goes quiet altogether: the idle stop closes, an offline one opens.
    const gone = new Date(idle.getTime() + 60 * 60_000);
    expect(await recordStops(db, gone)).toEqual({ opened: 1, closed: 1 });
    const rows = await stops(db);
    expect(rows.map((row) => row.state)).toEqual(['idle', 'offline']);
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[1].ended_at).toBeNull();
  });

  it('records manual as its own reason', async () => {
    const db = await base();
    const now = new Date('2026-09-29T14:00:00Z');
    await runtime(db, now, now, false);
    expect(await recordStops(db, now)).toEqual({ opened: 1, closed: 0 });
    expect((await stops(db))[0].state).toBe('manual');
  });
});
