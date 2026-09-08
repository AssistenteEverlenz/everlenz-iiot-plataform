import { it, expect } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { migrationStatus } from '../packages/database/src/status.js';
it('status is read-only, audits checksums and preserves Supabase tables without public API access', async () => {
  const { db, close } = await memoryDatabase();
  try {
    expect((await migrationStatus(db)).every((s) => s.status === 'pending')).toBe(true);
    expect(
      (
        await db.query<{ name: string | null }>(
          "SELECT to_regclass('public.schema_migrations')::text name",
        )
      ).rows[0].name,
    ).toBeNull();
    await db.query('CREATE ROLE anon; CREATE ROLE authenticated;');
    await db.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated;',
    );
    await migrate(db);
    expect((await migrationStatus(db)).every((s) => s.status === 'applied')).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      const result = await db.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1,'public.mqtt_messages_raw','SELECT') allowed",
        [role],
      );
      expect(result.rows[0].allowed).toBe(false);
    }
    await db.query("UPDATE schema_migrations SET checksum='tampered' WHERE name='001_initial.sql'");
    expect((await migrationStatus(db))[0].status).toBe('checksum_mismatch');
    await expect(migrate(db)).rejects.toThrow('checksum mismatch');
  } finally {
    await close();
  }
}, 30000);
