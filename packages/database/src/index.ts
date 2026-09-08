import pg from 'pg';
import { logger } from '@iiot/shared';
import { databaseConfig } from './config.js';
// Lazy initialization lets builds and PGlite tests run without credentials.
let instance: pg.Pool | undefined;
function getPool() {
  if (!instance) {
    instance = new pg.Pool(databaseConfig());
    instance.on('error', () =>
      logger(process.env.SERVICE_NAME ?? 'database').error({ event: 'database_disconnected' }),
    );
  }
  return instance;
}
export const pool = {
  query: (sql: string, values?: unknown[]) => getPool().query(sql, values),
  connect: () => getPool().connect(),
  end: async () => {
    if (instance) {
      await instance.end();
      instance = undefined;
    }
  },
};
export interface SqlExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export interface Database extends SqlExecutor {
  transaction<T>(fn: (client: SqlExecutor) => Promise<T>): Promise<T>;
}
export const database: Database = {
  async query<T>(sql: string, values?: unknown[]) {
    const result = await pool.query(sql, values);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  },
  async transaction<T>(fn: (client: SqlExecutor) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client as SqlExecutor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};
