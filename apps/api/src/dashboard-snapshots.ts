import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';
import { scheduleProductionRebuild } from './shift-production.js';

// Dashboard snapshots (migration 022): a manual "photo" of a dashboard — its cards with their
// settings, the dashboard's refresh settings and the device's production parameters — that can
// be restored later. A restore snapshots the current state first, so it can be undone.
// One dashboard per tenant can also be the default model: a new device's dashboard starts with
// its cards, without variables, and each card gets its variable from its pencil.

type Access = ReturnType<typeof createAccessControl>;
type Executor = Pick<Database, 'query'>;
const uuid = z.uuid();
// Columns that belong to the row itself, never restored from a snapshot.
const OWN_COLUMNS = new Set(['tenant_id', 'device_id', 'created_at', 'updated_at']);
// Card settings that only make sense for the device they were set on.
const DEVICE_SPECIFIC_CONFIG = ['productColors', 'resetVariable'];

interface SnapshotWidget {
  id: string;
  device_id: string;
  tag_id: string | null;
  widget_type: string;
  title: string;
  position: number;
  width: string;
  config: Record<string, unknown>;
}
interface SnapshotContent {
  version: 1;
  dashboard: { name: string; refresh_ms: number; time_window_minutes: number };
  widgets: SnapshotWidget[];
  production: Record<string, unknown> | null;
  productionContext: { product_key: string | null; fallback_product_code: string } | null;
}

function withoutOwnColumns(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !OWN_COLUMNS.has(key)));
}

async function capture(
  sql: Executor,
  tenantId: string,
  dashboardId: string,
): Promise<SnapshotContent | null> {
  const dashboard = await sql.query<{
    name: string;
    refresh_ms: number;
    time_window_minutes: number;
    device_id: string | null;
  }>(
    'SELECT name,refresh_ms,time_window_minutes,device_id FROM dashboards WHERE tenant_id=$1 AND id=$2',
    [tenantId, dashboardId],
  );
  const row = dashboard.rows[0];
  if (!row) return null;
  const widgets = await sql.query<SnapshotWidget>(
    `SELECT id,device_id,tag_id,widget_type,title,position,width,config FROM dashboard_widgets
     WHERE tenant_id=$1 AND dashboard_id=$2 ORDER BY position,created_at`,
    [tenantId, dashboardId],
  );
  let production: Record<string, unknown> | null = null;
  let productionContext: SnapshotContent['productionContext'] = null;
  if (row.device_id) {
    const settings = await sql.query<Record<string, unknown>>(
      'SELECT * FROM production_settings WHERE tenant_id=$1 AND device_id=$2',
      [tenantId, row.device_id],
    );
    production = withoutOwnColumns(settings.rows[0]);
    const context = await sql.query<{ product_key: string | null; fallback_product_code: string }>(
      'SELECT product_key,fallback_product_code FROM production_context_settings WHERE tenant_id=$1 AND device_id=$2',
      [tenantId, row.device_id],
    );
    productionContext = context.rows[0] ?? null;
  }
  return {
    version: 1,
    dashboard: {
      name: row.name,
      refresh_ms: row.refresh_ms,
      time_window_minutes: row.time_window_minutes,
    },
    widgets: widgets.rows,
    production,
    productionContext,
  };
}

/** Puts a snapshot back. Variables or devices removed since then are left unlinked. */
async function restore(
  sql: Executor,
  tenantId: string,
  dashboardId: string,
  deviceId: string | null,
  content: SnapshotContent,
) {
  await sql.query(
    `UPDATE dashboards SET refresh_ms=$3,time_window_minutes=$4,updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, dashboardId, content.dashboard.refresh_ms, content.dashboard.time_window_minutes],
  );
  const deviceIds = [...new Set(content.widgets.map((widget) => widget.device_id))];
  const devices = new Set(
    (
      await sql.query<{ id: string }>(
        'SELECT id FROM devices WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
        [tenantId, deviceIds],
      )
    ).rows.map((row) => row.id),
  );
  const tagIds = content.widgets
    .map((widget) => widget.tag_id)
    .filter((tag): tag is string => Boolean(tag));
  const tags = new Set(
    (
      await sql.query<{ id: string }>(
        'SELECT id FROM tags WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
        [tenantId, tagIds],
      )
    ).rows.map((row) => row.id),
  );
  await sql.query('DELETE FROM dashboard_widgets WHERE tenant_id=$1 AND dashboard_id=$2', [
    tenantId,
    dashboardId,
  ]);
  let position = 0;
  for (const widget of content.widgets) {
    if (!devices.has(widget.device_id)) continue;
    await sql.query(
      `INSERT INTO dashboard_widgets(id,tenant_id,dashboard_id,device_id,tag_id,widget_type,title,
         position,width,config)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        widget.id,
        tenantId,
        dashboardId,
        widget.device_id,
        widget.tag_id && tags.has(widget.tag_id) ? widget.tag_id : null,
        widget.widget_type,
        widget.title,
        position,
        widget.width,
        JSON.stringify(widget.config ?? {}),
      ],
    );
    position += 1;
  }
  if (!deviceId) return false;
  let productionRestored = false;
  if (content.production) {
    const columns = new Set(
      (
        await sql.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='production_settings'`,
        )
      ).rows.map((row) => row.column_name),
    );
    const deviceTags = new Set(
      (
        await sql.query<{ id: string }>('SELECT id FROM tags WHERE tenant_id=$1 AND device_id=$2', [
          tenantId,
          deviceId,
        ])
      ).rows.map((row) => row.id),
    );
    const entries = Object.entries(content.production).filter(
      ([key]) => columns.has(key) && !OWN_COLUMNS.has(key) && /^[a-z_]+$/.test(key),
    );
    if (entries.length) {
      const names = entries.map(([key]) => key);
      const values = entries.map(([key, value]) =>
        key.endsWith('_tag_id') && (typeof value !== 'string' || !deviceTags.has(value))
          ? null
          : value,
      );
      await sql.query(
        `INSERT INTO production_settings(tenant_id,device_id,${names.join(',')},updated_at)
         VALUES($1,$2,${names.map((_, index) => `$${index + 3}`).join(',')},now())
         ON CONFLICT(device_id) DO UPDATE SET
           ${names.map((name) => `${name}=EXCLUDED.${name}`).join(',')},updated_at=now()`,
        [tenantId, deviceId, ...values],
      );
      productionRestored = true;
    }
  }
  if (content.productionContext)
    await sql.query(
      `INSERT INTO production_context_settings(tenant_id,device_id,product_key,fallback_product_code,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(device_id) DO UPDATE SET product_key=EXCLUDED.product_key,
         fallback_product_code=EXCLUDED.fallback_product_code,updated_at=now()`,
      [
        tenantId,
        deviceId,
        content.productionContext.product_key,
        content.productionContext.fallback_product_code,
      ],
    );
  return productionRestored;
}

/** A new device's dashboard starts with the tenant's model cards, without variables. */
export async function applyDashboardTemplate(
  sql: Executor,
  tenantId: string,
  dashboardId: string,
  deviceId: string,
) {
  const template = await sql.query<{ content: SnapshotContent }>(
    'SELECT content FROM dashboard_templates WHERE tenant_id=$1',
    [tenantId],
  );
  const widgets = template.rows[0]?.content.widgets ?? [];
  for (const [position, widget] of widgets.entries()) {
    const config = { ...(widget.config ?? {}) };
    for (const key of DEVICE_SPECIFIC_CONFIG) delete config[key];
    await sql.query(
      `INSERT INTO dashboard_widgets(id,tenant_id,dashboard_id,device_id,tag_id,widget_type,title,
         position,width,config)
       VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9::jsonb)`,
      [
        randomUUID(),
        tenantId,
        dashboardId,
        deviceId,
        widget.widget_type,
        widget.title,
        position,
        widget.width,
        JSON.stringify(config),
      ],
    );
  }
  return widgets.length;
}

function snapshotName(prefix: string) {
  return `${prefix} ${new Date().toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  })}`;
}

export function registerDashboardSnapshotRoutes(
  app: FastifyInstance,
  db: Database,
  access: Access,
) {
  async function dashboardOf(req: FastifyRequest, reply: FastifyReply, id: string) {
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    const result = await db.query<{ id: string; device_id: string | null; name: string }>(
      `SELECT id,device_id,name FROM dashboards WHERE tenant_id=$1 AND id=$2
       AND ($3::uuid[] IS NULL OR device_id=ANY($3))`,
      [current.tenantId, id, deviceIds],
    );
    if (!result.rows[0]) {
      reply.code(404).send({ error: 'Dashboard not found' });
      return null;
    }
    return result.rows[0];
  }

  app.get('/api/dashboards/:id/snapshots', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await dashboardOf(req, reply, id))) return;
    return (
      await db.query(
        `SELECT id,name,created_at,created_by_email,
           jsonb_array_length(COALESCE(content->'widgets','[]'::jsonb))::int widgets
         FROM dashboard_snapshots WHERE tenant_id=$1 AND dashboard_id=$2
         ORDER BY created_at DESC LIMIT 100`,
        [access.principal(req).tenantId, id],
      )
    ).rows;
  });

  app.post('/api/dashboards/:id/snapshots', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ name: z.string().trim().max(120).nullable().optional() })
      .parse(req.body ?? {});
    const dashboard = await dashboardOf(req, reply, id);
    if (!dashboard) return;
    const current = access.principal(req);
    const created = await db.transaction(async (sql) => {
      const content = await capture(sql, current.tenantId, id);
      const inserted = await sql.query<{ id: string; name: string; created_at: string }>(
        `INSERT INTO dashboard_snapshots(tenant_id,dashboard_id,name,content,created_by,created_by_email)
         VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING id,name,created_at`,
        [
          current.tenantId,
          id,
          body.name || snapshotName('Snapshot'),
          JSON.stringify(content),
          current.id,
          current.email,
        ],
      );
      await recordAudit(sql, req, current, {
        action: 'dashboard.snapshot.create',
        targetType: 'dashboard',
        targetId: id,
        summary: { snapshotId: inserted.rows[0].id, name: inserted.rows[0].name },
      });
      return inserted.rows[0];
    });
    return reply.code(201).send(created);
  });

  app.post('/api/dashboards/:id/snapshots/:snapshotId/restore', async (req, reply) => {
    const { id, snapshotId } = z.object({ id: uuid, snapshotId: uuid }).parse(req.params);
    const dashboard = await dashboardOf(req, reply, id);
    if (!dashboard) return;
    const current = access.principal(req);
    const snapshot = await db.query<{ name: string; content: SnapshotContent }>(
      'SELECT name,content FROM dashboard_snapshots WHERE tenant_id=$1 AND dashboard_id=$2 AND id=$3',
      [current.tenantId, id, snapshotId],
    );
    if (!snapshot.rows[0]) return reply.code(404).send({ error: 'Snapshot not found' });
    const productionRestored = await db.transaction(async (sql) => {
      // The state being replaced is kept first: a restore can always be undone.
      const before = await capture(sql, current.tenantId, id);
      await sql.query(
        `INSERT INTO dashboard_snapshots(tenant_id,dashboard_id,name,content,created_by,created_by_email)
         VALUES($1,$2,$3,$4::jsonb,$5,$6)`,
        [
          current.tenantId,
          id,
          `Antes de restaurar “${snapshot.rows[0].name}”`.slice(0, 160),
          JSON.stringify(before),
          current.id,
          current.email,
        ],
      );
      const restored = await restore(
        sql,
        current.tenantId,
        id,
        dashboard.device_id,
        snapshot.rows[0].content,
      );
      await recordAudit(sql, req, current, {
        action: 'dashboard.snapshot.restore',
        targetType: 'dashboard',
        targetId: id,
        summary: { snapshotId, name: snapshot.rows[0].name },
      });
      return restored;
    });
    // Production parameters changed: the stored history is recounted with them.
    if (productionRestored && dashboard.device_id)
      scheduleProductionRebuild(db, current.tenantId, dashboard.device_id, req.log);
    return { restored: true };
  });

  // Makes this dashboard the model of new devices' dashboards (cards without variables).
  app.post('/api/dashboards/:id/template', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await dashboardOf(req, reply, id))) return;
    const current = access.principal(req);
    const content = await capture(db, current.tenantId, id);
    await db.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO dashboard_templates(tenant_id,source_dashboard_id,content,updated_at)
         VALUES($1,$2,$3::jsonb,now())
         ON CONFLICT(tenant_id) DO UPDATE SET source_dashboard_id=EXCLUDED.source_dashboard_id,
           content=EXCLUDED.content,updated_at=now()`,
        [current.tenantId, id, JSON.stringify(content)],
      );
      await recordAudit(sql, req, current, {
        action: 'dashboard.template.set',
        targetType: 'dashboard',
        targetId: id,
        summary: { widgets: content?.widgets.length ?? 0 },
      });
    });
    return { widgets: content?.widgets.length ?? 0 };
  });
}
