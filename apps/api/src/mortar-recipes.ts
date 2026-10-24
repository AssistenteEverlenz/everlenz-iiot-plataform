import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import { addDays, plantDate, plantInstant } from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';

/**
 * The mixer recipes and their manual additives (migration 051).
 *
 * The operator pours some of a batch straight into the mixer -- cellulose ether, redispersible
 * polymer, air entrainer, pigment -- while it waits for the additive: that mass never crosses the
 * scale. A plant keeps a catalog of its additives (kind, price per kg, the package they come in)
 * and says how many kilos of each go into one batch of each mixer recipe. The platform adds them
 * to the batch: to its mass (the mixed tons, the yield, the lots, the reconciliation) and to its
 * cost. Read through a guard, so a base without migration 051 reads no additives.
 */

export type Additive = {
  id: string;
  name: string;
  kind: string;
  pricePerKg: number | null;
  packageKg: number | null;
};
export type RecipeAdditive = Additive & { kgPerBatch: number };
export type RecipeAdditives = {
  items: RecipeAdditive[];
  /** Kilos of additive in one batch. */
  kgPerBatch: number;
  /** What the additives of one batch cost; null when one has no price. */
  costPerBatch: number | null;
};

async function hasTables(db: Database) {
  const found = await db.query<{ n: string }>(
    `SELECT count(*) n FROM information_schema.tables
     WHERE table_name IN ('mortar_additives','mortar_recipe_additives')`,
  );
  return Number(found.rows[0]?.n ?? 0) === 2;
}

/** The additives of every mixer recipe of a tenant, by recipe name. */
export async function loadRecipeAdditives(db: Database, tenantId: string) {
  const byRecipe = new Map<string, RecipeAdditives>();
  if (!(await hasTables(db))) return byRecipe;
  const rows = await db.query<{
    recipe: string;
    kg_per_batch: number;
    id: string;
    name: string;
    kind: string;
    price_per_kg: number | null;
    package_kg: number | null;
  }>(
    `SELECT r.recipe,r.kg_per_batch::float kg_per_batch,a.id,a.name,a.kind,
            a.price_per_kg::float price_per_kg,a.package_kg::float package_kg
     FROM mortar_recipe_additives r JOIN mortar_additives a ON a.id=r.additive_id
     WHERE r.tenant_id=$1 ORDER BY r.recipe,a.name`,
    [tenantId],
  );
  for (const row of rows.rows) {
    const entry = byRecipe.get(row.recipe) ?? { items: [], kgPerBatch: 0, costPerBatch: 0 };
    const item: RecipeAdditive = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      pricePerKg: row.price_per_kg == null ? null : Number(row.price_per_kg),
      packageKg: row.package_kg == null ? null : Number(row.package_kg),
      kgPerBatch: Number(row.kg_per_batch),
    };
    entry.items.push(item);
    entry.kgPerBatch += item.kgPerBatch;
    entry.costPerBatch =
      entry.costPerBatch == null || item.pricePerKg == null
        ? null
        : entry.costPerBatch + item.kgPerBatch * item.pricePerKg;
    byRecipe.set(row.recipe, entry);
  }
  return byRecipe;
}

const KINDS = [
  'celulose',
  'polimero',
  'incorporador',
  'retardador',
  'hidrofugante',
  'pigmento',
  'fibra',
  'outro',
] as const;
const additiveBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(KINDS).default('outro'),
  pricePerKg: z.number().min(0).max(100_000).nullable().optional(),
  packageKg: z.number().positive().max(5_000).nullable().optional(),
});

export function registerMortarRecipeRoutes(
  app: FastifyInstance,
  db: Database,
  access: ReturnType<typeof createAccessControl>,
) {
  const missing = (reply: { code: (n: number) => { send: (body: unknown) => unknown } }) =>
    reply.code(409).send({ error: 'Os aditivos precisam da migração 051 aplicada no banco.' });

  /** The catalog of additives, with how many recipes use each. */
  app.get('/api/mortar/additives', async (req) => {
    const tenantId = access.principal(req).tenantId;
    if (!(await hasTables(db))) return { available: false, additives: [] };
    const rows = await db.query<{
      id: string;
      name: string;
      kind: string;
      price_per_kg: number | null;
      package_kg: number | null;
      recipes: string;
    }>(
      `SELECT a.id,a.name,a.kind,a.price_per_kg::float price_per_kg,a.package_kg::float package_kg,
              (SELECT count(*) FROM mortar_recipe_additives r WHERE r.additive_id=a.id) recipes
       FROM mortar_additives a WHERE a.tenant_id=$1 ORDER BY a.name`,
      [tenantId],
    );
    return {
      available: true,
      additives: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        pricePerKg: row.price_per_kg == null ? null : Number(row.price_per_kg),
        packageKg: row.package_kg == null ? null : Number(row.package_kg),
        recipes: Number(row.recipes),
      })),
    };
  });

  app.post('/api/mortar/additives', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    if (!(await hasTables(db))) return missing(reply);
    const current = access.principal(req);
    const body = additiveBody.parse(req.body);
    const exists = await db.query(
      'SELECT 1 FROM mortar_additives WHERE tenant_id=$1 AND lower(name)=lower($2)',
      [current.tenantId, body.name],
    );
    if (exists.rows.length)
      return reply.code(409).send({ error: 'Já existe um aditivo com esse nome.' });
    const row = await db.query<{ id: string }>(
      `INSERT INTO mortar_additives(tenant_id,name,kind,price_per_kg,package_kg)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [current.tenantId, body.name, body.kind, body.pricePerKg ?? null, body.packageKg ?? null],
    );
    await recordAudit(db, req, current, {
      action: 'mortar.additive.create',
      targetType: 'additive',
      targetId: row.rows[0].id,
      summary: body,
    });
    return { id: row.rows[0].id };
  });

  app.patch('/api/mortar/additives/:additive', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    if (!(await hasTables(db))) return missing(reply);
    const current = access.principal(req);
    const { additive } = z.object({ additive: z.uuid() }).parse(req.params);
    const body = additiveBody.parse(req.body);
    const updated = await db.query(
      `UPDATE mortar_additives SET name=$3,kind=$4,price_per_kg=$5,package_kg=$6,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING id`,
      [
        current.tenantId,
        additive,
        body.name,
        body.kind,
        body.pricePerKg ?? null,
        body.packageKg ?? null,
      ],
    );
    if (!updated.rows.length) return reply.code(404).send({ error: 'Aditivo não encontrado' });
    await recordAudit(db, req, current, {
      action: 'mortar.additive.update',
      targetType: 'additive',
      targetId: additive,
      summary: body,
    });
    return { ok: true };
  });

  app.delete('/api/mortar/additives/:additive', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    if (!(await hasTables(db))) return missing(reply);
    const current = access.principal(req);
    const { additive } = z.object({ additive: z.uuid() }).parse(req.params);
    const removed = await db.query(
      'DELETE FROM mortar_additives WHERE tenant_id=$1 AND id=$2 RETURNING id',
      [current.tenantId, additive],
    );
    if (!removed.rows.length) return reply.code(404).send({ error: 'Aditivo não encontrado' });
    await recordAudit(db, req, current, {
      action: 'mortar.additive.delete',
      targetType: 'additive',
      targetId: additive,
      summary: {},
    });
    return { ok: true };
  });

  /** The additives of one mixer recipe, replaced whole. */
  app.put('/api/mortar/recipe-additives', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    if (!(await hasTables(db))) return missing(reply);
    const current = access.principal(req);
    const body = z
      .object({
        recipe: z.string().trim().min(1).max(120),
        items: z
          .array(z.object({ additiveId: z.uuid(), kgPerBatch: z.number().positive().max(2000) }))
          .max(20),
      })
      .parse(req.body);
    if (body.items.length) {
      const owned = await db.query<{ id: string }>(
        'SELECT id FROM mortar_additives WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
        [current.tenantId, [...new Set(body.items.map((item) => item.additiveId))]],
      );
      if (owned.rows.length !== new Set(body.items.map((item) => item.additiveId)).size)
        return reply.code(400).send({ error: 'Aditivo não encontrado' });
    }
    await db.transaction(async (sql) => {
      await sql.query('DELETE FROM mortar_recipe_additives WHERE tenant_id=$1 AND recipe=$2', [
        current.tenantId,
        body.recipe,
      ]);
      for (const item of body.items)
        await sql.query(
          `INSERT INTO mortar_recipe_additives(tenant_id,recipe,additive_id,kg_per_batch)
           VALUES($1,$2,$3,$4) ON CONFLICT (tenant_id,recipe,additive_id) DO UPDATE SET kg_per_batch=EXCLUDED.kg_per_batch,updated_at=now()`,
          [current.tenantId, body.recipe, item.additiveId, item.kgPerBatch],
        );
      await recordAudit(sql, req, current, {
        action: 'mortar.recipe_additives',
        targetType: 'recipe',
        targetId: body.recipe,
        summary: { items: body.items.length },
      });
    });
    return { ok: true };
  });

  /**
   * The mixer recipes of a device, as the recipes card shows them: the batches of the period,
   * what one batch is made of (the materials the recipe doses, the scale's real mass, the manual
   * additives), the product it fills, and what a batch, a ton and a bag cost.
   */
  app.get('/api/devices/:id/mortar/recipes-board', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = z
      .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
      .parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const to = query.to ?? plantDate(new Date());
    const from = query.from && query.from <= to ? query.from : addDays(to, -29);
    const start = plantInstant(from, '00:00');
    const end = plantInstant(addDays(to, 1), '00:00');
    const [recipes, materials, links, prices, additives, catalog, bagged] = await Promise.all([
      db.query<{
        recipe: string;
        batches: number;
        recipe_kg: number;
        scale_kg: number | null;
        weighed: number;
        last_at: Date;
        period_batches: number;
      }>(
        // Every recipe the mixer ran in the last year, its numbers over the period asked.
        `SELECT recipe,
                coalesce(sum(batches) FILTER (WHERE finished_at>=$3 AND finished_at<$4),0)::int period_batches,
                sum(batches)::int batches,
                (sum(total_kg)/nullif(sum(batches),0))::float recipe_kg,
                (sum(scale_kg) FILTER (WHERE scale_kg IS NOT NULL)
                  / nullif(sum(batches) FILTER (WHERE scale_kg IS NOT NULL),0))::float scale_kg,
                count(*) FILTER (WHERE scale_kg IS NOT NULL)::int weighed,
                max(finished_at) last_at
         FROM mix_batches WHERE tenant_id=$1 AND device_id=$2 AND finished_at > now() - interval '365 days'
         GROUP BY recipe ORDER BY max(finished_at) DESC`,
        [tenantId, id, start, end],
      ),
      db.query<{ recipe: string; label: string; kg: number }>(
        // What one batch of each recipe doses, material by material (the recipe's weights).
        `SELECT b.recipe,m->>'label' label,(sum((m->>'kg')::float)/nullif(sum(b.batches),0))::float kg
         FROM mix_batches b CROSS JOIN LATERAL jsonb_array_elements(b.materials) m
         WHERE b.tenant_id=$1 AND b.device_id=$2 AND b.finished_at > now() - interval '365 days'
         GROUP BY b.recipe,m->>'label'`,
        [tenantId, id],
      ),
      db.query<{ recipe: string; product_id: string; name: string; nominal_kg: number }>(
        `SELECT l.recipe,p.id product_id,p.name,p.nominal_kg::float nominal_kg
         FROM mortar_recipe_links l JOIN mortar_products p ON p.id=l.product_id WHERE l.tenant_id=$1`,
        [tenantId],
      ),
      db.query<{ label: string; price_per_ton: number }>(
        'SELECT label,price_per_ton::float price_per_ton FROM mortar_material_prices WHERE tenant_id=$1',
        [tenantId],
      ),
      loadRecipeAdditives(db, tenantId),
      hasTables(db),
      db.query<{ recipe: string; bags: number }>(
        // What the bagger HMI bagged under each of its recipe names in the period.
        `SELECT recipe,sum(bags)::float bags FROM bagging_buckets
         WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4 GROUP BY recipe`,
        [tenantId, id, start, end],
      ),
    ]);
    const price = new Map(prices.rows.map((row) => [row.label, Number(row.price_per_ton)]));
    const link = new Map(links.rows.map((row) => [row.recipe, row]));
    return {
      from,
      to,
      additivesAvailable: catalog,
      bagged: bagged.rows.map((row) => ({ recipe: row.recipe, bags: Number(row.bags) })),
      recipes: recipes.rows.map((row) => {
        const own = materials.rows
          .filter((item) => item.recipe === row.recipe)
          .map((item) => ({
            label: item.label,
            kg: Number(item.kg),
            cost: price.has(item.label) ? (Number(item.kg) / 1000) * price.get(item.label)! : null,
          }))
          // A silo the recipe does not dose reads 0 kg: it is no part of the batch.
          .filter((item) => item.kg >= 0.5)
          .sort((a, b) => b.kg - a.kg);
        const added = additives.get(row.recipe) ?? { items: [], kgPerBatch: 0, costPerBatch: 0 };
        const recipeKg = Number(row.recipe_kg ?? 0);
        const scaleKg = row.scale_kg == null ? null : Number(row.scale_kg);
        const weighedKg = scaleKg ?? recipeKg;
        const batchKg = weighedKg + added.kgPerBatch;
        const materialsCost = own.every((item) => item.cost != null)
          ? own.reduce((sum, item) => sum + (item.cost ?? 0), 0)
          : null;
        const costPerBatch =
          materialsCost == null || added.costPerBatch == null
            ? null
            : materialsCost + added.costPerBatch;
        const product = link.get(row.recipe);
        return {
          recipe: row.recipe,
          product: product
            ? { id: product.product_id, name: product.name, nominalKg: Number(product.nominal_kg) }
            : null,
          batches: Number(row.period_batches),
          lastAt: new Date(row.last_at).toISOString(),
          recipeKg,
          scaleKg,
          batchKg,
          materials: own,
          additives: added.items,
          additivesKg: added.kgPerBatch,
          materialsCost,
          additivesCost: added.costPerBatch,
          costPerBatch,
          costPerTon: costPerBatch == null || !batchKg ? null : costPerBatch / (batchKg / 1000),
          costPerBag:
            costPerBatch == null || !batchKg || !product
              ? null
              : (costPerBatch / batchKg) * Number(product.nominal_kg),
          bagsPerBatch: product ? batchKg / Number(product.nominal_kg) : null,
        };
      }),
    };
  });
}
