import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';

/**
 * How "Aproveitamento da máquina" is counted, per equipment (migration 038). Read back after
 * every write: a field accepted by the schema is not a field in the UPDATE.
 */
async function platform() {
  const { db } = await memoryDatabase();
  await migrate(db);
  await seed(db);
  const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
  return { db, api };
}

const stored = async (db: Awaited<ReturnType<typeof platform>>['db']) =>
  (
    await db.query<{ utilization_basis: string | null }>(
      'SELECT utilization_basis FROM production_settings WHERE tenant_id=$1 AND device_id=$2',
      [TENANT, HAIWELL],
    )
  ).rows[0]?.utilization_basis;

describe('fórmula do aproveitamento', () => {
  it('asks for the counter first, then saves and reads back the choice', async () => {
    const { db, api } = await platform();
    await db.query('DELETE FROM production_settings WHERE tenant_id=$1 AND device_id=$2', [
      TENANT,
      HAIWELL,
    ]);
    const patch = (basis: string) =>
      api.inject({
        method: 'PATCH',
        url: `/api/devices/${HAIWELL}/production-utilization`,
        payload: { basis },
      });
    expect((await patch('stopped')).statusCode).toBe(400);

    await db.query('INSERT INTO production_settings(tenant_id,device_id) VALUES($1,$2)', [
      TENANT,
      HAIWELL,
    ]);
    expect(await stored(db)).toBeNull();
    expect((await patch('stopped')).statusCode).toBe(200);
    expect(await stored(db)).toBe('stopped');
    expect((await patch('idle')).statusCode).toBe(200);
    expect(await stored(db)).toBe('idle');
    expect((await patch('anything')).statusCode).toBe(400);
    expect(await stored(db)).toBe('idle');
  });
});
