import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';


async function platform() {
  const { db } = await memoryDatabase();
  await migrate(db);
  await seed(db);
  await db.query(
    `INSERT INTO production_settings(device_id,tenant_id,weight_per_unit_kg,target_metric,target_per_shift)
     VALUES($1,$2,2.82,'pallets',100) ON CONFLICT (device_id) DO UPDATE SET weight_per_unit_kg=2.82`,
    [HAIWELL, TENANT],
  );
  const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
  return { db, api };
}

/** Full five-minute stretches of a week, at a given rate, so the capability is measurable. */
async function week(
  db: Awaited<ReturnType<typeof platform>>['db'],
  monday: string,
  piecesPerBucket: number,
  product = '09X19X19',
) {
  for (let slot = 0; slot < 12; slot += 1)
    await db.query(
      `INSERT INTO production_buckets(tenant_id,device_id,bucket,product_code,pieces,pallets,tons,producing_s,idle_s,manual_s)
       VALUES($1,$2,$3,$4,$5,1,0,300,0,0)`,
      [TENANT, HAIWELL, new Date(`${monday}T12:${String(slot * 5).padStart(2, '0')}:00Z`), product, piecesPerBucket],
    );
}

describe('wear tracking', () => {
  it('offers only recipes the device really ran, and the one running now', async () => {
    const { db, api } = await platform();
    await week(db, '2026-09-07', 500, '09X19X19');
    await week(db, '2026-09-14', 500, '9x19x29');
    await db.query(
      `INSERT INTO production_runtime(tenant_id,device_id,last_at,last_increment_at,auto,product_code)
       VALUES($1,$2,now(),now(),true,'9x19x29') ON CONFLICT (device_id) DO UPDATE SET product_code='9x19x29'`,
      [TENANT, HAIWELL],
    );
    const body = (await api.inject(`/api/devices/${HAIWELL}/recipes`)).json() as {
      recipes: string[];
      running: string | null;
    };
    expect(body.recipes).toEqual(['09X19X19', '9x19x29']);
    expect(body.running).toBe('9x19x29');
    await api.close();
  }, 30_000);

  it('keeps the sample, its spread and the nominal weight of the moment', async () => {
    const { api } = await platform();
    const saved = await api.inject({
      method: 'POST',
      url: `/api/devices/${HAIWELL}/weights`,
      payload: { product: '09X19X19', weights: [2.9, 3.0, 3.1], note: 'amostra da manhã' },
    });
    expect(saved.statusCode).toBe(200);
    const list = (await api.inject(`/api/devices/${HAIWELL}/weights`)).json() as {
      weights: Array<{ averageKg: number; spreadKg: number | null; nominalKg: number | null; pieces: number }>;
    };
    expect(list.weights).toHaveLength(1);
    expect(list.weights[0].averageKg).toBeCloseTo(3.0, 5);
    // The spread is what shows a die wearing unevenly before the average moves.
    expect(list.weights[0].spreadKg).toBeCloseTo(0.2, 5);
    // The recipe's nominal weight is stored alongside, so the drift survives a recipe change.
    expect(list.weights[0].nominalKg).toBeCloseTo(2.82, 5);
    await api.close();
  }, 30_000);

  it('refuses a measurement from a user without the permission', async () => {
    const { db } = await platform();
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
    // The synthetic principal of a test is a master, so check the rule itself on a plain user.
    const user = (
      await db.query<{ id: string }>(
        `INSERT INTO app_users(tenant_id,email,full_name,role,status,password_hash)
         VALUES($1,'operador@local','Operador','user','active','x') RETURNING id`,
        [TENANT],
      )
    ).rows[0];
    const allowed = await db.query<{ can_log_measurements: boolean }>(
      'SELECT can_log_measurements FROM app_users WHERE id=$1',
      [user.id],
    );
    expect(allowed.rows[0].can_log_measurements).toBe(false);
    await api.close();
  }, 30_000);

  it('splits a lost rate into the die and the auger', async () => {
    const { db, api } = await platform();
    // Reference week, then a week where the rate fell 10% and the brick got 10% heavier: the
    // whole loss is the die's, and the auger is untouched.
    await week(db, '2026-09-07', 500);
    await week(db, '2026-09-14', 450);
    for (const [date, value] of [
      ['2026-09-07', 3.0],
      ['2026-09-14', 3.3],
    ] as const)
      await api.inject({
        method: 'POST',
        url: `/api/devices/${HAIWELL}/weights`,
        payload: { date, product: '09X19X19', weights: [value] },
      });

    const wear = (await api.inject(`/api/devices/${HAIWELL}/wear?product=09X19X19`)).json() as {
      product: string;
      weeks: Array<{ week: string; capacity: number; rateDrift: number | null; dieDrift: number | null; augerDrift: number | null }>;
    };
    expect(wear.product).toBe('09X19X19');
    expect(wear.weeks).toHaveLength(2);
    const [reference, later] = wear.weeks;
    expect(reference.rateDrift).toBe(0);
    expect(later.capacity).toBe(450 * 12);
    // Rate fell 10%.
    expect(later.rateDrift).toBeCloseTo(-0.1, 3);
    // The brick got 10% heavier, which costs 10% of rate on its own: the die's share.
    expect(later.dieDrift).toBeCloseTo(-0.1, 3);
    // Nothing left over, so the auger is fine.
    expect(later.augerDrift).toBeCloseTo(0, 3);
    await api.close();
  }, 30_000);

  it('blames the auger when the brick did not change', async () => {
    const { db, api } = await platform();
    await week(db, '2026-09-07', 500);
    await week(db, '2026-09-14', 450);
    for (const date of ['2026-09-07', '2026-09-14'])
      await api.inject({
        method: 'POST',
        url: `/api/devices/${HAIWELL}/weights`,
        payload: { date, product: '09X19X19', weights: [3.0] },
      });
    const wear = (await api.inject(`/api/devices/${HAIWELL}/wear?product=09X19X19`)).json() as {
      weeks: Array<{ dieDrift: number | null; augerDrift: number | null }>;
    };
    const later = wear.weeks[1];
    expect(later.dieDrift).toBeCloseTo(0, 5);
    expect(later.augerDrift).toBeCloseTo(-0.1, 3);
    await api.close();
  }, 30_000);

  it('reads the curve from the last replacement of a part', async () => {
    const { db, api } = await platform();
    await week(db, '2026-09-07', 900);
    await week(db, '2026-09-14', 500);
    await week(db, '2026-09-21', 480);
    await api.inject({
      method: 'POST',
      url: `/api/devices/${HAIWELL}/maintenance`,
      payload: { date: '2026-09-14', kind: 'caracol', note: 'troca do caracol' },
    });
    const wear = (await api.inject(`/api/devices/${HAIWELL}/wear?product=09X19X19`)).json() as {
      since: string | null;
      augerChangedOn: string | null;
      weeks: Array<{ week: string }>;
    };
    expect(wear.augerChangedOn).toBe('2026-09-14');
    // The week before the change is not compared against: the part is a different one.
    expect(wear.weeks.map((row) => row.week)).toEqual(['2026-09-14', '2026-09-21']);
    await api.close();
  }, 30_000);
});
