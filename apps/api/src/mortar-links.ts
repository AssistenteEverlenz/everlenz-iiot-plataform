import type { Database } from '@iiot/database';

/**
 * Recipe names the HMI cuts short, linked to their product.
 *
 * The bagger's recipe name reaches the platform through a 14-character string of the cMT, so
 * "AC3 BM [BRANCA] B1" arrives as "AC3 BM [BRANCA" and "AUTONIVELANTE B1" as "AUTONIVELANTE".
 * The catalog has the full names, so those bags were counted but belonged to no product and
 * stayed out of the tons (Bella Massa, October 2026: 904 bags, the 16.7 t the yield card showed
 * as missing). A recipe nobody linked whose name begins every linked recipe of exactly one
 * product is that product's: the link is written once, as if the owner had made it, and every
 * card reads it from there.
 */

/** Shorter than this, a name is too generic to stand for a product ("AC2" begins many). */
const MIN_LENGTH = 10;

export function productOfTruncated(recipe: string, links: Array<{ recipe: string; productId: string }>) {
  const name = recipe.trim();
  if (name.length < MIN_LENGTH) return null;
  const products = new Set(
    links.filter((link) => link.recipe.startsWith(name) && link.recipe !== name).map((link) => link.productId),
  );
  return products.size === 1 ? [...products][0] : null;
}

export async function linkTruncatedRecipes(db: Database) {
  const unlinked = await db.query<{ tenant_id: string; recipe: string }>(
    `SELECT DISTINCT r.tenant_id,r.recipe FROM (
       SELECT tenant_id,recipe FROM bagging_buckets WHERE bucket > now() - interval '60 days' AND bags > 0
       UNION
       SELECT tenant_id,recipe FROM mix_batches WHERE finished_at > now() - interval '60 days'
     ) r
     WHERE NOT EXISTS (
       SELECT 1 FROM mortar_recipe_links l WHERE l.tenant_id=r.tenant_id AND l.recipe=r.recipe
     )`,
  );
  if (!unlinked.rows.length) return [];
  const tenants = [...new Set(unlinked.rows.map((row) => row.tenant_id))];
  const links = await db.query<{ tenant_id: string; recipe: string; product_id: string }>(
    'SELECT tenant_id,recipe,product_id FROM mortar_recipe_links WHERE tenant_id=ANY($1::uuid[])',
    [tenants],
  );
  const linked: Array<{ tenantId: string; recipe: string; productId: string }> = [];
  for (const row of unlinked.rows) {
    const productId = productOfTruncated(
      row.recipe,
      links.rows
        .filter((link) => link.tenant_id === row.tenant_id)
        .map((link) => ({ recipe: link.recipe, productId: link.product_id })),
    );
    if (!productId) continue;
    await db.query(
      `INSERT INTO mortar_recipe_links(tenant_id,recipe,product_id) VALUES($1,$2,$3)
       ON CONFLICT (tenant_id,recipe) DO NOTHING`,
      [row.tenant_id, row.recipe, productId],
    );
    await db.query(
      `INSERT INTO audit_log(tenant_id,actor_email,actor_role,action,target_type,target_id,summary)
       VALUES($1,'sistema@plataforma','master','mortar.recipe_autolink','recipe',$2,$3::jsonb)`,
      [row.tenant_id, row.recipe, JSON.stringify({ productId, reason: 'nome cortado pela IHM' })],
    ).catch(() => undefined);
    linked.push({ tenantId: row.tenant_id, recipe: row.recipe, productId });
  }
  return linked;
}
