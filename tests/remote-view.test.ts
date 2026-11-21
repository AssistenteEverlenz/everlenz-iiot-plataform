import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { gatewayLink, isPrivateIpv4, signGatewayToken } from '../apps/api/src/remote-view.js';

describe('remote view (Ver tela da IHM)', () => {
  it('signs the JWT the noVNC gateway expects: HS256 over the decoded key bytes', () => {
    const key = randomBytes(32).toString('base64url');
    const token = signGatewayToken(key, { host: '192.168.77.50', port: 5900, exp: 2000000000 });
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      host: '192.168.77.50',
      port: 5900,
    });
    const expected = createHmac('sha256', Buffer.from(key, 'base64url'))
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
    // Signing with the key string itself would be a different signature the gateway refuses.
    expect(createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')).not.toBe(
      signature,
    );
  });

  it('puts the token in the path noVNC opens its websocket on', () => {
    const url = new URL(gatewayLink('https://acessoihm.everlenz.com.br', 'a.b.c', true));
    expect(url.pathname).toBe('/vnc.html');
    expect(url.searchParams.get('path')).toBe('websockify?token=a.b.c');
    expect(url.searchParams.get('view_only')).toBe('1');
    expect(url.searchParams.get('autoconnect')).toBe('1');
  });

  it('only accepts HMI addresses inside a machine LAN', () => {
    for (const ip of ['192.168.77.50', '10.99.0.2', '172.16.0.1', '172.31.255.254'])
      expect(isPrivateIpv4(ip)).toBe(true);
    for (const ip of [
      '31.97.250.67',
      '8.8.8.8',
      '172.32.0.1',
      '192.169.0.1',
      '192.168.77',
      'localhost',
    ])
      expect(isPrivateIpv4(ip)).toBe(false);
  });
});

describe('remote view routes', () => {
  it('stores the HMI address, hides the button without a key and signs a logged link with it', async () => {
    const { memoryDatabase } = await import('./pglite.js');
    const { migrate } = await import('../packages/database/src/migrate.js');
    const { seed, TENANT, HAIWELL } = await import('../packages/database/src/seed.js');
    const { createApp } = await import('../apps/api/src/app.js');
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const app = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
    const previous = process.env.REMOTE_GATEWAY_JWT_KEY;
    try {
      delete process.env.REMOTE_GATEWAY_JWT_KEY;
      const refused = await app.inject({
        method: 'PUT',
        url: `/api/devices/${HAIWELL}/remote-access`,
        payload: { hmiIp: '8.8.8.8' },
      });
      expect(refused.statusCode).toBe(400);
      const saved = await app.inject({
        method: 'PUT',
        url: `/api/devices/${HAIWELL}/remote-access`,
        payload: { hmiIp: '192.168.77.50', hmiPort: 5900 },
      });
      expect(saved.statusCode).toBe(200);
      const withoutKey = await app.inject({ url: `/api/devices/${HAIWELL}/remote-access` });
      expect(withoutKey.json()).toMatchObject({
        available: false,
        hmiIp: '192.168.77.50',
        gatewayReady: false,
      });
      expect(
        (await app.inject({ method: 'POST', url: `/api/devices/${HAIWELL}/remote-session` }))
          .statusCode,
      ).toBe(404);

      process.env.REMOTE_GATEWAY_JWT_KEY = randomBytes(32).toString('base64url');
      expect(
        (await app.inject({ url: `/api/devices/${HAIWELL}/remote-access` })).json(),
      ).toMatchObject({
        available: true,
        mode: 'control',
      });
      const session = await app.inject({
        method: 'POST',
        url: `/api/devices/${HAIWELL}/remote-session`,
      });
      expect(session.statusCode).toBe(200);
      const { url, mode } = session.json() as { url: string; mode: string };
      expect(mode).toBe('control');
      const token = new URL(url).searchParams.get('path')!.replace('websockify?token=', '');
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      expect(claims).toMatchObject({
        host: '192.168.77.50',
        port: 5900,
        sub: HAIWELL,
        mode: 'control',
      });
      expect(claims.exp - claims.nbf).toBe(305);
      const logged = await db.query<{ mode: string; hmi_ip: string }>(
        'SELECT mode,hmi_ip FROM remote_view_sessions WHERE tenant_id=$1 AND device_id=$2',
        [TENANT, HAIWELL],
      );
      expect(logged.rows).toEqual([{ mode: 'control', hmi_ip: '192.168.77.50' }]);

      // Clearing the IP turns the screen off.
      await app.inject({
        method: 'PUT',
        url: `/api/devices/${HAIWELL}/remote-access`,
        payload: { hmiIp: null },
      });
      expect(
        (await app.inject({ url: `/api/devices/${HAIWELL}/remote-access` })).json(),
      ).toMatchObject({
        available: false,
      });
    } finally {
      if (previous === undefined) delete process.env.REMOTE_GATEWAY_JWT_KEY;
      else process.env.REMOTE_GATEWAY_JWT_KEY = previous;
      await app.close();
    }
  }, 120_000);
});
