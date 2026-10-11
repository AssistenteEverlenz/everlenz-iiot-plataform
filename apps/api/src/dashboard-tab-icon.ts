import type { Database } from '@iiot/database';

/**
 * Whether the panel tabs can keep an icon yet (migration 044).
 *
 * Production applies its migrations by hand, so the code can reach the server before the
 * column does. Asking first, instead of trying and catching, keeps a snapshot restore -- which
 * runs inside a transaction that one failed statement would abort -- working either way. Once
 * the column is there it stays, so only a yes is remembered.
 */
let present = false;
export async function tabIconColumn(sql: Pick<Database, 'query'>) {
  if (present) return true;
  const found = await sql.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name='dashboard_tabs' AND column_name='icon' LIMIT 1`,
  );
  present = found.rows.length > 0;
  return present;
}

/** The icon of a tab read without naming the column, so the read works before 044 too. */
export const TAB_ICON_SELECT = `(to_jsonb(dashboard_tabs)->>'icon') AS icon`;
