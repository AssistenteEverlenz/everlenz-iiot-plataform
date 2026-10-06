import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL, GENERIC } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';

/**
 * The model and the snapshots carry the panel's tabs (migration 036). The first version kept
 * only the cards: a model saved on Campo Forte, with its cards split into tabs, landed on
 * Capixaba as one long list. Read back from the panel after every apply.
 */
const json = (response: { body: string }) => JSON.parse(response.body);

describe('modelo e snapshot com abas', () => {
  it('a model applied to another panel brings its tabs, each card on its own', async () => {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
    const source = (
      await db.query<{ id: string }>('SELECT id FROM dashboards WHERE tenant_id=$1 AND device_id=$2', [
        TENANT,
        HAIWELL,
      ])
    ).rows[0].id;
    const target = (
      await db.query<{ id: string }>(
        `INSERT INTO dashboards(tenant_id,device_id,name,slug,refresh_ms,time_window_minutes)
         VALUES($1,$2,'Capixaba','capixaba',2000,60) RETURNING id`,
        [TENANT, GENERIC],
      )
    ).rows[0].id;

    const tab = async (panel: string, name: string) =>
      json(await api.inject({ method: 'POST', url: `/api/dashboards/${panel}/tabs`, payload: { name } }))
        .id as string;
    const card = async (panel: string, device: string, title: string, tabId: string | null) => {
      const id = json(
        await api.inject({
          method: 'POST',
          url: `/api/dashboards/${panel}/widgets`,
          payload: { deviceId: device, widgetType: 'value', title, width: 'small' },
        }),
      ).id as string;
      if (tabId)
        await api.inject({
          method: 'PATCH',
          url: `/api/dashboards/${panel}/widgets/${id}`,
          payload: { tabId },
        });
      return id;
    };
    const layout = async (panel: string) => {
      const view = json(await api.inject(`/api/dashboards/${panel}`)) as {
        tabs: Array<{ id: string; name: string }>;
        widgets: Array<{ title: string; tab_id: string | null }>;
      };
      const name = new Map(view.tabs.map((item) => [item.id, item.name]));
      return {
        tabs: view.tabs.map((item) => item.name),
        cards: Object.fromEntries(
          view.widgets.map((widget) => [widget.title, widget.tab_id ? name.get(widget.tab_id) : null]),
        ),
      };
    };

    // Campo Forte: two tabs, a card on each (the seed's sample cards out of the way).
    await db.query('DELETE FROM dashboard_widgets WHERE dashboard_id=$1', [source]);
    const operation = await tab(source, 'Operação');
    const charts = await tab(source, 'Gráficos');
    await card(source, HAIWELL, 'Peças', operation);
    await card(source, HAIWELL, 'Ritmo', charts);
    const expected = { tabs: ['Operação', 'Gráficos'], cards: { Peças: 'Operação', Ritmo: 'Gráficos' } };
    expect(await layout(source)).toEqual(expected);

    // Saved as the model, applied to Capixaba, which had a tab and a card of its own.
    await tab(target, 'Antiga');
    await card(target, GENERIC, 'Velha', null);
    expect((await api.inject({ method: 'POST', url: `/api/dashboards/${source}/template` })).statusCode).toBe(200);
    const applied = await api.inject({ method: 'POST', url: `/api/dashboards/${target}/template/apply` });
    expect(applied.statusCode).toBe(200);
    expect(await layout(target)).toEqual(expected);

    // A snapshot of Campo Forte restored after its tabs were changed puts them back.
    const snapshot = json(
      await api.inject({ method: 'POST', url: `/api/dashboards/${source}/snapshots`, payload: { name: 'antes' } }),
    );
    await api.inject({ method: 'DELETE', url: `/api/dashboards/${source}/tabs/${charts}` });
    expect((await layout(source)).tabs).toEqual(['Operação']);
    const restored = await api.inject({
      method: 'POST',
      url: `/api/dashboards/${source}/snapshots/${snapshot.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(await layout(source)).toEqual(expected);
    await api.close();
  }, 60_000);
});
