import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import { addDays, expandShifts, plantDate, plantInstant } from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';
import { loadShifts } from './shift-production.js';

/**
 * The production history of mortar plants (migrations 037, 040 and 043): one line or all of a
 * client's lines, any period, read by day, week or month. One answer feeds the whole Produção
 * page -- the overview, the history table and the comparisons -- so every number on it agrees.
 *
 * Bags come from the 5-minute bagging buckets, tons from the product each recipe is linked to,
 * the mix from the batches, and the stock from the opening balance plus what was bagged since.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PLANT_DAY = (column: string) => `to_char(${column} - interval '3 hours','YYYY-MM-DD')`;

type Group = 'day' | 'week' | 'month';

/** The slot a plant day belongs to: itself, the Monday of its week, or its month. */
function slotOf(date: string, group: Group) {
  if (group === 'day') return date;
  if (group === 'month') return date.slice(0, 7);
  const [y, m, d] = date.split('-').map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

/** Every slot of the range, in order, so a quiet week still shows as a zero and not a gap. */
function slotsOf(from: string, to: string, group: Group) {
  const slots: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const slot = slotOf(date, group);
    if (slots.at(-1) !== slot) slots.push(slot);
  }
  return slots;
}

export function registerMortarHistoryRoutes(
  app: FastifyInstance,
  db: Database,
  access: ReturnType<typeof createAccessControl>,
) {
  /** The mortar lines this user may read: devices with mortar settings. */
  async function mortarDevices(tenantId: string, allowed: string[] | null) {
    return (
      await db.query<{ id: string; name: string; site_id: string; site_name: string }>(
        `SELECT d.id,d.name,d.site_id,s.name site_name FROM devices d
         JOIN sites s ON s.id=d.site_id AND s.tenant_id=d.tenant_id
         JOIN mortar_settings m ON m.device_id=d.id AND m.tenant_id=d.tenant_id
         WHERE d.tenant_id=$1 AND d.archived_at IS NULL AND (m.bagging_enabled OR m.mix_enabled)
           AND ($2::uuid[] IS NULL OR d.id=ANY($2))
         ORDER BY s.name,d.name`,
        [tenantId, allowed],
      )
    ).rows;
  }

  app.get('/api/mortar/lines', async (req) => {
    const current = access.principal(req);
    return { lines: await mortarDevices(current.tenantId, await access.accessibleDeviceIds(req)) };
  });

  app.get('/api/mortar/history', async (req, reply) => {
    const current = access.principal(req);
    const query = z
      .object({
        device: z.union([z.uuid(), z.literal('all')]).default('all'),
        from: day.optional(),
        to: day.optional(),
        group: z.enum(['day', 'week', 'month']).default('day'),
      })
      .parse(req.query);
    const tenantId = current.tenantId;
    const lines = await mortarDevices(tenantId, await access.accessibleDeviceIds(req));
    const chosen =
      query.device === 'all' ? lines : lines.filter((line) => line.id === query.device);
    if (!chosen.length && query.device !== 'all')
      return reply.code(404).send({ error: 'Linha não encontrada' });
    const ids = chosen.map((line) => line.id);
    const to = query.to ?? plantDate(new Date());
    const from = query.from && query.from <= to ? query.from : addDays(to, -29);
    const start = plantInstant(from, '00:00');
    const end = plantInstant(addDays(to, 1), '00:00');
    const yearStart = plantInstant(`${to.slice(0, 4)}-01-01`, '00:00');
    const yearEnd = plantInstant(`${Number(to.slice(0, 4)) + 1}-01-01`, '00:00');

    const [
      links,
      buckets,
      stops,
      mix,
      materials,
      prices,
      heat,
      calendar,
      spouts,
      settings,
      opening,
    ] = await Promise.all([
      db.query<{
        recipe: string;
        product_id: string;
        name: string;
        nominal_kg: number;
        standard_rate: number | null;
      }>(
        `SELECT l.recipe,p.id product_id,p.name,p.nominal_kg::float nominal_kg,p.standard_rate::float standard_rate
         FROM mortar_recipe_links l JOIN mortar_products p ON p.id=l.product_id WHERE l.tenant_id=$1`,
        [tenantId],
      ),
      db.query<{
        day: string;
        device_id: string;
        spout_id: string;
        recipe: string;
        bags: number;
        running: number;
        idle: number;
        off: number;
      }>(
        `SELECT ${PLANT_DAY('bucket')} AS day,device_id,spout_id,recipe,sum(bags)::float bags,
                sum(running_s)::float running,sum(idle_s)::float idle,sum(off_s)::float off
         FROM bagging_buckets WHERE tenant_id=$1 AND device_id=ANY($2::uuid[]) AND bucket>=$3 AND bucket<$4
         GROUP BY 1,2,3,4`,
        [tenantId, ids, start, end],
      ),
      db
        .query<{ day: string; spout_id: string; stops: number; seconds: number }>(
          `SELECT ${PLANT_DAY('started_at')} AS day,spout_id,count(*)::int stops,sum(seconds)::float seconds
           FROM bagging_stops WHERE tenant_id=$1 AND device_id=ANY($2::uuid[]) AND state='idle'
             AND started_at>=$3 AND started_at<$4 GROUP BY 1,2`,
          [tenantId, ids, start, end],
        )
        .catch(() => ({
          rows: [] as Array<{ day: string; spout_id: string; stops: number; seconds: number }>,
        })),
      db.query<{ day: string; recipe: string; batches: number; kg: number }>(
        `SELECT ${PLANT_DAY('finished_at')} AS day,recipe,sum(batches)::int batches,sum(total_kg)::float kg
         FROM mix_batches WHERE tenant_id=$1 AND device_id=ANY($2::uuid[]) AND finished_at>=$3 AND finished_at<$4
         GROUP BY 1,2`,
        [tenantId, ids, start, end],
      ),
      db.query<{ day: string; label: string; kg: number }>(
        `SELECT ${PLANT_DAY('b.finished_at')} AS day,m->>'label' label,sum((m->>'kg')::float)::float kg
         FROM mix_batches b CROSS JOIN LATERAL jsonb_array_elements(b.materials) m
         WHERE b.tenant_id=$1 AND b.device_id=ANY($2::uuid[]) AND b.finished_at>=$3 AND b.finished_at<$4
         GROUP BY 1,2`,
        [tenantId, ids, start, end],
      ),
      db
        .query<{ label: string; price_per_ton: number }>(
          'SELECT label,price_per_ton::float price_per_ton FROM mortar_material_prices WHERE tenant_id=$1',
          [tenantId],
        )
        .catch(() => ({ rows: [] as Array<{ label: string; price_per_ton: number }> })),
      // When the line produces: bags by weekday and hour, over the days that had production.
      db.query<{ weekday: number; hour: number; bags: number; days: number }>(
        `SELECT extract(isodow FROM bucket - interval '3 hours')::int AS weekday,
                extract(hour FROM bucket - interval '3 hours')::int AS hour,
                sum(bags)::float bags,
                count(DISTINCT ${PLANT_DAY('bucket')})::int days
         FROM bagging_buckets WHERE tenant_id=$1 AND device_id=ANY($2::uuid[]) AND bucket>=$3 AND bucket<$4
         GROUP BY 1,2`,
        [tenantId, ids, start, end],
      ),
      // The whole year of the period's end, a day per cell.
      db.query<{ day: string; recipe: string; bags: number }>(
        `SELECT ${PLANT_DAY('bucket')} AS day,recipe,sum(bags)::float bags
         FROM bagging_buckets WHERE tenant_id=$1 AND device_id=ANY($2::uuid[]) AND bucket>=$3 AND bucket<$4
         GROUP BY 1,2`,
        [tenantId, ids, yearStart, yearEnd],
      ),
      db.query<{ id: string; device_id: string; name: string; position: number }>(
        'SELECT id,device_id,name,position FROM bagging_spouts WHERE tenant_id=$1 AND device_id=ANY($2::uuid[]) ORDER BY position',
        [tenantId, ids],
      ),
      db.query<{
        device_id: string;
        target_metric: 'bags' | 'tons' | null;
        target_per_shift: number | null;
      }>(
        'SELECT device_id,target_metric,target_per_shift FROM mortar_settings WHERE tenant_id=$1 AND device_id=ANY($2::uuid[])',
        [tenantId, ids],
      ),
      db
        .query<{ product_id: string; bags: number; as_of: string }>(
          `SELECT product_id,bags::float bags,to_char(as_of,'YYYY-MM-DD') as_of FROM mortar_stock_opening WHERE tenant_id=$1`,
          [tenantId],
        )
        .catch(() => ({ rows: [] as Array<{ product_id: string; bags: number; as_of: string }> })),
    ]);

    const product = new Map(links.rows.map((row) => [row.recipe, row]));
    const nameOf = (recipe: string) => product.get(recipe)?.name ?? recipe;
    const kgOf = (recipe: string, bags: number) => bags * (product.get(recipe)?.nominal_kg ?? 0);
    const group = query.group as Group;
    const slots = slotsOf(from, to, group);
    const index = new Map(slots.map((slot, at) => [slot, at]));

    // The target of each day: the target per shift times the shifts the plant ran that day.
    const shiftsBySite = new Map<string, Awaited<ReturnType<typeof loadShifts>>>();
    for (const line of chosen)
      if (!shiftsBySite.has(line.site_id))
        shiftsBySite.set(line.site_id, await loadShifts(db, tenantId, line.site_id));
    const dayTarget = new Map<string, { bags: number; kg: number }>();
    for (const line of chosen) {
      const own = settings.rows.find((row) => row.device_id === line.id);
      if (!own?.target_per_shift) continue;
      const occurrences = expandShifts(shiftsBySite.get(line.site_id)!.shifts, from, to);
      for (const occurrence of occurrences) {
        const entry = dayTarget.get(occurrence.productionDate) ?? { bags: 0, kg: 0 };
        if (own.target_metric === 'tons') entry.kg += Number(own.target_per_shift) * 1000;
        else entry.bags += Number(own.target_per_shift);
        dayTarget.set(occurrence.productionDate, entry);
      }
    }

    type Slot = {
      slot: string;
      bags: number;
      kg: number;
      products: Record<string, number>;
      running: number;
      idle: number;
      expected: number;
      rated: number;
      stops: number;
      stopSeconds: number;
      batches: number;
      mixedKg: number;
      days: number;
      targetBags: number;
      targetKg: number;
      daysHit: number;
      daysWithTarget: number;
    };
    const empty = (slot: string): Slot => ({
      slot,
      bags: 0,
      kg: 0,
      products: {},
      running: 0,
      idle: 0,
      expected: 0,
      rated: 0,
      stops: 0,
      stopSeconds: 0,
      batches: 0,
      mixedKg: 0,
      days: 0,
      targetBags: 0,
      targetKg: 0,
      daysHit: 0,
      daysWithTarget: 0,
    });
    const series = slots.map(empty);
    const byDay = new Map<string, { bags: number; kg: number }>();
    const productTotals = new Map<string, { bags: number; kg: number }>();
    const spoutTotals = new Map<
      string,
      {
        bags: number;
        kg: number;
        running: number;
        idle: number;
        expected: number;
        rated: number;
        stops: number;
        stopSeconds: number;
        slots: Record<
          string,
          { running: number; idle: number; expected: number; rated: number; bags: number }
        >;
      }
    >();
    const producedByProduct = new Map<string, number[]>();

    for (const row of buckets.rows) {
      const at = index.get(slotOf(row.day, group));
      if (at == null) continue;
      const slot = series[at];
      const bags = Number(row.bags);
      const kg = kgOf(row.recipe, bags);
      const name = nameOf(row.recipe);
      slot.bags += bags;
      slot.kg += kg;
      slot.products[name] = (slot.products[name] ?? 0) + bags;
      slot.running += Number(row.running);
      slot.idle += Number(row.idle);
      const rate = product.get(row.recipe)?.standard_rate;
      if (rate) {
        slot.expected += (Number(row.running) / 3600) * Number(rate);
        slot.rated += bags;
      }
      const dayEntry = byDay.get(row.day) ?? { bags: 0, kg: 0 };
      dayEntry.bags += bags;
      dayEntry.kg += kg;
      byDay.set(row.day, dayEntry);
      const totals = productTotals.get(name) ?? { bags: 0, kg: 0 };
      totals.bags += bags;
      totals.kg += kg;
      productTotals.set(name, totals);
      const spout = spoutTotals.get(row.spout_id) ?? {
        bags: 0,
        kg: 0,
        running: 0,
        idle: 0,
        expected: 0,
        rated: 0,
        stops: 0,
        stopSeconds: 0,
        slots: {},
      };
      spout.bags += bags;
      spout.kg += kg;
      spout.running += Number(row.running);
      spout.idle += Number(row.idle);
      const own = spout.slots[slot.slot] ?? { running: 0, idle: 0, expected: 0, rated: 0, bags: 0 };
      own.running += Number(row.running);
      own.idle += Number(row.idle);
      own.bags += bags;
      if (rate) {
        spout.expected += (Number(row.running) / 3600) * Number(rate);
        spout.rated += bags;
        own.expected += (Number(row.running) / 3600) * Number(rate);
        own.rated += bags;
      }
      spout.slots[slot.slot] = own;
      spoutTotals.set(row.spout_id, spout);
      const produced = producedByProduct.get(name) ?? slots.map(() => 0);
      produced[at] += bags;
      producedByProduct.set(name, produced);
    }
    for (const row of stops.rows) {
      const at = index.get(slotOf(row.day, group));
      if (at == null) continue;
      series[at].stops += Number(row.stops);
      series[at].stopSeconds += Number(row.seconds);
      const spout = spoutTotals.get(row.spout_id);
      if (spout) {
        spout.stops += Number(row.stops);
        spout.stopSeconds += Number(row.seconds);
      }
    }
    for (const row of mix.rows) {
      const at = index.get(slotOf(row.day, group));
      if (at == null) continue;
      series[at].batches += Number(row.batches);
      series[at].mixedKg += Number(row.kg);
    }
    for (const [date, produced] of byDay) {
      const at = index.get(slotOf(date, group));
      if (at == null || produced.bags <= 0) continue;
      series[at].days += 1;
      const target = dayTarget.get(date);
      if (target && (target.bags || target.kg)) {
        series[at].daysWithTarget += 1;
        series[at].targetBags += target.bags;
        series[at].targetKg += target.kg;
        const hit =
          (target.bags ? produced.bags >= target.bags : true) &&
          (target.kg ? produced.kg >= target.kg : true);
        if (hit) series[at].daysHit += 1;
      }
    }
    // Days with a target and no production also missed it.
    for (const [date, target] of dayTarget) {
      if (byDay.has(date) || date > plantDate(new Date())) continue;
      const at = index.get(slotOf(date, group));
      if (at == null) continue;
      series[at].daysWithTarget += 1;
      series[at].targetBags += target.bags;
      series[at].targetKg += target.kg;
    }

    const efficiencyOf = (row: {
      running: number;
      idle: number;
      expected: number;
      rated: number;
    }) => {
      const availability =
        row.running + row.idle > 0 ? row.running / (row.running + row.idle) : null;
      const performance = row.expected > 0 ? row.rated / row.expected : null;
      return {
        availability,
        performance,
        effectiveness:
          availability != null && performance != null ? availability * performance : null,
      };
    };

    // Totals of the period.
    const sum = (key: keyof Slot) =>
      series.reduce(
        (total, row) => total + (typeof row[key] === 'number' ? (row[key] as number) : 0),
        0,
      );
    const producedDays = [...byDay.entries()].filter(([, value]) => value.bags > 0);
    const best = producedDays.sort((a, b) => b[1].bags - a[1].bags)[0] ?? null;
    const totalBags = sum('bags');
    const totalKg = sum('kg');
    const materialTotals = new Map<string, number>();
    for (const row of materials.rows)
      materialTotals.set(row.label, (materialTotals.get(row.label) ?? 0) + Number(row.kg));
    const price = new Map(prices.rows.map((row) => [row.label, Number(row.price_per_ton)]));
    const cost = [...materialTotals.entries()].reduce(
      (total, [label, kg]) => total + (kg / 1000) * (price.get(label) ?? 0),
      0,
    );
    const mixedKg = sum('mixedKg');

    // Products ranked, with the ABC class: A until 80 % of the bags, B until 95 %, C the rest.
    let running = 0;
    const products = [...productTotals.entries()]
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.bags - a.bags)
      .map((item) => {
        running += item.bags;
        const cumulative = totalBags ? running / totalBags : 0;
        return {
          ...item,
          share: totalBags ? item.bags / totalBags : 0,
          cumulative,
          abc:
            cumulative - item.bags / Math.max(1, totalBags) < 0.8
              ? 'A'
              : cumulative - item.bags / Math.max(1, totalBags) < 0.95
                ? 'B'
                : 'C',
        };
      });

    // Stock: the opening balance, plus what was bagged between it and the period, plus the period.
    const stock: Array<{ name: string; opening: number; series: number[] }> = [];
    const openingByName = new Map<string, { bags: number; asOf: string }>();
    for (const row of opening.rows) {
      const link = links.rows.find((item) => item.product_id === row.product_id);
      if (link) openingByName.set(link.name, { bags: Number(row.bags), asOf: row.as_of });
    }
    const before = new Map<string, number>();
    const asOfs = [...openingByName.values()]
      .map((item) => item.asOf)
      .filter((date) => date < from);
    if (asOfs.length) {
      const earliest = asOfs.sort()[0];
      const between = await db.query<{ day: string; recipe: string; bags: number }>(
        `SELECT ${PLANT_DAY('bucket')} AS day,recipe,sum(bags)::float bags FROM bagging_buckets
         WHERE tenant_id=$1 AND device_id=ANY($2::uuid[]) AND bucket>=$3 AND bucket<$4 GROUP BY 1,2`,
        [tenantId, ids, plantInstant(earliest, '00:00'), start],
      );
      for (const row of between.rows) {
        const name = nameOf(row.recipe);
        const asOf = openingByName.get(name)?.asOf;
        if (asOf && row.day >= asOf) before.set(name, (before.get(name) ?? 0) + Number(row.bags));
      }
    }
    for (const name of new Set([...producedByProduct.keys(), ...openingByName.keys()])) {
      const open = openingByName.get(name);
      // An opening dated inside the period starts counting from its own day.
      const openingBags = open && open.asOf <= to ? open.bags : 0;
      let level = openingBags + (before.get(name) ?? 0);
      const produced = producedByProduct.get(name) ?? slots.map(() => 0);
      stock.push({
        name,
        opening: openingBags,
        series: produced.map((bags) => (level += bags)),
      });
    }
    stock.sort((a, b) => (b.series.at(-1) ?? 0) - (a.series.at(-1) ?? 0));

    // The heat map: average bags in each weekday and hour, over the days that produced.
    const heatmap = heat.rows.map((row) => ({
      weekday: Number(row.weekday),
      hour: Number(row.hour),
      bags: Number(row.days) ? Number(row.bags) / Number(row.days) : 0,
    }));
    const calendarDays = new Map<string, number>();
    for (const row of calendar.rows)
      calendarDays.set(row.day, (calendarDays.get(row.day) ?? 0) + Number(row.bags));

    const lineName = new Map(chosen.map((line) => [line.id, line.name]));
    return {
      from,
      to,
      group,
      lines: chosen,
      totals: {
        bags: totalBags,
        kg: totalKg,
        days: producedDays.length,
        perDay: producedDays.length ? totalBags / producedDays.length : 0,
        best: best ? { day: best[0], bags: best[1].bags, kg: best[1].kg } : null,
        daysHit: sum('daysHit'),
        daysWithTarget: sum('daysWithTarget'),
        targetBags: sum('targetBags'),
        targetKg: sum('targetKg'),
        ...efficiencyOf({
          running: sum('running'),
          idle: sum('idle'),
          expected: sum('expected'),
          rated: sum('rated'),
        }),
        stops: sum('stops'),
        stopSeconds: sum('stopSeconds'),
        batches: sum('batches'),
        mixedKg,
        cost: price.size ? cost : null,
        costPerTon: price.size && mixedKg ? cost / (mixedKg / 1000) : null,
      },
      series: series.map((row) => ({
        slot: row.slot,
        bags: row.bags,
        kg: row.kg,
        products: row.products,
        days: row.days,
        targetBags: row.targetBags,
        targetKg: row.targetKg,
        daysHit: row.daysHit,
        daysWithTarget: row.daysWithTarget,
        stops: row.stops,
        stopSeconds: row.stopSeconds,
        batches: row.batches,
        mixedKg: row.mixedKg,
        ...efficiencyOf(row),
        top: Object.entries(row.products).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      })),
      products,
      spouts: spouts.rows
        .map((spout) => {
          const own = spoutTotals.get(spout.id);
          return {
            id: spout.id,
            name:
              chosen.length > 1 ? `${lineName.get(spout.device_id)} · ${spout.name}` : spout.name,
            bags: own?.bags ?? 0,
            kg: own?.kg ?? 0,
            stops: own?.stops ?? 0,
            stopSeconds: own?.stopSeconds ?? 0,
            pacePerHour: own && own.running > 0 ? own.bags / (own.running / 3600) : null,
            ...efficiencyOf(own ?? { running: 0, idle: 0, expected: 0, rated: 0 }),
            series: slots.map((slot) => {
              const point = own?.slots[slot];
              return {
                bags: point?.bags ?? 0,
                ...efficiencyOf(point ?? { running: 0, idle: 0, expected: 0, rated: 0 }),
              };
            }),
          };
        })
        .sort((a, b) => b.bags - a.bags),
      materials: [...materialTotals.entries()]
        .map(([label, kg]) => ({
          label,
          kg,
          pricePerTon: price.get(label) ?? null,
          cost: price.has(label) ? (kg / 1000) * (price.get(label) ?? 0) : null,
          perTonBagged: totalKg ? (kg / totalKg) * 1000 : null,
        }))
        .sort((a, b) => b.kg - a.kg),
      recipes: Object.values(
        mix.rows.reduce<Record<string, { recipe: string; batches: number; kg: number }>>(
          (acc, row) => {
            const entry = acc[row.recipe] ?? { recipe: row.recipe, batches: 0, kg: 0 };
            entry.batches += Number(row.batches);
            entry.kg += Number(row.kg);
            acc[row.recipe] = entry;
            return acc;
          },
          {},
        ),
      ).sort((a, b) => b.kg - a.kg),
      stock,
      heatmap,
      calendar: [...calendarDays.entries()].map(([date, bags]) => ({ date, bags })),
    };
  });

  // The opening stock of each product (masters set it; everyone with mortar lines reads it).
  app.get('/api/mortar/stock-opening', async (req) => {
    const rows = await db
      .query<{
        product_id: string;
        name: string;
        nominal_kg: number;
        bags: number | null;
        as_of: string | null;
      }>(
        `SELECT p.id product_id,p.name,p.nominal_kg::float nominal_kg,o.bags::float bags,
                to_char(o.as_of,'YYYY-MM-DD') as_of
         FROM mortar_products p LEFT JOIN mortar_stock_opening o ON o.product_id=p.id AND o.tenant_id=p.tenant_id
         WHERE p.tenant_id=$1 ORDER BY p.name`,
        [access.principal(req).tenantId],
      )
      .catch(() => ({ rows: [] }));
    return { products: rows.rows };
  });
  app.put('/api/mortar/stock-opening', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const body = z
      .object({
        items: z
          .array(
            z.object({ productId: z.uuid(), bags: z.number().min(0).max(100_000_000), asOf: day }),
          )
          .max(200),
      })
      .parse(req.body);
    await db.transaction(async (sql) => {
      for (const item of body.items)
        await sql.query(
          `INSERT INTO mortar_stock_opening(tenant_id,product_id,bags,as_of,updated_at)
           SELECT $1,id,$3,$4,now() FROM mortar_products WHERE tenant_id=$1 AND id=$2
           ON CONFLICT(tenant_id,product_id) DO UPDATE SET bags=EXCLUDED.bags,as_of=EXCLUDED.as_of,updated_at=now()`,
          [current.tenantId, item.productId, item.bags, item.asOf],
        );
      await recordAudit(sql, req, current, {
        action: 'mortar.stock_opening',
        targetType: 'tenant',
        targetId: current.tenantId,
        summary: { items: body.items.length },
      });
    });
    return { ok: true };
  });
}
