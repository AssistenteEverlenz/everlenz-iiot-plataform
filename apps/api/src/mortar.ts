import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import { addDays, env, NO_RECIPE, plantDate, plantInstant } from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';

/**
 * Mortar plants (migration 037): the bagging spouts, the mixing batches and the products the
 * recipes fill. One summary feeds the four mortar cards, so a panel with all of them asks the
 * database once per period instead of four times.
 *
 * Tons are always bags times the product's nominal weight. A recipe not linked to a product has
 * no weight, so its bags are counted and shown, but left out of every kilogram -- and the card
 * says so, instead of guessing a weight from the recipe name.
 */
const uuid = z.uuid();
const range = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Plant-local day of a timestamp column, on the plant's fixed offset (shifts.ts). */
const PLANT_DAY = (column: string) => `to_char(${column} - interval '3 hours','YYYY-MM-DD')`;
/** Quarter of an hour: one day of bagging is read at this grain, so the curves show the day moving. */
const PLANT_QUARTER = (column: string) =>
  `to_char(date_bin('15 minutes', ${column} - interval '3 hours', timestamptz '2000-01-01 00:00+00'),'YYYY-MM-DD"T"HH24:MI')`;
const PLANT_HOUR = (column: string) =>
  `to_char(${column} - interval '3 hours','YYYY-MM-DD"T"HH24')`;

export function registerMortarRoutes(
  app: FastifyInstance,
  db: Database,
  access: ReturnType<typeof createAccessControl>,
) {
  app.get('/api/devices/:id/mortar', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = range.parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const to = query.to ?? plantDate(new Date());
    const from = query.from && query.from <= to ? query.from : to;
    const start = plantInstant(from, '00:00');
    const end = plantInstant(addDays(to, 1), '00:00');
    // One day reads by the hour; anything longer by the day.
    const hourly = from === to;
    const slot = hourly ? PLANT_HOUR : PLANT_DAY;

    const settings = (
      await db.query<{
        mix_enabled: boolean;
        bagging_enabled: boolean;
        idle_seconds: number;
        materials: Array<{ label?: string }> | null;
      }>(
        'SELECT mix_enabled,bagging_enabled,idle_seconds,materials FROM mortar_settings WHERE tenant_id=$1 AND device_id=$2',
        [tenantId, id],
      )
    ).rows[0];

    const [
      spouts,
      bySpout,
      series,
      links,
      batches,
      materials,
      cycles,
      mixSeries,
      stopRows,
      prices,
    ] = await Promise.all([
      db.query<{
        id: string;
        position: number;
        name: string;
        last_at: Date | null;
        last_increment_at: Date | null;
        enabled: boolean | null;
        recipe: string | null;
      }>(
        `SELECT s.id,s.position,s.name,r.last_at,r.last_increment_at,r.enabled,r.recipe
         FROM bagging_spouts s LEFT JOIN bagging_runtime r ON r.spout_id=s.id
         WHERE s.tenant_id=$1 AND s.device_id=$2 ORDER BY s.position`,
        [tenantId, id],
      ),
      db.query<{
        spout_id: string;
        recipe: string;
        bags: number;
        running_s: number;
        idle_s: number;
        off_s: number;
      }>(
        `SELECT spout_id,recipe,sum(bags)::float bags,sum(running_s)::float running_s,
                sum(idle_s)::float idle_s,sum(off_s)::float off_s
         FROM bagging_buckets WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4
         GROUP BY spout_id,recipe`,
        [tenantId, id, start, end],
      ),
      db.query<{
        slot: string;
        spout_id: string;
        recipe: string;
        bags: number;
        running_s: number;
        idle_s: number;
        off_s: number;
      }>(
        `SELECT ${hourly ? PLANT_QUARTER('bucket') : slot('bucket')} slot,spout_id,recipe,sum(bags)::float bags,
                sum(running_s)::float running_s,sum(idle_s)::float idle_s,sum(off_s)::float off_s
         FROM bagging_buckets WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4
         GROUP BY 1,2,3 ORDER BY 1`,
        [tenantId, id, start, end],
      ),
      db.query<{
        recipe: string;
        product_id: string;
        name: string;
        nominal_kg: number;
        standard_rate: number | null;
      }>(
        `SELECT l.recipe,p.id product_id,p.name,p.nominal_kg::float nominal_kg,p.standard_rate::float standard_rate
         FROM mortar_recipe_links l JOIN mortar_products p ON p.id=l.product_id
         WHERE l.tenant_id=$1`,
        [tenantId],
      ),
      db.query<{
        recipe: string;
        batches: number;
        total_kg: number;
        scale_kg: number | null;
        scale_batches: number;
        scale_theoretical: number;
        last_at: Date;
      }>(
        `SELECT recipe,sum(batches)::int batches,sum(total_kg)::float total_kg,
                sum(scale_kg)::float scale_kg,
                coalesce(sum(batches) FILTER (WHERE scale_kg IS NOT NULL),0)::int scale_batches,
                coalesce(sum(total_kg) FILTER (WHERE scale_kg IS NOT NULL),0)::float scale_theoretical,
                max(finished_at) last_at
         FROM mix_batches WHERE tenant_id=$1 AND device_id=$2 AND finished_at>=$3 AND finished_at<$4
         GROUP BY recipe ORDER BY sum(total_kg) DESC`,
        [tenantId, id, start, end],
      ),
      db.query<{ recipe: string; label: string; kg: number }>(
        `SELECT b.recipe,m->>'label' label,sum((m->>'kg')::float)::float kg
         FROM mix_batches b CROSS JOIN LATERAL jsonb_array_elements(b.materials) m
         WHERE b.tenant_id=$1 AND b.device_id=$2 AND b.finished_at>=$3 AND b.finished_at<$4
         GROUP BY 1,2`,
        [tenantId, id, start, end],
      ),
      // The pace of the mixer: minutes between one batch and the next on the same day. A gap of
      // more than 40 minutes is a stop, not a cycle, and is left out.
      db.query<{ cycles: number; minutes: number | null }>(
        `SELECT count(*)::int cycles,avg(gap)::float minutes FROM (
           SELECT extract(epoch FROM finished_at - lag(finished_at) OVER (
             PARTITION BY ${PLANT_DAY('finished_at')} ORDER BY finished_at))/60 gap
           FROM mix_batches WHERE tenant_id=$1 AND device_id=$2 AND finished_at>=$3 AND finished_at<$4
         ) g WHERE gap IS NOT NULL AND gap>0 AND gap<=40`,
        [tenantId, id, start, end],
      ),
      db.query<{ slot: string; label: string; kg: number; batches: number }>(
        `SELECT ${slot('b.finished_at')} slot,m->>'label' label,sum((m->>'kg')::float)::float kg,
                sum(b.batches)::int batches
         FROM mix_batches b CROSS JOIN LATERAL jsonb_array_elements(b.materials) m
         WHERE b.tenant_id=$1 AND b.device_id=$2 AND b.finished_at>=$3 AND b.finished_at<$4
         GROUP BY 1,2 ORDER BY 1`,
        [tenantId, id, start, end],
      ),
      // Stops of each spout in the period (migration 040): how many times, not only how long.
      db
        .query<{ spout_id: string; stops: number; seconds: number; longest: number }>(
          `SELECT spout_id,count(*)::int stops,sum(seconds)::float seconds,max(seconds)::float longest
             FROM bagging_stops WHERE tenant_id=$1 AND device_id=$2 AND state='idle'
               AND started_at>=$3 AND started_at<$4 GROUP BY spout_id`,
          [tenantId, id, start, end],
        )
        .catch(() => ({
          rows: [] as Array<{ spout_id: string; stops: number; seconds: number; longest: number }>,
        })),
      db
        .query<{ label: string; price_per_ton: number }>(
          'SELECT label,price_per_ton::float price_per_ton FROM mortar_material_prices WHERE tenant_id=$1',
          [tenantId],
        )
        .catch(() => ({ rows: [] as Array<{ label: string; price_per_ton: number }> })),
    ]);

    const product = new Map(links.rows.map((row) => [row.recipe, row]));
    const kgOf = (recipe: string, bags: number) => {
      const link = product.get(recipe);
      return link ? bags * Number(link.nominal_kg) : null;
    };

    // What each spout is doing now, read the way the ceramic board reads a machine.
    const now = Date.now();
    const idleMs = (settings?.idle_seconds ?? 120) * 1000;
    const stateOf = (row: (typeof spouts.rows)[number]) => {
      if (!row.last_at) return 'unknown';
      if (now - new Date(row.last_at).getTime() > env.DEVICE_OFFLINE_SECONDS * 1000)
        return 'offline';
      if (row.enabled === false) return 'off';
      const bag = row.last_increment_at ? new Date(row.last_increment_at).getTime() : 0;
      return now - bag <= idleMs ? 'running' : 'idle';
    };

    const spoutList = spouts.rows.map((row) => {
      const rows = bySpout.rows.filter((item) => item.spout_id === row.id);
      const sum = (key: 'bags' | 'running_s' | 'idle_s' | 'off_s') =>
        rows.reduce((total, item) => total + Number(item[key]), 0);
      const runningS = sum('running_s');
      const bags = sum('bags');
      const recipeNow = row.recipe ?? null;
      return {
        id: row.id,
        position: row.position,
        name: row.name,
        state: stateOf(row),
        recipe: recipeNow,
        product: recipeNow ? (product.get(recipeNow)?.name ?? null) : null,
        lastBagAt: row.last_increment_at,
        bags,
        kg: rows.reduce((total, item) => total + (kgOf(item.recipe, Number(item.bags)) ?? 0), 0),
        runningS,
        idleS: sum('idle_s'),
        offS: sum('off_s'),
        bagsPerHour: runningS > 0 ? bags / (runningS / 3600) : null,
        // Like the time per pallet: seconds filling divided by the bags, stops left out.
        secondsPerBag: bags > 0 ? runningS / bags : null,
        ...(() => {
          const own = stopRows.rows.find((item) => item.spout_id === row.id);
          // Bags the standard pace of each product would have made in the time spent filling.
          let expected = 0;
          let rated = 0;
          for (const item of rows) {
            const rate = product.get(item.recipe)?.standard_rate;
            if (!rate) continue;
            expected += (Number(item.running_s) / 3600) * Number(rate);
            rated += Number(item.bags);
          }
          return {
            stops: own ? Number(own.stops) : 0,
            stopSeconds: own ? Number(own.seconds) : 0,
            longestStop: own ? Number(own.longest) : 0,
            performance: expected > 0 ? rated / expected : null,
          };
        })(),
        // What the spout filled in the period, product by product (the recipe it came from too).
        products: rows
          .filter((item) => Number(item.bags) > 0 || Number(item.running_s) > 0)
          .map((item) => {
            const itemBags = Number(item.bags);
            const itemRunning = Number(item.running_s);
            return {
              recipe: item.recipe,
              product: product.get(item.recipe)?.name ?? null,
              bags: itemBags,
              kg: kgOf(item.recipe, itemBags),
              runningS: itemRunning,
              secondsPerBag: itemBags > 0 ? itemRunning / itemBags : null,
            };
          })
          .sort((a, b) => b.bags - a.bags),
      };
    });

    // Products: the linked recipes summed under their product; the rest each on its own line.
    const products = new Map<
      string,
      {
        key: string;
        productId: string | null;
        name: string;
        nominalKg: number | null;
        bags: number;
        kg: number | null;
        recipes: Map<string, number>;
        spouts: Record<string, number>;
      }
    >();
    for (const row of bySpout.rows) {
      const bags = Number(row.bags);
      if (!bags) continue;
      const link = product.get(row.recipe);
      const key = link ? `p:${link.product_id}` : `r:${row.recipe}`;
      let entry = products.get(key);
      if (!entry) {
        entry = {
          key,
          productId: link?.product_id ?? null,
          name: link?.name ?? row.recipe,
          nominalKg: link ? Number(link.nominal_kg) : null,
          bags: 0,
          kg: link ? 0 : null,
          recipes: new Map(),
          spouts: {},
        };
        products.set(key, entry);
      }
      entry.bags += bags;
      if (entry.kg != null && entry.nominalKg) entry.kg += bags * entry.nominalKg;
      entry.recipes.set(row.recipe, (entry.recipes.get(row.recipe) ?? 0) + bags);
      entry.spouts[row.spout_id] = (entry.spouts[row.spout_id] ?? 0) + bags;
    }
    const productList = [...products.values()]
      .map((entry) => ({
        ...entry,
        recipes: [...entry.recipes.entries()]
          .map(([recipe, bags]) => ({ recipe, bags }))
          .sort((a, b) => b.bags - a.bags),
      }))
      .sort((a, b) => b.bags - a.bags);

    const bagSeries = new Map<
      string,
      {
        slot: string;
        bags: number;
        kg: number;
        spouts: Record<string, number>;
        /** Seconds each spout spent filling in the slot: with its bags, the time per bag. */
        running: Record<string, number>;
        idle: Record<string, number>;
        off: Record<string, number>;
      }
    >();
    for (const row of series.rows) {
      const entry = bagSeries.get(row.slot) ?? {
        slot: row.slot,
        bags: 0,
        kg: 0,
        spouts: {},
        running: {},
        idle: {},
        off: {},
      };
      const bags = Number(row.bags);
      entry.bags += bags;
      entry.kg += kgOf(row.recipe, bags) ?? 0;
      entry.spouts[row.spout_id] = (entry.spouts[row.spout_id] ?? 0) + bags;
      entry.running[row.spout_id] = (entry.running[row.spout_id] ?? 0) + Number(row.running_s);
      entry.idle[row.spout_id] = (entry.idle[row.spout_id] ?? 0) + Number(row.idle_s);
      entry.off[row.spout_id] = (entry.off[row.spout_id] ?? 0) + Number(row.off_s);
      bagSeries.set(row.slot, entry);
    }

    const totalBags = spoutList.reduce((sum, item) => sum + item.bags, 0);
    const baggedKg = spoutList.reduce((sum, item) => sum + item.kg, 0);
    const unlinkedBags = productList
      .filter((item) => !item.productId)
      .reduce((sum, item) => sum + item.bags, 0);

    const materialTotals = new Map<string, number>();
    for (const row of materials.rows)
      materialTotals.set(row.label, (materialTotals.get(row.label) ?? 0) + Number(row.kg));
    const mixSlots = new Map<
      string,
      { slot: string; batches: number; materials: Record<string, number> }
    >();
    for (const row of mixSeries.rows) {
      const entry = mixSlots.get(row.slot) ?? { slot: row.slot, batches: 0, materials: {} };
      entry.materials[row.label] = Number(row.kg);
      // Every material row of a slot carries the same batches: take it once.
      entry.batches = Math.max(entry.batches, Number(row.batches));
      mixSlots.set(row.slot, entry);
    }
    const order = (settings?.materials ?? []).map((item) => item.label);
    const rank = (label: string) => (order.includes(label) ? order.indexOf(label) : order.length);
    const mixedKg = batches.rows.reduce((sum, row) => sum + Number(row.total_kg), 0);
    const batchCount = batches.rows.reduce((sum, row) => sum + Number(row.batches), 0);
    const scaleKg = batches.rows.reduce((sum, row) => sum + Number(row.scale_kg ?? 0), 0);
    const scaleTheoretical = batches.rows.reduce(
      (sum, row) => sum + Number(row.scale_theoretical),
      0,
    );
    // The mass that went into the silo: the scale where it weighed, the recipe elsewhere.
    const realMixedKg = mixedKg - scaleTheoretical + scaleKg;

    return {
      from,
      to,
      granularity: hourly ? 'hour' : 'day',
      modules: { mix: settings?.mix_enabled ?? false, bagging: settings?.bagging_enabled ?? false },
      bagging: {
        totals: {
          bags: totalBags,
          kg: baggedKg,
          unlinkedBags,
          runningS: spoutList.reduce((sum, item) => sum + item.runningS, 0),
          idleS: spoutList.reduce((sum, item) => sum + item.idleS, 0),
          offS: spoutList.reduce((sum, item) => sum + item.offS, 0),
        },
        spouts: spoutList,
        products: productList,
        series: [...bagSeries.values()],
      },
      mix: {
        batches: batchCount,
        kg: mixedKg,
        scaleKg: scaleTheoretical > 0 ? scaleKg : null,
        scaleTheoreticalKg: scaleTheoretical,
        lastBatchAt: batches.rows.reduce<Date | null>(
          (last, row) => (!last || new Date(row.last_at) > last ? new Date(row.last_at) : last),
          null,
        ),
        // In the order the plant set them up (sand, cement, complement), not the database's.
        materials: [...materialTotals.entries()]
          .map(([label, kg]) => ({ label, kg }))
          .sort((a, b) => rank(a.label) - rank(b.label)),
        cycleMinutes: cycles.rows[0]?.minutes ?? null,
        // What the raw materials cost, at the prices set in Produtos e receitas.
        cost: (() => {
          const price = new Map(prices.rows.map((row) => [row.label, Number(row.price_per_ton)]));
          if (!price.size) return null;
          const items = [...materialTotals.entries()].map(([label, kg]) => ({
            label,
            pricePerTon: price.get(label) ?? null,
            cost: price.has(label) ? (kg / 1000) * (price.get(label) ?? 0) : null,
          }));
          const total = items.reduce((sum, item) => sum + (item.cost ?? 0), 0);
          const byRecipe = batches.rows.map((row) => {
            const cost = materials.rows
              .filter((item) => item.recipe === row.recipe)
              .reduce(
                (sum, item) => sum + (Number(item.kg) / 1000) * (price.get(item.label) ?? 0),
                0,
              );
            return {
              recipe: row.recipe,
              cost,
              perTon: Number(row.total_kg) ? cost / (Number(row.total_kg) / 1000) : null,
            };
          });
          return {
            total,
            perTon: mixedKg ? total / (mixedKg / 1000) : null,
            perBatch: batchCount ? total / batchCount : null,
            missing: items.filter((item) => item.pricePerTon == null).map((item) => item.label),
            materials: items,
            byRecipe,
          };
        })(),
        recipes: batches.rows.map((row) => ({
          recipe: row.recipe,
          batches: Number(row.batches),
          kg: Number(row.total_kg),
          lastAt: row.last_at,
          // The scale against the recipe, for the batches of this recipe that were weighed.
          scaleKg: Number(row.scale_theoretical) > 0 ? Number(row.scale_kg ?? 0) : null,
          scaleTheoreticalKg: Number(row.scale_theoretical),
          materials: materials.rows
            .filter((item) => item.recipe === row.recipe)
            .map((item) => ({ label: item.label, kg: Number(item.kg) })),
        })),
        series: [...mixSlots.values()],
      },
      yield: {
        mixedKg: realMixedKg,
        baggedKg,
        unlinkedBags,
        lossKg: realMixedKg > 0 ? realMixedKg - baggedKg : null,
        lossRatio: realMixedKg > 0 ? (realMixedKg - baggedKg) / realMixedKg : null,
      },
    };
  });

  // ---- Configuration of a device's mortar modules (masters only) ----

  app.get('/api/devices/:id/mortar/settings', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const tenantId = access.principal(req).tenantId;
    const [settings, spouts] = await Promise.all([
      db.query(
        `SELECT mix_enabled,recipe_tag_id,batch_count_tag_id,scale_tag_id,materials,bagging_enabled,idle_seconds
         FROM mortar_settings WHERE tenant_id=$1 AND device_id=$2`,
        [tenantId, id],
      ),
      db.query(
        `SELECT id,position,name,count_tag_id,recipe_tag_id,running_tag_id,enabled_tag_id
         FROM bagging_spouts WHERE tenant_id=$1 AND device_id=$2 ORDER BY position`,
        [tenantId, id],
      ),
    ]);
    return { settings: settings.rows[0] ?? null, spouts: spouts.rows };
  });

  const tagRef = uuid
    .nullable()
    .optional()
    .transform((value) => value ?? null);
  app.put('/api/devices/:id/mortar/settings', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const body = z
      .object({
        mixEnabled: z.boolean(),
        recipeTagId: tagRef,
        batchCountTagId: tagRef,
        scaleTagId: tagRef,
        materials: z
          .array(z.object({ label: z.string().trim().min(1).max(40), tagId: tagRef }))
          .max(8),
        baggingEnabled: z.boolean(),
        idleSeconds: z.number().int().min(10).max(3600),
        spouts: z
          .array(
            z.object({
              id: uuid.optional(),
              name: z.string().trim().min(1).max(40),
              countTagId: tagRef,
              recipeTagId: tagRef,
              runningTagId: tagRef,
              enabledTagId: tagRef,
            }),
          )
          .max(24),
      })
      .parse(req.body);
    // Every variable must belong to this device: a foreign id would read another plant.
    const ids = [
      body.recipeTagId,
      body.batchCountTagId,
      body.scaleTagId,
      ...body.materials.map((item) => item.tagId),
      ...body.spouts.flatMap((spout) => [
        spout.countTagId,
        spout.recipeTagId,
        spout.runningTagId,
        spout.enabledTagId,
      ]),
    ].filter((value): value is string => !!value);
    if (ids.length) {
      const owned = await db.query<{ id: string }>(
        'SELECT id FROM tags WHERE tenant_id=$1 AND device_id=$2 AND id=ANY($3::uuid[])',
        [current.tenantId, id, [...new Set(ids)]],
      );
      if (owned.rows.length !== new Set(ids).size)
        return reply.code(400).send({ error: 'Variável não pertence a este equipamento' });
    }
    await db.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO mortar_settings(device_id,tenant_id,mix_enabled,recipe_tag_id,batch_count_tag_id,scale_tag_id,
           materials,bagging_enabled,idle_seconds,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,now())
         ON CONFLICT(device_id) DO UPDATE SET mix_enabled=EXCLUDED.mix_enabled,recipe_tag_id=EXCLUDED.recipe_tag_id,
           batch_count_tag_id=EXCLUDED.batch_count_tag_id,scale_tag_id=EXCLUDED.scale_tag_id,
           materials=EXCLUDED.materials,bagging_enabled=EXCLUDED.bagging_enabled,
           idle_seconds=EXCLUDED.idle_seconds,updated_at=now()`,
        [
          id,
          current.tenantId,
          body.mixEnabled,
          body.recipeTagId,
          body.batchCountTagId,
          body.scaleTagId,
          JSON.stringify(body.materials),
          body.baggingEnabled,
          body.idleSeconds,
        ],
      );
      // Spouts are kept by id: removing one from the list deletes it and its history, renaming
      // or moving it keeps everything it counted.
      const keep = body.spouts.map((spout) => spout.id).filter((value): value is string => !!value);
      await sql.query(
        'DELETE FROM bagging_spouts WHERE tenant_id=$1 AND device_id=$2 AND NOT (id=ANY($3::uuid[]))',
        [current.tenantId, id, keep],
      );
      // Positions are unique: park the survivors out of the way before writing the new order.
      await sql.query(
        'UPDATE bagging_spouts SET position=position+12 WHERE tenant_id=$1 AND device_id=$2',
        [current.tenantId, id],
      );
      for (const [index, spout] of body.spouts.entries()) {
        const values = [
          index + 1,
          spout.name,
          spout.countTagId,
          spout.recipeTagId,
          spout.runningTagId,
          spout.enabledTagId,
        ];
        if (spout.id)
          await sql.query(
            `UPDATE bagging_spouts SET position=$4,name=$5,count_tag_id=$6,recipe_tag_id=$7,running_tag_id=$8,
               enabled_tag_id=$9 WHERE id=$1 AND tenant_id=$2 AND device_id=$3`,
            [spout.id, current.tenantId, id, ...values],
          );
        else
          await sql.query(
            `INSERT INTO bagging_spouts(tenant_id,device_id,position,name,count_tag_id,recipe_tag_id,running_tag_id,enabled_tag_id)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [current.tenantId, id, ...values],
          );
      }
      await recordAudit(sql, req, current, {
        action: 'mortar.settings',
        targetType: 'device',
        targetId: id,
        summary: {
          mix: body.mixEnabled,
          bagging: body.baggingEnabled,
          spouts: body.spouts.length,
          materials: body.materials.map((item) => item.label),
        },
      });
    });
    return { ok: true };
  });

  // ---- Products and the recipes linked to them ----

  /** Every recipe name the bagging machines have sent, with the product it is linked to. */
  app.get('/api/mortar/products', async (req) => {
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    const [products, recipes] = await Promise.all([
      db.query<{ id: string; name: string; nominal_kg: number; standard_rate: number | null }>(
        'SELECT id,name,nominal_kg::float nominal_kg,standard_rate::float standard_rate FROM mortar_products WHERE tenant_id=$1 ORDER BY name',
        [current.tenantId],
      ),
      db.query<{ recipe: string; product_id: string | null; bags: number; last_at: Date | null }>(
        `SELECT r.recipe,l.product_id,coalesce(r.bags,0)::float bags,r.last_at FROM (
           SELECT recipe,sum(bags) bags,max(bucket) last_at FROM bagging_buckets
           WHERE tenant_id=$1 AND ($2::uuid[] IS NULL OR device_id=ANY($2)) GROUP BY recipe
           UNION ALL
           SELECT recipe,0,NULL FROM mortar_recipe_links l2 WHERE tenant_id=$1
             AND NOT EXISTS(SELECT 1 FROM bagging_buckets b WHERE b.tenant_id=$1 AND b.recipe=l2.recipe)
         ) r LEFT JOIN mortar_recipe_links l ON l.tenant_id=$1 AND l.recipe=r.recipe
         WHERE r.recipe<>$3
         ORDER BY r.recipe`,
        [current.tenantId, deviceIds, NO_RECIPE],
      ),
    ]);
    return {
      products: products.rows,
      recipes: recipes.rows.map((row) => ({
        recipe: row.recipe,
        productId: row.product_id,
        bags: Number(row.bags),
        lastAt: row.last_at,
      })),
    };
  });

  const productBody = z.object({
    name: z.string().trim().min(1).max(80),
    nominalKg: z.number().positive().max(2000),
    // Bags per hour a spout should reach on it; optional, it only feeds the performance.
    standardRate: z.number().positive().max(10_000).nullable().optional(),
  });
  app.post('/api/mortar/products', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const body = productBody.parse(req.body);
    const created = await db.query(
      `INSERT INTO mortar_products(tenant_id,name,nominal_kg,standard_rate) VALUES($1,$2,$3,$4)
       ON CONFLICT(tenant_id,name) DO NOTHING RETURNING id,name,nominal_kg::float nominal_kg`,
      [current.tenantId, body.name, body.nominalKg, body.standardRate ?? null],
    );
    if (!created.rows[0])
      return reply.code(409).send({ error: 'Já existe um produto com esse nome' });
    return reply.code(201).send(created.rows[0]);
  });
  app.patch('/api/mortar/products/:productId', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const { productId } = z.object({ productId: uuid }).parse(req.params);
    const body = productBody.parse(req.body);
    const updated = await db.query(
      'UPDATE mortar_products SET name=$3,nominal_kg=$4,standard_rate=$5 WHERE tenant_id=$1 AND id=$2 RETURNING id',
      [current.tenantId, productId, body.name, body.nominalKg, body.standardRate ?? null],
    );
    if (!updated.rows[0]) return reply.code(404).send({ error: 'Produto não encontrado' });
    return { ok: true };
  });
  app.delete('/api/mortar/products/:productId', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const { productId } = z.object({ productId: uuid }).parse(req.params);
    // The links go with it (cascade); the bags stay, counted under their recipe names again.
    await db.query('DELETE FROM mortar_products WHERE tenant_id=$1 AND id=$2', [
      current.tenantId,
      productId,
    ]);
    return reply.code(204).send();
  });
  app.put('/api/mortar/recipes', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const body = z
      .object({ recipe: z.string().trim().min(1).max(120), productId: uuid.nullable() })
      .parse(req.body);
    if (body.productId) {
      const linked = await db.query(
        `INSERT INTO mortar_recipe_links(tenant_id,recipe,product_id)
         SELECT $1,$2,id FROM mortar_products WHERE tenant_id=$1 AND id=$3
         ON CONFLICT(tenant_id,recipe) DO UPDATE SET product_id=EXCLUDED.product_id RETURNING recipe`,
        [current.tenantId, body.recipe, body.productId],
      );
      if (!linked.rows[0]) return reply.code(404).send({ error: 'Produto não encontrado' });
    } else
      await db.query('DELETE FROM mortar_recipe_links WHERE tenant_id=$1 AND recipe=$2', [
        current.tenantId,
        body.recipe,
      ]);
    return { ok: true };
  });

  // ---- The industry a client (site) works in ----

  app.patch('/api/sites/:id/segment', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ segment: z.enum(['ceramica', 'argamassa']) }).parse(req.body);
    const updated = await db.query(
      'UPDATE sites SET segment=$3 WHERE tenant_id=$1 AND id=$2 RETURNING id',
      [current.tenantId, id, body.segment],
    );
    if (!updated.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' });
    await recordAudit(db, req, current, {
      action: 'site.segment',
      targetType: 'site',
      targetId: id,
      summary: { segment: body.segment },
    });
    return { ok: true };
  });
}
