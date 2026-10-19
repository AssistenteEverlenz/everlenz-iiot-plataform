// Writes again the stops of a stretch the stop recorder missed, from the stored readings
// (apps/api/src/production-stops.ts, rebuildStops), for every machine that counts production.
//
//   npx -y pnpm@10.28.2 exec tsx scripts/rebuild-stops.ts <from ISO instant> [machine names...] [--dry]
//
// From that instant up to now; with names, only those machines (a name may carry its own start
// as "Name=ISO"). --dry writes nothing and prints the stops it would write. Readings are kept
// three days, so it must run within that.
import type { Database } from '../packages/database/src/index.js';
import { rebuildStops } from '../apps/api/src/production-stops.js';

const clock = (at: Date | null) =>
  at
    ? at.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'aberta';

export async function rebuildAllStops(
  db: Database,
  from: Date,
  options: { names?: Map<string, Date | null>; dryRun?: boolean; to?: Date } = {},
) {
  const devices = await db.query<{ id: string; name: string }>(
    `SELECT d.id,d.name FROM devices d
     JOIN production_settings ps ON ps.device_id=d.id AND ps.tenant_id=d.tenant_id
     WHERE d.archived_at IS NULL AND d.enabled=true
       AND (ps.blocks_tag_id IS NOT NULL OR ps.pallets_tag_id IS NOT NULL)
     ORDER BY d.name`,
  );
  const result = [];
  for (const device of devices.rows) {
    if (options.names && !options.names.has(device.name)) continue;
    const start = options.names?.get(device.name) ?? from;
    const rebuilt = await rebuildStops(db, device.id, start, options.to ?? new Date(), {
      dryRun: options.dryRun,
    });
    result.push({
      device: device.name,
      from: clock(start),
      stops: rebuilt?.stops ?? 0,
      openBefore: rebuilt?.carriedIn ? clock(rebuilt.carriedEnd) : '-',
    });
    if (options.dryRun && rebuilt)
      for (const row of rebuilt.rows.slice(0, 8))
        console.log(`  ${device.name}: ${row.state} ${clock(row.started_at)} -> ${clock(row.ended_at)}`);
  }
  return result;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/rebuild-stops.ts')) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const [first, ...rest] = args.filter((arg) => arg !== '--dry');
  const from = new Date(first ?? '');
  if (Number.isNaN(from.getTime())) throw new Error('Informe o instante inicial (ISO)');
  const names = rest.length
    ? new Map(
        rest.map((arg) => {
          const [name, at] = arg.split('=');
          return [name, at ? new Date(at) : null] as const;
        }),
      )
    : undefined;
  for (const at of [from, ...(names ? [...names.values()] : [])])
    if (at && Date.now() - at.getTime() > 3 * 24 * 3600_000)
      throw new Error('As leituras são guardadas por três dias: não dá para reconstruir antes disso');
  const { database } = await import('../packages/database/src/index.js');
  console.table(await rebuildAllStops(database, from, { names, dryRun }));
  process.exit(0);
}
