import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';

// TV of the operations page (migration 029): the screens a group's wall display shows in turn,
// each a 12-column grid of plants, so every ceramic is read at once without scrolling. Anyone
// who opens the operations page reads it; only the master changes it, and a save replaces the
// whole set so a half-edited TV never exists.

type Access = ReturnType<typeof createAccessControl>;
const uuid = z.uuid();

export interface OperationTvCard {
  device_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OperationTvScreen {
  name: string;
  duration_seconds: number;
  rows: number;
  cards: OperationTvCard[];
}

const configSchema = z.object({
  screens: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        duration_seconds: z.number().int().min(5).max(600).default(20),
        rows: z.number().int().min(4).max(24).default(12),
        cards: z
          .array(
            z.object({
              device_id: uuid,
              x: z.number().int().min(1).max(12),
              y: z.number().int().min(1).max(24),
              w: z.number().int().min(1).max(12),
              h: z.number().int().min(1).max(24),
            }),
          )
          .max(24),
      }),
    )
    .max(12),
});

export function registerOperationTvRoutes(app: FastifyInstance, db: Database, access: Access) {
  app.get('/api/operations/tv', async (req) => {
    const { tenantId } = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    const screens = await db.query<{
      id: string;
      name: string;
      duration_seconds: number;
      grid_rows: number;
    }>(
      `SELECT id,name,duration_seconds,grid_rows FROM operation_tv_screens
       WHERE tenant_id=$1 ORDER BY position,created_at`,
      [tenantId],
    );
    if (!screens.rows.length) return { screens: [] };
    // A plant the reader cannot see leaves its place empty rather than the TV refusing to draw.
    const cards = await db.query<OperationTvCard & { screen_id: string }>(
      `SELECT screen_id,device_id,x,y,w,h FROM operation_tv_cards
       WHERE tenant_id=$1 AND screen_id=ANY($2::uuid[])
         AND ($3::uuid[] IS NULL OR device_id=ANY($3))
       ORDER BY position`,
      [tenantId, screens.rows.map((screen) => screen.id), deviceIds],
    );
    return {
      screens: screens.rows.map((screen) => ({
        name: screen.name,
        duration_seconds: screen.duration_seconds,
        rows: screen.grid_rows,
        cards: cards.rows
          .filter((card) => card.screen_id === screen.id)
          .map(({ screen_id: _screen, ...card }) => card),
      })),
    };
  });

  app.put('/api/operations/tv', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const body = configSchema.parse(req.body);
    const devices = new Set(
      (
        await db.query<{ id: string }>(
          'SELECT id FROM devices WHERE tenant_id=$1 AND archived_at IS NULL',
          [current.tenantId],
        )
      ).rows.map((row) => row.id),
    );
    for (const screen of body.screens)
      for (const card of screen.cards)
        if (!devices.has(card.device_id))
          return reply.code(400).send({ error: 'Cerâmica não encontrada neste cliente.' });
    await db.transaction(async (sql) => {
      await sql.query('DELETE FROM operation_tv_screens WHERE tenant_id=$1', [current.tenantId]);
      for (const [index, screen] of body.screens.entries()) {
        const created = await sql.query<{ id: string }>(
          `INSERT INTO operation_tv_screens(tenant_id,name,position,duration_seconds,grid_rows)
           VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [current.tenantId, screen.name, index, screen.duration_seconds, screen.rows],
        );
        const screenId = created.rows[0].id;
        for (const [position, card] of screen.cards.entries())
          await sql.query(
            `INSERT INTO operation_tv_cards(tenant_id,screen_id,device_id,x,y,w,h,position)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [current.tenantId, screenId, card.device_id, card.x, card.y, card.w, card.h, position],
          );
      }
      await recordAudit(sql, req, current, {
        action: 'operation_tv.save',
        targetType: 'tenant',
        targetId: current.tenantId,
        summary: {
          screens: body.screens.length,
          cards: body.screens.reduce((total, screen) => total + screen.cards.length, 0),
        },
      });
    });
    return { screens: body.screens.length };
  });
}
