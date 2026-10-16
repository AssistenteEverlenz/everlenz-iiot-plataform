import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, GENERIC } from '../packages/database/src/seed.js';
import { IngestionPipeline } from '../apps/ingestor/src/pipeline.js';

/**
 * The mixer's two processes (migration 046): every change of step opens a row and closes the
 * one before; a silence longer than the offline limit closes the step at the last message.
 */
describe('mortar process steps', () => {
  it('writes each step with its start and end, and closes a step at a silence', async () => {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    for (const [key, type] of [['ProcessoPesagem', 'number'], ['ProcessoMisturador', 'number'], ['ReceitaAtual', 'string']])
      await db.query('INSERT INTO tags(tenant_id,device_id,key,name,data_type) VALUES($1,$2,$3,$3,$4)', [
        TENANT,
        GENERIC,
        key,
        type,
      ]);
    const pipeline = new IngestionPipeline(db);
    const t0 = Date.now() - 3600_000;
    const send = (seconds: number, values: Record<string, unknown>) =>
      pipeline.ingest({
        topic: 'iiot/poc/laboratorio/generic-001/telemetry',
        payload: Buffer.from(JSON.stringify({ timestamp: new Date().toISOString(), values })),
        qos: 1,
        retain: false,
        receivedAt: new Date(t0 + seconds * 1000),
      });
    await send(0, { ProcessoPesagem: 1, ProcessoMisturador: 1, ReceitaAtual: 'AC3 BellaMassa' });
    await send(10, { ProcessoPesagem: 10, ProcessoMisturador: 1 });
    for (const at of [20, 60, 100, 140]) await send(at, { ProcessoPesagem: 10, ProcessoMisturador: 1 });
    await send(160, { ProcessoPesagem: 20, ProcessoMisturador: 5 });
    // An hour of silence, then the scale is back where it was.
    await send(3800, { ProcessoPesagem: 20, ProcessoMisturador: 5 });
    const rows = (
      await db.query<{ process: string; step: number; started: number; ended: number | null; recipe: string | null }>(
        `SELECT process,step,recipe,extract(epoch FROM started_at)::float started,
           extract(epoch FROM ended_at)::float ended
         FROM mortar_process_steps WHERE device_id=$1 ORDER BY process,started_at`,
        [GENERIC],
      )
    ).rows.map((row) => ({
      process: row.process,
      step: Number(row.step),
      from: Math.round(Number(row.started) - t0 / 1000),
      to: row.ended == null ? null : Math.round(Number(row.ended) - t0 / 1000),
    }));
    expect(rows.filter((row) => row.process === 'pesagem')).toEqual([
      { process: 'pesagem', step: 1, from: 0, to: 10 },
      { process: 'pesagem', step: 10, from: 10, to: 160 },
      { process: 'pesagem', step: 20, from: 160, to: 160 },
      { process: 'pesagem', step: 20, from: 3800, to: null },
    ]);
    expect(rows.filter((row) => row.process === 'misturador').map((row) => row.step)).toEqual([1, 5, 5]);
  });
});
