import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';
import {
  utilizationFormulaError,
  utilizationFormulaText,
  utilizationFrom,
} from '../apps/web/components/utilizationFormula.js';

/**
 * How "Aproveitamento da máquina" is counted, per equipment (migrations 038 and 039). Read back after
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
    await db.query<{ utilization_formula: unknown }>(
      'SELECT utilization_formula FROM production_settings WHERE tenant_id=$1 AND device_id=$2',
      [TENANT, HAIWELL],
    )
  ).rows[0]?.utilization_formula;

describe('fórmula do aproveitamento', () => {
  it('passes through the web proxy, which answers 404 to any path it does not list', () => {
    const route = readFileSync('apps/web/app/api/[...path]/route.ts', 'utf8');
    const allowed = new RegExp(route.match(/const allowed =\s*\/(.+)\/;/)![1]);
    expect(allowed.test(`devices/${HAIWELL}/production-utilization`)).toBe(true);
  });

  it('reads the formula the plant writes, as the percentage itself', () => {
    const time = { producing: 32 * 60, idle: 60, manual: 19 * 60, offline: 60 };
    expect(utilizationFrom(null, time)).toBeCloseTo(32 / 33);
    expect(
      utilizationFrom(
        'painel.horas_produzindo / (painel.horas_produzindo + painel.horas_paradas) * 100',
        time,
      ),
    ).toBeCloseTo(32 / 52);
    // The first custom formulas were boxes; they read as the same formula written out.
    const boxes = utilizationFormulaText({
      numerator: ['producing'],
      denominator: ['producing', 'idle', 'manual'],
    });
    expect(utilizationFrom(boxes, time)).toBeCloseTo(32 / 52);
    expect(utilizationFormulaError('painel.horas_produzindo / ihm.Velocidade')).toMatch(
      /não encontrada/,
    );
  });

  it('asks for the counter first, then saves and reads back the formula', async () => {
    const { db, api } = await platform();
    await db.query('DELETE FROM production_settings WHERE tenant_id=$1 AND device_id=$2', [
      TENANT,
      HAIWELL,
    ]);
    const patch = (formula: unknown) =>
      api.inject({
        method: 'PATCH',
        url: `/api/devices/${HAIWELL}/production-utilization`,
        payload: { formula },
      });
    const own = 'painel.minutos_produzindo / (painel.minutos_produzindo + painel.minutos_paradas) * 100';
    expect((await patch(own)).statusCode).toBe(400);

    await db.query('INSERT INTO production_settings(tenant_id,device_id) VALUES($1,$2)', [
      TENANT,
      HAIWELL,
    ]);
    expect(await stored(db)).toBeNull();
    expect((await patch(own)).statusCode).toBe(200);
    expect(await stored(db)).toEqual({ formula: own });
    expect((await patch(null)).statusCode).toBe(200);
    expect(await stored(db)).toBeNull();
    const refused = await patch('painel.horas_produzindo / ');
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body).error).toMatch(/terminou/);
    expect((await patch('process.exit(1)')).statusCode).toBe(400);
    expect(await stored(db)).toBeNull();
  }, 30000);
});
