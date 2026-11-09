import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';

// How each person uses the platform (migration 042), for the master alone.
//
// The browser reports once a minute while the platform is on screen; a minute is one row, so the
// time on the platform is a count of rows. A visit is a run of minutes with no gap longer than
// VISIT_GAP_MINUTES. TV boards run for hours with nobody watching, so their minutes are counted
// apart and never mixed into anyone's time or ranking. Plant time is Brasília (UTC-3, no DST).

type Access = ReturnType<typeof createAccessControl>;
const uuid = z.uuid();
const VISIT_GAP_MINUTES = 10;
const LOCAL = "(minute - interval '3 hours')";

/** Every successful login, so the history survives the logout that deletes the session. */
export async function recordLogin(
  db: Database,
  user: { id: string; tenant_id: string },
  request: FastifyRequest,
  persistent: boolean,
) {
  try {
    await db.query(
      `INSERT INTO usage_logins(tenant_id,user_id,ip_address,user_agent,persistent)
       VALUES($1,$2,$3,$4,$5)`,
      [
        user.tenant_id,
        user.id,
        request.ip,
        String(request.headers['user-agent'] ?? '').slice(0, 300),
        persistent,
      ],
    );
  } catch {
    // Usage is never worth a failed login (the table may not be applied yet).
  }
}

/** A page's name in the plant's words; a panel is named after itself. */
function pageLabel(path: string, panels: Map<string, string>) {
  const panel = path.match(/^\/dashboards\/([0-9a-f-]{36})(\/tv)?$/);
  if (panel) {
    const name = panels.get(panel[1]) ?? 'painel removido';
    return panel[2] ? `TV · ${name}` : `Painel · ${name}`;
  }
  const fixed: Array<[RegExp, string]> = [
    [/^\/$/, 'Centro de comando'],
    [/^\/operations\/tv$/, 'TV da operação'],
    [/^\/operations/, 'Operação'],
    [/^\/dashboards$/, 'Lista de painéis'],
    [/^\/production/, 'Produção'],
    [/^\/devices/, 'Dispositivos'],
    [/^\/users/, 'Usuários e acessos'],
    [/^\/settings/, 'White label'],
    [/^\/mqtt-inspector/, 'Inspetor MQTT'],
  ];
  return fixed.find(([pattern]) => pattern.test(path))?.[1] ?? path;
}

async function panelNames(db: Database, tenantId: string) {
  const rows = await db.query<{ id: string; name: string }>(
    'SELECT id,name FROM dashboards WHERE tenant_id=$1',
    [tenantId],
  );
  return new Map(rows.rows.map((row) => [row.id, row.name]));
}

/** The minutes of the window numbered into visits (runs with no gap over VISIT_GAP_MINUTES). */
const VISITS_SQL = `
  WITH m AS (
    SELECT user_id,minute,active,path,device FROM usage_minutes
    WHERE tenant_id=$1 AND minute>=$2 AND NOT tv
  ), g AS (
    SELECT *, CASE WHEN minute - lag(minute) OVER (PARTITION BY user_id ORDER BY minute)
      <= interval '${VISIT_GAP_MINUTES} minutes' THEN 0 ELSE 1 END starts FROM m
  ), v AS (
    SELECT *, sum(starts) OVER (PARTITION BY user_id ORDER BY minute) visit FROM g
  )`;

const daysSchema = z.object({ days: z.coerce.number().int().min(1).max(400).default(30) });

/** Behaviour events (migration 056) are kept 90 days; the API's retention job calls this. */
export const USAGE_EVENTS_KEEP_DAYS = 90;
export async function pruneUsageEvents(db: Database, now = new Date()) {
  const result = await db.query(`DELETE FROM usage_events WHERE at < $1`, [
    new Date(now.getTime() - USAGE_EVENTS_KEEP_DAYS * 86_400_000),
  ]);
  return result.rowCount ?? 0;
}

const PATH = /^\/[A-Za-z0-9/_-]{0,200}$/;
const eventsSchema = z.object({
  session: uuid,
  device: z.enum(['desktop', 'mobile', 'tv']).default('desktop'),
  events: z
    .array(
      z.object({
        kind: z.enum([
          'screen',
          'click',
          'repeat',
          'dead',
          'modal',
          'form_abandoned',
          'empty_search',
          'error',
        ]),
        path: z.string().max(300),
        target: z.string().max(300).nullish(),
        ms: z.number().min(0).max(86_400_000).nullish(),
      }),
    )
    .max(50),
});

/** A target is a control's name, never a value: digits masked, whitespace folded, 80 chars. */
const cleanTarget = (value: string | null | undefined) => {
  const text = (value ?? '').replace(/\d/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80);
  return text || null;
};
const since = (days: number) => new Date(Date.now() - days * 86_400_000);

const SIGNALS = ['repeat', 'dead', 'modal', 'form_abandoned', 'empty_search', 'error'];

/**
 * A click worth reading in "O que mais clicam": a named control. Closing or cancelling a window,
 * the TV "touch to open" cover and a text with no word left after the digits were masked
 * ("#x#x#.#,# kg") say nothing about how the platform is used.
 */
const CLICK_NOISE = /^(fechar|cancelar|voltar|sair|ok|não|nao|agora não|×|x|✕)$/i;
export function meaningfulClick(target: string | null) {
  if (!target) return false;
  const text = target.replace(/\s*\(desativado\)$/, '').trim();
  return (
    !CLICK_NOISE.test(text) && !/^toque em qualquer lugar/i.test(text) && /\p{L}{3,}/u.test(text)
  );
}

/**
 * How the platform is used, from the behaviour events (056): where people got stuck, how long
 * a visit to each page lasts and which controls they use. For one person, or for everyone but
 * the master accounts (the master's own clicking around is not how the plants use it).
 */
async function behaviour(
  db: Database,
  tenantId: string,
  from: Date,
  userId: string | null,
  panels: Map<string, string>,
) {
  const who = userId ? 'AND user_id=$3' : "AND role IS DISTINCT FROM 'master'";
  const params = userId ? [tenantId, from, userId] : [tenantId, from];
  const base = `FROM usage_events WHERE tenant_id=$1 AND at>=$2 ${who}`;
  try {
    const [kinds, signals, screens, clicks, since] = await Promise.all([
      db.query<{ kind: string; n: string; people: string }>(
        `SELECT kind,count(*) n,count(DISTINCT user_id) people ${base} GROUP BY kind`,
        params,
      ),
      db.query<{
        kind: string;
        path: string;
        target: string | null;
        n: string;
        people: string;
        last: string;
      }>(
        `SELECT kind,path,target,count(*) n,count(DISTINCT user_id) people,max(at) last ${base}
           AND kind = ANY($${params.length + 1}::text[])
         GROUP BY 1,2,3 ORDER BY count(DISTINCT user_id) DESC,count(*) DESC,max(at) DESC LIMIT 40`,
        [...params, SIGNALS],
      ),
      db.query<{ path: string; visits: string; avg_ms: string; total_ms: string; people: string }>(
        `SELECT path,count(*) visits,avg(ms) avg_ms,sum(ms) total_ms,count(DISTINCT user_id) people
         ${base} AND kind='screen' AND ms IS NOT NULL
         GROUP BY path ORDER BY sum(ms) DESC LIMIT 20`,
        params,
      ),
      db.query<{ path: string; target: string | null; n: string; people: string }>(
        `SELECT path,target,count(*) n,count(DISTINCT user_id) people ${base} AND kind='click'
         GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 80`,
        params,
      ),
      db.query<{ first: string | null }>(
        'SELECT min(at) AS first FROM usage_events WHERE tenant_id=$1',
        [tenantId],
      ),
    ]);
    return {
      since: since.rows[0]?.first ?? null,
      kinds: Object.fromEntries(
        kinds.rows.map((row) => [row.kind, { count: Number(row.n), people: Number(row.people) }]),
      ),
      signals: signals.rows.map((row) => ({
        kind: row.kind,
        page: pageLabel(row.path, panels),
        target: row.target,
        count: Number(row.n),
        people: Number(row.people),
        lastAt: row.last,
      })),
      screens: screens.rows.map((row) => ({
        page: pageLabel(row.path, panels),
        visits: Number(row.visits),
        averageMs: Math.round(Number(row.avg_ms)),
        totalMs: Number(row.total_ms),
        people: Number(row.people),
      })),
      clicks: clicks.rows
        .filter((row) => meaningfulClick(row.target))
        .slice(0, 15)
        .map((row) => ({
          page: pageLabel(row.path, panels),
          target: row.target,
          count: Number(row.n),
          people: Number(row.people),
        })),
    };
  } catch {
    // Migration 056 not applied: the page still shows the minutes.
    return null;
  }
}

export function registerUsageRoutes(app: FastifyInstance, db: Database, access: Access) {
  // Once a minute from any signed-in screen. Never an error the person would see: a report that
  // cannot be written is simply lost.
  app.post('/api/usage/beat', async (request, reply) => {
    const body = z
      .object({
        path: z.string().max(300),
        active: z.boolean(),
        device: z.enum(['desktop', 'mobile', 'tv']).default('desktop'),
      })
      .parse(request.body);
    const path = body.path.split('?')[0];
    if (!/^\/[A-Za-z0-9/_-]{0,200}$/.test(path)) return reply.code(204).send();
    const current = access.principal(request);
    const tv = /\/tv$/.test(path);
    try {
      await db.query(
        `INSERT INTO usage_minutes(tenant_id,user_id,minute,path,active,tv,device)
         VALUES($1,$2,date_trunc('minute',now()),$3,$4,$5,$6)
         ON CONFLICT (user_id,minute) DO UPDATE SET path=EXCLUDED.path,
           active=usage_minutes.active OR EXCLUDED.active,tv=EXCLUDED.tv,device=EXCLUDED.device`,
        [current.tenantId, current.id, path, body.active, tv, tv ? 'tv' : body.device],
      );
    } catch {
      // Table not applied yet, or a principal without a user row (authentication off).
    }
    return reply.code(204).send();
  });

  // Where a screen confuses (migration 056), sent in batches by the browser. Like the beat,
  // never an error the person would see.
  app.post('/api/usage/events', async (request, reply) => {
    const body = eventsSchema.parse(request.body);
    const rows = body.events
      .map((event) => ({ ...event, path: event.path.split('?')[0] }))
      .filter((event) => PATH.test(event.path));
    if (!rows.length) return reply.code(204).send();
    const current = access.principal(request);
    try {
      await db.query(
        `INSERT INTO usage_events(tenant_id,user_id,role,session,kind,path,target,ms,device)
         SELECT $1,$2,$3,$4,e.kind,e.path,e.target,e.ms,$5
         FROM unnest($6::text[],$7::text[],$8::text[],$9::int[]) AS e(kind,path,target,ms)`,
        [
          current.tenantId,
          current.id,
          current.role,
          body.session,
          body.device,
          rows.map((row) => row.kind),
          rows.map((row) => row.path),
          rows.map((row) => cleanTarget(row.target)),
          rows.map((row) => (row.ms == null ? null : Math.round(row.ms))),
        ],
      );
    } catch {
      // Table not applied yet, or a principal without a user row (authentication off).
    }
    return reply.code(204).send();
  });

  // Everyone side by side: who comes, for how long, and how the platform is used day by day.
  app.get('/api/usage/overview', async (request, reply) => {
    if (!access.requireMaster(request, reply)) return;
    const { days } = daysSchema.parse(request.query);
    const tenantId = access.principal(request).tenantId;
    const from = since(days);
    const [users, visits, logins, daily, panels] = await Promise.all([
      db.query<{
        id: string;
        full_name: string;
        email: string;
        role: string;
        status: string;
        last_login_at: string | null;
        open: string;
        active: string;
        tv: string;
        mobile: string;
        desktop: string;
        days: string;
        last_seen: string | null;
        top_path: string | null;
      }>(
        `SELECT u.id,u.full_name,u.email,u.role,u.status,u.last_login_at,
           count(m.minute) FILTER (WHERE NOT m.tv) open,
           count(m.minute) FILTER (WHERE m.active AND NOT m.tv) active,
           count(m.minute) FILTER (WHERE m.tv) tv,
           count(m.minute) FILTER (WHERE NOT m.tv AND m.device='mobile') mobile,
           count(m.minute) FILTER (WHERE NOT m.tv AND m.device='desktop') desktop,
           count(DISTINCT (m.minute - interval '3 hours')::date) FILTER (WHERE NOT m.tv) days,
           max(m.minute) last_seen,
           mode() WITHIN GROUP (ORDER BY m.path) FILTER (WHERE NOT m.tv) top_path
         FROM app_users u
         LEFT JOIN usage_minutes m ON m.user_id=u.id AND m.minute>=$2
         WHERE u.tenant_id=$1
         GROUP BY u.id ORDER BY u.full_name`,
        [tenantId, from],
      ),
      db.query<{ user_id: string; visits: string }>(
        `${VISITS_SQL} SELECT user_id,count(DISTINCT visit) visits FROM v GROUP BY user_id`,
        [tenantId, from],
      ),
      db.query<{ user_id: string; logins: string }>(
        `SELECT user_id,count(*) logins FROM usage_logins WHERE tenant_id=$1 AND at>=$2 GROUP BY user_id`,
        [tenantId, from],
      ),
      db.query<{ day: string; users: string; open: string; active: string }>(
        `SELECT to_char(${LOCAL},'YYYY-MM-DD') AS day,count(DISTINCT user_id) users,
           count(*) open,count(*) FILTER (WHERE active) active
         FROM usage_minutes WHERE tenant_id=$1 AND minute>=$2 AND NOT tv
         GROUP BY 1 ORDER BY 1`,
        [tenantId, from],
      ),
      panelNames(db, tenantId),
    ]);
    const visitsBy = new Map(visits.rows.map((row) => [row.user_id, Number(row.visits)]));
    const loginsBy = new Map(logins.rows.map((row) => [row.user_id, Number(row.logins)]));
    const behaviourOf = await behaviour(db, tenantId, from, null, panels);
    return {
      days,
      behaviour: behaviourOf,
      users: users.rows.map((row) => ({
        id: row.id,
        name: row.full_name,
        email: row.email,
        role: row.role,
        status: row.status,
        lastLoginAt: row.last_login_at,
        lastSeenAt: row.last_seen,
        openMinutes: Number(row.open),
        activeMinutes: Number(row.active),
        tvMinutes: Number(row.tv),
        mobileMinutes: Number(row.mobile),
        desktopMinutes: Number(row.desktop),
        activeDays: Number(row.days),
        visits: visitsBy.get(row.id) ?? 0,
        logins: loginsBy.get(row.id) ?? 0,
        topPage: row.top_path ? pageLabel(row.top_path, panels) : null,
      })),
      daily: daily.rows.map((row) => ({
        day: row.day,
        users: Number(row.users),
        openMinutes: Number(row.open),
        activeMinutes: Number(row.active),
      })),
    };
  });

  // One person: day by day, each visit, what they open, when, from what, and their logins.
  app.get('/api/usage/users/:id', async (request, reply) => {
    if (!access.requireMaster(request, reply)) return;
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { days } = daysSchema.parse(request.query);
    const tenantId = access.principal(request).tenantId;
    const user = await db.query<{
      id: string;
      full_name: string;
      email: string;
      role: string;
      status: string;
      created_at: string;
      last_login_at: string | null;
    }>(
      'SELECT id,full_name,email,role,status,created_at,last_login_at FROM app_users WHERE tenant_id=$1 AND id=$2',
      [tenantId, id],
    );
    if (!user.rows[0]) return reply.code(404).send({ error: 'User not found' });
    const from = since(days);
    const mine = 'tenant_id=$1 AND minute>=$2 AND user_id=$3';
    const [daily, visits, pages, hours, weekdays, devices, logins, panels, loginCount] =
      await Promise.all([
        db.query<{ day: string; open: string; active: string; tv: string }>(
          `SELECT to_char(${LOCAL},'YYYY-MM-DD') AS day,
           count(*) FILTER (WHERE NOT tv) open,count(*) FILTER (WHERE active AND NOT tv) active,
           count(*) FILTER (WHERE tv) tv
         FROM usage_minutes WHERE ${mine} GROUP BY 1 ORDER BY 1`,
          [tenantId, from, id],
        ),
        db.query<{
          started: string;
          ended: string;
          minutes: string;
          active: string;
          paths: string[];
          device: string;
        }>(
          `${VISITS_SQL}
         SELECT min(minute) started,max(minute) ended,count(*) minutes,
           count(*) FILTER (WHERE active) active,array_agg(DISTINCT path) paths,
           mode() WITHIN GROUP (ORDER BY device) device
         FROM v WHERE user_id=$3 GROUP BY visit ORDER BY min(minute) DESC LIMIT 60`,
          [tenantId, from, id],
        ),
        db.query<{ path: string; tv: boolean; minutes: string; active: string }>(
          `SELECT path,tv,count(*) minutes,count(*) FILTER (WHERE active) active
         FROM usage_minutes WHERE ${mine} GROUP BY path,tv ORDER BY count(*) DESC LIMIT 20`,
          [tenantId, from, id],
        ),
        db.query<{ hour: number; minutes: string }>(
          `SELECT extract(hour FROM ${LOCAL})::int AS hour,count(*) minutes
         FROM usage_minutes WHERE ${mine} AND NOT tv GROUP BY 1`,
          [tenantId, from, id],
        ),
        db.query<{ weekday: number; minutes: string }>(
          `SELECT extract(dow FROM ${LOCAL})::int AS weekday,count(*) minutes
         FROM usage_minutes WHERE ${mine} AND NOT tv GROUP BY 1`,
          [tenantId, from, id],
        ),
        db.query<{ device: string; minutes: string }>(
          `SELECT device,count(*) minutes FROM usage_minutes WHERE ${mine} GROUP BY 1 ORDER BY 2 DESC`,
          [tenantId, from, id],
        ),
        db.query<{
          at: string;
          ip_address: string | null;
          user_agent: string | null;
          persistent: boolean;
        }>(
          `SELECT at,ip_address,user_agent,persistent FROM usage_logins
         WHERE tenant_id=$1 AND user_id=$2 ORDER BY at DESC LIMIT 30`,
          [tenantId, id],
        ),
        panelNames(db, tenantId),
        db.query<{ n: string }>(
          'SELECT count(*) n FROM usage_logins WHERE tenant_id=$1 AND user_id=$2 AND at>=$3',
          [tenantId, id, from],
        ),
      ]);
    const hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      minutes: Number(hours.rows.find((row) => Number(row.hour) === hour)?.minutes ?? 0),
    }));
    const byWeekday = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      minutes: Number(weekdays.rows.find((row) => Number(row.weekday) === weekday)?.minutes ?? 0),
    }));
    const behaviourOf = await behaviour(db, tenantId, from, id, panels);
    return {
      days,
      behaviour: behaviourOf,
      user: {
        id: user.rows[0].id,
        name: user.rows[0].full_name,
        email: user.rows[0].email,
        role: user.rows[0].role,
        status: user.rows[0].status,
        createdAt: user.rows[0].created_at,
        lastLoginAt: user.rows[0].last_login_at,
      },
      daily: daily.rows.map((row) => ({
        day: row.day,
        openMinutes: Number(row.open),
        activeMinutes: Number(row.active),
        tvMinutes: Number(row.tv),
      })),
      visits: visits.rows.map((row) => ({
        startedAt: row.started,
        endedAt: row.ended,
        minutes: Number(row.minutes),
        activeMinutes: Number(row.active),
        device: row.device,
        pages: [...new Set(row.paths.map((path) => pageLabel(path, panels)))],
      })),
      pages: pages.rows.map((row) => ({
        label: pageLabel(row.path, panels),
        tv: row.tv,
        minutes: Number(row.minutes),
        activeMinutes: Number(row.active),
      })),
      hours: hourly,
      weekdays: byWeekday,
      loginCount: Number(loginCount.rows[0]?.n ?? 0),
      devices: devices.rows.map((row) => ({ device: row.device, minutes: Number(row.minutes) })),
      logins: logins.rows.map((row) => ({
        at: row.at,
        ip: row.ip_address,
        userAgent: row.user_agent,
        persistent: row.persistent,
      })),
    };
  });
}
