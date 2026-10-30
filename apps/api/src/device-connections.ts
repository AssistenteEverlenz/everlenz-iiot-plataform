import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';

/**
 * Who connects with each device's credential (migration 054, filled by the ingestor from the
 * broker's log). Only the platform's master sees it: a second HMI on a plant's credential is
 * the platform's problem to sort out, not something to put in front of the plant.
 */

type Access = ReturnType<typeof createAccessControl>;

/** How far back a warning stays on the home page until it is dismissed. */
const ALERT_DAYS = 14;

/** Before migration 054 is applied the table does not exist: say nothing rather than fail. */
const missingTable = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '42P01';

export function registerDeviceConnectionRoutes(app: FastifyInstance, db: Database, access: Access) {
  app.get('/api/connections/alerts', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    try {
      const rows = await db.query<{
        id: string;
        device_id: string;
        device_name: string;
        client_id: string;
        ip: string | null;
        connected_at: Date;
        disconnected_at: Date | null;
        new_client: boolean;
        overlapped: boolean;
        usual_client: string | null;
        usual_ip: string | null;
      }>(
        `SELECT c.id::text,c.device_id,d.name device_name,c.client_id,c.ip,c.connected_at,
           c.disconnected_at,c.new_client,c.overlapped,usual.client_id usual_client,usual.ip usual_ip
         FROM device_connections c
         JOIN devices d ON d.id=c.device_id AND d.tenant_id=c.tenant_id
         -- The identity the device spent most of the last two weeks connected as, for contrast.
         LEFT JOIN LATERAL (
           SELECT client_id,(array_agg(ip ORDER BY connected_at DESC))[1] ip
           FROM device_connections u
           WHERE u.device_id=c.device_id AND u.connected_at>now()-interval '14 days'
           GROUP BY client_id
           ORDER BY sum(extract(epoch FROM coalesce(u.disconnected_at,now())-u.connected_at)) DESC
           LIMIT 1
         ) usual ON true
         WHERE c.tenant_id=$1 AND (c.new_client OR c.overlapped) AND c.dismissed_at IS NULL
           AND c.connected_at>now()-($2::int * interval '1 day')
         ORDER BY c.connected_at DESC LIMIT 50`,
        [current.tenantId, ALERT_DAYS],
      );
      return rows.rows;
    } catch (error) {
      if (missingTable(error)) return [];
      throw error;
    }
  });

  app.get('/api/devices/:id/connections', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const current = access.principal(req);
    try {
      return (
        await db.query(
          `SELECT id::text,client_id,ip,connected_at,disconnected_at,end_reason,new_client,overlapped
           FROM device_connections WHERE tenant_id=$1 AND device_id=$2
           ORDER BY connected_at DESC LIMIT 50`,
          [current.tenantId, id],
        )
      ).rows;
    } catch (error) {
      if (missingTable(error)) return [];
      throw error;
    }
  });

  app.post('/api/connections/:id/dismiss', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const current = access.principal(req);
    const result = await db.query<{ device_id: string; client_id: string }>(
      `UPDATE device_connections SET dismissed_at=now()
       WHERE id=$1::bigint AND tenant_id=$2 AND dismissed_at IS NULL RETURNING device_id,client_id`,
      [id, current.tenantId],
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: 'Aviso não encontrado' });
    await recordAudit(db, req, current, {
      action: 'device.connection_alert.dismiss',
      targetType: 'device',
      targetId: row.device_id,
      summary: { clientId: row.client_id },
    });
    return { ok: true };
  });
}
