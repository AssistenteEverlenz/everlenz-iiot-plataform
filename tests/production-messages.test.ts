import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';
import {
  claimNextMessage,
  normalizePhone,
  queueProductionMessages,
} from '../apps/api/src/production-messages.js';

/**
 * The WhatsApp daily summary (migration 043): written once per person per closed day, handed to
 * n8n one at a time inside the sending window, never two within three minutes.
 *
 * Tuesday 2026-10-06 is the day; the plant runs the default shift, 07:00-17:00 (UTC-3).
 */
const DAY = '2026-10-06';
const at = (iso: string) => new Date(iso);

async function platform() {
  const { db } = await memoryDatabase();
  await migrate(db);
  await seed(db);
  const pallets = (
    await db.query<{ id: string }>(
      `INSERT INTO tags(tenant_id,device_id,key,name,data_type,unit)
       VALUES($1,$2,'QuantidadePaletes','Paletes','number','paletes') RETURNING id`,
      [TENANT, HAIWELL],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO production_settings(device_id,tenant_id,pallets_tag_id,target_metric,target_per_shift)
     VALUES($1,$2,$3,'pallets',100)
     ON CONFLICT (device_id) DO UPDATE SET pallets_tag_id=$3,target_metric='pallets',target_per_shift=100`,
    [HAIWELL, TENANT, pallets],
  );
  // 10:00Z-20:00Z = 07:00-17:00 at the plant, 4 pallets every five minutes, plus overtime
  // until 18:00 at the plant.
  for (let minute = 0; minute < 11 * 60; minute += 5)
    await db.query(
      `INSERT INTO production_buckets(tenant_id,device_id,bucket,product_code,pieces,pallets,tons,producing_s,idle_s,manual_s)
       VALUES($1,$2,$3,'9x19x19',1200,1,3,280,20,0)`,
      [TENANT, HAIWELL, new Date(at(`${DAY}T10:00:00Z`).getTime() + minute * 60_000)],
    );
  const user = (
    await db.query<{ id: string }>(
      `INSERT INTO app_users(tenant_id,email,full_name,role,password_hash,must_change_password,
         phone,whatsapp_daily,whatsapp_since)
       VALUES($1,'ana@lab.test','Ana Supervisora','user','x',false,'5527999998888',true,$2) RETURNING id`,
      [TENANT, at(`${DAY}T09:00:00Z`)],
    )
  ).rows[0].id;
  await db.query(
    'INSERT INTO user_device_access(tenant_id,user_id,device_id) VALUES($1,$2,$3)',
    [TENANT, user, HAIWELL],
  );
  return { db, user };
}

const setLastIncrement = (db: Awaited<ReturnType<typeof platform>>['db'], when: Date) =>
  db.query(
    `INSERT INTO production_runtime(tenant_id,device_id,last_at,last_increment_at,auto)
     VALUES($1,$2,$3,$3,true)
     ON CONFLICT (device_id) DO UPDATE SET last_at=$3,last_increment_at=$3`,
    [TENANT, HAIWELL, when],
  );

describe('resumo diário no WhatsApp', () => {
  it('reads a Brazilian phone however it is typed', () => {
    expect(normalizePhone('(27) 99999-8888')).toBe('5527999998888');
    expect(normalizePhone('+55 27 99999-8888')).toBe('5527999998888');
    expect(normalizePhone('2733334444')).toBe('552733334444');
    expect(normalizePhone('999')).toBeNull();
  });

  it('waits for the overtime to end, then writes one message for the day', async () => {
    const { db } = await platform();
    // 17:20 at the plant: the shift is over but the line is still running (overtime).
    await setLastIncrement(db, at(`${DAY}T20:18:00Z`));
    expect(await queueProductionMessages(db, at(`${DAY}T20:20:00Z`))).toBe(0);
    // 18:40 at the plant: quiet for 40 minutes. The day closes.
    await setLastIncrement(db, at(`${DAY}T21:00:00Z`));
    expect(await queueProductionMessages(db, at(`${DAY}T21:40:00Z`))).toBe(1);
    expect(await queueProductionMessages(db, at(`${DAY}T21:45:00Z`))).toBe(0);
    const message = (
      await db.query<{ body: string; phone: string; due_at: Date }>(
        'SELECT body,phone,due_at FROM production_messages',
      )
    ).rows[0];
    expect(message.phone).toBe('5527999998888');
    // The verdict is the first line, what the lock screen shows.
    expect(message.body.startsWith('🟢 *Haiwell A7 Teste · 120 paletes · 120%*')).toBe(true);
    expect(message.body).toContain('🎯 Meta 100');
    expect(message.body).toContain('➕ 12 paletes após o turno');
    if (process.env.SHOW_MESSAGE) console.log(message.body);
  }, 30_000);

  it('hands out one message at a time, inside the window, three minutes apart', async () => {
    const { db, user } = await platform();
    await setLastIncrement(db, at(`${DAY}T21:00:00Z`));
    await queueProductionMessages(db, at(`${DAY}T21:40:00Z`));
    // A second message waiting behind the first.
    await db.query(
      `INSERT INTO production_messages(tenant_id,user_id,kind,production_date,phone,body,due_at)
       VALUES($1,$2,'test',$3,'5527999998888','teste',$4)`,
      [TENANT, user, DAY, at(`${DAY}T21:40:00Z`)],
    );
    // 23:00 at the plant: outside the window.
    expect((await claimNextMessage(db, at('2026-10-07T02:00:00Z'))).message).toBeNull();
    // Opened from the environment for a test at night.
    process.env.WHATSAPP_SEND_WINDOW = '0-24';
    expect((await claimNextMessage(db, at('2026-10-07T02:00:00Z'))).message?.kind).toBe('test');
    delete process.env.WHATSAPP_SEND_WINDOW;
    await db.query("UPDATE production_messages SET status='pending',claimed_at=NULL,attempts=0");
    // 08:00 the next morning.
    const first = await claimNextMessage(db, at('2026-10-07T11:00:00Z'));
    expect(first.message?.kind).toBe('test');
    const secondPending = (await db.query<{ body: string }>("SELECT body FROM production_messages WHERE kind='daily'")).rows[0].body;
    expect(secondPending).toContain('meta batida');
    // One minute later: too soon for the next one.
    expect((await claimNextMessage(db, at('2026-10-07T11:01:00Z'))).reason).toBe(
      'intervalo entre envios',
    );
    const second = await claimNextMessage(db, at('2026-10-07T11:04:00Z'));
    expect(second.message?.kind).toBe('daily');
    // 08:04 at the plant: the greeting is told at sending time.
    // The verdict is the first line, what the lock screen shows.
    expect(second.message?.text).toMatch(/^🟢 /);
  }, 30_000);

  it('n8n needs its key, and reports what happened', async () => {
    const { db } = await platform();
    process.env.N8N_API_KEY = 'chave-de-teste-123';
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: true });
    try {
      expect(
        (await api.inject({ url: '/api/n8n/production-messages/next' })).statusCode,
      ).toBe(401);
      await setLastIncrement(db, at(`${DAY}T21:00:00Z`));
      await queueProductionMessages(db, at(`${DAY}T21:40:00Z`));
      const id = (await db.query<{ id: string }>('SELECT id FROM production_messages')).rows[0].id;
      await db.query(`UPDATE production_messages SET status='sending',attempts=1 WHERE id=$1`, [id]);
      const done = await api.inject({
        method: 'POST',
        url: `/api/n8n/production-messages/${id}/result`,
        headers: { 'x-n8n-key': 'chave-de-teste-123' },
        payload: { ok: true },
      });
      expect(done.statusCode).toBe(200);
      const row = (await db.query<{ status: string; sent_at: Date | null }>(
        'SELECT status,sent_at FROM production_messages WHERE id=$1',
        [id],
      )).rows[0];
      expect(row.status).toBe('sent');
      expect(row.sent_at).not.toBeNull();
    } finally {
      await api.close();
      delete process.env.N8N_API_KEY;
    }
  }, 30_000);
});
