import { PGlite } from '@electric-sql/pglite';
import type { Database, SqlExecutor } from '../packages/database/src/index.js';
export async function memoryDatabase() {
  const pg = new PGlite();
  await pg.waitReady;
  const wrap = (client: Pick<PGlite, 'query' | 'exec'>): SqlExecutor => ({
    async query<T>(sql: string, values?: unknown[]) {
      // Migrations contain multiple SQL statements; prepared queries are single-statement.
      if (!values && sql.includes(';')) {
        await client.exec(sql);
        return { rows: [] as T[] };
      }
      const result = await client.query<T>(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows };
    },
  });
  const db: Database = {
    ...wrap(pg),
    transaction: async (fn) => pg.transaction(async (tx) => fn(wrap(tx as unknown as PGlite))),
  };
  return { db, close: () => pg.close() };
}
