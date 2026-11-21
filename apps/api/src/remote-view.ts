import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';

/**
 * "Ver tela da IHM" (migration 058): the HMI's screen in the browser.
 *
 * Each machine's router keeps a WireGuard tunnel to the server; a noVNC gateway (websockify
 * with the JWTTokenApi plugin, separate Coolify resource) opens the HMI's VNC through it. The
 * platform checks who may see the machine, signs a JWT naming the HMI's address (always read
 * from device_remote_access, never from the request) and hands back the gateway link.
 *
 * Token, as the gateway expects it: HS256, key = the BYTES of REMOTE_GATEWAY_JWT_KEY (base64url
 * of 32 random bytes, the same string the gateway has as GATEWAY_JWT_KEY), claims host + port,
 * nbf/exp. exp only gates opening the connection; an open screen stays until it is closed.
 * view_only is enforced by noVNC in the browser, not by the gateway.
 */

type Access = ReturnType<typeof createAccessControl>;

/** How long a link can be used to open the screen. */
const LINK_SECONDS = 300;

const gatewayUrl = () =>
  (process.env.REMOTE_GATEWAY_URL || 'https://acessoihm.everlenz.com.br').replace(/\/+$/, '');
const gatewayKey = () => (process.env.REMOTE_GATEWAY_JWT_KEY ?? '').trim();

/** Before migration 058 is applied the tables do not exist: the feature stays hidden. */
const missingTable = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '42P01';

const octet = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const ipv4 = new RegExp(`^${octet}(\\.${octet}){3}$`);
/** Only addresses inside a machine's LAN: the gateway must never be pointed at the internet. */
export function isPrivateIpv4(value: string) {
  if (!ipv4.test(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export function signGatewayToken(key: string, claims: Record<string, unknown>) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function gatewayLink(base: string, token: string, viewOnly: boolean) {
  const query = new URLSearchParams({
    autoconnect: '1',
    resize: 'scale',
    reconnect: '0',
    view_only: viewOnly ? '1' : '0',
    path: `websockify?token=${token}`,
  });
  return `${base}/vnc.html?${query.toString()}`;
}

interface RemoteRow {
  hmi_ip: string;
  hmi_port: number;
  enabled: boolean;
  customer_control: boolean;
  updated_at: Date;
}

export function registerRemoteViewRoutes(app: FastifyInstance, db: Database, access: Access) {
  const deviceId = z.object({ id: z.uuid() });

  async function load(tenantId: string, id: string) {
    try {
      const rows = await db.query<RemoteRow>(
        `SELECT hmi_ip,hmi_port,enabled,customer_control,updated_at FROM device_remote_access
         WHERE tenant_id=$1 AND device_id=$2`,
        [tenantId, id],
      );
      return { ready: true, row: rows.rows[0] ?? null };
    } catch (error) {
      if (missingTable(error)) return { ready: false, row: null };
      throw error;
    }
  }

  // What the panel and the device sheet need: is there a screen to open, and (master) where.
  app.get('/api/devices/:id/remote-access', async (req, reply) => {
    const { id } = deviceId.parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const { ready, row } = await load(current.tenantId, id);
    const available = Boolean(ready && row?.enabled && gatewayKey());
    const master = current.role === 'master';
    return {
      available,
      mode: master || row?.customer_control ? 'control' : 'view',
      // The plant's users only see the button; the address is the master's business.
      ...(master
        ? {
            tablesReady: ready,
            gatewayReady: Boolean(gatewayKey()),
            hmiIp: row?.hmi_ip ?? null,
            hmiPort: row?.hmi_port ?? 5900,
            enabled: row?.enabled ?? false,
            customerControl: row?.customer_control ?? false,
          }
        : {}),
    };
  });

  // Set (or clear, with hmiIp null) where the HMI answers inside the machine's tunnel.
  app.put('/api/devices/:id/remote-access', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = deviceId.parse(req.params);
    const current = access.principal(req);
    const body = z
      .object({
        hmiIp: z
          .string()
          .trim()
          .refine(isPrivateIpv4, 'Use o IP da IHM na rede da máquina (ex. 192.168.77.50)')
          .nullable(),
        hmiPort: z.coerce.number().int().min(1).max(65535).default(5900),
        enabled: z.boolean().default(true),
        customerControl: z.boolean().default(false),
      })
      .parse(req.body);
    const device = await db.query(
      'SELECT 1 FROM devices WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
      [current.tenantId, id],
    );
    if (!device.rows.length) return reply.code(404).send({ error: 'Device not found' });
    try {
      if (body.hmiIp === null)
        await db.query('DELETE FROM device_remote_access WHERE tenant_id=$1 AND device_id=$2', [
          current.tenantId,
          id,
        ]);
      else await saveRemoteAccess(db, current.tenantId, id, { ...body, hmiIp: body.hmiIp });
    } catch (error) {
      if (missingTable(error))
        return reply
          .code(503)
          .send({ error: 'A tabela do acesso remoto (058) ainda não foi criada' });
      throw error;
    }
    await recordAudit(db, req, current, {
      action: 'device.remote_access',
      targetType: 'device',
      targetId: id,
      summary: body,
    });
    return { ok: true };
  });

  // One link to open the screen, valid for a few minutes, recorded with who asked for it.
  app.post('/api/devices/:id/remote-session', async (req, reply) => {
    const { id } = deviceId.parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const key = gatewayKey();
    const { ready, row } = await load(current.tenantId, id);
    if (!ready || !row?.enabled || !key)
      return reply.code(404).send({ error: 'Esta máquina ainda não tem acesso remoto à IHM' });
    const mode = current.role === 'master' || row.customer_control ? 'control' : 'view';
    const sessionId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const token = signGatewayToken(key, {
      host: row.hmi_ip,
      port: row.hmi_port,
      nbf: now - 5,
      exp: now + LINK_SECONDS,
      sub: id,
      mode,
      jti: sessionId,
    });
    await db.query(
      `INSERT INTO remote_view_sessions(id,tenant_id,device_id,user_id,user_email,mode,hmi_ip,hmi_port,ip_address,expires_at)
       VALUES($1,$2,$3,(SELECT id FROM app_users WHERE id=$4),$5,$6,$7,$8,$9,to_timestamp($10))`,
      [
        sessionId,
        current.tenantId,
        id,
        current.id,
        current.email,
        mode,
        row.hmi_ip,
        row.hmi_port,
        req.ip,
        now + LINK_SECONDS,
      ],
    );
    await recordAudit(db, req, current, {
      action: 'device.remote_session',
      targetType: 'device',
      targetId: id,
      summary: { session: sessionId, mode },
    });
    return {
      url: gatewayLink(gatewayUrl(), token, mode === 'view'),
      mode,
      expiresAt: new Date((now + LINK_SECONDS) * 1000).toISOString(),
    };
  });
}

/** Shared with POST /api/devices, which can take the HMI's address at registration. */
export async function saveRemoteAccess(
  db: Pick<Database, 'query'>,
  tenantId: string,
  deviceId: string,
  value: { hmiIp: string; hmiPort: number; enabled: boolean; customerControl: boolean },
) {
  await db.query(
    `INSERT INTO device_remote_access(device_id,tenant_id,hmi_ip,hmi_port,enabled,customer_control)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (device_id) DO UPDATE SET hmi_ip=EXCLUDED.hmi_ip,hmi_port=EXCLUDED.hmi_port,
       enabled=EXCLUDED.enabled,customer_control=EXCLUDED.customer_control,updated_at=now()`,
    [deviceId, tenantId, value.hmiIp, value.hmiPort, value.enabled, value.customerControl],
  );
}
