import { describe, expect, it } from 'vitest';
import { plantInstant } from '../packages/shared/src/index.js';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { auditDevice, checkDevice, fixAnomaly } from '../apps/api/src/production-audit.js';

/** The production check (migration 055) over buckets with no readings left behind them. */
const at = (date: string, time: string) => plantInstant(date, time).getTime();

async function line() {
  const { db } = await memoryDatabase();
  await migrate(db);
  await seed(db);
  const tag = async (key: string) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type)
         VALUES($1,$2,$3,$3,'number') RETURNING id`,
        [TENANT, HAIWELL, key],
      )
    ).rows[0].id;
  const pieces = await tag('Pecas');
  const pallets = await tag('Paletes');
  await db.query(
    `INSERT INTO production_settings(device_id,tenant_id,blocks_tag_id,pallets_tag_id,weight_per_unit_kg)
     VALUES($1,$2,$3,$4,2.5)
     ON CONFLICT (device_id) DO UPDATE SET blocks_tag_id=$3,pallets_tag_id=$4,weight_per_unit_kg=2.5`,
    [HAIWELL, TENANT, pieces, pallets],
  );
  const bucket = (t: number, piecesIn: number, palletsIn: number, active = 300) =>
    db.query(
      `INSERT INTO production_buckets(tenant_id,device_id,bucket,product_code,pieces,pallets,tons,producing_s,idle_s,manual_s)
       VALUES($1,$2,$3,'9x19',$4,$5,$6,$7,0,0)`,
      [TENANT, HAIWELL, new Date(t), piecesIn, palletsIn, (piecesIn * 2.5) / 1000, active],
    );
  const day = async (date: string) =>
    (
      await db.query<{ pieces: number; pallets: number }>(
        `SELECT coalesce(sum(pieces),0)::float8 pieces,coalesce(sum(pallets),0)::float8 pallets
         FROM production_buckets WHERE device_id=$1 AND bucket>=$2 AND bucket<$3`,
        [HAIWELL, plantInstant(date, '00:00'), plantInstant(date, '23:59')],
      )
    ).rows[0];
  const anomaly = async (kind: string) =>
    (
      await db.query(
        `SELECT id::text,tenant_id,device_id,kind,counter,window_start,window_end,
           to_char(production_date,'YYYY-MM-DD') production_date,amount::float8 amount,details,status
         FROM production_anomalies WHERE kind=$1`,
        [kind],
      )
    ).rows[0] as Parameters<typeof fixAnomaly>[1];
  return { db, bucket, day, anomaly };
}

describe('production check', () => {
  it('finds a hand-edited pallet counter and brings the bucket back to the usual', async () => {
    const { db, bucket, day, anomaly } = await line();
    const date = '2026-10-06';
    for (let t = at(date, '07:00'); t < at(date, '17:00'); t += 300_000)
      await bucket(t, 300, t === at(date, '10:00') ? 38 : 1);
    const findings = await auditDevice(db, TENANT, HAIWELL, date, date);
    expect(findings.map((item) => `${item.kind} ${item.counter}`)).toContain('jump pallets');
    await checkDevice(db, TENANT, HAIWELL, date, date);
    await fixAnomaly(db, await anomaly('jump'));
    expect((await day(date)).pallets).toBe(120);
    expect((await day(date)).pieces).toBe(300 * 120);
    // The shift rows follow the corrected buckets.
    const reported = await db.query<{ pallets: number }>(
      `SELECT sum(pallets)::float8 pallets FROM shift_reports WHERE device_id=$1 AND deleted_at IS NULL`,
      [HAIWELL],
    );
    expect(Number(reported.rows[0].pallets)).toBe(120);
  }, 60_000);

  it('spreads production that arrived after the HMI was offline over the shift time it missed', async () => {
    const { db, bucket, day, anomaly } = await line();
    const date = '2026-10-07';
    for (let t = at(date, '07:00'); t < at(date, '12:00'); t += 300_000) await bucket(t, 300, 1);
    // Offline 12:00-14:00; the PLC kept counting: 24 buckets' worth arrives at 14:00.
    await bucket(at(date, '14:00'), 300 * 24, 24);
    for (let t = at(date, '14:05'); t < at(date, '17:00'); t += 300_000) await bucket(t, 300, 1);
    const before = await day(date);
    const findings = await auditDevice(db, TENANT, HAIWELL, date, date);
    // No shift rows were written yet either: that is the other finding.
    expect(findings.map((item) => item.kind).sort()).toEqual(['late_burst', 'report_mismatch']);
    await checkDevice(db, TENANT, HAIWELL, date, date);
    await fixAnomaly(db, await anomaly('late_burst'));
    // Nothing is lost or made up: the same day total, no longer piled on one bucket.
    expect(await day(date)).toEqual(before);
    const peak = await db.query<{ pieces: number }>(
      'SELECT max(pieces)::float8 pieces FROM production_buckets WHERE device_id=$1',
      [HAIWELL],
    );
    expect(Number(peak.rows[0].pieces)).toBeLessThanOrEqual(600);
  }, 60_000);

  it('leaves a clean day alone', async () => {
    const { db, bucket } = await line();
    const date = '2026-10-08';
    for (let t = at(date, '07:00'); t < at(date, '17:00'); t += 300_000) await bucket(t, 300, 1);
    await checkDevice(db, TENANT, HAIWELL, date, date);
    expect(await auditDevice(db, TENANT, HAIWELL, date, date)).toEqual([]);
  }, 60_000);
});
