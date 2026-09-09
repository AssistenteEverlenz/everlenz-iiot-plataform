import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { env } from '@iiot/shared';
import { database, type Database } from '@iiot/database';
import { randomUUID } from 'node:crypto';
import { createAccessControl, registerAuthRoutes } from './auth.js';
const uuid = z.uuid();
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
const telemetryPagination = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
const timeRange = {
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};
function checkRange(q: { from?: string; to?: string }) {
  if (q.from && q.to && new Date(q.from) > new Date(q.to))
    throw new ZodError([{ code: 'custom', path: ['from'], message: 'from must precede to' }]);
}
function slug(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
}
function csv(value: unknown) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function createApp(
  db: Database = database,
  settings: { tenantId: string; operatorRaw: boolean; authRequired?: boolean } = {
    tenantId: env.DEV_TENANT_ID,
    operatorRaw: env.OPERATOR_RAW_ACCESS,
    authRequired: process.env.NODE_ENV !== 'test',
  },
) {
  const app = Fastify({
    logger: {
      base: { service: 'api' },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (level) => ({ level }) },
      redact: ['req.headers.authorization'],
    },
    bodyLimit: 16384,
  });
  const access = createAccessControl(db, {
    tenantId: settings.tenantId,
    required: settings.authRequired ?? process.env.NODE_ENV !== 'test',
  });
  app.addHook('preHandler', access.authenticate);
  registerAuthRoutes(app, db, access);
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      event: 'http_response',
      status: reply.statusCode,
      duration: reply.elapsedTime,
    });
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ error: 'Invalid parameters', issues: error.issues });
    request.log.error({
      event: 'request_failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return reply.code(500).send({ error: 'Internal server error' });
  });
  // Local development principal. Replace here with an authenticated server-side principal.
  // Query parameters and headers cannot select a different tenant.
  app.get('/health', async (_req, reply) => {
    let dbOk = false,
      broker = false;
    try {
      await db.query('SELECT 1');
      dbOk = true;
    } catch {
      /* readiness below */
    }
    try {
      const response = await fetch(env.INGESTOR_HEALTH_URL, { signal: AbortSignal.timeout(2000) });
      const body = (await response.json()) as { broker?: boolean };
      broker = response.ok && body.broker === true;
    } catch {
      /* readiness below */
    }
    return reply
      .code(dbOk ? 200 : 503)
      .send({ status: dbOk ? 'ok' : 'degraded', live: true, api: true, database: dbOk, broker });
  });
  app.get(
    '/api/tenants',
    async (req) =>
      (await db.query('SELECT * FROM tenants WHERE id=$1', [access.principal(req).tenantId])).rows,
  );
  app.get('/api/sites', async (req) => {
    const q = pagination.parse(req.query);
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    return (
      await db.query(
        `SELECT s.* FROM sites s WHERE s.tenant_id=$1
         AND ($2::uuid[] IS NULL OR EXISTS(SELECT 1 FROM devices d WHERE d.site_id=s.id AND d.id=ANY($2)))
         ORDER BY s.name,s.id LIMIT $3 OFFSET $4`,
        [current.tenantId, deviceIds, q.limit, q.offset],
      )
    ).rows;
  });
  const deviceSelect = `SELECT d.*,ds.last_message_at,COALESCE(d.enabled AND ds.last_message_at > now()-($2::int * interval '1 second'),false) online FROM devices d LEFT JOIN device_status ds ON ds.device_id=d.id AND ds.tenant_id=d.tenant_id`;
  app.get('/api/devices', async (req) => {
    const q = pagination.parse(req.query);
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    return (
      await db.query(
        `${deviceSelect} WHERE d.tenant_id=$1 AND ($3::uuid[] IS NULL OR d.id=ANY($3)) ORDER BY d.name,d.id LIMIT $4 OFFSET $5`,
        [current.tenantId, env.DEVICE_OFFLINE_SECONDS, deviceIds, q.limit, q.offset],
      )
    ).rows;
  });
  app.get('/api/devices/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const result = await db.query(`${deviceSelect} WHERE d.tenant_id=$1 AND d.id=$3`, [
      current.tenantId,
      env.DEVICE_OFFLINE_SECONDS,
      id,
    ]);
    return result.rows[0] ?? reply.code(404).send({ error: 'Device not found' });
  });
  app.get('/api/devices/:id/tags', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    return (
      await db.query('SELECT * FROM tags WHERE tenant_id=$1 AND device_id=$2 ORDER BY key', [
        access.principal(req).tenantId,
        id,
      ])
    ).rows;
  });
  app.get('/api/devices/:id/latest', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    return (
      await db.query(
        `SELECT DISTINCT ON (t.id) t.id tag_id,t.key,t.unit,t.data_type,s.timestamp,s.value_number,s.value_text,s.value_boolean,s.quality FROM tags t LEFT JOIN telemetry_samples s ON s.tag_id=t.id AND s.tenant_id=t.tenant_id WHERE t.tenant_id=$1 AND t.device_id=$2 AND t.enabled=true ORDER BY t.id,s.timestamp DESC NULLS LAST,s.id DESC`,
        [access.principal(req).tenantId, id],
      )
    ).rows;
  });
  app.get('/api/devices/:id/signals', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    return (
      await db.query(
        `SELECT COALESCE(c.id,t.id) id,COALESCE(c.key,t.key) key,
          COALESCE(t.data_type,c.inferred_type) data_type,t.name,t.unit,t.id tag_id,
          c.sample_value,c.first_seen_at,c.last_seen_at,COALESCE(c.occurrences,0)::int occurrences,
          (t.id IS NOT NULL) configured
         FROM device_signal_catalog c FULL OUTER JOIN tags t
          ON t.tenant_id=c.tenant_id AND t.device_id=c.device_id AND t.key=c.key
         WHERE COALESCE(c.tenant_id,t.tenant_id)=$1 AND COALESCE(c.device_id,t.device_id)=$2
         ORDER BY configured DESC,COALESCE(c.last_seen_at,t.created_at) DESC,COALESCE(c.key,t.key)`,
        [access.principal(req).tenantId, id],
      )
    ).rows;
  });
  app.post('/api/devices/:id/tags', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        key: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[A-Za-z0-9_.:-]+$/),
        name: z.string().min(1).max(120),
        dataType: z.enum(['number', 'boolean', 'string']),
        unit: z.string().max(24).nullable().optional(),
        scaleMultiplier: z.number().finite().default(1),
        scaleOffset: z.number().finite().default(0),
      })
      .parse(req.body);
    const device = await db.query('SELECT id FROM devices WHERE tenant_id=$1 AND id=$2', [
      access.principal(req).tenantId,
      id,
    ]);
    if (!device.rows.length) return reply.code(404).send({ error: 'Device not found' });
    return (
      await db.query(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type,unit,scale_multiplier,scale_offset)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(device_id,key) DO UPDATE SET name=EXCLUDED.name,data_type=EXCLUDED.data_type,
         unit=EXCLUDED.unit,scale_multiplier=EXCLUDED.scale_multiplier,scale_offset=EXCLUDED.scale_offset,enabled=true
         RETURNING *`,
        [
          access.principal(req).tenantId,
          id,
          body.key,
          body.name,
          body.dataType,
          body.unit ?? null,
          body.scaleMultiplier,
          body.scaleOffset,
        ],
      )
    ).rows[0];
  });
  app.post('/api/devices', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const body = z
      .object({
        siteId: uuid,
        name: z.string().min(2).max(120),
        manufacturer: z.string().min(1).max(80),
        model: z.string().min(1).max(80),
        serialNumber: z.string().max(120).nullable().optional(),
        adapterType: z.enum(['haiwell', 'generic']),
        topic: z.string().min(3).max(65535),
      })
      .parse(req.body);
    const site = await db.query<{ slug: string }>(
      'SELECT slug FROM sites WHERE tenant_id=$1 AND id=$2',
      [current.tenantId, body.siteId],
    );
    if (!site.rows.length) return reply.code(404).send({ error: 'Site not found' });
    const id = randomUUID();
    const suffix = id.replace(/-/g, '').slice(0, 8).toUpperCase();
    const code = `EVL-${
      body.manufacturer
        .slice(0, 3)
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase() || 'DEV'
    }-${suffix}`;
    const deviceSlug = `${slug(body.name) || 'dispositivo'}-${suffix.slice(0, 4).toLowerCase()}`;
    const topic = body.topic.replace(/^\/+|\/+$/g, '');
    const mapping = body.adapterType === 'haiwell' ? topic.replace(/^data\//, '') : topic;
    const row = await db.transaction(async (sql) => {
      const created = await sql.query(
        `INSERT INTO devices(id,tenant_id,site_id,slug,device_code,name,manufacturer,model,serial_number,mqtt_identifier,adapter_type,provisioning_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'awaiting_connection') RETURNING *`,
        [
          id,
          current.tenantId,
          body.siteId,
          deviceSlug,
          code,
          body.name,
          body.manufacturer,
          body.model,
          body.serialNumber ?? null,
          `device-${id}`,
          body.adapterType,
        ],
      );
      await sql.query(
        'INSERT INTO device_topic_mappings(tenant_id,device_id,kind,topic) VALUES($1,$2,$3,$4)',
        [current.tenantId, id, body.adapterType === 'haiwell' ? 'haiwell' : 'exact', mapping],
      );
      return created.rows[0];
    });
    return reply.code(201).send({
      device: row,
      connection: {
        host: env.MQTT_PUBLIC_HOST ?? env.MQTT_HOST,
        port: env.MQTT_TLS_PORT,
        tls: true,
        topic,
        suggestedUsername: code.toLowerCase(),
      },
    });
  });
  app.get('/api/telemetry', async (req, reply) => {
    const q = telemetryPagination
      .extend({ deviceId: uuid, tagId: uuid.optional(), ...timeRange })
      .parse(req.query);
    checkRange(q);
    if (!(await access.requireDevice(req, reply, q.deviceId))) return;
    return (
      await db.query(
        `SELECT s.*,t.key,t.unit FROM telemetry_samples s JOIN tags t ON t.id=s.tag_id AND t.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.device_id=$2 AND ($3::uuid IS NULL OR s.tag_id=$3) AND ($4::timestamptz IS NULL OR s.timestamp >= $4) AND ($5::timestamptz IS NULL OR s.timestamp <= $5) ORDER BY s.timestamp DESC,s.id DESC LIMIT $6 OFFSET $7`,
        [
          access.principal(req).tenantId,
          q.deviceId,
          q.tagId ?? null,
          q.from ?? null,
          q.to ?? null,
          q.limit,
          q.offset,
        ],
      )
    ).rows;
  });
  app.get('/api/devices/:id/statistics', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const { hours } = z
      .object({
        hours: z.coerce
          .number()
          .min(1 / 60)
          .max(24 * 366)
          .default(24),
      })
      .parse(req.query);
    return (
      await db.query(
        `SELECT t.id tag_id,t.key,t.name,t.unit,count(s.id)::int samples,
          min(s.value_number) minimum,max(s.value_number) maximum,avg(s.value_number) average,
          regr_slope(s.value_number,extract(epoch from s.timestamp)) trend_per_second
         FROM tags t LEFT JOIN telemetry_samples s ON s.tag_id=t.id AND s.tenant_id=t.tenant_id
          AND s.timestamp >= now()-($3::double precision * interval '1 hour')
         WHERE t.tenant_id=$1 AND t.device_id=$2 AND t.data_type='number' AND t.enabled=true
         GROUP BY t.id,t.key,t.name,t.unit ORDER BY t.name`,
        [access.principal(req).tenantId, id, hours],
      )
    ).rows;
  });
  app.get('/api/export/telemetry.csv', async (req, reply) => {
    const q = z
      .object({
        deviceId: uuid,
        tagId: uuid.optional(),
        ...timeRange,
        limit: z.coerce.number().int().min(1).max(50000).default(10000),
      })
      .parse(req.query);
    checkRange(q);
    if (!(await access.requireDevice(req, reply, q.deviceId))) return;
    const rows = (
      await db.query<Record<string, unknown>>(
        `SELECT s.timestamp,s.received_at,d.device_code,d.name device,t.key,t.name variable,t.unit,
          s.value_number,s.value_text,s.value_boolean,s.quality
         FROM telemetry_samples s JOIN devices d ON d.id=s.device_id AND d.tenant_id=s.tenant_id
         JOIN tags t ON t.id=s.tag_id AND t.tenant_id=s.tenant_id
         WHERE s.tenant_id=$1 AND s.device_id=$2 AND ($3::uuid IS NULL OR s.tag_id=$3)
          AND ($4::timestamptz IS NULL OR s.timestamp >= $4) AND ($5::timestamptz IS NULL OR s.timestamp <= $5)
         ORDER BY s.timestamp DESC,s.id DESC LIMIT $6`,
        [
          access.principal(req).tenantId,
          q.deviceId,
          q.tagId ?? null,
          q.from ?? null,
          q.to ?? null,
          q.limit,
        ],
      )
    ).rows;
    const columns = [
      'timestamp',
      'received_at',
      'device_code',
      'device',
      'key',
      'variable',
      'unit',
      'value',
      'quality',
    ];
    const lines = [columns.join(',')];
    for (const row of rows) {
      const value = row.value_number ?? row.value_boolean ?? row.value_text;
      lines.push(columns.map((column) => csv(column === 'value' ? value : row[column])).join(','));
    }
    return reply
      .header('content-disposition', `attachment; filename="telemetria-${q.deviceId}.csv"`)
      .type('text/csv; charset=utf-8')
      .send(`\uFEFF${lines.join('\r\n')}`);
  });
  app.get('/api/dashboards', async (req) => {
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    return (
      await db.query(
        `SELECT d.*,v.name device_name,count(w.id)::int widget_count FROM dashboards d
         LEFT JOIN devices v ON v.id=d.device_id AND v.tenant_id=d.tenant_id
         LEFT JOIN dashboard_widgets w ON w.dashboard_id=d.id AND w.tenant_id=d.tenant_id
         WHERE d.tenant_id=$1 AND ($2::uuid[] IS NULL OR d.device_id=ANY($2))
         GROUP BY d.id,v.name ORDER BY d.is_default DESC,d.name`,
        [current.tenantId, deviceIds],
      )
    ).rows;
  });
  app.get('/api/dashboards/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    const dashboard = await db.query(
      'SELECT * FROM dashboards WHERE tenant_id=$1 AND id=$2 AND ($3::uuid[] IS NULL OR device_id=ANY($3))',
      [current.tenantId, id, deviceIds],
    );
    if (!dashboard.rows.length) return reply.code(404).send({ error: 'Dashboard not found' });
    const widgets = await db.query(
      `SELECT w.*,t.key,t.name tag_name,t.unit,t.data_type FROM dashboard_widgets w
       LEFT JOIN tags t ON t.id=w.tag_id AND t.tenant_id=w.tenant_id
       WHERE w.tenant_id=$1 AND w.dashboard_id=$2 ORDER BY w.position,w.created_at`,
      [current.tenantId, id],
    );
    return { ...dashboard.rows[0], widgets: widgets.rows };
  });
  app.patch('/api/dashboards/:id', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(2).max(120).optional(),
        refreshMs: z.number().int().min(1000).max(60000).optional(),
        timeWindowMinutes: z.number().int().min(1).max(525600).optional(),
      })
      .parse(req.body);
    const result = await db.query(
      `UPDATE dashboards SET name=COALESCE($3,name),refresh_ms=COALESCE($4,refresh_ms),
       time_window_minutes=COALESCE($5,time_window_minutes),updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [
        access.principal(req).tenantId,
        id,
        body.name ?? null,
        body.refreshMs ?? null,
        body.timeWindowMinutes ?? null,
      ],
    );
    return result.rows[0] ?? reply.code(404).send({ error: 'Dashboard not found' });
  });
  app.post('/api/dashboards/:id/widgets', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        deviceId: uuid,
        tagId: uuid.nullable().optional(),
        widgetType: z.enum(['value', 'line', 'gauge', 'status', 'production', 'oee', 'pareto']),
        title: z.string().min(1).max(120),
        width: z.enum(['small', 'medium', 'large', 'full']).default('medium'),
        config: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(req.body);
    const dashboard = await db.query('SELECT id FROM dashboards WHERE tenant_id=$1 AND id=$2', [
      current.tenantId,
      id,
    ]);
    if (!dashboard.rows.length) return reply.code(404).send({ error: 'Dashboard not found' });
    const position = await db.query<{ next: number }>(
      'SELECT COALESCE(max(position),0)+1 next FROM dashboard_widgets WHERE tenant_id=$1 AND dashboard_id=$2',
      [current.tenantId, id],
    );
    return reply.code(201).send(
      (
        await db.query(
          `INSERT INTO dashboard_widgets(tenant_id,dashboard_id,device_id,tag_id,widget_type,title,position,width,config)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
          [
            current.tenantId,
            id,
            body.deviceId,
            body.tagId ?? null,
            body.widgetType,
            body.title,
            position.rows[0].next,
            body.width,
            JSON.stringify(body.config),
          ],
        )
      ).rows[0],
    );
  });
  app.delete('/api/dashboards/:dashboardId/widgets/:widgetId', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { dashboardId, widgetId } = z
      .object({ dashboardId: uuid, widgetId: uuid })
      .parse(req.params);
    const result = await db.query(
      'DELETE FROM dashboard_widgets WHERE tenant_id=$1 AND dashboard_id=$2 AND id=$3 RETURNING id',
      [access.principal(req).tenantId, dashboardId, widgetId],
    );
    return result.rows.length
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'Widget not found' });
  });
  // Separate local operator scope is needed to inspect messages whose tenant is still unknown.
  const rawScope = settings.operatorRaw ? '(tenant_id=$1 OR tenant_id IS NULL)' : 'tenant_id=$1';
  app.get('/api/mqtt/raw', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const q = pagination
      .extend({
        topic: z.string().max(65535).optional(),
        processingStatus: z.enum(['pending', 'processed', 'unrecognized', 'error']).optional(),
        ...timeRange,
      })
      .parse(req.query);
    checkRange(q);
    return (
      await db.query(
        `SELECT * FROM mqtt_messages_raw WHERE ${rawScope} AND ($2::text IS NULL OR topic=$2) AND ($3::text IS NULL OR processing_status=$3) AND ($4::timestamptz IS NULL OR received_at >= $4) AND ($5::timestamptz IS NULL OR received_at <= $5) ORDER BY received_at DESC,id DESC LIMIT $6 OFFSET $7`,
        [
          access.principal(req).tenantId,
          q.topic ?? null,
          q.processingStatus ?? null,
          q.from ?? null,
          q.to ?? null,
          q.limit,
          q.offset,
        ],
      )
    ).rows;
  });
  app.get('/api/mqtt/topics', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const q = pagination.parse(req.query);
    return (
      await db.query(
        `SELECT topic,count(*)::int message_count,min(received_at) first_seen,max(received_at) last_seen FROM mqtt_messages_raw WHERE ${rawScope} GROUP BY topic ORDER BY max(received_at) DESC,topic LIMIT $2 OFFSET $3`,
        [access.principal(req).tenantId, q.limit, q.offset],
      )
    ).rows;
  });
  app.get('/api/overview', async (req) => {
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    const devices = await db.query<{ count: number }>(
      'SELECT count(*)::int count FROM devices WHERE tenant_id=$1 AND ($2::uuid[] IS NULL OR id=ANY($2))',
      [current.tenantId, deviceIds],
    );
    const raw = await db.query<{ count: number; last_message_at: string | null }>(
      `SELECT count(*)::int count,max(received_at) last_message_at FROM mqtt_messages_raw
       WHERE ${rawScope} AND ($2::uuid[] IS NULL OR device_id=ANY($2))`,
      [current.tenantId, deviceIds],
    );
    return {
      devices: devices.rows[0].count,
      messages: raw.rows[0].count,
      lastMessageAt: raw.rows[0].last_message_at,
      operatorRawAccess: settings.operatorRaw,
    };
  });
  return app;
}
