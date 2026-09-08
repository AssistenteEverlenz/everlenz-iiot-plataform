import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { databaseConfig } from '../packages/database/src/config.js';
import { ingestionHealth } from '../apps/ingestor/src/health.js';
describe('PostgreSQL connection configuration', () => {
  it.each([
    'postgresql://user:dummy@direct.invalid:5432/postgres',
    'postgres://user.project:dummy@session.invalid:5432/postgres',
  ])('supports full URL without hostname assumptions', (DATABASE_URL) => {
    const config = databaseConfig({ DATABASE_URL });
    expect(config.connectionString).toContain('.invalid:5432/postgres');
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
  });
  it('keeps certificate and hostname verification with sslmode=require', () => {
    const config = databaseConfig({
      DATABASE_URL: 'postgresql://user:p%40ss@host.invalid/db?sslmode=require',
    });
    const client = new pg.Client(config);
    expect(client.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain('sslmode');
  });
  it('accepts a private CA without disabling verification', () =>
    expect(
      databaseConfig({
        DATABASE_URL: 'postgresql://u:p@host.invalid/db',
        DATABASE_SSL_CA_PEM: 'test-ca',
      }).ssl,
    ).toEqual({ rejectUnauthorized: true, ca: 'test-ca' }));
  it('permits explicit plaintext only outside production', () => {
    expect(
      databaseConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db?sslmode=disable' }).ssl,
    ).toBe(false);
    expect(() =>
      databaseConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@localhost/db?sslmode=disable',
      }),
    ).toThrow('cannot be disabled');
  });
  it.each([
    'sslmode=no-verify',
    'sslmode=prefer',
    'sslmode=verify-ca',
    'ssl=false',
    'sslrootcert=file',
    'uselibpqcompat=true',
  ])('rejects conflicting/insecure URL setting %s', (option) =>
    expect(() =>
      databaseConfig({ DATABASE_URL: `postgresql://u:p@host.invalid/db?${option}` }),
    ).toThrow(),
  );
  it('does not put a malformed secret in errors', () => {
    expect(() => databaseConfig({ DATABASE_URL: 'secret-value' })).toThrow('must be a valid');
    try {
      databaseConfig({ DATABASE_URL: 'secret-value' });
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  });
  it('does not silently fall back to local PostgreSQL', () =>
    expect(() => databaseConfig({ POSTGRES_HOST: 'localhost' })).toThrow(
      'DATABASE_URL is required',
    ));
});
describe('Ingestor readiness', () => {
  const healthy = {
    mqtt: true,
    subscribed: true,
    database: true,
    stopping: false,
    storageFailure: false,
  };
  it('distinguishes a live process from unavailable dependencies', () => {
    expect(ingestionHealth({ ...healthy, mqtt: false })).toMatchObject({
      live: true,
      ready: false,
      mqtt: false,
      database: true,
    });
    expect(ingestionHealth({ ...healthy, database: false })).toMatchObject({
      live: true,
      ready: false,
      mqtt: true,
      database: false,
    });
    expect(ingestionHealth(healthy).ready).toBe(true);
    expect(ingestionHealth({ ...healthy, stopping: true })).toMatchObject({
      live: false,
      ready: false,
    });
  });
});
