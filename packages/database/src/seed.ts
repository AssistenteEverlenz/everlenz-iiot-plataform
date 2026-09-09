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
    for (const [id, slug, code, name, manufacturer, model, adapter] of [
      [HAIWELL, 'a7-001', 'EVL-A7-0001', 'Haiwell A7 Teste', 'Haiwell', 'A7', 'haiwell'],
      [GENERIC, 'generic-001', 'EVL-GW-0001', 'Gateway genérico', 'Simulador', 'JSON', 'generic'],
    ]) {
      await sql.query(
        'INSERT INTO devices(id,tenant_id,site_id,slug,device_code,name,manufacturer,model,adapter_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',
        [id, TENANT, SITE, slug, code, name, manufacturer, model, adapter],
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
    const dashboard = '55555555-5555-4555-8555-555555555555';
    await sql.query(
      `INSERT INTO dashboards(id,tenant_id,device_id,name,slug,description,refresh_ms,time_window_minutes,is_default)
       VALUES($1,$2,$3,'Gestão à Vista','gestao-a-vista','Produção e condição da Haiwell A7',2000,60,true)
       ON CONFLICT DO NOTHING`,
      [dashboard, TENANT, HAIWELL],
    );
    await sql.query(
      `INSERT INTO dashboard_widgets(tenant_id,dashboard_id,device_id,tag_id,widget_type,title,position,width,config)
       SELECT $1,$2,$3,id,
        CASE key WHEN 'status' THEN 'status' WHEN 'temperatura' THEN 'gauge' ELSE 'value' END,
        name,CASE key WHEN 'temperatura' THEN 1 WHEN 'corrente_motor' THEN 2 WHEN 'velocidade' THEN 3 ELSE 4 END,
        'small',CASE key
          WHEN 'temperatura' THEN '{"color":"#f97316","min":0,"max":120}'::jsonb
          WHEN 'corrente_motor' THEN '{"color":"#14b8a6"}'::jsonb
          WHEN 'velocidade' THEN '{"color":"#3b82f6"}'::jsonb
          ELSE '{"color":"#22c55e"}'::jsonb END
       FROM tags WHERE tenant_id=$1 AND device_id=$3 ON CONFLICT DO NOTHING`,
      [TENANT, dashboard, HAIWELL],
    );
    await sql.query(
      `INSERT INTO dashboard_widgets(tenant_id,dashboard_id,device_id,tag_id,widget_type,title,position,width,config)
       SELECT $1,$2,$3,id,'line','Tendência de temperatura',5,'large','{"color":"#f97316"}'::jsonb
       FROM tags WHERE tenant_id=$1 AND device_id=$3 AND key='temperatura' ON CONFLICT DO NOTHING`,
      [TENANT, dashboard, HAIWELL],
    );
    await sql.query(
      `INSERT INTO dashboard_widgets(tenant_id,dashboard_id,device_id,tag_id,widget_type,title,position,width,config)
       VALUES($1,$2,$3,NULL,'oee','Eficiência global (OEE)',6,'medium','{"color":"#8b5cf6"}'::jsonb),
             ($1,$2,$3,NULL,'pareto','Pareto de perdas',7,'full','{"color":"#eab308"}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [TENANT, dashboard, HAIWELL],
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
