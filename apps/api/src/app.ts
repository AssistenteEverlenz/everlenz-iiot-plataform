import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { env, temporaryPassword } from '@iiot/shared';
import { database, type Database } from '@iiot/database';
import { randomUUID } from 'node:crypto';
import { access as accessFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAccessControl, registerAuthRoutes, type Principal } from './auth.js';
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
const hmiModels: Record<string, string[]> = {
  Haiwell: ['A7', 'A7 Pro', 'A10', 'A10 Pro', 'A15', 'A15 Pro'],
  Weintek: [
    'cMT2078X',
    'cMT2108X2',
    'cMT2158X',
    'cMT2166X',
    'cMT3072XP',
    'cMT3092X',
    'cMT3102X',
    'cMT3108XH',
    'cMT3152X',
    'cMT3162X',
    'cMT-FHDX-820',
    'cMT-SVRX-820',
  ],
  Delta: ['DOP-3S07S3E2', 'DOP-3S10S3E2'],
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
// Async because the rate limiter must finish loading before any route is registered:
// its global hook only reaches routes added to the context after it is in place.
export async function createApp(
  db: Database = database,
  settings: { tenantId: string; operatorRaw: boolean; authRequired?: boolean } = {
    tenantId: env.DEV_TENANT_ID,
    operatorRaw: env.OPERATOR_RAW_ACCESS,
    authRequired: process.env.NODE_ENV !== 'test',
  },
) {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    // Exactly one hop is trusted: the Coolify/Traefik proxy in front of this service.
    // Without this, request.ip is the proxy for every caller and per-client throttling
    // is meaningless. With `true`, any client could spoof X-Forwarded-For and forge an
    // address; hop 0 is the immediate peer, which can only be the proxy itself.
    trustProxy: (_address: string, hop: number) => hop === 0,
    logger: {
      base: { service: 'api' },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (level) => ({ level }) },
      redact: ['req.headers.authorization'],
    },
  });
  // Awaited before any route is added, so the global hook covers all of them. Measured
  // saturation is ~15 req/s for the whole service, so these ceilings are generous
  // per client but still bound what a single caller can consume.
  if (process.env.NODE_ENV !== 'test')
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      // Container healthchecks originate on loopback and must never be throttled.
      allowList: ['127.0.0.1', '::1'],
      continueExceeding: true,
      addHeadersOnExceeding: { 'x-ratelimit-remaining': false },
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
    // Plugins signal client errors by throwing with a statusCode. The rate limiter's 429
    // in particular must survive: collapsing it into 500 would silently disable the
    // throttle's feedback and make the limit look like a server fault.
    const signalled = (error as { statusCode?: unknown } | undefined)?.statusCode;
    const status = typeof signalled === 'number' ? signalled : 500;
    if (status === 429) return reply.code(429).send({ error: 'Too many requests. Slow down.' });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'Invalid request' });
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
  app.post('/api/sites', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const body = z
      .object({ name: z.string().min(2).max(120), reference: z.string().min(2).max(40) })
      .parse(req.body);
    const id = randomUUID();
    const suffix = id.replace(/-/g, '').slice(0, 5).toLowerCase();
    return reply.code(201).send(
      (
        await db.query(
          `INSERT INTO sites(id,tenant_id,slug,name,reference) VALUES($1,$2,$3,$4,upper($5))
           RETURNING *`,
          [
            id,
            current.tenantId,
            `${slug(body.name) || 'cliente'}-${suffix}`,
            body.name.trim(),
            body.reference.trim(),
          ],
        )
      ).rows[0],
    );
  });
  const deviceSelect = `SELECT d.*,s.name site_name,s.reference site_reference,m.topic mqtt_topic,
    COALESCE(d.mqtt_username,lower(d.device_code)) mqtt_username,ds.last_message_at,
    COALESCE(d.enabled AND ds.last_message_at > now()-($2::int * interval '1 second'),false) online
    FROM devices d JOIN sites s ON s.id=d.site_id AND s.tenant_id=d.tenant_id
    LEFT JOIN device_status ds ON ds.device_id=d.id AND ds.tenant_id=d.tenant_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN dm.kind='haiwell' AND dm.topic NOT LIKE 'data/%' THEN 'data/'||dm.topic ELSE dm.topic END topic
      FROM device_topic_mappings dm WHERE dm.device_id=d.id AND dm.tenant_id=d.tenant_id ORDER BY dm.id LIMIT 1
    ) m ON true`;
  app.get('/api/devices', async (req) => {
    const q = pagination.parse(req.query);
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    return (
      await db.query(
        `${deviceSelect} WHERE d.tenant_id=$1 AND d.archived_at IS NULL AND ($3::uuid[] IS NULL OR d.id=ANY($3)) ORDER BY d.name,d.id LIMIT $4 OFFSET $5`,
        [current.tenantId, env.DEVICE_OFFLINE_SECONDS, deviceIds, q.limit, q.offset],
      )
    ).rows;
  });
  app.get('/api/devices/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const result = await db.query(
      `${deviceSelect} WHERE d.tenant_id=$1 AND d.id=$3 AND d.archived_at IS NULL`,
      [current.tenantId, env.DEVICE_OFFLINE_SECONDS, id],
    );
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
    const { id } = z.object({ id: uuid }).parse(req.params);
    // Tag scaling rewrites how every future sample is interpreted: master only.
    // A `user` is a viewer and must not be able to silently falsify telemetry.
    if (!access.requireMaster(req, reply)) return;
    if (!(await access.requireDevice(req, reply, id))) return;
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
        manufacturer: z.enum(['Haiwell', 'Weintek', 'Delta']),
        model: z.string().min(1).max(80),
        serialNumber: z.string().max(120).nullable().optional(),
      })
      .parse(req.body);
    if (!hmiModels[body.manufacturer]?.includes(body.model))
      return reply.code(400).send({ error: 'Model is not available for this manufacturer' });
    const site = await db.query<{ slug: string; reference: string }>(
      'SELECT slug,reference FROM sites WHERE tenant_id=$1 AND id=$2',
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
    const topic = `iiot/${current.tenantId}/${site.rows[0].slug}/${code.toLowerCase()}/telemetry`;
    const adapterType = body.manufacturer === 'Haiwell' ? 'haiwell' : 'generic';
    const mqttUsername = code.toLowerCase();
    const mqttPassword = temporaryPassword(20);
    const dashboardId = randomUUID();
    const row = await db.transaction(async (sql) => {
      const created = await sql.query(
        `INSERT INTO devices(id,tenant_id,site_id,slug,device_code,name,manufacturer,model,serial_number,mqtt_identifier,adapter_type,provisioning_status,mqtt_username,mqtt_password)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'awaiting_connection',$12,$13) RETURNING *`,
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
          adapterType,
          mqttUsername,
          mqttPassword,
        ],
      );
      await sql.query(
        'INSERT INTO device_topic_mappings(tenant_id,device_id,kind,topic) VALUES($1,$2,$3,$4)',
        [current.tenantId, id, 'exact', topic],
      );
      await sql.query(
        `INSERT INTO dashboards(id,tenant_id,device_id,name,slug,description,refresh_ms,time_window_minutes)
         VALUES($1,$2,$3,$4,$5,$6,2000,60)`,
        [
          dashboardId,
          current.tenantId,
          id,
          `Gestão à Vista · ${body.name.trim()}`,
          `gestao-a-vista-${code.toLowerCase()}`,
          `Painel operacional de ${body.name.trim()}`,
        ],
      );
      return created.rows[0];
    });
    const credentialActive = await provisionMqttRequest(
      'upsert',
      mqttUsername,
      mqttPassword,
      topic,
    );
    return reply.code(201).send({
      device: row,
      dashboardId,
      connection: {
        host: env.MQTT_PUBLIC_HOST ?? env.MQTT_HOST,
        port: env.MQTT_TLS_PORT,
        tls: true,
        topic,
        username: mqttUsername,
        password: mqttPassword,
        clientReference: site.rows[0].reference,
        credentialActive,
      },
    });
  });
  app.patch('/api/devices/:id', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        siteId: uuid.optional(),
        name: z.string().min(2).max(120).optional(),
        manufacturer: z.enum(['Haiwell', 'Weintek', 'Delta']).optional(),
        model: z.string().min(1).max(80).optional(),
        serialNumber: z.string().max(120).nullable().optional(),
      })
      .parse(req.body);
    const existing = await db.query<{ manufacturer: string; model: string }>(
      'SELECT manufacturer,model FROM devices WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
      [current.tenantId, id],
    );
    if (!existing.rows.length) return reply.code(404).send({ error: 'Device not found' });
    const manufacturer = body.manufacturer ?? existing.rows[0].manufacturer;
    const model = body.model ?? existing.rows[0].model;
    if (!hmiModels[manufacturer]?.includes(model))
      return reply.code(400).send({ error: 'Model is not available for this manufacturer' });
    const adapterType = manufacturer === 'Haiwell' ? 'haiwell' : 'generic';
    const updated = await db.query(
      `UPDATE devices SET site_id=COALESCE($3,site_id),name=COALESCE($4,name),
       manufacturer=$5,model=$6,serial_number=CASE WHEN $7::boolean THEN $8 ELSE serial_number END,
       adapter_type=$9,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,
      [
        current.tenantId,
        id,
        body.siteId ?? null,
        body.name?.trim() ?? null,
        manufacturer,
        model,
        body.serialNumber !== undefined,
        body.serialNumber ?? null,
        adapterType,
      ],
    );
    return updated.rows[0] ?? reply.code(404).send({ error: 'Device not found' });
  });
  app.delete('/api/devices/:id', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const result = await db.query<{ id: string; mqtt_username: string | null }>(
      `UPDATE devices SET archived_at=now(),enabled=false,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id,mqtt_username`,
      [access.principal(req).tenantId, id],
    );
    if (!result.rows.length) return reply.code(404).send({ error: 'Device not found' });
    if (result.rows[0].mqtt_username)
      await provisionMqttRequest('delete', result.rows[0].mqtt_username, '', '');
    return reply.code(204).send();
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
  // A single export may scan 50k rows. Kept far below the global ceiling so one
  // caller cannot hold the 5-connection pool open in a loop.
  app.get(
    '/api/export/telemetry.csv',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
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
        lines.push(
          columns.map((column) => csv(column === 'value' ? value : row[column])).join(','),
        );
      }
      return reply
        .header('content-disposition', `attachment; filename="telemetria-${q.deviceId}.csv"`)
        .type('text/csv; charset=utf-8')
        .send(`\uFEFF${lines.join('\r\n')}`);
    },
  );
  app.get('/api/dashboards', async (req) => {
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    return (
      await db.query(
        `SELECT d.*,v.name device_name,v.device_code,v.enabled device_enabled,
          s.name site_name,s.reference site_reference,ds.last_message_at,
          COALESCE(v.enabled AND v.archived_at IS NULL AND ds.last_message_at > now()-($3::int * interval '1 second'),false) device_online,
          (v.archived_at IS NOT NULL OR NOT v.enabled) device_deactivated,
          count(w.id)::int widget_count FROM dashboards d
         LEFT JOIN devices v ON v.id=d.device_id AND v.tenant_id=d.tenant_id
         LEFT JOIN sites s ON s.id=v.site_id AND s.tenant_id=v.tenant_id
         LEFT JOIN device_status ds ON ds.device_id=v.id AND ds.tenant_id=v.tenant_id
         LEFT JOIN dashboard_widgets w ON w.dashboard_id=d.id AND w.tenant_id=d.tenant_id
         WHERE d.tenant_id=$1 AND ($2::uuid[] IS NULL OR d.device_id=ANY($2))
         GROUP BY d.id,v.name,v.device_code,v.enabled,v.archived_at,s.name,s.reference,ds.last_message_at
         ORDER BY d.is_default DESC,s.name,v.name,d.name`,
        [current.tenantId, deviceIds, env.DEVICE_OFFLINE_SECONDS],
      )
    ).rows;
  });
  app.get('/api/dashboards/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const current = access.principal(req);
    const deviceIds = await access.accessibleDeviceIds(req);
    const view = await dashboardView(db, current, id, deviceIds);
    return view ?? reply.code(404).send({ error: 'Dashboard not found' });
  });
  app.get('/api/dashboards/:id/statistics', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const current = access.principal(req);
    const view = await dashboardView(db, current, id, await access.accessibleDeviceIds(req));
    if (!view) return reply.code(404).send({ error: 'Dashboard not found' });
    const productionWidgets = view.widgets.filter(
      (widget) => widget.widget_type === 'production' && widget.tag_id,
    );
    return Promise.all(
      productionWidgets.map(async (widget) => {
        const widgetConfig = widget.config as {
          productionPeriodMinutes?: unknown;
          productionMinimumValue?: unknown;
        };
        const requestedPeriod = Number(widgetConfig.productionPeriodMinutes ?? 60);
        const periodMinutes = Math.min(
          60 * 24 * 31,
          Math.max(1, Number.isFinite(requestedPeriod) ? requestedPeriod : 60),
        );
        const requestedMinimum = Number(widgetConfig.productionMinimumValue ?? 0.1);
        const minimumValue = Number.isFinite(requestedMinimum) ? requestedMinimum : 0.1;
        const result = await db.query<{
          samples: number;
          ignored_samples: number;
          minimum: number | null;
          maximum: number | null;
          average: number | null;
          trend_per_second: number | null;
        }>(
          `SELECT
            count(*) FILTER (WHERE value_number >= $5)::int samples,
            count(*) FILTER (WHERE value_number < $5)::int ignored_samples,
            min(value_number) FILTER (WHERE value_number >= $5) minimum,
            max(value_number) FILTER (WHERE value_number >= $5) maximum,
            avg(value_number) FILTER (WHERE value_number >= $5) average,
            regr_slope(value_number,extract(epoch from timestamp))
              FILTER (WHERE value_number >= $5) trend_per_second
           FROM telemetry_samples
           WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3
             AND timestamp >= now()-($4::double precision * interval '1 minute')`,
          [current.tenantId, widget.device_id, widget.tag_id, periodMinutes, minimumValue],
        );
        return {
          widget_id: widget.id,
          tag_id: widget.tag_id,
          period_minutes: periodMinutes,
          minimum_value: minimumValue,
          ...result.rows[0],
        };
      }),
    );
  });
  app.patch('/api/dashboards/:id', async (req, reply) => {
    const current = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(2).max(120).optional(),
        refreshMs: z.number().int().min(1000).max(60000).optional(),
        timeWindowMinutes: z.number().int().min(1).max(525600).optional(),
      })
      .parse(req.body);
    if (body.name && !access.requireMaster(req, reply)) return;
    const view = await dashboardView(db, current, id, await access.accessibleDeviceIds(req));
    if (!view) return reply.code(404).send({ error: 'Dashboard not found' });
    if (body.name)
      await db.query(
        'UPDATE dashboards SET name=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [current.tenantId, id, body.name],
      );
    await saveDashboardView(db, current, id, {
      refresh_ms: body.refreshMs ?? view.refresh_ms,
      time_window_minutes: body.timeWindowMinutes ?? view.time_window_minutes,
      widgets: view.widgets,
    });
    return dashboardView(db, current, id, await access.accessibleDeviceIds(req));
  });
  app.post('/api/dashboards/:id/widgets', async (req, reply) => {
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
    if (!(await access.requireDevice(req, reply, body.deviceId))) return;
    const view = await dashboardView(db, current, id, await access.accessibleDeviceIds(req));
    if (!view) return reply.code(404).send({ error: 'Dashboard not found' });
    let tag: Record<string, unknown> | undefined;
    if (body.tagId) {
      tag = (
        await db.query<Record<string, unknown>>(
          'SELECT id tag_id,key,name tag_name,unit,data_type FROM tags WHERE tenant_id=$1 AND device_id=$2 AND id=$3',
          [current.tenantId, body.deviceId, body.tagId],
        )
      ).rows[0];
      if (!tag) return reply.code(400).send({ error: 'Tag does not belong to this device' });
    }
    const widget = {
      id: randomUUID(),
      tenant_id: current.tenantId,
      dashboard_id: id,
      device_id: body.deviceId,
      tag_id: body.tagId ?? null,
      widget_type: body.widgetType,
      title: body.title,
      position: view.widgets.length,
      width: body.width,
      config: body.config,
      key: tag?.key ?? null,
      tag_name: tag?.tag_name ?? null,
      unit: tag?.unit ?? null,
      data_type: tag?.data_type ?? null,
    };
    await saveDashboardView(db, current, id, { ...view, widgets: [...view.widgets, widget] });
    return reply.code(201).send(widget);
  });
  app.patch('/api/dashboards/:dashboardId/widgets/:widgetId', async (req, reply) => {
    const current = access.principal(req);
    const { dashboardId, widgetId } = z
      .object({ dashboardId: uuid, widgetId: uuid })
      .parse(req.params);
    const body = z
      .object({
        title: z.string().min(1).max(120).optional(),
        width: z.enum(['small', 'medium', 'large', 'full']).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    const view = await dashboardView(
      db,
      current,
      dashboardId,
      await access.accessibleDeviceIds(req),
    );
    if (!view) return reply.code(404).send({ error: 'Dashboard not found' });
    const index = view.widgets.findIndex((widget) => widget.id === widgetId);
    if (index < 0) return reply.code(404).send({ error: 'Widget not found' });
    const updated = {
      ...view.widgets[index],
      ...(body.title ? { title: body.title } : {}),
      ...(body.width ? { width: body.width } : {}),
      ...(body.config ? { config: { ...view.widgets[index].config, ...body.config } } : {}),
    };
    view.widgets[index] = updated;
    await saveDashboardView(db, current, dashboardId, view);
    return updated;
  });
  app.patch('/api/dashboards/:id/layout', async (req, reply) => {
    const current = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { widgetIds } = z.object({ widgetIds: z.array(uuid).max(100) }).parse(req.body);
    const view = await dashboardView(db, current, id, await access.accessibleDeviceIds(req));
    if (!view) return reply.code(404).send({ error: 'Dashboard not found' });
    if (
      widgetIds.length !== view.widgets.length ||
      new Set(widgetIds).size !== widgetIds.length ||
      widgetIds.some((widgetId) => !view.widgets.some((widget) => widget.id === widgetId))
    )
      return reply.code(400).send({ error: 'Layout must contain every widget exactly once' });
    view.widgets = widgetIds.map((widgetId, position) => ({
      ...view.widgets.find((widget) => widget.id === widgetId)!,
      position,
    }));
    await saveDashboardView(db, current, id, view);
    return { widgets: view.widgets };
  });
  app.delete('/api/dashboards/:dashboardId/widgets/:widgetId', async (req, reply) => {
    const current = access.principal(req);
    const { dashboardId, widgetId } = z
      .object({ dashboardId: uuid, widgetId: uuid })
      .parse(req.params);
    const view = await dashboardView(
      db,
      current,
      dashboardId,
      await access.accessibleDeviceIds(req),
    );
    if (!view) return reply.code(404).send({ error: 'Dashboard not found' });
    const widgets = view.widgets.filter((widget) => widget.id !== widgetId);
    if (widgets.length === view.widgets.length)
      return reply.code(404).send({ error: 'Widget not found' });
    await saveDashboardView(db, current, dashboardId, {
      ...view,
      widgets: widgets.map((widget, position) => ({ ...widget, position })),
    });
    return reply.code(204).send();
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
      'SELECT count(*)::int count FROM devices WHERE tenant_id=$1 AND archived_at IS NULL AND ($2::uuid[] IS NULL OR id=ANY($2))',
      [current.tenantId, deviceIds],
    );
    const raw = await db.query<{ messages_per_minute: number }>(
      `SELECT count(*)::int messages_per_minute FROM mqtt_messages_raw
       WHERE ${rawScope} AND ($2::uuid[] IS NULL OR device_id=ANY($2))
       AND received_at >= now()-interval '1 minute'`,
      [current.tenantId, deviceIds],
    );
    const last = await db.query<{ last_message_at: string | null }>(
      `SELECT max(last_message_at) last_message_at FROM device_status
       WHERE tenant_id=$1 AND ($2::uuid[] IS NULL OR device_id=ANY($2))`,
      [current.tenantId, deviceIds],
    );
    return {
      devices: devices.rows[0].count,
      messagesPerMinute: raw.rows[0].messages_per_minute,
      lastMessageAt: last.rows[0].last_message_at,
      operatorRawAccess: settings.operatorRaw,
    };
  });
  return app;
}

async function provisionMqttRequest(
  action: 'upsert' | 'delete',
  username: string,
  password: string,
  topic: string,
) {
  if (!env.MQTT_PROVISION_DIR) return false;
  const requestId = randomUUID();
  const requestPath = join(env.MQTT_PROVISION_DIR, `${requestId}.request`);
  const temporaryPath = `${requestPath}.tmp`;
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
  try {
    await mkdir(env.MQTT_PROVISION_DIR, { recursive: true });
    await writeFile(
      temporaryPath,
      `${encode(username)}\n${encode(password)}\n${encode(topic)}\n${encode(action)}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, requestPath);
    const doneDirectory = join(env.MQTT_PROVISION_DIR, '..', 'done');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        await accessFile(join(doneDirectory, `${requestId}.done`));
        return true;
      } catch {
        /* still processing */
      }
      try {
        await accessFile(join(doneDirectory, `${requestId}.error`));
        return false;
      } catch {
        /* still processing */
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'mqtt_credential_provision_failed',
        username,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return false;
}

interface DashboardWidgetRecord {
  id: string;
  device_id: string;
  tag_id: string | null;
  widget_type: 'value' | 'line' | 'gauge' | 'status' | 'production' | 'oee' | 'pareto';
  title: string;
  position: number;
  width: 'small' | 'medium' | 'large' | 'full';
  config: Record<string, unknown>;
  [key: string]: unknown;
}

interface DashboardViewSettings {
  refresh_ms: number;
  time_window_minutes: number;
  widgets: DashboardWidgetRecord[];
}

async function dashboardView(
  db: Database,
  current: Principal,
  dashboardId: string,
  deviceIds: string[] | null,
) {
  const dashboard = await db.query<Record<string, unknown>>(
    `SELECT * FROM dashboards WHERE tenant_id=$1 AND id=$2
     AND ($3::uuid[] IS NULL OR device_id=ANY($3))`,
    [current.tenantId, dashboardId, deviceIds],
  );
  if (!dashboard.rows.length) return null;
  const widgets = await db.query<DashboardWidgetRecord>(
    `SELECT w.*,t.key,t.name tag_name,t.unit,t.data_type FROM dashboard_widgets w
     LEFT JOIN tags t ON t.id=w.tag_id AND t.tenant_id=w.tenant_id
     WHERE w.tenant_id=$1 AND w.dashboard_id=$2 ORDER BY w.position,w.created_at`,
    [current.tenantId, dashboardId],
  );
  return { ...dashboard.rows[0], widgets: widgets.rows } as Record<string, unknown> &
    DashboardViewSettings;
}

async function saveDashboardView(
  db: Database,
  current: Principal,
  dashboardId: string,
  view: DashboardViewSettings,
) {
  await db.transaction(async (sql) => {
    await sql.query(
      `UPDATE dashboards SET refresh_ms=$3,time_window_minutes=$4,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [current.tenantId, dashboardId, view.refresh_ms, view.time_window_minutes],
    );
    await sql.query('DELETE FROM dashboard_widgets WHERE tenant_id=$1 AND dashboard_id=$2', [
      current.tenantId,
      dashboardId,
    ]);
    for (const [position, widget] of view.widgets.entries()) {
      await sql.query(
        `INSERT INTO dashboard_widgets(id,tenant_id,dashboard_id,device_id,tag_id,widget_type,title,position,width,config)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          widget.id,
          current.tenantId,
          dashboardId,
          widget.device_id,
          widget.tag_id,
          widget.widget_type,
          widget.title,
          position,
          widget.width,
          JSON.stringify(widget.config),
        ],
      );
    }
  });
}
