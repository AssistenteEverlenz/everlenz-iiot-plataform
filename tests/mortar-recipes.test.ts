import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, GENERIC } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';
import { plantDate } from '../packages/shared/src/index.js';

/**
 * The manual additives of the mixer recipes (migration 051): poured by hand, never weighed. Once
 * a recipe says how many kilos of each go into a batch, the batch weighs and costs that much more,
 * on the recipes card and in the summary the other mortar cards draw.
 */
describe('mortar recipe additives', () => {
  it('adds the hand-poured kilos and their cost to every batch of the recipe', async () => {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
    const today = plantDate(new Date());
    const materials = JSON.stringify([
      { label: 'Areia', kg: 1600 },
      { label: 'Cimento', kg: 400 },
    ]);
    // Three batches of AC3 (2000 kg of recipe each, the scale read 2010) and one of AC1.
    await db.query(
      `INSERT INTO mix_batches(tenant_id,device_id,finished_at,recipe,batches,materials,total_kg,scale_kg)
       VALUES ($1,$2,now() - interval '2 hours','AC3 BELLAFIX',3,$3::jsonb,6000,6030),
              ($1,$2,now() - interval '1 hour','AC1 INTERNA',1,$4::jsonb,2000,NULL)`,
      [TENANT, GENERIC, materials.replace('1600', '4800').replace('400', '1200'), materials],
    );
    await db.query(
      `INSERT INTO mortar_material_prices(tenant_id,label,price_per_ton) VALUES ($1,'Areia',100),($1,'Cimento',800)`,
      [TENANT],
    );

    const created = await api.inject({
      method: 'POST',
      url: '/api/mortar/additives',
      payload: { name: 'Polímero VAE', kind: 'polimero', pricePerKg: 20, packageKg: 25 },
    });
    expect(created.statusCode).toBe(200);
    const additive = created.json<{ id: string }>();
    const duplicate = await api.inject({
      method: 'POST',
      url: '/api/mortar/additives',
      payload: { name: 'Polímero VAE', kind: 'polimero' },
    });
    expect(duplicate.statusCode).toBe(409);

    const put = await api.inject({
      method: 'PUT',
      url: '/api/mortar/recipe-additives',
      payload: { recipe: 'AC3 BELLAFIX', items: [{ additiveId: additive.id, kgPerBatch: 12.5 }] },
    });
    expect(put.statusCode).toBeLessThan(300);

    const board = (
      await api.inject({ method: 'GET', url: `/api/devices/${GENERIC}/mortar/recipes-board?from=${today}&to=${today}` })
    ).json<{
      additivesAvailable: boolean;
      recipes: Array<{
        recipe: string;
        batches: number;
        scaleKg: number | null;
        batchKg: number;
        additivesKg: number;
        materialsCost: number | null;
        costPerBatch: number | null;
      }>;
    }>();
    expect(board.additivesAvailable).toBe(true);
    const ac3 = board.recipes.find((item) => item.recipe === 'AC3 BELLAFIX')!;
    expect(ac3.batches).toBe(3);
    expect(ac3.scaleKg).toBeCloseTo(2010);
    expect(ac3.batchKg).toBeCloseTo(2022.5);
    expect(ac3.additivesKg).toBeCloseTo(12.5);
    // 1600 kg of sand at R$ 100/t and 400 kg of cement at R$ 800/t, plus 12,5 kg at R$ 20/kg.
    expect(ac3.materialsCost).toBeCloseTo(480);
    expect(ac3.costPerBatch).toBeCloseTo(730);
    const ac1 = board.recipes.find((item) => item.recipe === 'AC1 INTERNA')!;
    expect(ac1.additivesKg).toBe(0);
    expect(ac1.batchKg).toBeCloseTo(2000);

    // The summary: 3 × 12,5 kg more mixed, listed as a manual material.
    const summary = (
      await api.inject({ method: 'GET', url: `/api/devices/${GENERIC}/mortar?from=${today}&to=${today}` })
    ).json<{ mix: { kg: number; additivesKg: number; materials: Array<{ label: string; kg: number; manual: boolean }> } }>();
    expect(summary.mix.additivesKg).toBeCloseTo(37.5);
    expect(summary.mix.kg).toBeCloseTo(8037.5);
    expect(summary.mix.materials.find((item) => item.manual)).toMatchObject({ label: 'Polímero VAE' });

    // Removing the additive takes it out of the recipe.
    expect((await api.inject({ method: 'DELETE', url: `/api/mortar/additives/${additive.id}` })).statusCode).toBeLessThan(300);
    const after = (
      await api.inject({ method: 'GET', url: `/api/devices/${GENERIC}/mortar/recipes-board?from=${today}&to=${today}` })
    ).json<{ recipes: Array<{ recipe: string; batchKg: number }> }>();
    expect(after.recipes.find((item) => item.recipe === 'AC3 BELLAFIX')!.batchKg).toBeCloseTo(2010);
  }, 60_000);
});
