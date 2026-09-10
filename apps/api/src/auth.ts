import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Database, SqlExecutor } from '@iiot/database';
import { recordAudit } from './audit.js';
import {
  hashPassword,
  sessionToken,
  sessionTokenHash,
  temporaryPassword,
  verifyPassword,
} from '@iiot/shared';

// A login for an unknown account must cost the same scrypt work as a real one,
// otherwise response time alone reveals which e-mails exist. Verifying against this
// decoy always fails, because nobody is given the random password it derives from.
let decoyHashPromise: Promise<string> | undefined;
function decoyHash() {
  decoyHashPromise ??= hashPassword(randomBytes(32).toString('base64url'));
  return decoyHashPromise;
}

// Failed attempts are tracked in process memory, so they reset on restart and are not
// shared between API replicas. SECURITY-DEBT: move to the database (see SECURITY.md
// item 7) before running more than one API instance.
const MAX_TRACKED_LOGINS = 20_000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** Durable per-account lockout (SECURITY.md item 7b), applied on top of the memory map. */
const ACCOUNT_LOCK_THRESHOLD = 10;
const ACCOUNT_LOCK_MINUTES = 15;
/**
 * A session also dies after this much silence, independently of its 12h absolute cap.
 * Chosen above the dashboard poll interval so an operator with a screen open is never
 * logged out mid-shift, while an abandoned browser stops being a usable credential.
 */
const SESSION_IDLE_HOURS = 4;

export interface Principal {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: 'master' | 'user';
  status: 'active' | 'inactive';
  mustChangePassword: boolean;
  sessionHash: string;
}

interface AuthSettings {
  tenantId: string;
  required: boolean;
}

const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((value) => /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value), {
    message: 'Password must include uppercase, lowercase and number',
  });

export function createAccessControl(db: Database, settings: AuthSettings) {
  const principals = new WeakMap<object, Principal>();
  const loginAttempts = new Map<
    string,
    { count: number; startedAt: number; blockedUntil: number }
  >();
  const publicRoutes = new Set(['/health', '/api/auth/login', '/api/branding/public']);

  function principal(request: FastifyRequest): Principal {
    const authenticated = principals.get(request);
    if (authenticated) return authenticated;
    if (!settings.required)
      return {
        id: '00000000-0000-4000-8000-000000000000',
        tenantId: settings.tenantId,
        email: 'test@local',
        fullName: 'Test master',
        role: 'master',
        status: 'active',
        mustChangePassword: false,
        sessionHash: '',
      };
    throw new Error('Authenticated principal missing');
  }

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    if (!settings.required || publicRoutes.has(request.routeOptions.url ?? '')) return;
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,})$/)?.[1];
    if (!token) return reply.code(401).send({ error: 'Authentication required' });
    const tokenHash = sessionTokenHash(token);
    const result = await db.query<{
      id: string;
      tenant_id: string;
      email: string;
      full_name: string;
      role: 'master' | 'user';
      status: 'active' | 'inactive';
      must_change_password: boolean;
      last_seen_at: Date | string;
    }>(
      `SELECT u.id,u.tenant_id,u.email,u.full_name,u.role,u.status,u.must_change_password,s.last_seen_at
       FROM app_sessions s JOIN app_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now()
         AND s.last_seen_at > now()-($2::int * interval '1 hour')`,
      [tokenHash, SESSION_IDLE_HOURS],
    );
    const row = result.rows[0];
    if (!row) {
      // Also clears a row that only failed the idle check, so an abandoned session does
      // not linger until its absolute expiry.
      await db.query('DELETE FROM app_sessions WHERE token_hash=$1', [tokenHash]);
      return reply.code(401).send({ error: 'Session expired' });
    }
    if (row.status !== 'active') {
      await db.query('DELETE FROM app_sessions WHERE token_hash=$1', [tokenHash]);
      return reply.code(403).send({ error: 'User inactive' });
    }
    const authenticated: Principal = {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      status: row.status,
      mustChangePassword: row.must_change_password,
      sessionHash: tokenHash,
    };
    principals.set(request, authenticated);
    if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60 * 1000)
      await db.query('UPDATE app_sessions SET last_seen_at=now() WHERE token_hash=$1', [tokenHash]);
    const allowedDuringPasswordChange = new Set([
      '/api/auth/session',
      '/api/auth/change-password',
      '/api/auth/logout',
      '/api/branding',
    ]);
    if (
      authenticated.mustChangePassword &&
      !allowedDuringPasswordChange.has(request.routeOptions.url ?? '')
    )
      return reply.code(428).send({ error: 'Password change required' });
  }

  async function accessibleDeviceIds(request: FastifyRequest) {
    const current = principal(request);
    if (current.role === 'master') return null;
    return (
      await db.query<{ device_id: string }>(
        'SELECT device_id FROM user_device_access WHERE tenant_id=$1 AND user_id=$2 ORDER BY device_id',
        [current.tenantId, current.id],
      )
    ).rows.map((row) => row.device_id);
  }

  async function requireDevice(request: FastifyRequest, reply: FastifyReply, deviceId: string) {
    const current = principal(request);
    if (current.role === 'master') return true;
    const allowed = await db.query(
      'SELECT 1 FROM user_device_access WHERE tenant_id=$1 AND user_id=$2 AND device_id=$3',
      [current.tenantId, current.id, deviceId],
    );
    if (allowed.rows.length) return true;
    reply.code(404).send({ error: 'Device not found' });
    return false;
  }

  function requireMaster(request: FastifyRequest, reply: FastifyReply) {
    if (principal(request).role === 'master') return true;
    reply.code(403).send({ error: 'Master access required' });
    return false;
  }

  function isLoginBlocked(key: string) {
    const now = Date.now();
    const attempt = loginAttempts.get(key);
    if (!attempt) return false;
    if (attempt.blockedUntil > now) return true;
    if (now - attempt.startedAt > ATTEMPT_WINDOW_MS) loginAttempts.delete(key);
    return false;
  }

  // Spraying unique e-mails would otherwise grow this map without bound, which is a
  // memory-exhaustion path of its own. Drop expired entries first, then the oldest.
  function pruneAttempts(now: number) {
    if (loginAttempts.size < MAX_TRACKED_LOGINS) return;
    for (const [key, attempt] of loginAttempts) {
      if (attempt.blockedUntil <= now && now - attempt.startedAt > ATTEMPT_WINDOW_MS)
        loginAttempts.delete(key);
      if (loginAttempts.size < MAX_TRACKED_LOGINS) return;
    }
    for (const key of loginAttempts.keys()) {
      if (loginAttempts.size < MAX_TRACKED_LOGINS) return;
      loginAttempts.delete(key);
    }
  }

  function failedLogin(key: string, limit = 8) {
    const now = Date.now();
    pruneAttempts(now);
    const current = loginAttempts.get(key);
    const attempt =
      !current || now - current.startedAt > ATTEMPT_WINDOW_MS
        ? { count: 1, startedAt: now, blockedUntil: 0 }
        : { ...current, count: current.count + 1 };
    if (attempt.count >= limit) attempt.blockedUntil = now + ATTEMPT_WINDOW_MS;
    loginAttempts.set(key, attempt);
  }

  async function createSession(userId: string, request: FastifyRequest) {
    const token = sessionToken();
    await db.query(
      `INSERT INTO app_sessions(user_id,token_hash,expires_at,ip_address,user_agent)
       VALUES($1,$2,now()+interval '12 hours',$3,$4)`,
      [
        userId,
        sessionTokenHash(token),
        request.ip,
        request.headers['user-agent']?.slice(0, 500) ?? null,
      ],
    );
    return token;
  }

  return {
    authenticate,
    principal,
    accessibleDeviceIds,
    requireDevice,
    requireMaster,
    isLoginBlocked,
    failedLogin,
    clearLoginAttempts: (ip: string) => loginAttempts.delete(ip),
    createSession,
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  db: Database,
  access: ReturnType<typeof createAccessControl>,
) {
  // Each attempt costs a deliberate scrypt derivation (~100ms CPU, 64MB). Without a
  // hard ceiling here, a handful of concurrent callers can exhaust the whole service.
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = z
        .object({ email: z.email().max(254), password: z.string().min(1).max(128) })
        .parse(request.body);
      const email = body.email.trim().toLowerCase();
      // Two independent budgets. The per-origin key alone is bypassed by spreading an
      // attack across addresses, so the account itself also carries a (looser) limit.
      const originKey = `origin:${request.ip}:${email}`;
      const accountKey = `account:${email}`;
      if (access.isLoginBlocked(originKey) || access.isLoginBlocked(accountKey))
        return reply.code(429).send({ error: 'Too many attempts. Try again later.' });
      const result = await db.query<{
        id: string;
        tenant_id: string;
        email: string;
        full_name: string;
        role: 'master' | 'user';
        status: 'active' | 'inactive';
        password_hash: string;
        must_change_password: boolean;
        failed_attempts: number;
        locked_until: Date | string | null;
      }>('SELECT * FROM app_users WHERE lower(email)=lower($1)', [body.email.trim()]);
      const user = result.rows[0];
      const locked = user?.locked_until
        ? new Date(user.locked_until).getTime() > Date.now()
        : false;
      // Always pay the scrypt cost, and answer unknown / wrong password / inactive /
      // locked with one identical 401. Distinguishing them leaks the account list, which
      // is the raw material for targeted phishing. A locked-out or deactivated user is
      // told by their operator, not by this endpoint.
      const passwordValid = await verifyPassword(
        body.password,
        user ? user.password_hash : await decoyHash(),
      );
      if (!user || !passwordValid || user.status !== 'active' || locked) {
        access.failedLogin(originKey, 8);
        access.failedLogin(accountKey, 20);
        // Durable counterpart of the memory throttle: survives redeploys and is shared
        // between replicas. Only reachable for an account that actually exists.
        if (user && !locked)
          await db.query(
            `UPDATE app_users SET failed_attempts=failed_attempts+1,
               locked_until=CASE WHEN failed_attempts+1 >= $2
                 THEN now()+($3::int * interval '1 minute') ELSE locked_until END
             WHERE id=$1`,
            [user.id, ACCOUNT_LOCK_THRESHOLD, ACCOUNT_LOCK_MINUTES],
          );
        return reply.code(401).send({ error: 'Invalid email or password' });
      }
      access.clearLoginAttempts(originKey);
      access.clearLoginAttempts(accountKey);
      const token = await access.createSession(user.id, request);
      await db.query(
        'UPDATE app_users SET last_login_at=now(),failed_attempts=0,locked_until=NULL WHERE id=$1',
        [user.id],
      );
      return { token, user: publicUser(user) };
    },
  );

  app.get('/api/auth/session', async (request) => {
    const current = access.principal(request);
    const deviceIds = await access.accessibleDeviceIds(request);
    return {
      user: {
        id: current.id,
        tenantId: current.tenantId,
        email: current.email,
        fullName: current.fullName,
        role: current.role,
        status: current.status,
        mustChangePassword: current.mustChangePassword,
      },
      deviceIds,
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await db.query('DELETE FROM app_sessions WHERE token_hash=$1', [
      access.principal(request).sessionHash,
    ]);
    return reply.code(204).send();
  });

  app.post('/api/auth/change-password', async (request, reply) => {
    const current = access.principal(request);
    const body = z
      .object({
        currentPassword: z.string().max(128).optional(),
        password: passwordSchema,
        confirmation: z.string(),
      })
      .refine((value) => value.password === value.confirmation, {
        path: ['confirmation'],
        message: 'Passwords do not match',
      })
      .parse(request.body);
    if (!current.mustChangePassword) {
      const stored = await db.query<{ password_hash: string }>(
        'SELECT password_hash FROM app_users WHERE id=$1',
        [current.id],
      );
      if (
        !body.currentPassword ||
        !(await verifyPassword(body.currentPassword, stored.rows[0].password_hash))
      )
        return reply.code(400).send({ error: 'Current password is invalid' });
    }
    const passwordHash = await hashPassword(body.password);
    const token = await db.transaction(async (sql) => {
      await sql.query(
        'UPDATE app_users SET password_hash=$2,must_change_password=false,updated_at=now() WHERE id=$1',
        [current.id, passwordHash],
      );
      await sql.query('DELETE FROM app_sessions WHERE user_id=$1', [current.id]);
      const nextToken = sessionToken();
      await sql.query(
        `INSERT INTO app_sessions(user_id,token_hash,expires_at,ip_address,user_agent)
         VALUES($1,$2,now()+interval '12 hours',$3,$4)`,
        [
          current.id,
          sessionTokenHash(nextToken),
          request.ip,
          request.headers['user-agent']?.slice(0, 500) ?? null,
        ],
      );
      return nextToken;
    });
    return { token, user: { ...current, mustChangePassword: false, sessionHash: undefined } };
  });

  app.get(
    '/api/branding/public',
    async () =>
      (
        await db.query(
          'SELECT product_name,subtitle,logo_url,primary_color,accent_color FROM tenant_branding ORDER BY tenant_id LIMIT 1',
        )
      ).rows[0],
  );

  app.get('/api/branding', async (request) => {
    const current = access.principal(request);
    return (await db.query('SELECT * FROM tenant_branding WHERE tenant_id=$1', [current.tenantId]))
      .rows[0];
  });

  app.patch('/api/branding', async (request, reply) => {
    if (!access.requireMaster(request, reply)) return;
    const current = access.principal(request);
    const body = z
      .object({
        productName: z.string().min(2).max(80),
        subtitle: z.string().min(2).max(120),
        logoUrl: z
          .string()
          .max(850_000)
          .refine(
            (value) =>
              value === '' ||
              /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value) ||
              z.string().url().safeParse(value).success,
            'Logotipo inválido',
          )
          .optional(),
        primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
      })
      .parse(request.body);
    return (
      await db.query(
        `UPDATE tenant_branding SET product_name=$2,subtitle=$3,logo_url=$4,primary_color=$5,accent_color=$6,updated_at=now()
         WHERE tenant_id=$1 RETURNING *`,
        [
          current.tenantId,
          body.productName,
          body.subtitle,
          body.logoUrl || null,
          body.primaryColor,
          body.accentColor,
        ],
      )
    ).rows[0];
  });

  app.get('/api/users', async (request, reply) => {
    if (!access.requireMaster(request, reply)) return;
    const current = access.principal(request);
    return (
      await db.query(
        `SELECT u.id,u.email,u.full_name,u.role,u.status,u.must_change_password,u.last_login_at,u.created_at,u.updated_at,
          COALESCE(array_agg(a.device_id) FILTER(WHERE a.device_id IS NOT NULL),'{}') device_ids
         FROM app_users u LEFT JOIN user_device_access a ON a.user_id=u.id AND a.tenant_id=u.tenant_id
         WHERE u.tenant_id=$1 GROUP BY u.id ORDER BY u.role='master' DESC,u.full_name,u.id`,
        [current.tenantId],
      )
    ).rows;
  });

  app.post('/api/users', async (request, reply) => {
    if (!access.requireMaster(request, reply)) return;
    const current = access.principal(request);
    const body = userMutationSchema.parse(request.body);
    const duplicate = await db.query('SELECT 1 FROM app_users WHERE lower(email)=lower($1)', [
      body.email,
    ]);
    if (duplicate.rows.length) return reply.code(409).send({ error: 'Email already registered' });
    if (!(await validDevices(db, current.tenantId, body.deviceIds)))
      return reply.code(400).send({ error: 'Invalid device assignment' });
    const initialPassword = temporaryPassword();
    const passwordHash = await hashPassword(initialPassword);
    const user = await db.transaction(async (sql) => {
      const created = await sql.query<{ id: string } & Record<string, unknown>>(
        `INSERT INTO app_users(tenant_id,email,full_name,role,status,password_hash,must_change_password,created_by)
         VALUES($1,lower($2),$3,'user',$4,$5,true,$6)
         RETURNING id,email,full_name,role,status,must_change_password,created_at`,
        [
          current.tenantId,
          body.email.trim(),
          body.fullName.trim(),
          body.status,
          passwordHash,
          current.id,
        ],
      );
      await replaceDeviceAccess(sql, current.tenantId, created.rows[0].id, body.deviceIds);
      await recordAudit(sql, request, current, {
        action: 'user.create',
        targetType: 'user',
        targetId: created.rows[0].id,
        summary: {
          email: body.email.trim().toLowerCase(),
          status: body.status,
          device_count: body.deviceIds.length,
        },
      });
      return created.rows[0];
    });
    return reply
      .code(201)
      .send({ user: { ...user, device_ids: body.deviceIds }, temporaryPassword: initialPassword });
  });

  app.patch('/api/users/:id', async (request, reply) => {
    if (!access.requireMaster(request, reply)) return;
    const current = access.principal(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = userMutationSchema.partial().parse(request.body);
    const target = await db.query<{ role: 'master' | 'user' }>(
      'SELECT role FROM app_users WHERE tenant_id=$1 AND id=$2',
      [current.tenantId, id],
    );
    if (!target.rows.length) return reply.code(404).send({ error: 'User not found' });
    if (target.rows[0].role === 'master' && (body.status || body.deviceIds))
      return reply.code(400).send({ error: 'Master access cannot be restricted' });
    if (body.email) {
      const duplicate = await db.query(
        'SELECT 1 FROM app_users WHERE lower(email)=lower($1) AND id<>$2',
        [body.email, id],
      );
      if (duplicate.rows.length) return reply.code(409).send({ error: 'Email already registered' });
    }
    if (body.deviceIds && !(await validDevices(db, current.tenantId, body.deviceIds)))
      return reply.code(400).send({ error: 'Invalid device assignment' });
    const user = await db.transaction(async (sql) => {
      const updated = await sql.query(
        `UPDATE app_users SET email=COALESCE(lower($3),email),full_name=COALESCE($4,full_name),
         status=COALESCE($5,status),updated_at=now() WHERE tenant_id=$1 AND id=$2
         RETURNING id,email,full_name,role,status,must_change_password,last_login_at,created_at,updated_at`,
        [
          current.tenantId,
          id,
          body.email?.trim() ?? null,
          body.fullName?.trim() ?? null,
          body.status ?? null,
        ],
      );
      if (body.deviceIds) await replaceDeviceAccess(sql, current.tenantId, id, body.deviceIds);
      if (body.status === 'inactive')
        await sql.query('DELETE FROM app_sessions WHERE user_id=$1', [id]);
      await recordAudit(sql, request, current, {
        action: 'user.update',
        targetType: 'user',
        targetId: id,
        summary: {
          changed: Object.keys(body),
          status: body.status ?? null,
          device_count: body.deviceIds?.length ?? null,
        },
      });
      return updated.rows[0];
    });
    const deviceIds =
      body.deviceIds ??
      (
        await db.query<{ device_id: string }>(
          'SELECT device_id FROM user_device_access WHERE user_id=$1',
          [id],
        )
      ).rows.map((row) => row.device_id);
    return { ...user, device_ids: deviceIds };
  });

  app.delete('/api/users/:id', async (request, reply) => {
    if (!access.requireMaster(request, reply)) return;
    const current = access.principal(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const removed = await db.transaction(async (sql) => {
      const result = await sql.query<{ id: string; email: string }>(
        `DELETE FROM app_users WHERE tenant_id=$1 AND id=$2 AND role='user' RETURNING id,email`,
        [current.tenantId, id],
      );
      if (result.rows.length)
        await recordAudit(sql, request, current, {
          action: 'user.delete',
          targetType: 'user',
          targetId: id,
          summary: { email: result.rows[0].email },
        });
      return result.rows.length;
    });
    return removed
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'User not found or protected' });
  });

  app.post('/api/users/:id/reset-password', async (request, reply) => {
    if (!access.requireMaster(request, reply)) return;
    const current = access.principal(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const initialPassword = temporaryPassword();
    const passwordHash = await hashPassword(initialPassword);
    const updated = await db.transaction(async (sql) => {
      // Also the administrative unlock path: a per-account lockout can be triggered
      // deliberately by an attacker, so a master must be able to end it without waiting.
      const result = await sql.query(
        `UPDATE app_users SET password_hash=$3,must_change_password=true,
           failed_attempts=0,locked_until=NULL,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND role='user' RETURNING id`,
        [current.tenantId, id, passwordHash],
      );
      if (result.rows.length) {
        await sql.query('DELETE FROM app_sessions WHERE user_id=$1', [id]);
        await recordAudit(sql, request, current, {
          action: 'user.reset_password',
          targetType: 'user',
          targetId: id,
          summary: { sessions_revoked: true, lock_cleared: true },
        });
      }
      return result.rows.length;
    });
    return updated
      ? { temporaryPassword: initialPassword }
      : reply.code(404).send({ error: 'User not found or protected' });
  });
}

export { passwordSchema, temporaryPassword };

function publicUser(user: {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  role: 'master' | 'user';
  status: 'active' | 'inactive';
  must_change_password: boolean;
}) {
  return {
    id: user.id,
    tenantId: user.tenant_id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    status: user.status,
    mustChangePassword: user.must_change_password,
  };
}

const userMutationSchema = z.object({
  email: z.email().max(254),
  fullName: z.string().min(2).max(120),
  status: z.enum(['active', 'inactive']).default('active'),
  deviceIds: z.array(z.uuid()).max(500).default([]),
});

async function validDevices(db: Database, tenantId: string, deviceIds: string[]) {
  if (!deviceIds.length) return true;
  const unique = [...new Set(deviceIds)];
  const result = await db.query<{ count: number }>(
    'SELECT count(*)::int count FROM devices WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
    [tenantId, unique],
  );
  return Number(result.rows[0].count) === unique.length;
}

async function replaceDeviceAccess(
  sql: SqlExecutor,
  tenantId: string,
  userId: string,
  deviceIds: string[],
) {
  await sql.query('DELETE FROM user_device_access WHERE tenant_id=$1 AND user_id=$2', [
    tenantId,
    userId,
  ]);
  const unique = [...new Set(deviceIds)];
  if (!unique.length) return;
  await sql.query(
    `INSERT INTO user_device_access(tenant_id,user_id,device_id)
     SELECT $1,$2,unnest($3::uuid[])`,
    [tenantId, userId, unique],
  );
}
