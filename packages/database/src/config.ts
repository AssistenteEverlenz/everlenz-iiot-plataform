import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

/** No hostname assumptions: works with Direct Connection and Supavisor Session Mode. */
export function databaseConfig(source: NodeJS.ProcessEnv = process.env): PoolConfig {
  if (source.DATABASE_SSL_CA_FILE && source.DATABASE_SSL_CA_PEM)
    throw new Error('Choose DATABASE_SSL_CA_FILE or DATABASE_SSL_CA_PEM, not both');
  const raw = source.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for database operations');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  ) {
    throw new Error('DATABASE_URL must specify PostgreSQL host and database');
  }
  const mode = url.searchParams.get('sslmode');
  if (mode && !['require', 'verify-full', 'disable'].includes(mode)) {
    throw new Error('Use sslmode=verify-full (or require, upgraded to full verification)');
  }
  // pg connection-string SSL parameters otherwise override the explicit TLS object.
  for (const key of ['ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
    if (url.searchParams.has(key))
      throw new Error(
        'Use DATABASE_SSL_CA_FILE for custom trust; conflicting URL TLS options are rejected',
      );
  }
  if (mode === 'disable' && source.NODE_ENV === 'production') {
    throw new Error('PostgreSQL TLS cannot be disabled in production');
  }
  url.searchParams.delete('sslmode');
  const max = Number(source.DATABASE_POOL_MAX ?? 5);
  if (!Number.isInteger(max) || max < 1 || max > 100)
    throw new Error('DATABASE_POOL_MAX must be 1..100');
  return {
    connectionString: url.toString(),
    ssl:
      mode === 'disable'
        ? false
        : {
            rejectUnauthorized: true,
            ...(source.DATABASE_SSL_CA_PEM
              ? { ca: source.DATABASE_SSL_CA_PEM }
              : source.DATABASE_SSL_CA_FILE
                ? { ca: readFileSync(source.DATABASE_SSL_CA_FILE, 'utf8') }
                : {}),
          },
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    application_name: source.SERVICE_NAME ?? 'iiot',
  };
}
