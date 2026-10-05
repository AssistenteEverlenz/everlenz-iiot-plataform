import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';
import { captureProductionPhotos } from '../apps/api/src/shift-production.js';
import { evaluateFormula } from '../apps/web/components/formula.js';

/**
 * A closed day read back with the production board's formulas. The photos looked for them only
 * on the older production card, so every photo of a plant that writes them on the board came
 * back without them, and a past day showed today's numbers instead of its own.
 */
const SITE = '22222222-2222-4222-8222-222222222222';
const DASHBOARD = '55555555-5555-4555-8555-555555555555';

describe('fórmulas de um dia fechado', () => {
  it("reads the board's formulas and the day's HMI averages from the photo", async () => {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const tag = async (key: string) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO tags(tenant_id,device_id,key,name,data_type) VALUES($1,$2,$3,$3,'number') RETURNING id`,
          [TENANT, HAIWELL, key],
        )
      ).rows[0].id;
    const pallets = await tag('QuantidadePaletes');
    const speed = await tag('Velocidade');
    await db.query(
      `INSERT INTO production_settings(device_id,tenant_id,pallets_tag_id,target_metric,target_per_shift)
       VALUES($1,$2,$3,'pallets',100)`,
      [HAIWELL, TENANT, pallets],
    );
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
    await api.inject({
      method: 'POST',
      url: `/api/dashboards/${DASHBOARD}/widgets`,
      payload: {
        deviceId: HAIWELL,
        tagId: pallets,
        widgetType: 'shift_board',
        title: 'Quadro',
        width: 'full',
        config: {
          calculated: [{ id: 'v', label: 'Velocidade', formula: 'ihm.Velocidade * 2', unit: 'm/min' }],
        },
      },
    });

    const date = '2026-09-25';
    const from = new Date(`${date}T10:00:00Z`);
    for (let step = 0; step <= 40; step += 1)
      await db.query(
        `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,quality,product_code)
         VALUES($1,$2,$3,$4,$5,$5,$6,'good','BLOCO A')`,
        [TENANT, SITE, HAIWELL, pallets, new Date(from.getTime() + step * 600_000), step * 2],
      );
    // The HMI's hourly averages: 40 and 50, so the day reads 45.
    for (const [hour, average] of [[0, 40], [1, 50]])
      await db.query(
        `INSERT INTO telemetry_hourly_rollups(tenant_id,site_id,device_id,tag_id,bucket,sample_count,value_sum,value_min,value_max,first_value,first_at,last_value,last_at)
         VALUES($1,$2,$3,$4,$5,10,$6,1,1,1,$5,1,$5)`,
        [TENANT, SITE, HAIWELL, speed, new Date(from.getTime() + hour * 3600_000), average * 10],
      );
    await db.query(
      `INSERT INTO shift_reports(tenant_id,device_id,site_id,kind,shift_name,production_date,
         planned_start,planned_end,planned_seconds,pieces,pallets,tons,producing_s,idle_s,manual_s,offline_s,products,target_metric,target_value)
       VALUES($1,$2,$3,'shift','Turno 01',$4,$5,$6,28800,0,80,0,26000,2800,0,0,'[]'::jsonb,'pallets',100)`,
      [TENANT, HAIWELL, SITE, date, from, new Date(`${date}T18:00:00Z`)],
    );
    for (let run = 0; run < 6; run += 1)
      await captureProductionPhotos(db, new Date('2026-09-29T12:00:00Z'));

    const { photo } = (
      await api.inject(`/api/devices/${HAIWELL}/production-photo?date=${date}&kind=day`)
    ).json() as {
      photo: {
        calculated: Array<{ formula: string }>;
        charts: { variables: Record<string, Array<{ hour: string; value: number }>> };
      };
    };
    expect(photo.calculated.map((field) => field.formula)).toEqual(['ihm.Velocidade * 2']);
    expect(photo.charts.variables.Velocidade).toHaveLength(2);
    // The day's value is the formula over the day's average, as the board reads it.
    const points = photo.charts.variables.Velocidade;
    const average = points.reduce((sum, point) => sum + point.value, 0) / points.length;
    expect(evaluateFormula('ihm.Velocidade * 2', { 'ihm.Velocidade': average })).toBe(90);
  }, 60000);
});
