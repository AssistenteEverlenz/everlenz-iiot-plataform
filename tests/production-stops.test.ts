import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { rebuildStops, recordStops } from '../apps/api/src/production-stops.js';

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
  }, 30_000);

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
  }, 30_000);

  it('records manual as its own reason', async () => {
    const db = await base();
    const now = new Date('2026-09-29T14:00:00Z');
    await runtime(db, now, now, false);
    expect(await recordStops(db, now)).toEqual({ opened: 1, closed: 0 });
    expect((await stops(db))[0].state).toBe('manual');
  }, 30_000);

  it('keeps a machine switched off for the weekend offline until it comes back', async () => {
    // Capixaba, 2026-10-17: nothing sent from Friday night to Monday 07:20, so nothing in the
    // warm-up; the replay must still read it as offline, not close its stop on Saturday.
    const db = await base();
    const site = (await db.query<{ site_id: string }>('SELECT site_id FROM devices WHERE id=$1', [HAIWELL]))
      .rows[0].site_id;
    const tag = (
      await db.query<{ id: string }>(
        "INSERT INTO tags(tenant_id,device_id,key,name,data_type) VALUES($1,$2,'Blocos','Blocos','number') RETURNING id",
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    await db.query('UPDATE production_settings SET blocks_tag_id=$1 WHERE device_id=$2', [tag, HAIWELL]);
    let count = 500;
    let message = 1;
    const send = async (from: Date, to: Date, running: boolean) => {
      for (let t = from.getTime(); t < to.getTime(); t += 15_000) {
        if (running) count += 1;
        await db.query(
          `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,quality,raw_message_id)
           VALUES($1,$2,$3,$4,$5,$5,$6,'good',$7)`,
          [TENANT, site, HAIWELL, tag, new Date(t), count, message++],
        );
      }
    };
    await send(new Date('2026-10-16T18:30:00Z'), new Date('2026-10-16T19:04:00Z'), true);
    await send(new Date('2026-10-19T10:20:00Z'), new Date('2026-10-19T11:00:00Z'), true);
    await db.query(
      `INSERT INTO production_stops(tenant_id,device_id,state,started_at,production_date)
       VALUES($1,$2,'offline','2026-10-16T19:04:32Z','2026-10-16')`,
      [TENANT, HAIWELL],
    );
    await rebuildStops(db, HAIWELL, new Date('2026-10-17T16:10:00Z'), new Date('2026-10-19T11:00:00Z'));
    const rows = await stops(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('offline');
    // Back with the first block on Monday, not at the start of the gap on Saturday.
    expect(rows[0].ended_at?.toISOString()).toBe('2026-10-19T10:20:00.000Z');

    // Back on Monday but not producing yet (Capixaba: manual and idle from 07:20): the silence
    // ends when the machine speaks again, not at Friday's last block plus the idle limit.
    await db.query('DELETE FROM telemetry_samples WHERE received_at > $1', [new Date('2026-10-19T00:00:00Z')]);
    await db.query('DELETE FROM production_stops');
    await db.query(
      `INSERT INTO production_stops(tenant_id,device_id,state,started_at,production_date)
       VALUES($1,$2,'offline','2026-10-16T19:04:32Z','2026-10-16')`,
      [TENANT, HAIWELL],
    );
    await send(new Date('2026-10-19T10:20:00Z'), new Date('2026-10-19T10:40:00Z'), false);
    await send(new Date('2026-10-19T10:40:00Z'), new Date('2026-10-19T11:00:00Z'), true);
    await rebuildStops(db, HAIWELL, new Date('2026-10-17T16:10:00Z'), new Date('2026-10-19T11:00:00Z'));
    expect(
      (await stops(db)).map((row) => [row.state, row.started_at.toISOString(), row.ended_at?.toISOString()]),
    ).toEqual([
      ['offline', '2026-10-16T19:04:32.000Z', '2026-10-19T10:20:00.000Z'],
      ['idle', '2026-10-19T10:21:00.000Z', '2026-10-19T10:40:00.000Z'],
    ]);

    // No reading left from before the gap (pruned): the open stop stays as it was.
    await db.query('DELETE FROM telemetry_samples WHERE received_at < $1', [new Date('2026-10-19T00:00:00Z')]);
    await db.query('DELETE FROM production_stops');
    await db.query(
      `INSERT INTO production_stops(tenant_id,device_id,state,started_at,production_date)
       VALUES($1,$2,'offline','2026-10-16T19:04:32Z','2026-10-16')`,
      [TENANT, HAIWELL],
    );
    await rebuildStops(db, HAIWELL, new Date('2026-10-17T16:10:00Z'), new Date('2026-10-19T11:00:00Z'));
    const [silence] = await stops(db);
    expect(silence.state).toBe('offline');
    expect(silence.ended_at?.getTime()).toBeGreaterThan(new Date('2026-10-19T10:00:00Z').getTime());
  }, 120_000);

  it('rebuilds the stops of a stretch the recorder missed from the stored readings', async () => {
    // The shift close failed for two days (2026-10-17) and took the recorder down with it.
    const db = await base();
    const site = (await db.query<{ site_id: string }>('SELECT site_id FROM devices WHERE id=$1', [HAIWELL]))
      .rows[0].site_id;
    const tag = (
      await db.query<{ id: string }>(
        "INSERT INTO tags(tenant_id,device_id,key,name,data_type) VALUES($1,$2,'Blocos','Blocos','number') RETURNING id",
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    await db.query('UPDATE production_settings SET blocks_tag_id=$1 WHERE device_id=$2', [tag, HAIWELL]);
    const at = (time: string) => new Date(`2026-10-17T${time}:00Z`);
    // A message every 15 s from 12:00 to 16:00; the counter moves 14:10-15:00 and 15:30-16:00.
    let count = 1000;
    let message = 1;
    for (let t = at('12:00').getTime(); t < at('16:00').getTime(); t += 15_000) {
      const running = (t >= at('14:10').getTime() && t < at('15:00').getTime()) || t >= at('15:30').getTime();
      if (running) count += 1;
      await db.query(
        `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,quality,raw_message_id)
         VALUES($1,$2,$3,$4,$5,$5,$6,'good',$7)`,
        [TENANT, site, HAIWELL, tag, new Date(t), count, message++],
      );
    }
    // What the recorder left: a stop open since before the gap, and one written wrong after it.
    const insert = (state: string, start: Date, end: Date | null = null) =>
      db.query(
        `INSERT INTO production_stops(tenant_id,device_id,state,started_at,ended_at,production_date)
         VALUES($1,$2,$3,$4,$5,'2026-10-17')`,
        [TENANT, HAIWELL, state, start, end],
      );
    await insert('idle', at('13:50'));
    await insert('offline', at('15:45'), at('15:50'));

    const result = await rebuildStops(db, HAIWELL, at('14:00'), at('16:00'));
    expect(result?.carriedIn).toBe(true);
    const rows = await stops(db);
    expect(rows.map((row) => [row.state, row.started_at.toISOString().slice(11, 19), row.ended_at?.toISOString().slice(11, 19)])).toEqual([
      // The open stop ends with the first block, the line stands from one idle minute after its
      // last block until it moves again, and nothing is left open.
      ['idle', '13:50:00', '14:10:00'],
      ['idle', '15:00:45', '15:30:00'],
    ]);
  }, 60_000);
});
