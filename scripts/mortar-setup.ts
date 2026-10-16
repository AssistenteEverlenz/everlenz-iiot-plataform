// Configures a mortar device from what its HMI already publishes: the variables, the spouts and
// the mixer, and loads the mortar panel model on its dashboard (a snapshot is kept, so the old
// panel can be restored from "Versões do painel").
//
//   npx -y pnpm@10.28.2 exec tsx scripts/mortar-setup.ts EVL-WEI-03FC2D75
//
// It reads the names the platform documents for mortar (docs: production variables):
//   Pacotes<bico>, Produto<bico>, Habilita<bico>, Ligada<bico>  -> one spout per <bico>
//   ContagemBateladas, ReceitaAtual, PesoBalanca, PesoDesejado<material> -> the mixer
// Running it again is harmless: spouts are kept by name, so their history stays.
import type { Database } from '../packages/database/src/index.js';
import { createApp } from '../apps/api/src/app.js';

/** The spouts of the bagger in the order the plant names them, left to right. */
const SPOUT_ORDER = ['LE', 'CT', 'LD'];
const MATERIAL_NAMES: Record<string, string> = {
  Areia: 'Areia',
  Cimento: 'Cimento',
  Bag02: 'Porta bag 02',
  Cal: 'Cal / complemento',
};

export async function setupMortarDevice(db: Database, deviceCode: string) {
  const device = (
    await db.query<{ id: string; tenant_id: string; name: string }>(
      'SELECT id,tenant_id,name FROM devices WHERE upper(device_code)=upper($1) AND archived_at IS NULL',
      [deviceCode],
    )
  ).rows[0];
  if (!device) throw new Error(`Equipamento ${deviceCode} não encontrado`);
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
    // Every variable the HMI has sent becomes a tag, so cards and settings can point at it.
    const signals = (
      await db.query<{ key: string; inferred_type: string }>(
        'SELECT key,inferred_type FROM device_signal_catalog WHERE device_id=$1 ORDER BY key',
        [device.id],
      )
    ).rows;
    if (!signals.length) throw new Error('A IHM ainda não enviou nenhuma variável');
    const tagOf = new Map<string, string>();
    for (const signal of signals) {
      const dataType = ['number', 'boolean', 'string'].includes(signal.inferred_type)
        ? signal.inferred_type
        : 'string';
      const tag = await call<{ id: string }>('POST', `/api/devices/${device.id}/tags`, {
        key: signal.key,
        name: signal.key.replace(/([a-z])([A-Z])/g, '$1 $2'),
        dataType,
        unit: /^Pacotes/.test(signal.key)
          ? 'un'
          : /^Toneladas/.test(signal.key)
            ? 't'
            : /^Peso/.test(signal.key)
              ? 'kg'
              : null,
      });
      tagOf.set(signal.key, tag.id);
    }
    const tag = (key: string) => tagOf.get(key) ?? null;

    // Spouts: one per Pacotes<name>, kept by name so a second run keeps their history.
    const existing = (
      await db.query<{ id: string; name: string }>(
        'SELECT id,name FROM bagging_spouts WHERE device_id=$1',
        [device.id],
      )
    ).rows;
    const names = signals
      .map((signal) => /^Pacotes(.+)$/.exec(signal.key)?.[1])
      .filter((name): name is string => !!name)
      .sort((a, b) => {
        const rank = (name: string) => {
          const at = SPOUT_ORDER.indexOf(name.toUpperCase());
          return at < 0 ? SPOUT_ORDER.length : at;
        };
        return rank(a) - rank(b) || a.localeCompare(b);
      });
    const spouts = names.map((name) => ({
      id: existing.find((spout) => spout.name === name)?.id,
      name,
      countTagId: tag(`Pacotes${name}`),
      recipeTagId: tag(`Produto${name}`),
      runningTagId: tag(`Ligada${name}`),
      enabledTagId: tag(`Habilita${name}`),
    }));

    // The mixer, when its batch counter is published.
    const materials = signals
      .map((signal) => /^PesoDesejado(.+)$/.exec(signal.key)?.[1])
      .filter((name): name is string => !!name && name !== 'Total' && name !== 'TotalBatelada')
      .sort((a, b) => {
        const rank = (name: string) => {
          const at = Object.keys(MATERIAL_NAMES).indexOf(name);
          return at < 0 ? 99 : at;
        };
        return rank(a) - rank(b) || a.localeCompare(b);
      })
      .map((name) => ({ label: MATERIAL_NAMES[name] ?? name, tagId: tag(`PesoDesejado${name}`) }));
    const mixEnabled = !!tag('ContagemBateladas');
    const settings = {
      mixEnabled,
      recipeTagId: tag('ReceitaAtual'),
      batchCountTagId: tag('ContagemBateladas'),
      scaleTagId: tag('PesoBalanca'),
      materials: mixEnabled ? materials : [],
      baggingEnabled: spouts.length > 0,
      idleSeconds: 120,
      spouts,
    };
    await call('PUT', `/api/devices/${device.id}/mortar/settings`, settings);

    // The panel: the mortar model, with a snapshot of the panel it replaces.
    const dashboard = (
      await db.query<{ id: string }>(
        'SELECT id FROM dashboards WHERE device_id=$1 ORDER BY created_at LIMIT 1',
        [device.id],
      )
    ).rows[0];
    const panel = dashboard
      ? await call('POST', `/api/dashboards/${dashboard.id}/template/apply`)
      : null;

    return {
      device: device.name,
      tags: tagOf.size,
      spouts: spouts.map((spout) => ({
        name: spout.name,
        count: !!spout.countTagId,
        product: !!spout.recipeTagId,
        enabled: !!spout.enabledTagId,
        running: !!spout.runningTagId,
      })),
      mixer: mixEnabled
        ? { recipe: !!settings.recipeTagId, scale: !!settings.scaleTagId, materials: materials.map((m) => m.label) }
        : 'sem ContagemBateladas: o misturador fica desligado até ela chegar',
      panel,
    };
  } finally {
    await app.close();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/mortar-setup.ts')) {
  const code = process.argv[2];
  if (!code) throw new Error('Informe o código do equipamento, ex.: EVL-WEI-03FC2D75');
  const { database } = await import('../packages/database/src/index.js');
  console.log(JSON.stringify(await setupMortarDevice(database, code), null, 2));
  process.exit(0);
}
