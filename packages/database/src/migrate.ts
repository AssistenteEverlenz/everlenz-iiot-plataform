import { readdir, readFile } from 'node:fs/promises';
import { database, pool, type Database } from './index.js';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
export const migrationDirectory = new URL('../migrations/', import.meta.url);
export async function migrationFiles() {
  return Promise.all(
    (await readdir(migrationDirectory))
      .filter((n) => n.endsWith('.sql'))
      .sort()
      .map(async (name) => {
        const sql = await readFile(new URL(name, migrationDirectory), 'utf8');
        return {
          name,
          sql,
          checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
        };
      }),
  );
}
export async function migrate(db: Database = database) {
  const files = await migrationFiles();
  await db.transaction(async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(712004)');
    await sql.query('SET LOCAL search_path TO public');
    await sql.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await sql.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
    for (const file of files) {
      const exists = await sql.query<{ checksum: string | null }>(
        'SELECT checksum FROM schema_migrations WHERE name=$1',
        [file.name],
      );
      if (!exists.rows.length) {
        await sql.query(file.sql);
        await sql.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
          file.name,
          file.checksum,
        ]);
      } else if (exists.rows[0].checksum && exists.rows[0].checksum !== file.checksum) {
        throw new Error(`Migration checksum mismatch: ${file.name}`);
      }
      // Old entries without checksum stay explicitly unverified, never silently blessed.
    }
  });
}
if (
  process.argv[1] &&
  /[\\/]migrate\.(ts|js)$/.test(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await migrate();
    console.log('Migrations applied');
  } catch {
    console.error(
      'Migration failed; no credentials or SQL details logged. Check db:status and database availability.',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
