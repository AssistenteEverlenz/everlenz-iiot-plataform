import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import { addDays, plantDate } from '@iiot/shared';
import { answerQuestion, composeNotFound } from './assistant-answers.js';
import { buildBriefing } from './briefing.js';
import { n8nAllowed } from './production-messages.js';
import { loadConfig, productionDetailData } from './shift-production.js';

/**
 * The WhatsApp assistant's side of the platform (migration 044), called by the n8n orchestrator
 * with the n8n key. n8n holds the conversation (router, normalizer, writer); the platform knows
 * who is writing and answers with the numbers, the same ones the production board shows.
 *
 *   inbound + collect: the debounce of a burst of messages;
 *   contact: who the number is, which machines they see, today's date at the plant;
 *   production: each day of a period, per machine (today included, so far);
 *   now: the machine at this moment (the panel's summary);
 *   answer: the question, already understood by n8n's router, answered with the messages
 *     themselves, written by the platform in the daily summary's layout (assistant-answers.ts).
 *
 * A number is only ever answered with the machines its person can see on the platform.
 */
export const WHATSAPP_ROUTES = [
  '/api/n8n/whatsapp/inbound',
  '/api/n8n/whatsapp/collect',
  '/api/n8n/whatsapp/contact',
  '/api/n8n/whatsapp/production',
  '/api/n8n/whatsapp/now',
  '/api/n8n/whatsapp/answer',
];

const MAX_DAYS = 62;
const UNITS: Record<string, string> = {
  milheiros: 'milheiros',
  tons: 't',
  blocks: 'peças',
  pallets: 'paletes',
};

/**
 * The ways a WhatsApp address can match a phone stored as 55 + DDD + number. WhatsApp writes many
 * older Brazilian mobile numbers without the ninth digit, so both spellings are tried.
 */
export function phoneCandidates(input: string) {
  const digits = String(input).split('@')[0].replace(/\D/g, '');
  const national = digits.startsWith('55') ? digits.slice(2) : digits;
  const candidates = new Set<string>([`55${national}`]);
  if (national.length === 10) candidates.add(`55${national.slice(0, 2)}9${national.slice(2)}`);
  if (national.length === 11 && national[2] === '9')
    candidates.add(`55${national.slice(0, 2)}${national.slice(3)}`);
  return [...candidates];
}

interface Contact {
  id: string;
  tenant_id: string;
  full_name: string;
  role: 'master' | 'user';
}

async function contactOf(db: Database, phoneOrJid: string) {
  const found = await db.query<Contact>(
    `SELECT id,tenant_id,full_name,role FROM app_users
     WHERE status='active' AND phone=ANY($1::text[]) ORDER BY created_at LIMIT 1`,
    [phoneCandidates(phoneOrJid)],
  );
  return found.rows[0] ?? null;
}

async function devicesOf(db: Database, contact: Contact) {
  return (
    await db.query<{ id: string; name: string; dashboard_id: string | null }>(
      `SELECT d.id,d.name,
         (SELECT da.id FROM dashboards da WHERE da.tenant_id=d.tenant_id AND da.device_id=d.id
          ORDER BY da.is_default DESC,da.created_at LIMIT 1) dashboard_id
       FROM devices d
       WHERE d.tenant_id=$1 AND d.archived_at IS NULL AND d.enabled=true
         AND EXISTS (SELECT 1 FROM production_settings ps WHERE ps.device_id=d.id
           AND (ps.blocks_tag_id IS NOT NULL OR ps.pallets_tag_id IS NOT NULL))
         AND ($3::text='master' OR EXISTS (SELECT 1 FROM user_device_access a
           WHERE a.tenant_id=d.tenant_id AND a.user_id=$2 AND a.device_id=d.id))
       ORDER BY d.name`,
      [contact.tenant_id, contact.id, contact.role],
    )
  ).rows;
}

const folded = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The machines a question is about: one named (by id or part of the name), or all of them. */
export function pickDevices<T extends { id: string; name: string }>(devices: T[], wanted?: string) {
  const term = folded(wanted ?? '');
  if (!term) return devices;
  const byId = devices.filter((device) => device.id === wanted);
  if (byId.length) return byId;
  const words = term.split(' ').filter((word) => word.length > 1 && !['ceramica', 'a', 'da', 'do'].includes(word));
  const matched = devices.filter((device) => {
    const name = folded(device.name);
    return words.length ? words.every((word) => name.includes(word)) : name.includes(term);
  });
  return matched;
}

/** One machine's day, the figures a WhatsApp answer needs. */
async function dayOf(db: Database, tenantId: string, device: { id: string; name: string }, date: string) {
  const config = await loadConfig(db, tenantId, device.id);
  if (!config) return null;
  const detail = await productionDetailData(db, tenantId, device.id, config, { date, kind: 'day' });
  const board = detail.board;
  const made =
    board.metric === 'blocks'
      ? board.totals.pieces
      : ((board.totals as Record<string, number>)[board.metric] ?? 0);
  return {
    date,
    metric: board.metric,
    device: device.name,
    shifts: detail.shifts.length,
    status: detail.status,
    unit: UNITS[board.metric] ?? board.metric,
    made: Math.round(made * 10) / 10,
    milheiros: Math.round(board.totals.milheiros * 10) / 10,
    pallets: board.totals.pallets,
    tons: Math.round(board.totals.tons * 10) / 10,
    target: board.target ? Math.round(board.target.value * 10) / 10 : null,
    targetShare: board.target && board.target.value > 0 ? Math.round((made / board.target.value) * 100) : null,
    utilization: board.utilization == null ? null : Math.round(board.utilization * 100),
    stoppedMinutes: Math.round((board.time.idle + board.time.manual + board.time.offline) / 60),
    pacePerHour: Math.round(board.pacePerHour * 10) / 10,
  };
}

const phoneQuery = z.object({ phone: z.string().min(8).max(60), device: z.string().max(120).optional() });

export function registerWhatsappAssistantRoutes(app: FastifyInstance, db: Database) {
  // A message as it arrives: kept in the inbox, answered with the token the collect step needs.
  app.post('/api/n8n/whatsapp/inbound', async (req, reply) => {
    if (!n8nAllowed(req, reply)) return;
    const body = z
      .object({
        jid: z.string().min(8).max(80),
        text: z.string().max(4000),
        messageId: z.string().max(120).optional(),
      })
      .parse(req.body);
    const contact = await contactOf(db, body.jid);
    const text = body.text.trim();
    // Only the same id with the same text is a repeated delivery. The same id with another text
    // is an execution replayed in the n8n editor with edited data: it counts as a new message.
    let messageId = body.messageId ?? null;
    if (messageId) {
      const seen = await db.query<{ text: string }>(
        'SELECT text FROM whatsapp_inbound WHERE jid=$1 AND message_id=$2',
        [body.jid, messageId],
      );
      if (seen.rows[0] && seen.rows[0].text !== text) messageId = `${messageId}#${Date.now()}`;
    }
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO whatsapp_inbound(tenant_id,user_id,jid,message_id,text) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (jid,message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
      [contact?.tenant_id ?? null, contact?.id ?? null, body.jid, messageId, text],
    );
    // A repeated delivery of a message already in the inbox: nothing more to do for it.
    if (!inserted.rows[0]) return { token: null, duplicate: true, known: Boolean(contact) };
    return { token: inserted.rows[0].id, duplicate: false, known: Boolean(contact) };
  });

  /*
   * After the wait: the run holding the newest message of the burst gets the whole burst, joined
   * in order, and marks it processed; any other run gets { process: false } and stops.
   */
  app.post('/api/n8n/whatsapp/collect', async (req, reply) => {
    if (!n8nAllowed(req, reply)) return;
    const body = z
      .object({ jid: z.string().min(8).max(80), token: z.union([z.string(), z.number()]).nullable() })
      .parse(req.body);
    if (body.token == null) return { process: false, reason: 'mensagem repetida' };
    const newest = await db.query<{ id: string }>(
      'SELECT max(id)::text id FROM whatsapp_inbound WHERE jid=$1 AND processed_at IS NULL',
      [body.jid],
    );
    if (!newest.rows[0]?.id || newest.rows[0].id !== String(body.token))
      return { process: false, reason: 'chegou mensagem mais nova' };
    const burst = await db.query<{ id: string; text: string }>(
      `SELECT id::text,text FROM whatsapp_inbound
       WHERE jid=$1 AND processed_at IS NULL AND id <= $2 ORDER BY id`,
      [body.jid, body.token],
    );
    await db.query(
      'UPDATE whatsapp_inbound SET processed_at=now() WHERE id=ANY($1::bigint[])',
      [burst.rows.map((row) => row.id)],
    );
    const text = burst.rows
      .map((row) => row.text)
      .filter(Boolean)
      .join('\n');
    return { process: Boolean(text), text };
  });

  app.get('/api/n8n/whatsapp/contact', async (req, reply) => {
    if (!n8nAllowed(req, reply)) return;
    const { phone } = phoneQuery.parse(req.query);
    const contact = await contactOf(db, phone);
    const now = new Date();
    if (!contact) return { known: false, today: plantDate(now) };
    return {
      known: true,
      name: contact.full_name,
      today: plantDate(now),
      weekday: new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' }).format(now),
      time: new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(now),
      devices: (await devicesOf(db, contact)).map((device) => device.name),
    };
  });

  // Each day of [from, to] for the machines asked about (all of the person's when none is named).
  app.get('/api/n8n/whatsapp/production', async (req, reply) => {
    if (!n8nAllowed(req, reply)) return;
    const query = phoneQuery
      .extend({ from: z.iso.date(), to: z.iso.date().optional(), dates: z.string().max(400).optional() })
      .parse(req.query);
    const contact = await contactOf(db, query.phone);
    if (!contact) return reply.code(404).send({ error: 'Contato não cadastrado' });
    const today = plantDate(new Date());
    // Either a list of days (a comparison) or a period.
    let days: string[];
    if (query.dates) days = [...new Set(query.dates.split(',').map((day) => day.trim()).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))];
    else {
      const asked = query.to ?? query.from;
      const to = asked > today ? today : asked;
      days = [];
      for (let day = query.from; day <= to && days.length < MAX_DAYS; day = addDays(day, 1)) days.push(day);
    }
    days = days.filter((day) => day <= today).slice(0, MAX_DAYS);
    const all = await devicesOf(db, contact);
    const devices = pickDevices(all, query.device);
    if (!devices.length)
      return { found: false, devices: all.map((device) => device.name), days: [] };
    const rows: NonNullable<Awaited<ReturnType<typeof dayOf>>>[] = [];
    for (const day of days)
      for (const device of devices) {
        const figures = await dayOf(db, contact.tenant_id, device, day);
        // A day with no shift and no production is not a production day: left out.
        if (figures && (figures.shifts > 0 || figures.made > 0)) rows.push(figures);
      }
    const totals = devices.map((device) => {
      const own = rows.filter((row) => row.device === device.name);
      return {
        device: device.name,
        unit: own[0]?.unit ?? '',
        days: own.length,
        made: Math.round(own.reduce((sum, row) => sum + row.made, 0) * 10) / 10,
        target: own.some((row) => row.target != null)
          ? Math.round(own.reduce((sum, row) => sum + (row.target ?? 0), 0) * 10) / 10
          : null,
      };
    });
    return { found: true, today, days: rows, totals };
  });

  // The answer itself: the messages to send, one per machine.
  app.get('/api/n8n/whatsapp/answer', async (req, reply) => {
    if (!n8nAllowed(req, reply)) return;
    const query = phoneQuery
      .extend({
        kind: z.enum(['agora', 'dia', 'paradas', 'periodo', 'comparativo']),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        dates: z.string().max(400).optional(),
      })
      .parse(req.query);
    const contact = await contactOf(db, query.phone);
    if (!contact) return reply.code(404).send({ error: 'Contato não cadastrado' });
    const all = await devicesOf(db, contact);
    const machines = pickDevices(all, query.device);
    const web = (process.env.PUBLIC_WEB_URL ?? 'https://iotplataform.everlenz.com.br').replace(/\/$/, '');
    const texts = machines.length
      ? await answerQuestion(db, contact.tenant_id, machines, query, web, async (machine, date) => {
          const figures = await dayOf(db, contact.tenant_id, machine, date);
          // A production day is one that produced, as for the summary's averages: a shift with the
          // machine off all day (a holiday) would pull the average and the worst day down.
          return figures && figures.made > 0 ? figures : null;
        })
      : [composeNotFound(query.device ?? '', all.map((device) => device.name))];
    // The shape the Mensageira gives, so n8n sends both the same way.
    return { output: { messages: texts.map((text) => ({ messages: text })) } };
  });

  // The machine at this moment: state, the day so far, the target and where it is heading.
  app.get('/api/n8n/whatsapp/now', async (req, reply) => {
    if (!n8nAllowed(req, reply)) return;
    const query = phoneQuery.parse(req.query);
    const contact = await contactOf(db, query.phone);
    if (!contact) return reply.code(404).send({ error: 'Contato não cadastrado' });
    const all = await devicesOf(db, contact);
    const devices = pickDevices(all, query.device);
    if (!devices.length) return { found: false, devices: all.map((device) => device.name), machines: [] };
    const machines: Array<Record<string, unknown>> = [];
    for (const device of devices) {
      const briefing = await buildBriefing(db, { tenantId: contact.tenant_id, id: null }, device.id);
      if (!briefing.configured) continue;
      machines.push({
        device: device.name,
        state: briefing.state.state,
        stateSince: briefing.state.since,
        product: briefing.state.product,
        unit: UNITS[briefing.metric] ?? briefing.metric,
        made: Math.round(briefing.made * 10) / 10,
        target: briefing.target ? Math.round(briefing.target.value * 10) / 10 : null,
        expectedNow: briefing.target ? Math.round(briefing.target.plannedToNow * 10) / 10 : null,
        projected: briefing.target ? Math.round(briefing.target.projected * 10) / 10 : null,
        requiredPerHour: briefing.target?.requiredPerHour == null ? null : Math.round(briefing.target.requiredPerHour * 10) / 10,
        pacePerHour: Math.round(briefing.pacePerHour * 10) / 10,
        utilization: briefing.utilization == null ? null : Math.round(briefing.utilization * 100),
        stops: briefing.stopped.count,
        stoppedMinutes: Math.round(briefing.stopped.seconds / 60),
        yesterdaySameTime: Math.round(briefing.yesterday * 10) / 10,
        shiftStatus: briefing.shiftStatus,
      });
    }
    return { found: true, time: new Date().toISOString(), machines };
  });
}
