// Loads a mortar plant's product catalog: each product with its bag weight, and every recipe
// name that fills it -- the mixer's and each bagger spout's -- linked to it.
//
//   npx -y pnpm@10.28.2 exec tsx scripts/mortar-catalog.ts <catalog.json>
//
// The file: { "products": [ { "name": "AC3 Bella Massa 20kg", "nominalKg": 20,
//   "standardRate": null, "recipes": ["AC3 BellaMassa", "AC3 BM B1", "AC3 BM B2"] } ] }
// Recipe names must be written exactly as the HMI sends them. Running it again updates the
// weights and moves a recipe to the product the file now gives it; nothing is deleted.
import { readFileSync } from 'node:fs';
import type { Database } from '../packages/database/src/index.js';
import { createApp } from '../apps/api/src/app.js';

type Catalog = {
  /** The device whose tenant owns the catalog. */
  deviceCode: string;
  products: Array<{
    name: string;
    nominalKg: number;
    standardRate?: number | null;
    recipes: string[];
  }>;
};

export async function loadMortarCatalog(db: Database, catalog: Catalog) {
  const device = (
    await db.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM devices WHERE upper(device_code)=upper($1) AND archived_at IS NULL',
      [catalog.deviceCode],
    )
  ).rows[0];
  if (!device) throw new Error(`Equipamento ${catalog.deviceCode} não encontrado`);
  const app = await createApp(db, {
    tenantId: device.tenant_id,
    operatorRaw: false,
    authRequired: false,
  });
  const call = async <T = Record<string, unknown>>(
    method: string,
    url: string,
    payload?: unknown,
  ): Promise<T> => {
    const response = await app.inject({ method: method as 'GET', url, payload: payload as object });
    if (response.statusCode >= 400)
      throw new Error(`${method} ${url} -> ${response.statusCode} ${response.body}`);
    return response.json() as T;
  };
  try {
    const existing = (
      await call<{ products: Array<{ id: string; name: string }> }>('GET', '/api/mortar/products')
    ).products;
    const result: Array<{ product: string; recipes: number; created: boolean }> = [];
    for (const product of catalog.products) {
      const body = {
        name: product.name,
        nominalKg: product.nominalKg,
        standardRate: product.standardRate ?? null,
      };
      const found = existing.find((item) => item.name === product.name);
      const id = found
        ? (await call('PATCH', `/api/mortar/products/${found.id}`, body), found.id)
        : (await call<{ id: string }>('POST', '/api/mortar/products', body)).id;
      for (const recipe of product.recipes)
        await call('PUT', '/api/mortar/recipes', { recipe, productId: id });
      result.push({ product: product.name, recipes: product.recipes.length, created: !found });
    }
    return result;
  } finally {
    await app.close();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/mortar-catalog.ts')) {
  const file = process.argv[2];
  if (!file) throw new Error('Informe o arquivo do catálogo');
  const catalog = JSON.parse(readFileSync(file, 'utf8')) as Catalog;
  const { database } = await import('../packages/database/src/index.js');
  console.table(await loadMortarCatalog(database, catalog));
  process.exit(0);
}
