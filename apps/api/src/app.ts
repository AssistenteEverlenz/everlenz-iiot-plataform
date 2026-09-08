import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { env } from '@iiot/shared';
import { database, type Database } from '@iiot/database';
const uuid = z.uuid();
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
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
export function createApp(
  db: Database = database,
  settings = { tenantId: env.DEV_TENANT_ID, operatorRaw: env.OPERATOR_RAW_ACCESS },
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
  const tenant = settings.tenantId;
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
    async () => (await db.query('SELECT * FROM tenants WHERE id=$1', [tenant])).rows,
  );
  app.get('/api/sites', async (req) => {
    const q = pagination.parse(req.query);
    return (
      await db.query('SELECT * FROM sites WHERE tenant_id=$1 ORDER BY name,id LIMIT $2 OFFSET $3', [
        tenant,
        q.limit,
        q.offset,
      ])
    ).rows;
  });
  const deviceSelect = `SELECT d.*,ds.last_message_at,COALESCE(d.enabled AND ds.last_message_at > now()-($2::int * interval '1 second'),false) online FROM devices d LEFT JOIN device_status ds ON ds.device_id=d.id AND ds.tenant_id=d.tenant_id`;
  app.get('/api/devices', async (req) => {
    const q = pagination.parse(req.query);
    return (
      await db.query(
        `${deviceSelect} WHERE d.tenant_id=$1 ORDER BY d.name,d.id LIMIT $3 OFFSET $4`,
        [tenant, env.DEVICE_OFFLINE_SECONDS, q.limit, q.offset],
      )
    ).rows;
  });
  app.get('/api/devices/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const result = await db.query(`${deviceSelect} WHERE d.tenant_id=$1 AND d.id=$3`, [
      tenant,
      env.DEVICE_OFFLINE_SECONDS,
      id,
    ]);
    return result.rows[0] ?? reply.code(404).send({ error: 'Device not found' });
  });
  app.get('/api/devices/:id/tags', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return (
      await db.query('SELECT * FROM tags WHERE tenant_id=$1 AND device_id=$2 ORDER BY key', [
        tenant,
        id,
      ])
    ).rows;
  });
  app.get('/api/devices/:id/latest', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return (
      await db.query(
        `SELECT DISTINCT ON (t.id) t.id tag_id,t.key,t.unit,t.data_type,s.timestamp,s.value_number,s.value_text,s.value_boolean,s.quality FROM tags t LEFT JOIN telemetry_samples s ON s.tag_id=t.id AND s.tenant_id=t.tenant_id WHERE t.tenant_id=$1 AND t.device_id=$2 AND t.enabled=true ORDER BY t.id,s.timestamp DESC NULLS LAST,s.id DESC`,
        [tenant, id],
      )
    ).rows;
  });
  app.get('/api/telemetry', async (req) => {
    const q = pagination
      .extend({ deviceId: uuid, tagId: uuid.optional(), ...timeRange })
      .parse(req.query);
    checkRange(q);
    return (
      await db.query(
        `SELECT s.*,t.key,t.unit FROM telemetry_samples s JOIN tags t ON t.id=s.tag_id AND t.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.device_id=$2 AND ($3::uuid IS NULL OR s.tag_id=$3) AND ($4::timestamptz IS NULL OR s.timestamp >= $4) AND ($5::timestamptz IS NULL OR s.timestamp <= $5) ORDER BY s.timestamp DESC,s.id DESC LIMIT $6 OFFSET $7`,
        [tenant, q.deviceId, q.tagId ?? null, q.from ?? null, q.to ?? null, q.limit, q.offset],
      )
    ).rows;
  });
  // Separate local operator scope is needed to inspect messages whose tenant is still unknown.
  const rawScope = settings.operatorRaw ? '(tenant_id=$1 OR tenant_id IS NULL)' : 'tenant_id=$1';
  app.get('/api/mqtt/raw', async (req) => {
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
          tenant,
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
  app.get('/api/mqtt/topics', async (req) => {
    const q = pagination.parse(req.query);
    return (
      await db.query(
        `SELECT topic,count(*)::int message_count,min(received_at) first_seen,max(received_at) last_seen FROM mqtt_messages_raw WHERE ${rawScope} GROUP BY topic ORDER BY max(received_at) DESC,topic LIMIT $2 OFFSET $3`,
        [tenant, q.limit, q.offset],
      )
    ).rows;
  });
  app.get('/api/overview', async () => {
    const devices = await db.query<{ count: number }>(
      'SELECT count(*)::int count FROM devices WHERE tenant_id=$1',
      [tenant],
    );
    const raw = await db.query<{ count: number; last_message_at: string | null }>(
      `SELECT count(*)::int count,max(received_at) last_message_at FROM mqtt_messages_raw WHERE ${rawScope}`,
      [tenant],
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
