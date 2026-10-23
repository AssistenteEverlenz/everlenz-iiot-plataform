import { describe, expect, it } from 'vitest';
import { allocateBags } from '../apps/api/src/mortar-lots.js';
import { productOfTruncated } from '../apps/api/src/mortar-links.js';

const MIN = 60_000;
const t0 = Date.UTC(2026, 9, 23, 13, 0);
const at = (minutes: number) => t0 + minutes * MIN;
/** A steady flow of bags of one product, a 5-minute bucket at a time. */
const flow = (product: string, from: number, to: number, perBucket: number) =>
  Array.from({ length: (to - from) / 5 }, (_, index) => ({ at: at(from + index * 5), product, bags: perBucket }));

describe('lots through the buffer silo', () => {
  it('gives each batch the bags its mass makes, not every bag after it started', () => {
    // Bella Massa 23/10: three lots of one 1,800 kg batch (90 bags of 20 kg), bagged without a break.
    const branca = { product: 'Branca', nominalKg: 20, mixedKg: 1800 };
    const { lots } = allocateBags(
      [
        { lot: 'A', startedAt: at(0), ...branca },
        { lot: 'B', startedAt: at(22), ...branca },
        { lot: 'C', startedAt: at(46), ...branca },
      ],
      flow('Branca', 20, 110, 15),
    );
    expect(lots.get('A')!.bags).toBe(90);
    expect(lots.get('B')!.bags).toBe(90);
    // The newest lot takes the rest, so the excess shows where it happened.
    expect(lots.get('C')!.bags).toBe(270 - 180);
  });

  it('keeps one product per lot: the tail of the previous product is not the next lot', () => {
    // 21/10: Graute 15:47, Contrapiso 16:13 -- Graute bags still came out after 16:13.
    const { lots } = allocateBags(
      [
        { lot: 'G', product: 'Graute', nominalKg: 25, mixedKg: 2200, startedAt: at(0) },
        { lot: 'C', product: 'Contrapiso', nominalKg: 20, mixedKg: 2200, startedAt: at(26) },
      ],
      [...flow('Graute', 10, 40, 12), ...flow('Contrapiso', 30, 60, 15)],
    );
    expect(lots.get('G')!.bags).toBe(72);
    expect(lots.get('C')!.bags).toBe(90);
  });

  it('does not let an old lot that missed its bags take another campaign of its product', () => {
    // A Reboco lot stamped late (HMI offline) never got its bags; the next Reboco run, after
    // another product, keeps its own.
    const reboco = { product: 'Reboco', nominalKg: 20, mixedKg: 2200 };
    const { lots } = allocateBags(
      [
        { lot: 'old', startedAt: at(0), ...reboco },
        { lot: 'fix', product: 'Fix', nominalKg: 20, mixedKg: 2200, startedAt: at(30) },
        { lot: 'new', startedAt: at(120), ...reboco },
      ],
      [...flow('Fix', 35, 70, 15), ...flow('Reboco', 125, 160, 15)],
    );
    expect(lots.get('old')!.bags).toBe(0);
    expect(lots.get('new')!.bags).toBe(105);
  });

  it('carries a campaign across the night', () => {
    const fix = { product: 'Fix', nominalKg: 20, mixedKg: 2200 };
    const { lots } = allocateBags(
      [
        { lot: 'evening', startedAt: at(0), ...fix },
        { lot: 'morning', startedAt: at(14 * 60), ...fix },
      ],
      [...flow('Fix', 5, 40, 10), ...flow('Fix', 14 * 60, 14 * 60 + 60, 10)],
    );
    expect(lots.get('evening')!.bags).toBe(110);
    expect(lots.get('morning')!.bags).toBe(70 + 120 - 110);
  });
});

describe('recipe names the HMI cuts short', () => {
  const links = [
    { recipe: 'AC3 BM [BRANCA] B1', productId: 'branca' },
    { recipe: 'AC3 BM [BRANCA] B2', productId: 'branca' },
    { recipe: 'AC3 BM B1', productId: 'bm' },
    { recipe: 'AUTONIVELANTE B1', productId: 'auto' },
    { recipe: 'NIVELADORA [BRANCA] B1', productId: 'nb' },
    { recipe: 'NIVELADORA [CINZA] B1', productId: 'nc' },
  ];
  it('links a cut name to the one product all its full names belong to', () => {
    expect(productOfTruncated('AC3 BM [BRANCA', links)).toBe('branca');
    expect(productOfTruncated('AUTONIVELANTE', links)).toBe('auto');
    expect(productOfTruncated('NIVELADORA [BR', links)).toBe('nb');
  });
  it('leaves a name that could be two products, or too short to tell', () => {
    expect(productOfTruncated('NIVELADORA [', links)).toBeNull();
    expect(productOfTruncated('AC3 BM', links)).toBeNull();
    expect(productOfTruncated('SEM RECEITA', links)).toBeNull();
  });
});

describe('linking cut names in the database', () => {
  it('writes the link once, and the yield reads the bags as tons', async () => {
    const { memoryDatabase } = await import('./pglite.js');
    const { migrate } = await import('../packages/database/src/migrate.js');
    const { seed, TENANT } = await import('../packages/database/src/seed.js');
    const { seedMortarDemo } = await import('../scripts/mortar-demo.js');
    const { linkTruncatedRecipes } = await import('../apps/api/src/mortar-links.js');
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const demo = await seedMortarDemo(db, TENANT, 1);
    const product = (
      await db.query<{ id: string }>(
        "INSERT INTO mortar_products(tenant_id,name,nominal_kg) VALUES($1,'Branca 20kg',20) RETURNING id",
        [TENANT],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO mortar_recipe_links(tenant_id,recipe,product_id) VALUES($1,'AC3 BM [BRANCA] B1',$2),($1,'AC3 BM [BRANCA] B2',$2)",
      [TENANT, product],
    );
    const spout = (await db.query<{ id: string }>('SELECT id FROM bagging_spouts WHERE device_id=$1 LIMIT 1', [demo.deviceId])).rows[0].id;
    await db.query(
      `INSERT INTO bagging_buckets(tenant_id,device_id,spout_id,bucket,recipe,bags) VALUES($1,$2,$3,now() - interval '1 hour','AC3 BM [BRANCA',40)`,
      [TENANT, demo.deviceId, spout],
    );
    const linked = await linkTruncatedRecipes(db);
    expect(linked.map((item) => item.recipe)).toContain('AC3 BM [BRANCA');
    const row = await db.query<{ product_id: string }>(
      "SELECT product_id FROM mortar_recipe_links WHERE tenant_id=$1 AND recipe='AC3 BM [BRANCA'",
      [TENANT],
    );
    expect(row.rows[0].product_id).toBe(product);
    // A second pass finds nothing left to link.
    expect((await linkTruncatedRecipes(db)).map((item) => item.recipe)).not.toContain('AC3 BM [BRANCA');
  }, 120_000);
});
