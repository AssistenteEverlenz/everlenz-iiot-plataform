import { database, pool, type Database } from './index.js';
import { migrationFiles } from './migrate.js';
import { pathToFileURL } from 'node:url';
export async function migrationStatus(db: Database = database) {
  const files = await migrationFiles();
  const exists = await db.query<{ name: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text name",
  );
  let applied: { name: string; applied_at: string; checksum?: string | null }[] = [];
  if (exists.rows[0].name)
    applied = (
      await db.query<{ name: string; applied_at: string; checksum?: string | null }>(
        'SELECT * FROM public.schema_migrations ORDER BY name',
      )
    ).rows;
  return [
    ...files.map((file) => {
      const row = applied.find((r) => r.name === file.name);
      return {
        name: file.name,
        status: !row
          ? 'pending'
          : !row.checksum
            ? 'applied_unverified'
            : row.checksum === file.checksum
              ? 'applied'
              : 'checksum_mismatch',
        appliedAt: row?.applied_at ?? null,
      };
    }),
    ...applied
      .filter((row) => !files.some((file) => file.name === row.name))
      .map((row) => ({ name: row.name, status: 'missing_local_file', appliedAt: row.applied_at })),
  ];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const status = await migrationStatus();
    console.table(status);
    if (status.some((s) => ['checksum_mismatch', 'missing_local_file'].includes(s.status)))
      process.exitCode = 1;
  } catch {
    console.error('Database status unavailable; verify DATABASE_URL/TLS and network access.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
