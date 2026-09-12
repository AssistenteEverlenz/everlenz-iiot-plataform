import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';

// Configurable TV (migration 023): the screens a dashboard's TV shows in turn, each a 12-column
// grid of cards. Anyone who can open the dashboard reads it (the TV itself); only the master
// changes it, and a save replaces the whole set so a half-edited TV never exists.

type Access = ReturnType<typeof createAccessControl>;
type Executor = Pick<Database, 'query'>;
const uuid = z.uuid();
const KINDS = ['widget', 'tv_kpis', 'tv_curve', 'tv_daymix', 'tv_week', 'tv_state', 'tv_alert'] as const;

export interface TvCard {
  kind: (typeof KINDS)[number];
  widget_id: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
}
export interface TvScreen {
  name: string;
  duration_seconds: number;
  rows: number;
  cards: TvCard[];
}

const cardSchema = z.object({
  kind: z.enum(KINDS),
  widget_id: uuid.nullable().default(null),
  x: z.number().int().min(1).max(12),
  y: z.number().int().min(1).max(24),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
  config: z.record(z.string(), z.unknown()).default({}),
});
const configSchema = z.object({
  screens: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        duration_seconds: z.number().int().min(5).max(600).default(20),
        rows: z.number().int().min(4).max(24).default(12),
        cards: z.array(cardSchema).max(40),
      }),
    )
    .max(12),
});

export async function loadTv(sql: Executor, tenantId: string, dashboardId: string): Promise<TvScreen[]> {
  const screens = await sql.query<{ id: string; name: string; duration_seconds: number; grid_rows: number }>(
    `SELECT id,name,duration_seconds,grid_rows FROM tv_screens
     WHERE tenant_id=$1 AND dashboard_id=$2 ORDER BY position,created_at`,
    [tenantId, dashboardId],
  );
  if (!screens.rows.length) return [];
  const cards = await sql.query<TvCard & { screen_id: string }>(
    `SELECT screen_id,kind,widget_id,x,y,w,h,config FROM tv_cards
     WHERE tenant_id=$1 AND screen_id=ANY($2::uuid[]) ORDER BY position`,
    [tenantId, screens.rows.map((screen) => screen.id)],
  );
  return screens.rows.map((screen) => ({
    name: screen.name,
    duration_seconds: screen.duration_seconds,
    rows: screen.grid_rows,
    cards: cards.rows
      .filter((card) => card.screen_id === screen.id)
      .map((card) => ({
        kind: card.kind,
        widget_id: card.widget_id,
        x: card.x,
        y: card.y,
        w: card.w,
        h: card.h,
        config: card.config ?? {},
      })),
  }));
}

/** Replaces the TV of a dashboard. Cards of dashboard cards that no longer exist are dropped. */
export async function saveTv(sql: Executor, tenantId: string, dashboardId: string, screens: TvScreen[]) {
  const widgets = new Set(
    (
      await sql.query<{ id: string }>(
        'SELECT id FROM dashboard_widgets WHERE tenant_id=$1 AND dashboard_id=$2',
        [tenantId, dashboardId],
      )
    ).rows.map((row) => row.id),
  );
  await sql.query('DELETE FROM tv_screens WHERE tenant_id=$1 AND dashboard_id=$2', [
    tenantId,
    dashboardId,
  ]);
  let cardsSaved = 0;
  for (const [position, screen] of screens.entries()) {
    const rows = Math.max(4, Math.min(24, screen.rows));
    const inserted = await sql.query<{ id: string }>(
      `INSERT INTO tv_screens(tenant_id,dashboard_id,name,position,duration_seconds,grid_rows)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tenantId, dashboardId, screen.name, position, screen.duration_seconds, rows],
    );
    let cardPosition = 0;
    for (const card of screen.cards) {
      if (card.kind === 'widget' && (!card.widget_id || !widgets.has(card.widget_id))) continue;
      // Kept inside the grid whatever the editor sent.
      const w = Math.max(1, Math.min(12, card.w));
      const h = Math.max(1, Math.min(rows, card.h));
      const x = Math.max(1, Math.min(13 - w, card.x));
      const y = Math.max(1, Math.min(rows + 1 - h, card.y));
      await sql.query(
        `INSERT INTO tv_cards(tenant_id,screen_id,kind,widget_id,x,y,w,h,config,position)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [
          tenantId,
          inserted.rows[0].id,
          card.kind,
          card.kind === 'widget' ? card.widget_id : null,
          x,
          y,
          w,
          h,
          JSON.stringify(card.config ?? {}),
          cardPosition,
        ],
      );
      cardPosition += 1;
      cardsSaved += 1;
    }
  }
  return cardsSaved;
}

export function registerTvRoutes(app: FastifyInstance, db: Database, access: Access) {
  async function dashboardOf(req: FastifyRequest, reply: FastifyReply, id: string) {
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    const result = await db.query<{ id: string }>(
      `SELECT id FROM dashboards WHERE tenant_id=$1 AND id=$2
       AND ($3::uuid[] IS NULL OR device_id=ANY($3))`,
      [current.tenantId, id, deviceIds],
    );
    if (!result.rows[0]) {
      reply.code(404).send({ error: 'Dashboard not found' });
      return null;
    }
    return result.rows[0];
  }

  app.get('/api/dashboards/:id/tv', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await dashboardOf(req, reply, id))) return;
    return { screens: await loadTv(db, access.principal(req).tenantId, id) };
  });

  app.put('/api/dashboards/:id/tv', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await dashboardOf(req, reply, id))) return;
    const body = configSchema.parse(req.body);
    const current = access.principal(req);
    await db.transaction(async (sql) => {
      const cards = await saveTv(sql, current.tenantId, id, body.screens);
      await recordAudit(sql, req, current, {
        action: 'dashboard.tv.update',
        targetType: 'dashboard',
        targetId: id,
        summary: { screens: body.screens.map((screen) => screen.name), cards },
      });
    });
    return { screens: await loadTv(db, current.tenantId, id) };
  });
}
