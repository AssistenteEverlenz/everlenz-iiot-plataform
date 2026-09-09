import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database, SqlExecutor } from '@iiot/database';
import {
  hashPassword,
  sessionToken,
  sessionTokenHash,
  temporaryPassword,
  verifyPassword,
} from '@iiot/shared';

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
       WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return reply.code(401).send({ error: 'Session expired' });
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

  function isLoginBlocked(ip: string) {
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (!attempt) return false;
    if (attempt.blockedUntil > now) return true;
    if (now - attempt.startedAt > 15 * 60 * 1000) loginAttempts.delete(ip);
    return false;
  }

  function failedLogin(ip: string) {
    const now = Date.now();
    const current = loginAttempts.get(ip);
    const attempt =
      !current || now - current.startedAt > 15 * 60 * 1000
        ? { count: 1, startedAt: now, blockedUntil: 0 }
        : { ...current, count: current.count + 1 };
    if (attempt.count >= 8) attempt.blockedUntil = now + 15 * 60 * 1000;
    loginAttempts.set(ip, attempt);
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
  app.post('/api/auth/login', async (request, reply) => {
    const body = z
      .object({ email: z.email().max(254), password: z.string().min(1).max(128) })
      .parse(request.body);
    const loginKey = `${request.ip}:${body.email.trim().toLowerCase()}`;
    if (access.isLoginBlocked(loginKey))
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
    }>('SELECT * FROM app_users WHERE lower(email)=lower($1)', [body.email.trim()]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      access.failedLogin(loginKey);
      return reply.code(401).send({ error: 'Invalid email or password' });
    }
    if (user.status !== 'active') return reply.code(403).send({ error: 'User inactive' });
    access.clearLoginAttempts(loginKey);
    const token = await access.createSession(user.id, request);
    await db.query('UPDATE app_users SET last_login_at=now() WHERE id=$1', [user.id]);
    return { token, user: publicUser(user) };
  });

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
    const removed = await db.query(
      `DELETE FROM app_users WHERE tenant_id=$1 AND id=$2 AND role='user' RETURNING id`,
      [current.tenantId, id],
    );
    return removed.rows.length
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
      const result = await sql.query(
        `UPDATE app_users SET password_hash=$3,must_change_password=true,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND role='user' RETURNING id`,
        [current.tenantId, id, passwordHash],
      );
      if (result.rows.length) await sql.query('DELETE FROM app_sessions WHERE user_id=$1', [id]);
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
