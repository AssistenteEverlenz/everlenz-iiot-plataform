import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, GENERIC } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';
import { IngestionPipeline } from '../apps/ingestor/src/pipeline.js';
import { attributeMix, attributeSpout, plantDate } from '../packages/shared/src/index.js';

/**
 * Mortar plants (migration 037): bags per spout, batches of the mixer, and the products the
 * recipes fill. The integration case runs real messages through the ingestor and reads the
 * summary the cards draw, because a number that only adds up on paper is no number at all.
 */
const T0 = Date.parse('2026-10-01T13:00:00Z');

describe('spout attribution', () => {
  const start = { at: T0, count: 100, recipe: 'AC-II 20KG LE', enabled: true, running: true };

  it('counts bags under the recipe that was on the spout, and the time as running', () => {
    const first = attributeSpout(null, start, 120, 300);
    expect(first.deltas).toEqual([]);
    const next = attributeSpout(first.runtime, { ...start, at: T0 + 30_000, count: 103 }, 120, 300);
    expect(next.deltas).toHaveLength(1);
    expect(next.deltas[0]).toMatchObject({
      recipe: 'AC-II 20KG LE',
      bags: 3,
      running: 30,
      idle: 0,
    });
  });

  it('turns a quiet spout idle once the limit runs out, and a disabled one off', () => {
    const first = attributeSpout(null, start, 60, 600).runtime;
    const quiet = attributeSpout(first, { ...start, at: T0 + 100_000 }, 60, 600);
    const total = (key: 'running' | 'idle' | 'off') =>
      quiet.deltas.reduce((sum, delta) => sum + delta[key], 0);
    expect(total('running')).toBe(60);
    expect(total('idle')).toBe(40);
    const disabled = attributeSpout(
      { ...first, enabled: false },
      { ...start, at: T0 + 50_000, enabled: false },
      60,
      600,
    );
    expect(disabled.deltas[0]).toMatchObject({ off: 50, running: 0, idle: 0 });
  });

  it('counts from zero again after "Finaliza produção" resets the counter', () => {
    const first = attributeSpout(null, { ...start, count: 1800 }, 120, 300).runtime;
    const reset = attributeSpout(first, { ...start, at: T0 + 10_000, count: 0 }, 120, 300).runtime;
    const after = attributeSpout(reset, { ...start, at: T0 + 20_000, count: 4 }, 120, 300);
    expect(after.deltas.reduce((sum, delta) => sum + delta.bags, 0)).toBe(4);
  });
});

describe('mix attribution', () => {
  const materials = [
    { label: 'Areia', kg: 500 },
    { label: 'Cimento', kg: 120 },
  ];
  it('writes the recipe weights times the batches that closed', () => {
    const first = attributeMix(null, {
      at: T0,
      count: 0,
      recipe: 'A',
      scale: 0,
      materials,
    }).runtime;
    const dosing = attributeMix(first, {
      at: T0 + 1000,
      count: 0,
      recipe: 'A',
      scale: 631,
      materials,
    });
    expect(dosing.batch).toBeNull();
    const closed = attributeMix(dosing.runtime, {
      at: T0 + 2000,
      count: 1,
      recipe: 'A',
      scale: 0,
      materials,
    });
    expect(closed.batch).toMatchObject({ recipe: 'A', batches: 1, totalKg: 620, scaleKg: 631 });
    expect(closed.runtime.scalePeak).toBeNull();
  });
});

describe('mortar summary', () => {
  it('sums bags by product across spouts and weighs them by the product, not the recipe', async () => {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
    const tag = async (key: string, type: 'number' | 'string' | 'boolean') =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO tags(tenant_id,device_id,key,name,data_type) VALUES($1,$2,$3,$3,$4) RETURNING id`,
          [TENANT, GENERIC, key, type],
        )
      ).rows[0].id;
    const tags = {
      le: await tag('pacotes_le', 'number'),
      leRecipe: await tag('produto_le', 'string'),
      ct: await tag('pacotes_ct', 'number'),
      ctRecipe: await tag('produto_ct', 'string'),
      batches: await tag('bateladas', 'number'),
      mixRecipe: await tag('receita', 'string'),
      sand: await tag('peso_areia', 'number'),
      cement: await tag('peso_cimento', 'number'),
    };
    const saved = await api.inject({
      method: 'PUT',
      url: `/api/devices/${GENERIC}/mortar/settings`,
      payload: {
        mixEnabled: true,
        recipeTagId: tags.mixRecipe,
        batchCountTagId: tags.batches,
        scaleTagId: null,
        materials: [
          { label: 'Areia', tagId: tags.sand },
          { label: 'Cimento', tagId: tags.cement },
        ],
        baggingEnabled: true,
        idleSeconds: 120,
        spouts: [
          { name: 'LE', countTagId: tags.le, recipeTagId: tags.leRecipe },
          { name: 'CT', countTagId: tags.ct, recipeTagId: tags.ctRecipe },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);

    const pipeline = new IngestionPipeline(db);
    const now = Date.now();
    const send = (seconds: number, values: Record<string, unknown>) =>
      pipeline.ingest({
        topic: 'iiot/poc/laboratorio/generic-001/telemetry',
        payload: Buffer.from(JSON.stringify({ timestamp: new Date().toISOString(), values })),
        qos: 1,
        retain: false,
        receivedAt: new Date(now - 600_000 + seconds * 1000),
      });
    const base = {
      produto_le: 'AC-II 20KG LE',
      produto_ct: 'AC-II 20KG CT',
      receita: 'AC-II',
      peso_areia: 500,
      peso_cimento: 120,
    };
    await send(0, { ...base, pacotes_le: 10, pacotes_ct: 50, bateladas: 0 });
    await send(30, { ...base, pacotes_le: 14, pacotes_ct: 53, bateladas: 1 });
    await send(60, { ...base, pacotes_le: 20, pacotes_ct: 60, bateladas: 3 });

    const product = await api.inject({
      method: 'POST',
      url: '/api/mortar/products',
      payload: { name: 'AC-II 20kg', nominalKg: 20 },
    });
    expect(product.statusCode).toBe(201);
    const productId = JSON.parse(product.body).id;
    for (const recipe of ['AC-II 20KG LE', 'AC-II 20KG CT'])
      expect(
        (
          await api.inject({
            method: 'PUT',
            url: '/api/mortar/recipes',
            payload: { recipe, productId },
          })
        ).statusCode,
      ).toBe(200);

    const day = plantDate(new Date(now));
    const yesterday = plantDate(new Date(now - 86_400_000));
    const summary = JSON.parse(
      (
        await api.inject({
          method: 'GET',
          url: `/api/devices/${GENERIC}/mortar?from=${yesterday}&to=${day}`,
        })
      ).body,
    );
    expect(summary.bagging.totals.bags).toBe(20);
    expect(summary.bagging.totals.kg).toBe(400);
    expect(summary.bagging.products).toHaveLength(1);
    expect(summary.bagging.products[0]).toMatchObject({ name: 'AC-II 20kg', bags: 20, kg: 400 });
    expect(summary.mix.batches).toBe(3);
    expect(summary.mix.materials).toEqual(
      expect.arrayContaining([
        { label: 'Areia', kg: 1500 },
        { label: 'Cimento', kg: 360 },
      ]),
    );
    expect(summary.yield.mixedKg).toBe(1860);
    expect(summary.yield.baggedKg).toBe(400);
  }, 60_000);
});
