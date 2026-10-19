// Writes again the stops of a stretch the stop recorder missed, from the stored readings
// (apps/api/src/production-stops.ts, rebuildStops), for every machine that counts production.
//
//   npx -y pnpm@10.28.2 exec tsx scripts/rebuild-stops.ts <from ISO instant>
//
// From that instant up to now. Readings are kept three days, so it must run within that.
import type { Database } from '../packages/database/src/index.js';
import { rebuildStops } from '../apps/api/src/production-stops.js';

export async function rebuildAllStops(db: Database, from: Date, to = new Date()) {
  const devices = await db.query<{ id: string; name: string }>(
    `SELECT d.id,d.name FROM devices d
     JOIN production_settings ps ON ps.device_id=d.id AND ps.tenant_id=d.tenant_id
     WHERE d.archived_at IS NULL AND d.enabled=true
       AND (ps.blocks_tag_id IS NOT NULL OR ps.pallets_tag_id IS NOT NULL)
     ORDER BY d.name`,
  );
  const result = [];
  for (const device of devices.rows) {
    const rebuilt = await rebuildStops(db, device.id, from, to);
    result.push({
      device: device.name,
      stops: rebuilt?.stops ?? 0,
      openBefore: rebuilt?.carriedIn ? (rebuilt.carriedEnd?.toISOString() ?? 'still open') : '-',
    });
  }
  return result;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/rebuild-stops.ts')) {
  const from = new Date(process.argv[2] ?? '');
  if (Number.isNaN(from.getTime())) throw new Error('Informe o instante inicial (ISO)');
  if (Date.now() - from.getTime() > 3 * 24 * 3600_000)
    throw new Error('As leituras são guardadas por três dias: não dá para reconstruir antes disso');
  const { database } = await import('../packages/database/src/index.js');
  console.table(await rebuildAllStops(database, from));
  process.exit(0);
}
