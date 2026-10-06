import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword } from '../packages/shared/src/index.js';

/**
 * The master's usage page (migration 042): the minutes the browser reports, the logins, and
 * what the master reads back. Read back after every write.
 */
describe('uso da plataforma', () => {
  it('counts minutes, splits visits, keeps logins and is for the master alone', async () => {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const add = async (email: string, role: 'master' | 'user') =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO app_users(tenant_id,email,full_name,role,password_hash,must_change_password)
           VALUES($1,$2,$2,$3,$4,false) RETURNING id`,
          [TENANT, email, role, await hashPassword('UsageCheck9!x')],
        )
      ).rows[0].id;
    await add('chefe@usage.test', 'master');
    const userId = await add('operador@usage.test', 'user');
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: true });
    const login = async (email: string) =>
      (
        await api.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email, password: 'UsageCheck9!x' },
        })
      ).json().token as string;
    const master = await login('chefe@usage.test');
    const user = await login('operador@usage.test');
    const as = (token: string) => ({ authorization: `Bearer ${token}` });

    // The minute the user is on screen, reported twice: one row, active if either said so.
    const beat = (active: boolean) =>
      api.inject({
        method: 'POST',
        url: '/api/usage/beat',
        headers: as(user),
        payload: { path: '/production?x=1', active, device: 'desktop' },
      });
    expect((await beat(true)).statusCode).toBe(204);
    expect((await beat(false)).statusCode).toBe(204);
    const now = await db.query<{ path: string; active: boolean }>(
      'SELECT path,active FROM usage_minutes WHERE user_id=$1',
      [userId],
    );
    expect(now.rows).toEqual([{ path: '/production', active: true }]);

    // Yesterday: 5 minutes, a 30-minute gap, 3 more (two visits), and an hour of TV.
    const at = (minutes: number) => new Date(Date.now() - 86_400_000 + minutes * 60_000);
    for (const minute of [0, 1, 2, 3, 4, 35, 36, 37])
      await db.query(
        `INSERT INTO usage_minutes(tenant_id,user_id,minute,path,active,tv,device)
         VALUES($1,$2,date_trunc('minute',$3::timestamptz),'/operations',$4,false,'mobile')`,
        [TENANT, userId, at(minute), minute < 3],
      );
    for (let minute = 100; minute < 160; minute += 1)
      await db.query(
        `INSERT INTO usage_minutes(tenant_id,user_id,minute,path,active,tv,device)
         VALUES($1,$2,date_trunc('minute',$3::timestamptz),'/operations/tv',false,true,'tv')`,
        [TENANT, userId, at(minute)],
      );

    expect(
      (await api.inject({ url: '/api/usage/overview', headers: as(user) })).statusCode,
    ).toBe(403);
    const overview = (
      await api.inject({ url: '/api/usage/overview?days=7', headers: as(master) })
    ).json() as { users: Array<Record<string, unknown>> };
    const row = overview.users.find((item) => item.id === userId)!;
    expect(row).toMatchObject({
      openMinutes: 9,
      activeMinutes: 4,
      tvMinutes: 60,
      visits: 3,
      logins: 1,
      activeDays: 2,
      topPage: 'Operação',
    });

    const detail = (
      await api.inject({ url: `/api/usage/users/${userId}?days=7`, headers: as(master) })
    ).json() as {
      visits: Array<{ minutes: number; device: string; pages: string[] }>;
      logins: unknown[];
      pages: Array<{ label: string; tv: boolean; minutes: number }>;
    };
    expect(detail.visits.map((visit) => visit.minutes)).toEqual([1, 3, 5]);
    expect(detail.visits[2]).toMatchObject({ device: 'mobile', pages: ['Operação'] });
    expect(detail.pages).toContainEqual({ label: 'TV da operação', tv: true, minutes: 60, activeMinutes: 0 });
    expect(detail.logins).toHaveLength(1);
    await api.close();
  }, 60000);
});
