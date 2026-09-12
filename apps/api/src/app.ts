import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { deviceSecret, env } from '@iiot/shared';
import { database, type Database } from '@iiot/database';
import { randomUUID } from 'node:crypto';
import { access as accessFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAccessControl, registerAuthRoutes, type Principal } from './auth.js';
import { recordAudit } from './audit.js';
import { publishCommand, type CommandPublisher } from './commands.js';
import { registerProductionRoutes } from './production.js';
import { registerShiftProductionRoutes } from './shift-production.js';
const uuid = z.uuid();
/** How long a PLC reset bit stays at 1 before the platform writes it back to 0. */
const COMMAND_PULSE_MS = 2000;
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
// Only HMIs that can publish MQTT over Ethernet; keep in step with models in
// apps/web/app/devices/page.tsx. Weintek: EasyBuilder Pro "Comparison of HMI Software
// Features" (MQTT row) — the iP line has no MQTT. Delta: DOP-100 models with an Ethernet port
// (MQTT in DOPSoft 4 / DIAScreen) and the DOP-300S line.
const hmiModels: Record<string, string[]> = {
  Haiwell: ['A7', 'A7 Pro', 'A10', 'A10 Pro', 'A15', 'A15 Pro'],
  Weintek: [
    'cMT2058XH',
    'cMT2078X',
    'cMT2108X',
    'cMT2108X2',
    'cMT2128X',
    'cMT2158X',
    'cMT2166X',
    'cMT1106X',
    'cMT3072X',
    'cMT3072X2',
    'cMT3072XH',
    'cMT3072XH2',
    'cMT3072XHT',
    'cMT3072XP',
    'cMT3092X',
    'cMT3102X',
    'cMT3108XH',
    'cMT3108XP',
    'cMT3152X',
    'cMT3161X',
    'cMT3162X',
    'cMT-FHDX-220',
    'cMT-FHDX-820',
    'cMT-SVRX-820',
    'cMT-SVRX-822',
    'cMT3071',
    'cMT3072',
    'cMT3090',
    'cMT3103',
    'cMT3151',
    'cMT-iV5',
    'cMT-HDM',
    'cMT-FHD',
    'cMT-SVR-100',
    'cMT-SVR-102',
    'cMT-SVR-200',
    'cMT-SVR-202',
    'cMT-G01',
    'cMT-G02',
    'cMT-G03',
    'cMT-G04',
    'cMT-CTRL01',
    'MT8050iE',
    'MT8051iE',
    'MT8053iE',
    'MT6070iE',
    'MT6071iE',
    'MT8070iE',
    'MT8071iE',
    'MT8073iE',
    'MT8100iE',
    'MT8101iE',
    'MT8102iE',
    'MT8103iE',
    'MT8090XE',
    'MT8091XE',
    'MT8092XE',
    'MT8121XE',
    'MT8150XE',
    'eMT3070B',
    'eMT3105P',
    'eMT3120A',
    'eMT3150A',
    'mTV-100',
  ],
  Delta: [
    'DOP-103DQ',
    'DOP-107DV',
    'DOP-107PV',
    'DOP-107EG',
    'DOP-107EV',
    'DOP-107IV',
    'DOP-108IG',
    'DOP-110IS',
    'DOP-110IG',
    'DOP-103WQ',
    'DOP-107WV',
    'DOP-110WS',
    'DOP-112WX',
    'DOP-115WX',
    'DOP-112MX',
    'DOP-115MX',
    'DOP-3S07S3E2',
    'DOP-3S10S3E2',
  ],
};
/** Payload reader per manufacturer. */
function adapterFor(manufacturer: string) {
  if (manufacturer === 'Haiwell') return 'haiwell';
  if (manufacturer === 'Weintek') return 'weintek';
  if (manufacturer === 'Delta') return 'delta';
  return 'generic';
}
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
const ipv4 = z
  .string()
  .regex(
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/,
    'IPv4 inválido',
  );
/** Broker address shown on the device sheet: TLS by default, the plain port for legacy HMIs. */
function brokerPort(legacyPlainMqtt: boolean) {
  return legacyPlainMqtt
    ? { port: env.MQTT_LEGACY_PUBLIC_PORT, tls: false }
    : { port: env.MQTT_TLS_PORT, tls: true };
}

export async function createApp(
  db: Database = database,
  settings: {
    tenantId: string;
    operatorRaw: boolean;
    authRequired?: boolean;
    /** Sends equipment commands; tests pass a fake. Defaults to the broker publisher. */
    publishCommand?: CommandPublisher;
  } = {
    tenantId: env.DEV_TENANT_ID,
    operatorRaw: env.OPERATOR_RAW_ACCESS,
    authRequired: process.env.NODE_ENV !== 'test',
  },
) {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    // Exactly one hop is trusted: the immediate peer, which is always the web container,
    // because the API is published only on the internal network (browser -> Traefik ->
    // web -> api). The web proxy forwards the X-Forwarded-For that Traefik set, and the
    // right-most entry becomes request.ip. With `true` instead, any client could forge
    // its address by sending the header itself.
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
      // Keyed by the real client address, which the web proxy forwards. A whole plant
      // usually sits behind one NAT address and every open dashboard polls roughly
      // 140-230 requests/min, so this fits several screens at 1 s refresh while still
      // stopping one runaway client. It is a per-client backstop, not capacity
      // protection: login and export keep their own strict limits.
      max: 1800,
      timeWindow: '1 minute',
      // Container healthchecks originate on loopback and must never be throttled.
      allowList: ['127.0.0.1', '::1'],
      // Never renew the window while a client keeps exceeding it. Dashboards keep
      // polling on errors, so renewal turned a single burst into a lockout lasting as
      // long as any screen stayed open (SECURITY.md item 2, incident of 2026-09-10).
      continueExceeding: false,
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
    const site = await db.transaction(async (sql) => {
      const created = await sql.query(
        `INSERT INTO sites(id,tenant_id,slug,name,reference) VALUES($1,$2,$3,$4,upper($5))
         RETURNING *`,
        [
          id,
          current.tenantId,
          `${slug(body.name) || 'cliente'}-${suffix}`,
          body.name.trim(),
          body.reference.trim(),
        ],
      );
      await recordAudit(sql, req, current, {
        action: 'site.create',
        targetType: 'site',
        targetId: id,
        summary: { name: body.name.trim(), reference: body.reference.trim() },
      });
      return created.rows[0];
    });
    return reply.code(201).send(site);
  });
  // `d.*` reaches the browser. Never add a secret column to `devices`: the plaintext
  // mqtt_password used to be exposed exactly this way (SECURITY.md item 12). Any new
  // sensitive column must be returned by an explicit, separately authorised route.
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
          (t.id IS NOT NULL) configured,
          -- The catalog keeps every key ever published. A key is still published when it was
          -- seen close to the device's newest publication; keys the HMI stopped sending fall out.
          COALESCE(c.last_seen_at >= max(c.last_seen_at) OVER () - interval '10 minutes',false) present
         FROM device_signal_catalog c FULL OUTER JOIN tags t
          ON t.tenant_id=c.tenant_id AND t.device_id=c.device_id AND t.key=c.key
         WHERE COALESCE(c.tenant_id,t.tenant_id)=$1 AND COALESCE(c.device_id,t.device_id)=$2
         ORDER BY configured DESC,COALESCE(c.last_seen_at,t.created_at) DESC,COALESCE(c.key,t.key)`,
        [access.principal(req).tenantId, id],
      )
    ).rows;
  });
  registerProductionRoutes(app, db, access);
  registerShiftProductionRoutes(app, db, access);
  app.get('/api/devices/:id/production-context', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const result = await db.query<{
      product_key: string | null;
      fallback_product_code: string;
    }>(
      `SELECT product_key,fallback_product_code FROM production_context_settings
       WHERE tenant_id=$1 AND device_id=$2`,
      [access.principal(req).tenantId, id],
    );
    return result.rows[0] ?? { product_key: null, fallback_product_code: 'ITEM GERAL' };
  });
  app.patch('/api/devices/:id/production-context', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const body = z
      .object({
        productKey: z.string().trim().min(1).max(120).nullable(),
        fallbackProductCode: z.string().trim().min(1).max(120),
      })
      .parse(req.body);
    const current = access.principal(req);
    const result = await db.query(
      `INSERT INTO production_context_settings(
         tenant_id,device_id,product_key,fallback_product_code
       ) VALUES($1,$2,$3,$4)
       ON CONFLICT(device_id) DO UPDATE SET product_key=EXCLUDED.product_key,
         fallback_product_code=EXCLUDED.fallback_product_code,updated_at=now()
       RETURNING product_key,fallback_product_code`,
      [current.tenantId, id, body.productKey, body.fallbackProductCode],
    );
    await recordAudit(db, req, current, {
      action: 'device.production_context.update',
      targetType: 'device',
      targetId: id,
      summary: { productKey: body.productKey, fallbackProductCode: body.fallbackProductCode },
    });
    return result.rows[0];
  });
  // Wipes the recorded history of one variable: its samples, the hourly rollups built from
  // them and the counter baseline. Used when a variable was read with the wrong format or
  // address and every average or total built on it is wrong; the next reading starts clean,
  // and the cleared baseline keeps a cumulative counter from counting its whole value as one
  // increment. Every card on this variable starts over. Master only, recorded in the audit.
  app.delete('/api/devices/:id/tags/:tagId/history', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id, tagId } = z.object({ id: uuid, tagId: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const current = access.principal(req);
    const tag = await db.query<{ key: string }>(
      'SELECT key FROM tags WHERE tenant_id=$1 AND device_id=$2 AND id=$3',
      [current.tenantId, id, tagId],
    );
    if (!tag.rows.length) return reply.code(404).send({ error: 'Variable not found' });
    const removed = await db.transaction(async (sql) => {
      await sql.query(
        'DELETE FROM telemetry_hourly_rollups WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3',
        [current.tenantId, id, tagId],
      );
      const samples = await sql.query(
        'DELETE FROM telemetry_samples WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3',
        [current.tenantId, id, tagId],
      );
      await sql.query(
        'DELETE FROM telemetry_numeric_state WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3',
        [current.tenantId, id, tagId],
      );
      await recordAudit(sql, req, current, {
        action: 'tag.history.clear',
        targetType: 'tag',
        targetId: tagId,
        summary: { key: tag.rows[0].key, samples: samples.rowCount ?? 0 },
      });
      return samples.rowCount ?? 0;
    });
    return { key: tag.rows[0].key, removedSamples: removed };
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
    const current = access.principal(req);
    return db.transaction(async (sql) => {
      const saved = await sql.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type,unit,scale_multiplier,scale_offset)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(device_id,key) DO UPDATE SET name=EXCLUDED.name,data_type=EXCLUDED.data_type,
         unit=EXCLUDED.unit,scale_multiplier=EXCLUDED.scale_multiplier,scale_offset=EXCLUDED.scale_offset,enabled=true
         RETURNING *`,
        [
          current.tenantId,
          id,
          body.key,
          body.name,
          body.dataType,
          body.unit ?? null,
          body.scaleMultiplier,
          body.scaleOffset,
        ],
      );
      // Scaling is recorded because changing it retroactively reinterprets the meaning
      // of every later sample; an investigation needs to see when that happened.
      await recordAudit(sql, req, current, {
        action: 'tag.upsert',
        targetType: 'tag',
        targetId: saved.rows[0].id,
        summary: {
          device_id: id,
          key: body.key,
          data_type: body.dataType,
          scale_multiplier: body.scaleMultiplier,
          scale_offset: body.scaleOffset,
        },
      });
      return saved.rows[0];
    });
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
        // Legacy HMI whose TLS client cannot reach the broker: plain MQTT on the compatibility
        // port, from addresses released on the device page (apps/api/src/legacy-mqtt.ts).
        legacyPlainMqtt: z.boolean().optional(),
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
    const adapterType = adapterFor(body.manufacturer);
    const mqttUsername = code.toLowerCase();
    const mqttPassword = deviceSecret();
    const dashboardId = randomUUID();
    const row = await db.transaction(async (sql) => {
      // The generated password is never stored: it is returned once, here, and can only
      // be replaced afterwards through POST /api/devices/:id/mqtt-credential.
      const created = await sql.query(
        `INSERT INTO devices(id,tenant_id,site_id,slug,device_code,name,manufacturer,model,serial_number,mqtt_identifier,adapter_type,provisioning_status,mqtt_username,mqtt_credential_rotated_at,legacy_plain_mqtt)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'awaiting_connection',$12,now(),$13) RETURNING *`,
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
          body.legacyPlainMqtt ?? false,
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
      await recordAudit(sql, req, current, {
        action: 'device.create',
        targetType: 'device',
        targetId: id,
        summary: { device_code: code, name: body.name, manufacturer: body.manufacturer, topic },
      });
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
        ...brokerPort(body.legacyPlainMqtt ?? false),
        topic,
        username: mqttUsername,
        password: mqttPassword,
        clientReference: site.rows[0].reference,
        credentialActive,
      },
    });
  });
  // Replaces the old "read the stored password back" flow. The secret exists only in
  // this response; losing it costs a rotation, not a database lookup.
  app.post('/api/devices/:id/mqtt-credential', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const device = await db.query<{
      device_code: string;
      mqtt_username: string | null;
      topic: string | null;
      site_reference: string;
      legacy_plain_mqtt: boolean;
    }>(
      `SELECT d.device_code,COALESCE(d.mqtt_username,lower(d.device_code)) mqtt_username,
        s.reference site_reference,d.legacy_plain_mqtt,
        (SELECT CASE WHEN dm.kind='haiwell' AND dm.topic NOT LIKE 'data/%' THEN 'data/'||dm.topic ELSE dm.topic END
         FROM device_topic_mappings dm WHERE dm.device_id=d.id AND dm.tenant_id=d.tenant_id ORDER BY dm.id LIMIT 1) topic
       FROM devices d JOIN sites s ON s.id=d.site_id AND s.tenant_id=d.tenant_id
       WHERE d.tenant_id=$1 AND d.id=$2 AND d.archived_at IS NULL`,
      [current.tenantId, id],
    );
    if (!device.rows.length) return reply.code(404).send({ error: 'Device not found' });
    const { device_code, mqtt_username, topic, site_reference, legacy_plain_mqtt } = device.rows[0];
    if (!topic) return reply.code(409).send({ error: 'Device has no MQTT topic mapping' });
    const username = mqtt_username ?? device_code.toLowerCase();
    const password = deviceSecret();
    await db.transaction(async (sql) => {
      await sql.query(
        'UPDATE devices SET mqtt_username=$3,mqtt_credential_rotated_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [current.tenantId, id, username],
      );
      await recordAudit(sql, req, current, {
        action: 'device.mqtt_credential.rotate',
        targetType: 'device',
        targetId: id,
        summary: { device_code, mqtt_username: username },
      });
    });
    const credentialActive = await provisionMqttRequest('upsert', username, password, topic);
    return {
      connection: {
        host: env.MQTT_PUBLIC_HOST ?? env.MQTT_HOST,
        ...brokerPort(legacy_plain_mqtt),
        topic,
        username,
        password,
        clientReference: site_reference,
        credentialActive,
      },
    };
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
        legacyPlainMqtt: z.boolean().optional(),
        legacyAllowedIps: z.array(ipv4).max(20).optional(),
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
    const adapterType = adapterFor(manufacturer);
    const updated = await db.query(
      `UPDATE devices SET site_id=COALESCE($3,site_id),name=COALESCE($4,name),
       manufacturer=$5,model=$6,serial_number=CASE WHEN $7::boolean THEN $8 ELSE serial_number END,
       adapter_type=$9,legacy_plain_mqtt=COALESCE($10,legacy_plain_mqtt),
       legacy_allowed_ips=COALESCE($11::text[],legacy_allowed_ips),updated_at=now()
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
        body.legacyPlainMqtt ?? null,
        body.legacyAllowedIps ? [...new Set(body.legacyAllowedIps)] : null,
      ],
    );
    if (!updated.rows.length) return reply.code(404).send({ error: 'Device not found' });
    await recordAudit(db, req, current, {
      action: 'device.update',
      targetType: 'device',
      targetId: id,
      summary: { changed: Object.keys(body), manufacturer, model },
    });
    return updated.rows[0];
  });
  // Addresses a legacy HMI tried the compatibility port from and was refused (migration 016).
  // The device page lists them so a person can release the right one.
  app.get('/api/devices/:id/legacy-attempts', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    return (
      await db.query(
        `SELECT source_ip,first_seen_at,last_seen_at,attempts FROM device_legacy_attempts
         WHERE tenant_id=$1 AND device_id=$2 ORDER BY last_seen_at DESC LIMIT 20`,
        [access.principal(req).tenantId, id],
      )
    ).rows;
  });
  // Releases one address: the device switches to legacy mode, the address joins its list and
  // its refused attempts are cleared. The compatibility port picks it up within seconds.
  app.post('/api/devices/:id/legacy-allow', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { ip } = z.object({ ip: ipv4 }).parse(req.body);
    const released = await db.transaction(async (sql) => {
      const updated = await sql.query<{ legacy_allowed_ips: string[] }>(
        `UPDATE devices SET legacy_plain_mqtt=true,
         legacy_allowed_ips=(SELECT array_agg(DISTINCT address ORDER BY address)
           FROM unnest(legacy_allowed_ips || ARRAY[$3::text]) address),
         updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL RETURNING legacy_allowed_ips`,
        [current.tenantId, id, ip],
      );
      if (!updated.rows.length) return null;
      await sql.query(
        'DELETE FROM device_legacy_attempts WHERE tenant_id=$1 AND device_id=$2 AND source_ip=$3',
        [current.tenantId, id, ip],
      );
      await recordAudit(sql, req, current, {
        action: 'device.legacy_ip.allow',
        targetType: 'device',
        targetId: id,
        summary: { ip },
      });
      return updated.rows[0].legacy_allowed_ips;
    });
    if (!released) return reply.code(404).send({ error: 'Device not found' });
    return { legacyPlainMqtt: true, legacyAllowedIps: released };
  });
  // Deleting a device removes it and everything recorded for it (purge_device, migration 015):
  // samples, raw messages, variables, topic, status and dashboard. Only the audit log keeps
  // who deleted it and when. Deletion used to archive the device and leave all of that behind.
  app.delete('/api/devices/:id', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const tenantId = access.principal(req).tenantId;
    const found = await db.query<{
      name: string;
      device_code: string | null;
      mqtt_username: string | null;
    }>('SELECT name,device_code,mqtt_username FROM devices WHERE tenant_id=$1 AND id=$2', [
      tenantId,
      id,
    ]);
    if (!found.rows.length) return reply.code(404).send({ error: 'Device not found' });
    await db.query('SELECT purge_device($1,$2)', [tenantId, id]);
    await recordAudit(db, req, access.principal(req), {
      action: 'device.delete',
      targetType: 'device',
      targetId: id,
      summary: { ...found.rows[0] },
    });
    if (found.rows[0].mqtt_username)
      await provisionMqttRequest('delete', found.rows[0].mqtt_username, '', '');
    return reply.code(204).send();
  });
  app.get('/api/telemetry', async (req, reply) => {
    const q = telemetryPagination
      .extend({
        deviceId: uuid,
        tagId: uuid.optional(),
        bucket: z.enum(['minute']).optional(),
        ...timeRange,
      })
      .parse(req.query);
    checkRange(q);
    if (!(await access.requireDevice(req, reply, q.deviceId))) return;
    // Chart history: one averaged point per numeric variable and minute, with only the columns
    // a chart draws. Dashboards polled the raw rows of the whole window every 2 s (over a
    // thousand full rows per call), which alone drained the database egress allowance.
    if (q.bucket === 'minute')
      return (
        await db.query(
          `SELECT s.tag_id,t.key,t.unit,
             date_bin('1 minute',s.timestamp,timestamptz '2000-01-01') AS timestamp,
             avg(s.value_number)::double precision value_number,
             NULL::text value_text,NULL::boolean value_boolean,'good' quality
           FROM telemetry_samples s JOIN tags t ON t.id=s.tag_id AND t.tenant_id=s.tenant_id
           WHERE s.tenant_id=$1 AND s.device_id=$2 AND ($3::uuid IS NULL OR s.tag_id=$3)
             AND s.value_number IS NOT NULL
             AND ($4::timestamptz IS NULL OR s.timestamp >= $4)
             AND ($5::timestamptz IS NULL OR s.timestamp <= $5)
           GROUP BY s.tag_id,t.key,t.unit,4
           ORDER BY 4 DESC LIMIT $6 OFFSET $7`,
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
    const query = z
      .object({
        period: z
          .enum(['today', '7d', 'week', 'month', 'year', '30d', '365d', 'custom'])
          .default('7d'),
        // One widget at a time: each production chart carries its own period filter.
        widgetId: uuid.optional(),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(req.query);
    const current = access.principal(req);
    const view = await dashboardView(db, current, id, await access.accessibleDeviceIds(req));
    if (!view) return reply.code(404).send({ error: 'Dashboard not found' });
    let customFrom: string | null = null;
    let customTo: string | null = null;
    let periodDays = {
      today: 1,
      '7d': 7,
      week: 7,
      month: 30,
      year: 365,
      '30d': 30,
      '365d': 365,
      custom: 7,
    }[query.period];
    if (query.period === 'custom') {
      if (!query.from || !query.to)
        return reply.code(400).send({ error: 'from and to are required for a custom period' });
      periodDays =
        Math.floor(
          (Date.parse(`${query.to}T12:00:00Z`) - Date.parse(`${query.from}T12:00:00Z`)) / 86400000,
        ) + 1;
      if (periodDays < 1 || periodDays > 366)
        return reply.code(400).send({ error: 'Custom period must contain between 1 and 366 days' });
      customFrom = query.from;
      customTo = query.to;
    }
    // Calendar periods up to today in plant time: the week starts on Monday.
    if (query.period === 'week' || query.period === 'month' || query.period === 'year') {
      const localToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const todayNoon = new Date(`${localToday}T12:00:00Z`);
      const start = new Date(todayNoon);
      if (query.period === 'week')
        start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      else if (query.period === 'month') start.setUTCDate(1);
      else start.setUTCMonth(0, 1);
      customFrom = start.toISOString().slice(0, 10);
      customTo = localToday;
      periodDays = Math.round((todayNoon.getTime() - start.getTime()) / 86400000) + 1;
    }
    const productionWidgets = view.widgets.filter(
      (widget) =>
        // Quick charts are views of the same production metric and share its answer.
        ['production', 'donut', 'bar_vertical', 'bar_horizontal'].includes(widget.widget_type) &&
        widget.tag_id &&
        (!query.widgetId || widget.id === query.widgetId),
    );
    return Promise.all(
      productionWidgets.map(async (widget) => {
        const widgetConfig = widget.config as {
          productionMinimumValue?: unknown;
          productionMetricKind?: unknown;
        };
        const requestedMinimum = Number(widgetConfig.productionMinimumValue ?? 0.1);
        const minimumValue = Number.isFinite(requestedMinimum) ? requestedMinimum : 0.1;
        const metricKind =
          widgetConfig.productionMetricKind === 'counter_delta' ? 'counter_delta' : 'rate_average';
        const rows = (
          await db.query<{
            date: string;
            product_code: string;
            value: number | null;
            samples: number;
            minimum: number | null;
            maximum: number | null;
            is_current: boolean;
          }>(
            `WITH selected AS (
           SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date today
         ), bounds AS (
           SELECT coalesce($7::date,today-($5::int-1)) start_date,
             coalesce($8::date,today) end_date FROM selected
         ), dated AS (
           SELECT b.*,(b.start_date-(b.end_date-b.start_date+1)) previous_start FROM bounds b
         )
         SELECT to_char((r.bucket AT TIME ZONE 'America/Sao_Paulo')::date,'YYYY-MM-DD') date,
           r.product_code,
           CASE WHEN $4='counter_delta' THEN sum(r.positive_delta)
             ELSE sum(r.value_sum) FILTER (WHERE r.value_sum/r.sample_count >= $6)
               / nullif(sum(r.sample_count) FILTER (WHERE r.value_sum/r.sample_count >= $6),0)
           END value,
           coalesce(sum(r.sample_count) FILTER (
             WHERE $4='counter_delta' OR r.value_sum/r.sample_count >= $6
           ),0)::int samples,
           min(r.value_min) FILTER (
             WHERE $4='counter_delta' OR r.value_sum/r.sample_count >= $6
           ) minimum,
           max(r.value_max) FILTER (
             WHERE $4='counter_delta' OR r.value_sum/r.sample_count >= $6
           ) maximum,
           (r.bucket AT TIME ZONE 'America/Sao_Paulo')::date >= d.start_date is_current
         FROM telemetry_hourly_rollups r CROSS JOIN dated d
         WHERE r.tenant_id=$1 AND r.device_id=$2 AND r.tag_id=$3
           AND r.product_code NOT IN (
             SELECT h.product_code FROM hidden_products h WHERE h.device_id=r.device_id
           )
           AND r.bucket >= (d.previous_start::timestamp AT TIME ZONE 'America/Sao_Paulo')
           AND r.bucket < ((d.end_date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
         GROUP BY (r.bucket AT TIME ZONE 'America/Sao_Paulo')::date,r.product_code,d.start_date
         ORDER BY date,r.product_code`,
            [
              current.tenantId,
              widget.device_id,
              widget.tag_id,
              metricKind,
              periodDays,
              minimumValue,
              customFrom,
              customTo,
            ],
          )
        ).rows;
        const hidden = (
          await db.query<{ product_code: string }>(
            'SELECT product_code FROM hidden_products WHERE tenant_id=$1 AND device_id=$2 ORDER BY product_code',
            [current.tenantId, widget.device_id],
          )
        ).rows.map((row) => row.product_code);
        const currentRows = rows.filter((row) => row.is_current);
        const previousRows = rows.filter((row) => !row.is_current);
        const summarize = (selected: typeof rows) => {
          const usable = selected.filter((row) => row.value != null);
          if (!usable.length) return null;
          return metricKind === 'counter_delta'
            ? usable.reduce((total, row) => total + Number(row.value), 0)
            : usable.reduce((total, row) => total + Number(row.value) * row.samples, 0) /
                Math.max(
                  1,
                  usable.reduce((total, row) => total + row.samples, 0),
                );
        };
        const currentPeriodValue = summarize(currentRows);
        const previousPeriodValue = summarize(previousRows);
        const byDate = new Map<string, { total: number; weighted: number; samples: number }>();
        for (const row of currentRows) {
          if (row.value == null) continue;
          const day = byDate.get(row.date) ?? { total: 0, weighted: 0, samples: 0 };
          day.total += Number(row.value);
          day.weighted += Number(row.value) * row.samples;
          day.samples += row.samples;
          byDate.set(row.date, day);
        }
        const localToday = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Sao_Paulo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date());
        const periodEnd = customTo ?? localToday;
        const offsetDate = (date: string, amount: number) => {
          const parsed = new Date(`${date}T12:00:00Z`);
          parsed.setUTCDate(parsed.getUTCDate() + amount);
          return parsed.toISOString().slice(0, 10);
        };
        const periodStart = customFrom ?? offsetDate(periodEnd, -(periodDays - 1));
        const dailySeries =
          periodDays <= 60
            ? Array.from({ length: periodDays }, (_, index) => {
                const date = offsetDate(periodStart, index);
                const day = byDate.get(date);
                return {
                  date,
                  value: day
                    ? metricKind === 'counter_delta'
                      ? day.total
                      : day.weighted / Math.max(1, day.samples)
                    : null,
                  samples: day?.samples ?? 0,
                };
              })
            : [
                ...[...byDate.entries()].reduce((months, [date, day]) => {
                  const month = date.slice(0, 7);
                  const aggregate = months.get(month) ?? { total: 0, weighted: 0, samples: 0 };
                  aggregate.total += day.total;
                  aggregate.weighted += day.weighted;
                  aggregate.samples += day.samples;
                  months.set(month, aggregate);
                  return months;
                }, new Map<string, { total: number; weighted: number; samples: number }>()),
              ].map(([date, month]) => ({
                date,
                value:
                  metricKind === 'counter_delta'
                    ? month.total
                    : month.weighted / Math.max(1, month.samples),
                samples: month.samples,
              }));
        const byProduct = new Map<string, { total: number; weighted: number; samples: number }>();
        for (const row of currentRows) {
          if (row.value == null) continue;
          const product = byProduct.get(row.product_code) ?? { total: 0, weighted: 0, samples: 0 };
          product.total += Number(row.value);
          product.weighted += Number(row.value) * row.samples;
          product.samples += row.samples;
          byProduct.set(row.product_code, product);
        }
        const productBreakdown = [...byProduct.entries()]
          .map(([product_code, product]) => ({
            product_code,
            value:
              metricKind === 'counter_delta'
                ? product.total
                : product.weighted / Math.max(1, product.samples),
            samples: product.samples,
          }))
          .sort((a, b) => b.value - a.value);
        const distributionTotal = productBreakdown.reduce(
          (total, product) => total + product.value,
          0,
        );
        const best = [...dailySeries].sort((a, b) => Number(b.value) - Number(a.value))[0];
        const changePercent =
          currentPeriodValue != null && previousPeriodValue != null && previousPeriodValue !== 0
            ? ((currentPeriodValue - previousPeriodValue) / Math.abs(previousPeriodValue)) * 100
            : null;
        const minimumValues = currentRows.flatMap((row) =>
          row.minimum == null ? [] : [Number(row.minimum)],
        );
        const maximumValues = currentRows.flatMap((row) =>
          row.maximum == null ? [] : [Number(row.maximum)],
        );
        return {
          widget_id: widget.id,
          tag_id: widget.tag_id,
          period: query.period,
          period_days: periodDays,
          period_minutes: periodDays * 1440,
          minimum_value: minimumValue,
          metric_kind: metricKind,
          trend_days: periodDays,
          current_period_value: currentPeriodValue,
          previous_period_value: previousPeriodValue,
          change_percent: changePercent,
          best_day: best?.date ?? null,
          best_value: best?.value ?? null,
          daily_series: dailySeries,
          bucket_granularity: periodDays > 60 ? 'month' : 'day',
          hidden_products: hidden,
          product_breakdown: productBreakdown.map((product) => ({
            ...product,
            share_percent: distributionTotal > 0 ? (product.value / distributionTotal) * 100 : 0,
          })),
          samples: currentRows.reduce((total, row) => total + row.samples, 0),
          ignored_samples: 0,
          minimum: minimumValues.length ? Math.min(...minimumValues) : null,
          maximum: maximumValues.length ? Math.max(...maximumValues) : null,
          average: metricKind === 'rate_average' ? currentPeriodValue : null,
          trend_per_second: null,
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
    // Only the dashboard row changes; rewriting every card here used to erase a card edit
    // saved a moment earlier by another tab or request.
    await db.query(
      `UPDATE dashboards SET refresh_ms=$3,time_window_minutes=$4,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [
        current.tenantId,
        id,
        body.refreshMs ?? view.refresh_ms,
        body.timeWindowMinutes ?? view.time_window_minutes,
      ],
    );
    return dashboardView(db, current, id, await access.accessibleDeviceIds(req));
  });
  app.post('/api/dashboards/:id/widgets', async (req, reply) => {
    const current = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        deviceId: uuid,
        tagId: uuid.nullable().optional(),
        widgetType: z.enum([
          'value',
          'line',
          'gauge',
          'status',
          'production',
          'oee',
          'pareto',
          'donut',
          'bar_vertical',
          'bar_horizontal',
          'shift_board',
        ]),
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
    const inserted = await db.query<{ position: number }>(
      `INSERT INTO dashboard_widgets(id,tenant_id,dashboard_id,device_id,tag_id,widget_type,title,position,width,config)
       VALUES($1,$2,$3,$4,$5,$6,$7,
         (SELECT COALESCE(max(position)+1,0) FROM dashboard_widgets WHERE tenant_id=$2 AND dashboard_id=$3),
         $8,$9::jsonb)
       RETURNING position`,
      [
        widget.id,
        current.tenantId,
        id,
        widget.device_id,
        widget.tag_id,
        widget.widget_type,
        widget.title,
        widget.width,
        JSON.stringify(widget.config),
      ],
    );
    return reply.code(201).send({ ...widget, position: inserted.rows[0].position });
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
    // One row, config merged inside the database: concurrent edits to other cards, or to
    // other keys of this one, are never overwritten by a stale copy of the dashboard.
    await db.query(
      `UPDATE dashboard_widgets SET title=COALESCE($4,title),width=COALESCE($5,width),
         config=config || $6::jsonb,updated_at=now()
       WHERE tenant_id=$1 AND dashboard_id=$2 AND id=$3`,
      [
        current.tenantId,
        dashboardId,
        widgetId,
        body.title ?? null,
        body.width ?? null,
        JSON.stringify(body.config ?? {}),
      ],
    );
    const fresh = await dashboardView(
      db,
      current,
      dashboardId,
      await access.accessibleDeviceIds(req),
    );
    return fresh?.widgets.find((widget) => widget.id === widgetId) ?? updated;
  });
  // Zeroing records the moment, not the raw value. The HMI counter itself rolls back to zero
  // on shift, recipe or power cycles, so a remembered raw baseline stopped meaning anything
  // within minutes. Server time is used so a wrong client clock cannot shift the reset.
  app.post('/api/dashboards/:dashboardId/widgets/:widgetId/reset-counter', async (req, reply) => {
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
    const index = view.widgets.findIndex((widget) => widget.id === widgetId);
    if (index < 0) return reply.code(404).send({ error: 'Widget not found' });
    const widget = view.widgets[index];
    if (!widget.tag_id || (widget as { data_type?: string }).data_type !== 'number')
      return reply.code(400).send({ error: 'Only numeric widgets can be zeroed' });
    // With a reset variable set, "Zerar contador" also zeroes the count in the PLC: the HMI
    // receives { "<variable>": 1 } on its command topic and writes the bit, and the PLC
    // program clears the count. The bit is pulsed back to 0 so it never stays set if the PLC
    // does not clear it itself. The panel is zeroed only once the broker accepted the command.
    const resetVariable = String(
      (widget.config as { resetVariable?: unknown }).resetVariable ?? '',
    ).trim();
    let command: { topic: string; variable: string } | null = null;
    if (resetVariable) {
      if (!/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(resetVariable))
        return reply.code(400).send({ error: 'Nome da variável de reset inválido.' });
      const mapping = await db.query<{ topic: string }>(
        `SELECT topic FROM device_topic_mappings
         WHERE tenant_id=$1 AND device_id=$2 AND kind='exact' AND topic LIKE 'iiot/%/telemetry'
         ORDER BY id LIMIT 1`,
        [current.tenantId, widget.device_id],
      );
      const telemetry = mapping.rows[0]?.topic;
      if (!telemetry || telemetry.split('/').length !== 5)
        return reply.code(409).send({
          error: 'Este equipamento não tem um tópico da plataforma para receber comandos.',
        });
      const topic = telemetry.replace(/\/telemetry$/, '/command');
      const send = settings.publishCommand ?? publishCommand;
      try {
        await send(topic, { [resetVariable]: 1 });
      } catch (error) {
        req.log.error({
          event: 'counter_reset_command_failed',
          topic,
          error: error instanceof Error ? error.message : String(error),
        });
        return reply
          .code(502)
          .send({ error: 'Não foi possível enviar o comando ao equipamento. Nada foi zerado.' });
      }
      setTimeout(() => {
        send(topic, { [resetVariable]: 0 }).catch((error: unknown) =>
          req.log.error({
            event: 'counter_reset_release_failed',
            topic,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }, COMMAND_PULSE_MS).unref();
      command = { topic, variable: resetVariable };
    }
    const resetAt = new Date().toISOString();
    const config: Record<string, unknown> = { ...(widget.config as Record<string, unknown>) };
    delete config.counterBaseline;
    view.widgets[index] = {
      ...widget,
      config: { ...config, counterMode: true, counterResetAt: resetAt },
    };
    await db.query(
      `UPDATE dashboard_widgets
       SET config=(config - 'counterBaseline')
         || jsonb_build_object('counterMode', true, 'counterResetAt', $4::text),
         updated_at=now()
       WHERE tenant_id=$1 AND dashboard_id=$2 AND id=$3`,
      [current.tenantId, dashboardId, widgetId, resetAt],
    );
    await recordAudit(db, req, current, {
      action: 'dashboard.widget.counter_reset',
      targetType: 'widget',
      targetId: widgetId,
      summary: {
        dashboard_id: dashboardId,
        reset_at: resetAt,
        ...(command ? { command_topic: command.topic, command_variable: command.variable } : {}),
      },
    });
    return view.widgets[index];
  });
  // Count since the reset = every positive increment after that moment, with the same rule
  // as the production rollups: a drop is the HMI restarting, so the new value is added.
  // The partial first hour comes from raw samples; whole hours after it from the rollups.
  app.get('/api/dashboards/:id/counters', async (req, reply) => {
    const current = access.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const view = await dashboardView(db, current, id, await access.accessibleDeviceIds(req));
    if (!view) return reply.code(404).send({ error: 'Dashboard not found' });
    const zeroed = view.widgets.filter((widget) => {
      const config = widget.config as { counterMode?: unknown; counterResetAt?: unknown };
      return (
        widget.tag_id && config.counterMode === true && typeof config.counterResetAt === 'string'
      );
    });
    return Promise.all(
      zeroed.map(async (widget) => {
        const resetAt = (widget.config as { counterResetAt: string }).counterResetAt;
        const result = await db.query<{ since_reset: number | null }>(
          `WITH bounds AS (
             SELECT $4::timestamptz reset_at,
               date_trunc('hour',$4::timestamptz)+interval '1 hour' boundary
           ), partial AS (
             SELECT sum(CASE WHEN s.previous IS NULL OR s.timestamp <= b.reset_at THEN 0
                 WHEN s.value_number >= s.previous THEN s.value_number-s.previous
                 ELSE greatest(s.value_number,0) END) increment
             FROM (
               SELECT t.timestamp,t.value_number,
                 lag(t.value_number) OVER (ORDER BY t.timestamp,t.id) previous
               FROM telemetry_samples t CROSS JOIN bounds
               WHERE t.tenant_id=$1 AND t.device_id=$2 AND t.tag_id=$3
                 AND t.value_number IS NOT NULL
                 AND t.timestamp > bounds.reset_at - interval '1 hour'
                 AND t.timestamp < bounds.boundary
             ) s CROSS JOIN bounds b
           ), full_hours AS (
             SELECT sum(r.positive_delta) increment
             FROM telemetry_hourly_rollups r CROSS JOIN bounds b
             WHERE r.tenant_id=$1 AND r.device_id=$2 AND r.tag_id=$3 AND r.bucket >= b.boundary
           )
           SELECT coalesce((SELECT increment FROM partial),0)
             + coalesce((SELECT increment FROM full_hours),0) since_reset`,
          [current.tenantId, widget.device_id, widget.tag_id, resetAt],
        );
        return {
          widget_id: widget.id,
          reset_at: resetAt,
          since_reset: Number(result.rows[0]?.since_reset ?? 0),
        };
      }),
    );
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
    // Positions are unique per dashboard, so they move out of the way first, then land.
    await db.transaction(async (sql) => {
      await sql.query(
        'UPDATE dashboard_widgets SET position=-position-1 WHERE tenant_id=$1 AND dashboard_id=$2',
        [current.tenantId, id],
      );
      await sql.query(
        `UPDATE dashboard_widgets w SET position=v.ordinality-1,updated_at=now()
         FROM unnest($3::uuid[]) WITH ORDINALITY AS v(widget_id, ordinality)
         WHERE w.tenant_id=$1 AND w.dashboard_id=$2 AND w.id=v.widget_id`,
        [current.tenantId, id, widgetIds],
      );
    });
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
    await db.query(
      'DELETE FROM dashboard_widgets WHERE tenant_id=$1 AND dashboard_id=$2 AND id=$3',
      [current.tenantId, dashboardId, widgetId],
    );
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
  widget_type:
    | 'value'
    | 'line'
    | 'gauge'
    | 'status'
    | 'production'
    | 'oee'
    | 'pareto'
    | 'donut'
    | 'bar_vertical'
    | 'bar_horizontal'
    | 'shift_board';
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
