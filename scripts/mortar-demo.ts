/**
 * A mortar test client (migration 037) with thirty days of bagging and mixing, to see the
 * mortar cards with real-looking numbers before a real plant is connected.
 *
 * Everything that has an API goes through it -- the client, the device, its variables, the
 * mortar settings, the products and the cards -- so the demo is built by the same rules as a
 * real registration. Only the history is written directly, since it would otherwise take a
 * month of messages. Running it again removes the previous demo client first.
 *
 *   DATABASE_URL=... DEV_TENANT_ID=... npx tsx scripts/mortar-demo.ts
 */
import type { Database } from '../packages/database/src/index.js';
import { createApp } from '../apps/api/src/app.js';

export const DEMO_REFERENCE = 'ARG-DEMO';
const BUCKET_MS = 300_000;

/** A small deterministic random, so the demo looks the same every time it is built. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const PRODUCTS = [
  { name: 'AC-I 20kg', nominal: 20, mix: 'AC-I' },
  { name: 'AC-II 20kg', nominal: 20, mix: 'AC-II' },
  { name: 'AC-III 20kg', nominal: 20, mix: 'AC-III' },
  { name: 'Reboco 25kg', nominal: 25, mix: 'REBOCO' },
  { name: 'Contrapiso 40kg', nominal: 40, mix: 'CONTRAPISO' },
];
const SPOUTS = ['LE', 'CT', 'LD'];
/** The share of each material in a batch of each mix recipe: sand, cement, complement. */
const MIX: Record<string, [number, number, number]> = {
  'AC-I': [0.76, 0.17, 0.07],
  'AC-II': [0.73, 0.19, 0.08],
  'AC-III': [0.7, 0.21, 0.09],
  REBOCO: [0.8, 0.12, 0.08],
  CONTRAPISO: [0.84, 0.13, 0.03],
};
const BATCH_KG = 2000;

export async function seedMortarDemo(db: Database, tenantId: string, days = 30) {
  const app = await createApp(db, { tenantId, operatorRaw: false, authRequired: false });
  const call = async <T = Record<string, unknown>>(
    method: string,
    url: string,
    payload?: unknown,
  ) => {
    const response = await app.inject({ method: method as 'GET', url, payload: payload as object });
    if (response.statusCode >= 300)
      throw new Error(`${method} ${url} → ${response.statusCode} ${response.body.slice(0, 300)}`);
    return (response.body ? JSON.parse(response.body) : null) as T;
  };

  // Start over: the previous demo client and everything under it.
  const previous = await db.query<{ id: string }>(
    'SELECT id FROM sites WHERE tenant_id=$1 AND reference=$2',
    [tenantId, DEMO_REFERENCE],
  );
  for (const site of previous.rows) {
    const devices = await db.query<{ id: string }>('SELECT id FROM devices WHERE site_id=$1', [
      site.id,
    ]);
    for (const device of devices.rows)
      await call('DELETE', `/api/devices/${device.id}?purge=true`).catch(() => null);
  }

  const site =
    previous.rows[0] ??
    (await call<{ id: string }>('POST', '/api/sites', {
      name: 'Argamassas Demonstração',
      reference: DEMO_REFERENCE,
      segment: 'argamassa',
    }));
  await call('PATCH', `/api/sites/${site.id}/segment`, { segment: 'argamassa' });
  // The response carries the MQTT password once; the demo never connects, so it is dropped.
  const created = await call<{ device: { id: string }; dashboardId: string }>(
    'POST',
    '/api/devices',
    {
      siteId: site.id,
      name: 'Linha de Argamassa',
      manufacturer: 'Weintek',
      model: 'cMT2108X',
    },
  );
  const deviceId = created.device.id;
  const dashboardId = created.dashboardId;
  // The tenant's panel model is a ceramic one: a mortar line starts with only its own cards.
  await db.query('DELETE FROM dashboard_widgets WHERE tenant_id=$1 AND dashboard_id=$2', [
    tenantId,
    dashboardId,
  ]);

  // The variables the cMT publishes, named the way the HMI screens name them.
  const tag = async (key: string, name: string, dataType: string, unit: string | null = null) =>
    (
      await call<{ id: string }>('POST', `/api/devices/${deviceId}/tags`, {
        key,
        name,
        dataType,
        unit,
      })
    ).id;
  const tags = {
    recipe: await tag('ReceitaAtual', 'Receita atual no CLP', 'string'),
    batches: await tag('ContagemBateladas', 'Contagem de bateladas atual', 'number', 'un'),
    scale: await tag('PesoBalanca', 'Peso na balança', 'number', 'kg'),
    total: await tag('PesoTotalDesejado', 'Peso total desejado batelada', 'number', 'kg'),
    sand: await tag('PesoDesejadoAreia', 'Peso desejado areia', 'number', 'kg'),
    cement: await tag('PesoDesejadoCimento', 'Peso desejado porta bag cimento', 'number', 'kg'),
    complement: await tag('PesoDesejadoBag02', 'Peso desejado porta bag 02', 'number', 'kg'),
    mixTime: await tag('TempoMistura', 'Tempo de mistura do misturador', 'number', 's'),
    mixerCurrent: await tag('CorrenteMisturador', 'Corrente do misturador', 'number', 'A'),
  };
  const spoutTags = [];
  for (const name of SPOUTS)
    spoutTags.push({
      name,
      countTagId: await tag(`Pacotes${name}`, `Pacotes ensacadeira ${name}`, 'number', 'un'),
      recipeTagId: await tag(`Produto${name}`, `Produto ensacadeira ${name}`, 'string'),
      enabledTagId: await tag(`Habilita${name}`, `Habilita ensacadeira ${name}`, 'boolean'),
      runningTagId: await tag(`Ligada${name}`, `Ensacadeira ${name} ligada`, 'boolean'),
    });

  await call('PUT', `/api/devices/${deviceId}/mortar/settings`, {
    mixEnabled: true,
    recipeTagId: tags.recipe,
    batchCountTagId: tags.batches,
    scaleTagId: tags.scale,
    materials: [
      { label: 'Areia', tagId: tags.sand },
      { label: 'Cimento', tagId: tags.cement },
      { label: 'Cal / complemento', tagId: tags.complement },
    ],
    baggingEnabled: true,
    idleSeconds: 120,
    spouts: spoutTags,
  });
  const spouts = (
    await db.query<{ id: string; name: string }>(
      'SELECT id,name FROM bagging_spouts WHERE device_id=$1 ORDER BY position',
      [deviceId],
    )
  ).rows;

  // Products, and each spout's own recipe for it, as the bagging HMI saves them.
  const catalog = await call<{ products: Array<{ id: string; name: string }> }>(
    'GET',
    '/api/mortar/products',
  );
  for (const product of PRODUCTS) {
    const existing = catalog.products.find((item) => item.name === product.name);
    const id =
      existing?.id ??
      (
        await call<{ id: string }>('POST', '/api/mortar/products', {
          name: product.name,
          nominalKg: product.nominal,
        })
      ).id;
    for (const spout of SPOUTS)
      await call('PUT', '/api/mortar/recipes', {
        recipe: `${product.name.toUpperCase()} ${spout}`,
        productId: id,
      });
  }

  // Thirty days of history: Monday to Saturday, 07:00 to 17:00 with lunch at 11:00.
  const rand = random(37);
  const now = Date.now();
  const offset = 3 * 3600_000;
  const today = Math.floor((now - offset) / 86_400_000) * 86_400_000 + offset;
  const buckets: unknown[][] = [];
  const batches: unknown[][] = [];
  for (let day = days - 1; day >= 0; day -= 1) {
    const midnight = today - day * 86_400_000;
    const weekday = new Date(midnight - offset).getUTCDay();
    if (weekday === 0) continue;
    const saturday = weekday === 6;
    // Each spout runs one or two products a day; the right spout often stays off on Saturdays.
    // Each spout runs one to three products a day, changing at fixed hours; yesterday every
    // spout ran three, to show a day with several products. The right spout often stays off
    // on Saturdays. Each spout has its own pace (the left one is the best tuned).
    const yesterday = day === 1;
    const plan = SPOUTS.map((_, index) => {
      const count = yesterday ? 3 : 1 + Math.floor(rand() * 3);
      const start = Math.floor(rand() * PRODUCTS.length);
      const products = Array.from(
        { length: count },
        (_, at) => PRODUCTS[(start + at * 2 + index) % PRODUCTS.length],
      );
      return {
        products,
        // The hours the spout changes product: after 09:30, after lunch, at 15:00.
        changes: count === 3 ? [9.5, 14] : count === 2 ? [12] : [],
        off: !yesterday && index === 2 && (saturday || rand() < 0.15),
        pace: [4.5, 4.1, 3.7][index] * (0.95 + rand() * 0.1),
      };
    });
    const end = saturday ? 12 : 17;
    let mixCarry = 0;
    let mixRecipe = plan[0].products[0].mix;
    for (let at = midnight + 7 * 3600_000; at < midnight + end * 3600_000; at += BUCKET_MS) {
      if (at > now - BUCKET_MS) break;
      const hour = (at - midnight) / 3600_000;
      if (hour >= 11 && hour < 12) continue;
      let bucketKg = 0;
      for (const [index, spout] of spouts.entries()) {
        const spoutPlan = plan[index];
        const product =
          spoutPlan.products[spoutPlan.changes.filter((change) => hour >= change).length];
        const recipe = `${product.name.toUpperCase()} ${spout.name}`;
        if (spoutPlan.off) {
          buckets.push([tenantId, deviceId, spout.id, new Date(at), recipe, 0, 0, 0, 300]);
          continue;
        }
        // Mostly filling, with the odd stretch waiting for bags, pallets or the silo.
        const stopped = rand() < 0.12 ? 120 + rand() * 180 : rand() * 25;
        const running = 300 - stopped;
        // A heavier bag takes longer to fill: 40 kg runs at about 70 % of the pace of 20 kg.
        const pace = spoutPlan.pace * Math.sqrt(20 / product.nominal);
        const bags = Math.round((running / 60) * pace * (0.92 + rand() * 0.16));
        buckets.push([
          tenantId,
          deviceId,
          spout.id,
          new Date(at),
          recipe,
          bags,
          running,
          stopped,
          0,
        ]);
        bucketKg += bags * product.nominal;
        mixRecipe = product.mix;
      }
      // The mixer keeps the silo a little ahead of the bagging: about 1.5 % more goes in.
      mixCarry += bucketKg * 1.015;
      while (mixCarry >= BATCH_KG) {
        mixCarry -= BATCH_KG;
        const [sand, cement, complement] = MIX[mixRecipe];
        const materials = [
          { label: 'Areia', kg: BATCH_KG * sand },
          { label: 'Cimento', kg: BATCH_KG * cement },
          { label: 'Cal / complemento', kg: BATCH_KG * complement },
        ];
        batches.push([
          tenantId,
          deviceId,
          new Date(at + Math.floor(rand() * BUCKET_MS)),
          mixRecipe,
          JSON.stringify(materials),
          BATCH_KG,
          Math.round(BATCH_KG * (1 + (rand() - 0.4) * 0.012) * 10) / 10,
        ]);
      }
    }
  }
  const insert = async (sql: string, rows: unknown[][], width: number) => {
    for (let start = 0; start < rows.length; start += 400) {
      const chunk = rows.slice(start, start + 400);
      const values = chunk.flat();
      const tuples = chunk.map(
        (_, row) =>
          `(${Array.from({ length: width }, (_, col) => `$${row * width + col + 1}`).join(',')})`,
      );
      await db.query(sql.replace('%VALUES%', tuples.join(',')), values);
    }
  };
  await insert(
    `INSERT INTO bagging_buckets(tenant_id,device_id,spout_id,bucket,recipe,bags,running_s,idle_s,off_s)
     VALUES %VALUES% ON CONFLICT(spout_id,bucket,recipe) DO NOTHING`,
    buckets,
    9,
  );
  await insert(
    `INSERT INTO mix_batches(tenant_id,device_id,finished_at,recipe,materials,total_kg,scale_kg)
     VALUES %VALUES%`,
    batches.map((row) => [...row.slice(0, 4), row[4], row[5], row[6]]),
    7,
  );

  // What each spout is doing now: the left one filling, the centre waiting, the right one off.
  for (const [index, spout] of spouts.entries())
    await db.query(
      `INSERT INTO bagging_runtime(spout_id,tenant_id,device_id,last_at,last_count,last_increment_at,enabled,running,recipe)
       VALUES($1,$2,$3,$4,0,$5,$6,$6,$7) ON CONFLICT(spout_id) DO NOTHING`,
      [
        spout.id,
        tenantId,
        deviceId,
        new Date(now - 4000),
        new Date(now - (index === 0 ? 8_000 : 7 * 60_000)),
        index !== 2,
        `${PRODUCTS[index].name.toUpperCase()} ${spout.name}`,
      ],
    );

  // A current reading of the mixer's variables, so the plain cards have something to show and
  // the panel does not flag them as never published.
  const readings: Array<[string, string, unknown]> = [
    ['PesoBalanca', tags.scale, 1386.4],
    ['CorrenteMisturador', tags.mixerCurrent, 47.8],
    ['ReceitaAtual', tags.recipe, 'AC-II'],
    ['ContagemBateladas', tags.batches, 7],
  ];
  for (const [key, tagId, value] of readings) {
    await db.query(
      `INSERT INTO device_signal_catalog(tenant_id,device_id,key,inferred_type,sample_value,first_seen_at,last_seen_at)
       VALUES($1,$2,$3,$4,$5::jsonb,now(),now()) ON CONFLICT DO NOTHING`,
      [
        tenantId,
        deviceId,
        key,
        typeof value === 'number' ? 'number' : 'string',
        JSON.stringify(value),
      ],
    );
    await db.query(
      `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,value_text,quality)
       VALUES($1,$2,$3,$4,now(),now(),$5,$6,'good')`,
      [
        tenantId,
        site.id,
        deviceId,
        tagId,
        typeof value === 'number' ? value : null,
        typeof value === 'number' ? null : value,
      ],
    );
  }

  // The cards: the four mortar boards, and a few plain readings of the mixer.
  const card = (
    widgetType: string,
    title: string,
    width: string,
    tagId: string | null = null,
    config = {},
  ) =>
    call('POST', `/api/dashboards/${dashboardId}/widgets`, {
      deviceId,
      tagId,
      widgetType,
      title,
      width,
      config,
    });
  await card('bagging', 'Ensaque', 'full');
  await card('mortar_output', 'Produzido por produto', 'large');
  await card('mortar_yield', 'Rendimento', 'medium');
  await card('mortar_materials', 'Matéria-prima', 'full');
  await card('value', 'Peso na balança', 'small', tags.scale, { decimals: 1 });
  await card('gauge', 'Corrente do misturador', 'small', tags.mixerCurrent, {
    min: 0,
    max: 120,
    decimals: 1,
  });

  await app.close();
  return {
    siteId: site.id,
    deviceId,
    dashboardId,
    buckets: buckets.length,
    batches: batches.length,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/mortar-demo.ts')) {
  const { database } = await import('../packages/database/src/index.js');
  const tenantId = process.env.DEV_TENANT_ID;
  if (!tenantId) throw new Error('DEV_TENANT_ID is required');
  console.log(await seedMortarDemo(database, tenantId));
  process.exit(0);
}
