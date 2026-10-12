import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import { addDays, plantDate, plantInstant } from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';
import { composeMessage, gatherDay, type DayFacts } from './daily-report.js';
import { dayImages } from './daily-images.js';
import { loadConfig, loadShiftsFor } from './shift-production.js';

/**
 * The daily production summary on WhatsApp (migration 043).
 *
 * A day is closed when every shift of it is over and the line has been quiet for half an hour, so
 * the overtime of a shift that ran late is in the summary. A line still running at night is
 * summed up the next morning at 07:00 instead. One message per person per day, with every
 * machine the person sees, written into a queue that n8n drains one message at a time.
 *
 * The pace is the queue's, not n8n's: a message is handed out only inside the sending window and
 * only when the previous one went out at least MIN_GAP_MS ago, with a random spread on top, so
 * the number never sends in bursts and does not read as spam.
 */
const QUIET_MS = 30 * 60_000;
/**
 * The sending window, plant hours [start, end): WHATSAPP_SEND_WINDOW="7-21" by default, read on
 * every call so it can be opened ("0-24", for a test at night) and closed again from the
 * environment alone.
 */
export function sendWindow() {
  const match = String(process.env.WHATSAPP_SEND_WINDOW ?? '').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  const start = match ? Math.min(23, Number(match[1])) : 7;
  const end = match ? Math.max(start + 1, Math.min(24, Number(match[2]))) : 21;
  return { start, end };
}
const MIN_GAP_MS = 3 * 60_000;
const LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;

type Access = ReturnType<typeof createAccessControl>;

/** "55" + DDD + number, the way WhatsApp addresses a Brazilian phone; null when it is not one. */
export function normalizePhone(input: string | null | undefined) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const national = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
  if (national.length !== 10 && national.length !== 11) return null;
  return `55${national}`;
}

/** Hour of the day at the plant (UTC-3 all year). */
function plantHour(at: Date) {
  return new Date(at.getTime() - 3 * 3600_000).getUTCHours();
}

/** The first moment, from `at` on, inside the sending window. */
function nextWindow(at: Date) {
  const { start, end } = sendWindow();
  const hour = plantHour(at);
  if (hour >= start && hour < end) return at;
  const date = plantDate(at);
  return plantInstant(hour < start ? date : addDays(date, 1), `${String(start).padStart(2, '0')}:00`);
}

interface DeviceDay {
  deviceId: string;
  closed: boolean;
  /** No shift that day (or no counter): the machine is left out of the message. */
  noShift: boolean;
  facts: DayFacts | null;
}

/** One machine's day: closed yet (overtime included), and its facts once it is. */
async function deviceDay(
  db: Database,
  tenantId: string,
  device: { id: string; name: string; dashboard_id: string | null; last_increment_at: Date | null },
  date: string,
  now: Date,
): Promise<DeviceDay> {
  const base = { deviceId: device.id };
  const config = await loadConfig(db, tenantId, device.id);
  if (!config || !(config.blocks_tag_id || config.pallets_tag_id))
    return { ...base, closed: true, noShift: true, facts: null };
  const occurrences = (await loadShiftsFor(db, tenantId, config.site_id, date)).filter(
    (item) => item.productionDate === date,
  );
  if (!occurrences.length) return { ...base, closed: true, noShift: true, facts: null };
  const lastEnd = Math.max(...occurrences.map((item) => item.end.getTime()));
  const quiet =
    !device.last_increment_at || now.getTime() - new Date(device.last_increment_at).getTime() >= QUIET_MS;
  const morningAfter = plantInstant(addDays(date, 1), '07:00').getTime();
  const closed =
    now.getTime() >= lastEnd + QUIET_MS && (quiet || now.getTime() >= morningAfter);
  if (!closed) return { ...base, closed: false, noShift: false, facts: null };
  const facts = await gatherDay(db, tenantId, device, date);
  return { ...base, closed: true, noShift: !facts, facts };
}

function greeting(name: string, at: Date) {
  const hour = plantHour(at);
  const first = name.trim().split(/\s+/)[0] ?? '';
  const salute = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  // A few openings, so a hundred summaries are not a hundred identical texts.
  const openings = [
    `${salute}, ${first}! Aqui está o fechamento de produção`,
    `${salute}, ${first}. Segue o resumo do dia de produção`,
    `${salute}, ${first}! O dia de produção fechou, veja como foi`,
  ];
  return openings[Math.floor(Math.random() * openings.length)];
}

/** Stands for the greeting until the message is handed out: "bom dia" is told at sending time. */
const GREETING = '{{saudacao}}';

function messageText(date: string, days: DeviceDay[], kind: 'daily' | 'test') {
  const web = (process.env.PUBLIC_WEB_URL ?? 'https://iotplataform.everlenz.com.br').replace(/\/$/, '');
  return composeMessage(
    days.map((day) => day.facts).filter((facts): facts is DayFacts => facts != null),
    web,
    kind,
  );
}

interface Recipient {
  id: string;
  tenant_id: string;
  full_name: string;
  role: 'master' | 'user';
  phone: string;
  whatsapp_since: Date | null;
}

async function devicesOf(db: Database, user: Recipient) {
  return (
    await db.query<{ id: string; name: string; dashboard_id: string | null; last_increment_at: Date | null }>(
      `SELECT d.id,d.name,pr.last_increment_at,
         (SELECT da.id FROM dashboards da WHERE da.tenant_id=d.tenant_id AND da.device_id=d.id
          ORDER BY da.is_default DESC,da.created_at LIMIT 1) dashboard_id
       FROM devices d
       LEFT JOIN production_runtime pr ON pr.device_id=d.id AND pr.tenant_id=d.tenant_id
       WHERE d.tenant_id=$1 AND d.archived_at IS NULL AND d.enabled=true
         AND ($3::text='master' OR EXISTS (SELECT 1 FROM user_device_access a
           WHERE a.tenant_id=d.tenant_id AND a.user_id=$2 AND a.device_id=d.id))
       ORDER BY d.name`,
      [user.tenant_id, user.id, user.role],
    )
  ).rows;
}

/**
 * Writes the summaries of the days that have closed. Runs on the API's minute timer; cheap when
 * nobody receives them (one query). A machine read for one person is not read again for the next.
 */
export async function queueProductionMessages(db: Database, now = new Date()) {
  let recipients: Recipient[];
  try {
    recipients = (
      await db.query<Recipient>(
        `SELECT id,tenant_id,full_name,role,phone,whatsapp_since FROM app_users
         WHERE whatsapp_daily AND phone IS NOT NULL AND status='active'`,
      )
    ).rows;
  } catch {
    return 0; // Migration 043 not applied yet.
  }
  if (!recipients.length) return 0;
  const today = plantDate(now);
  const cache = new Map<string, Promise<DeviceDay>>();
  let queued = 0;
  for (const user of recipients) {
    for (const date of [addDays(today, -1), today]) {
      // Only days that close after the person asked for the summary.
      if (user.whatsapp_since && plantInstant(addDays(date, 1), '00:00') < new Date(user.whatsapp_since))
        continue;
      const exists = await db.query(
        `SELECT 1 FROM production_messages WHERE user_id=$1 AND production_date=$2 AND kind='daily'`,
        [user.id, date],
      );
      if (exists.rows.length) continue;
      const devices = await devicesOf(db, user);
      const days: DeviceDay[] = [];
      let waiting = false;
      for (const device of devices) {
        const key = `${device.id}|${date}`;
        if (!cache.has(key)) cache.set(key, deviceDay(db, user.tenant_id, device, date, now));
        const day = await cache.get(key)!;
        if (!day.closed) waiting = true;
        else if (!day.noShift) days.push(day);
      }
      if (waiting || !days.length) continue;
      const inserted = await db.query(
        `INSERT INTO production_messages(tenant_id,user_id,kind,production_date,phone,body,due_at)
         VALUES($1,$2,'daily',$3,$4,$5,$6)
         ON CONFLICT (user_id,production_date) WHERE kind='daily' DO NOTHING`,
        [user.tenant_id, user.id, date, user.phone, messageText(date, days, 'daily'), nextWindow(now)],
      );
      queued += inserted.rowCount ?? 0;
    }
  }
  return queued;
}

/** n8n authenticates with a shared key; the routes are off while none is configured. */
export function n8nAllowed(req: FastifyRequest, reply: FastifyReply) {
  const expected = process.env.N8N_API_KEY ?? '';
  if (!expected) {
    reply.code(503).send({ error: 'N8N_API_KEY não configurada' });
    return false;
  }
  const given = String(req.headers['x-n8n-key'] ?? '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    reply.code(401).send({ error: 'Chave inválida' });
    return false;
  }
  return true;
}

/**
 * The next message to send, or { message: null } with the reason. Handed out only inside the
 * sending window and at least MIN_GAP_MS after the last one; leased, so a run of n8n that dies
 * mid-way gives it back after LEASE_MS.
 */
export async function claimNextMessage(db: Database, now: Date) {
  const hour = plantHour(now);
  const window = sendWindow();
  if (hour < window.start || hour >= window.end)
    return { message: null, reason: 'fora da janela de envio' };
  // A day older than yesterday is no news anymore: it is dropped, not sent late.
  await db.query(
    `UPDATE production_messages SET status='skipped',error='expirou sem envio'
     WHERE status IN ('pending','sending') AND kind='daily' AND production_date < $1`,
    [addDays(plantDate(now), -1)],
  );
  const last = await db.query<{ at: Date | null }>(
    `SELECT max(greatest(sent_at,claimed_at)) at FROM production_messages
     WHERE status IN ('sent','sending')`,
  );
  const lastAt = last.rows[0]?.at ? new Date(last.rows[0].at).getTime() : 0;
  if (now.getTime() - lastAt < MIN_GAP_MS) return { message: null, reason: 'intervalo entre envios' };
  const claimed = await db.query<{ id: string; phone: string; body: string; kind: string }>(
    `UPDATE production_messages SET status='sending',claimed_at=$3,attempts=attempts+1
     WHERE id=(SELECT id FROM production_messages
       WHERE due_at <= $3 AND attempts < $1
         AND (status='pending' OR (status='sending' AND claimed_at < $3::timestamptz-($2::int * interval '1 millisecond')))
       ORDER BY kind='test' DESC,due_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id,phone,body,kind`,
    [MAX_ATTEMPTS, LEASE_MS, now],
  );
  const message = claimed.rows[0];
  if (!message) return { message: null, reason: 'fila vazia' };
  const person = await db.query<{ full_name: string }>(
    'SELECT u.full_name FROM production_messages m JOIN app_users u ON u.id=m.user_id WHERE m.id=$1',
    [message.id],
  );
  return {
    message: {
      id: message.id,
      number: message.phone,
      text: message.body.replace(GREETING, greeting(person.rows[0]?.full_name ?? '', now)),
      kind: message.kind,
      // Seconds n8n waits before sending, so the moments are not on the minute.
      waitSeconds: 5 + Math.floor(Math.random() * 40),
    },
  };
}

/**
 * The two images of each machine's day (production, stops) for a person, as base64 PNG. An image
 * that cannot be drawn is left out: the text still goes.
 */
async function imagesFor(db: Database, person: Recipient, date: string) {
  try {
    const brand = (
      await db.query<{ product_name: string; primary_color: string }>(
        'SELECT product_name,primary_color FROM tenant_branding WHERE tenant_id=$1',
        [person.tenant_id],
      )
    ).rows[0];
    const images: Array<{ device: string; kind: string; caption: string; fileName: string; mimetype: string; base64: string }> = [];
    for (const device of await devicesOf(db, person)) {
      const facts = await gatherDay(db, person.tenant_id, device, date);
      if (!facts) continue;
      for (const image of dayImages(facts, {
        name: brand?.product_name ?? 'Everlenz',
        color: brand?.primary_color ?? '#185785',
      }))
        images.push({
          device: device.name,
          kind: image.name,
          caption: `${image.name === 'producao' ? '📊 Produção' : '⛔ Paradas'} · ${device.name}`,
          fileName: `${image.name}-${date}.png`,
          mimetype: 'image/png',
          base64: Buffer.from(image.png).toString('base64'),
        });
    }
    return images;
  } catch {
    return [];
  }
}

/** The Evolution connection the summaries go out through, from the environment; null if unset. */
function evolution() {
  const url = (process.env.EVOLUTION_URL ?? '').trim().replace(/\/+$/, '');
  const instance = (process.env.EVOLUTION_INSTANCE ?? '').trim();
  const apikey = (process.env.EVOLUTION_APIKEY ?? '').trim();
  return url && instance && apikey ? { url, instance, apikey } : null;
}

/**
 * Push instead of pull: when N8N_SUMMARY_WEBHOOK_URL is set, the platform posts the next message
 * to n8n itself, at the queue's own pace (window, gap, lease), so the plants that close at 17:00
 * go out one by one. n8n sends it and answers on the result route; a webhook that does not take
 * it gives the message back to the queue.
 */
export async function dispatchProductionMessages(db: Database, now = new Date()) {
  const url = process.env.N8N_SUMMARY_WEBHOOK_URL ?? '';
  if (!url || !process.env.N8N_API_KEY) return 0;
  let next: Awaited<ReturnType<typeof claimNextMessage>>;
  try {
    next = await claimNextMessage(db, now);
  } catch {
    return 0; // Migration 043 not applied yet.
  }
  const message = next.message;
  if (!message) return 0;
  const details = await db.query<Recipient & { production_date: string }>(
    `SELECT u.id,u.tenant_id,u.full_name,u.role,u.phone,u.whatsapp_since,
       m.production_date::text production_date
     FROM production_messages m JOIN app_users u ON u.id=m.user_id WHERE m.id=$1`,
    [message.id],
  );
  const person = details.rows[0];
  const images = person ? await imagesFor(db, person, person.production_date) : [];
  const web = (process.env.PUBLIC_WEB_URL ?? 'https://iotplataform.everlenz.com.br').replace(/\/$/, '');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-n8n-key': process.env.N8N_API_KEY },
      body: JSON.stringify({
        ...message,
        name: person?.full_name ?? '',
        productionDate: person?.production_date ?? null,
        // Sent after the text, in this order: production, then stops, per machine.
        images,
        // Where to send it from, so the n8n flow needs no copy of it (EVOLUTION_* in Coolify).
        ...(evolution() ? { evolution: evolution() } : {}),
        resultUrl: `${web}/api/n8n/production-messages/${message.id}/result`,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`webhook respondeu HTTP ${response.status}`);
    return 1;
  } catch (error) {
    // Not taken: back to the queue, counted as an attempt, tried again in ten minutes.
    await db.query(
      `UPDATE production_messages SET error=$2,
         status=CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
         due_at=now()+interval '10 minutes'
       WHERE id=$1 AND status='sending'`,
      [message.id, error instanceof Error ? error.message.slice(0, 300) : 'falha no webhook', MAX_ATTEMPTS],
    );
    return 0;
  }
}

export const N8N_ROUTES = [
  '/api/n8n/production-messages/next',
  '/api/n8n/production-messages/:id/result',
];

export function registerProductionMessageRoutes(app: FastifyInstance, db: Database, access: Access) {
  // The next message for n8n: see claimNextMessage.
  app.get('/api/n8n/production-messages/next', async (req, reply) => {
    if (!n8nAllowed(req, reply)) return;
    return claimNextMessage(db, new Date());
  });

  app.post('/api/n8n/production-messages/:id/result', async (req, reply) => {
    if (!n8nAllowed(req, reply)) return;
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({ ok: z.boolean(), error: z.string().max(500).optional() })
      .parse(req.body);
    const updated = await db.query(
      body.ok
        ? `UPDATE production_messages SET status='sent',sent_at=now(),error=NULL
           WHERE id=$1 AND status='sending'`
        : `UPDATE production_messages SET error=$2,
             status=CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
             due_at=now()+interval '10 minutes'
           WHERE id=$1 AND status='sending'`,
      body.ok ? [id] : [id, body.error ?? 'falha no envio', MAX_ATTEMPTS],
    );
    if (!updated.rowCount) return reply.code(409).send({ error: 'Mensagem não está em envio' });
    return { ok: true };
  });

  // "Enviar teste": today's summary so far, to the person's phone, ahead of the queue.
  app.post('/api/users/:id/whatsapp-test', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const user = (
      await db.query<Recipient>(
        'SELECT id,tenant_id,full_name,role,phone,whatsapp_since FROM app_users WHERE tenant_id=$1 AND id=$2',
        [current.tenantId, id],
      )
    ).rows[0];
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado' });
    if (!user.phone) return reply.code(400).send({ error: 'Cadastre o telefone do usuário primeiro.' });
    // Today so far, closed or not; on a day with no shift (a Sunday, a holiday), the last day
    // that produced, up to two weeks back, so the test works at any hour of any day.
    const devices = await devicesOf(db, user);
    let date = plantDate(new Date());
    let days: DeviceDay[] = [];
    for (let back = 0; back <= 14 && !days.length; back += 1) {
      date = addDays(plantDate(new Date()), -back);
      const found: DeviceDay[] = [];
      for (const device of devices) {
        const day = await deviceDay(db, user.tenant_id, device, date, new Date(plantInstant(addDays(date, 1), '07:00')));
        if (!day.noShift) found.push(day);
      }
      if (found.some((day) => (day.facts?.made ?? 0) > 0)) days = found;
    }
    if (!days.length)
      return reply
        .code(400)
        .send({ error: 'Nenhum dia com produção nas últimas duas semanas para os equipamentos deste usuário.' });
    await db.query(
      `INSERT INTO production_messages(tenant_id,user_id,kind,production_date,phone,body)
       VALUES($1,$2,'test',$3,$4,$5)`,
      [user.tenant_id, user.id, date, user.phone, messageText(date, days, 'test')],
    );
    await recordAudit(db, req, current, {
      action: 'user.whatsapp_test',
      targetType: 'user',
      targetId: id,
      summary: {},
    });
    return { queued: true };
  });

  // The queue as the master sees it: what went out, what is waiting, what failed.
  app.get('/api/users/:id/whatsapp-messages', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const current = access.principal(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return (
      await db.query(
        `SELECT id,kind,production_date::text production_date,status,attempts,due_at,sent_at,error,created_at
         FROM production_messages WHERE tenant_id=$1 AND user_id=$2
         ORDER BY created_at DESC LIMIT 20`,
        [current.tenantId, id],
      )
    ).rows;
  });
}
