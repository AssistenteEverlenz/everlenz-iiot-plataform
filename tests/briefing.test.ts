import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';

/**
 * The summary a panel opens with: what changed since this person last looked, read from the
 * minutes the platform was on their screen (migration 042), and the switch that turns it off.
 */
// The principal the API uses when authentication is off.
const ME = '00000000-0000-4000-8000-000000000000';

describe('resumo da operação', () => {
  it('counts what was made since the previous visit, and can be switched off', async () => {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const pallets = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type,unit)
         VALUES($1,$2,'QuantidadePaletes','Paletes','number','paletes') RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO production_settings(device_id,tenant_id,pallets_tag_id,target_metric,target_per_shift)
       VALUES($1,$2,$3,'pallets',100)
       ON CONFLICT (device_id) DO UPDATE SET pallets_tag_id=$3,target_metric='pallets'`,
      [HAIWELL, TENANT, pallets],
    );
    await db.query(
      `INSERT INTO app_users(id,tenant_id,email,full_name,role,password_hash,must_change_password)
       VALUES($1,$2,'me@lab.test','Eu','master','x',false)`,
      [ME, TENANT],
    );
    const now = Date.now();
    const minute = (ago: number) => new Date(Math.floor((now - ago * 60_000) / 60_000) * 60_000);
    // The previous visit: five minutes, two hours ago. The current one: the last two minutes.
    for (const ago of [125, 124, 123, 122, 121, 1, 0])
      await db.query(
        `INSERT INTO usage_minutes(tenant_id,user_id,minute,path,active) VALUES($1,$2,$3,'/',true)`,
        [TENANT, ME, minute(ago)],
      );
    // Since the previous visit: six five-minute buckets with two pallets each.
    for (let index = 0; index < 6; index += 1)
      await db.query(
        `INSERT INTO production_buckets(tenant_id,device_id,bucket,product_code,pieces,pallets,tons,producing_s,idle_s,manual_s)
         VALUES($1,$2,$3,'9x19x19',600,2,1,300,0,0)`,
        [TENANT, HAIWELL, new Date(Math.floor((now - (100 - index * 5) * 60_000) / 300_000) * 300_000)],
      );
    // The seed creates the tenant after the migration that gives every tenant its branding row.
    await db.query('INSERT INTO tenant_branding(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [TENANT]);
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
    try {
      const briefing = (await api.inject(`/api/devices/${HAIWELL}/briefing`)).json();
      expect(briefing.configured).toBe(true);
      expect(briefing.sinceVisit).not.toBeNull();
      expect(briefing.sinceVisit.made).toBe(12);
      // The visit ended at its last minute, two hours ago.
      const minutesAgo = (now - new Date(briefing.sinceVisit.at).getTime()) / 60_000;
      expect(minutesAgo).toBeGreaterThanOrEqual(120.9);
      expect(minutesAgo).toBeLessThanOrEqual(122);

      expect((await api.inject('/api/branding/public')).json().briefing_enabled).toBe(true);
      const off = await api.inject({
        method: 'PATCH',
        url: '/api/branding',
        payload: {
          productName: 'Everlenz IIoT',
          subtitle: 'Industrial Intelligence',
          primaryColor: '#0b2028',
          accentColor: '#12b8a6',
          briefingEnabled: false,
        },
      });
      expect(off.statusCode).toBe(200);
      // Read back: a field in the schema is not a field in the UPDATE.
      expect((await api.inject('/api/branding/public')).json().briefing_enabled).toBe(false);
    } finally {
      await api.close();
    }
  }, 30_000);
});
