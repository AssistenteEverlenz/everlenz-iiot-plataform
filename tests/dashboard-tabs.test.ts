import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';

/**
 * The panel's own tabs (migration 036).
 *
 * The first version of the move answered 200 and wrote nothing: the field was accepted by the
 * schema and left out of the UPDATE, so the card jumped back to its old tab on the next
 * refresh and nothing anywhere said why. These tests read the card back after every write.
 */
async function platform() {
  const { db } = await memoryDatabase();
  await migrate(db);
  await seed(db);
  const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
  const panel = (
    await db.query<{ id: string }>('SELECT id FROM dashboards WHERE tenant_id=$1 LIMIT 1', [
      TENANT,
    ])
  ).rows[0].id;
  return { db, api, panel };
}

const body = (response: { body: string }) => JSON.parse(response.body);

async function makeTab(api: Awaited<ReturnType<typeof platform>>['api'], panel: string, name: string) {
  const made = await api.inject({
    method: 'POST',
    url: `/api/dashboards/${panel}/tabs`,
    payload: { name },
  });
  expect(made.statusCode).toBe(201);
  return body(made) as { id: string; name: string; position: number };
}

async function makeCard(api: Awaited<ReturnType<typeof platform>>['api'], panel: string) {
  const made = await api.inject({
    method: 'POST',
    url: `/api/dashboards/${panel}/widgets`,
    payload: { deviceId: HAIWELL, widgetType: 'value', title: 'Peças', width: 'small' },
  });
  expect(made.statusCode).toBe(201);
  return body(made).id as string;
}

/** The card as the server really has it, not as the answer to the write claimed. */
async function cardTab(
  api: Awaited<ReturnType<typeof platform>>['api'],
  panel: string,
  card: string,
) {
  const view = body(await api.inject({ method: 'GET', url: `/api/dashboards/${panel}` }));
  return view.widgets.find((w: { id: string }) => w.id === card)?.tab_id ?? null;
}

describe('abas do painel', () => {
  it('a panel starts with no tabs, and every card is shown without one', async () => {
    const { api, panel } = await platform();
    const card = await makeCard(api, panel);
    const view = body(await api.inject({ method: 'GET', url: `/api/dashboards/${panel}` }));
    expect(view.tabs).toEqual([]);
    expect(await cardTab(api, panel, card)).toBeNull();
  }, 30_000);

  it('keeps a card on the tab it was moved to', async () => {
    const { api, panel } = await platform();
    const first = await makeTab(api, panel, 'Operação');
    const second = await makeTab(api, panel, 'Gráficos');
    const card = await makeCard(api, panel);

    const moved = await api.inject({
      method: 'PATCH',
      url: `/api/dashboards/${panel}/widgets/${card}`,
      payload: { tabId: second.id },
    });
    expect(moved.statusCode).toBe(200);
    // Read back: the bug this test exists for answered 200 and changed nothing.
    expect(await cardTab(api, panel, card)).toBe(second.id);

    await api.inject({
      method: 'PATCH',
      url: `/api/dashboards/${panel}/widgets/${card}`,
      payload: { tabId: first.id },
    });
    expect(await cardTab(api, panel, card)).toBe(first.id);
  }, 30_000);

  it('leaves the tab alone when the patch is about something else', async () => {
    const { api, panel } = await platform();
    const tab = await makeTab(api, panel, 'Operação');
    const card = await makeCard(api, panel);
    await api.inject({
      method: 'PATCH',
      url: `/api/dashboards/${panel}/widgets/${card}`,
      payload: { tabId: tab.id },
    });
    await api.inject({
      method: 'PATCH',
      url: `/api/dashboards/${panel}/widgets/${card}`,
      payload: { title: 'Outro nome' },
    });
    expect(await cardTab(api, panel, card)).toBe(tab.id);
  }, 30_000);

  it('takes a card off its tab when the tab is null', async () => {
    const { api, panel } = await platform();
    const tab = await makeTab(api, panel, 'Operação');
    const card = await makeCard(api, panel);
    await api.inject({
      method: 'PATCH',
      url: `/api/dashboards/${panel}/widgets/${card}`,
      payload: { tabId: tab.id },
    });
    await api.inject({
      method: 'PATCH',
      url: `/api/dashboards/${panel}/widgets/${card}`,
      payload: { tabId: null },
    });
    expect(await cardTab(api, panel, card)).toBeNull();
  }, 30_000);

  it('creates a card straight onto a tab', async () => {
    const { api, panel } = await platform();
    const tab = await makeTab(api, panel, 'Operação');
    const made = await api.inject({
      method: 'POST',
      url: `/api/dashboards/${panel}/widgets`,
      payload: {
        deviceId: HAIWELL,
        widgetType: 'value',
        title: 'Peças',
        width: 'small',
        tabId: tab.id,
      },
    });
    expect(await cardTab(api, panel, body(made).id)).toBe(tab.id);
  }, 30_000);

  it('deleting a tab moves its cards instead of taking them along', async () => {
    const { api, panel } = await platform();
    const first = await makeTab(api, panel, 'Operação');
    const second = await makeTab(api, panel, 'Gráficos');
    const card = await makeCard(api, panel);
    await api.inject({
      method: 'PATCH',
      url: `/api/dashboards/${panel}/widgets/${card}`,
      payload: { tabId: second.id },
    });

    const removed = await api.inject({
      method: 'DELETE',
      url: `/api/dashboards/${panel}/tabs/${second.id}`,
      payload: { moveTo: first.id },
    });
    expect(removed.statusCode).toBe(200);
    expect(await cardTab(api, panel, card)).toBe(first.id);

    // And with nowhere to send them, the cards survive without a tab.
    const last = await api.inject({
      method: 'DELETE',
      url: `/api/dashboards/${panel}/tabs/${first.id}`,
      payload: { moveTo: null },
    });
    expect(last.statusCode).toBe(200);
    expect(await cardTab(api, panel, card)).toBeNull();
  }, 30_000);

  it('renames and reorders', async () => {
    const { api, panel } = await platform();
    const tab = await makeTab(api, panel, 'Aba 1');
    await api.inject({
      method: 'PATCH',
      url: `/api/dashboards/${panel}/tabs/${tab.id}`,
      payload: { name: 'Operação', position: 3 },
    });
    const view = body(await api.inject({ method: 'GET', url: `/api/dashboards/${panel}` }));
    expect(view.tabs[0].name).toBe('Operação');
    expect(view.tabs[0].position).toBe(3);
  }, 30_000);
});
