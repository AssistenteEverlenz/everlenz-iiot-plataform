import { database, pool, type Database } from './index.js';
import { pathToFileURL } from 'node:url';
export const TENANT = '11111111-1111-4111-8111-111111111111';
export const SITE = '22222222-2222-4222-8222-222222222222';
export const HAIWELL = '33333333-3333-4333-8333-333333333333';
export const GENERIC = '44444444-4444-4444-8444-444444444444';
export async function seed(db: Database = database) {
  await db.transaction(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
      TENANT,
      'poc',
      'POC Industrial',
    ]);
    await sql.query(
      'INSERT INTO sites(id,tenant_id,slug,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [SITE, TENANT, 'laboratorio', 'Laboratório'],
    );
    for (const [id, slug, name, manufacturer, model, adapter] of [
      [HAIWELL, 'a7-001', 'Haiwell A7 Teste', 'Haiwell', 'A7', 'haiwell'],
      [GENERIC, 'generic-001', 'Gateway genérico', 'Simulador', 'JSON', 'generic'],
    ]) {
      await sql.query(
        'INSERT INTO devices(id,tenant_id,site_id,slug,name,manufacturer,model,adapter_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
        [id, TENANT, SITE, slug, name, manufacturer, model, adapter],
      );
      for (const [key, type, unit] of [
        ['temperatura', 'number', '°C'],
        ['corrente_motor', 'number', 'A'],
        ['velocidade', 'number', '%'],
        ['status', 'boolean', null],
      ]) {
        await sql.query(
          'INSERT INTO tags(tenant_id,device_id,key,name,data_type,unit) VALUES($1,$2,$3,$3,$4,$5) ON CONFLICT DO NOTHING',
          [TENANT, id, key, type, unit],
        );
      }
    }
    await sql.query(
      "INSERT INTO device_topic_mappings(tenant_id,device_id,kind,topic) VALUES($1,$2,'haiwell','POC/group1/A7-001') ON CONFLICT DO NOTHING",
      [TENANT, HAIWELL],
    );
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await seed();
    console.log('Development seed applied');
  } catch {
    console.error('Seed failed; verify migrations and database access. No secrets logged.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
