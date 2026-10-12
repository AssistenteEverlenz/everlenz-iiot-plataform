import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';
import { phoneCandidates, pickDevices } from '../apps/api/src/whatsapp-assistant.js';
import { dispatchProductionMessages } from '../apps/api/src/production-messages.js';

/**
 * The WhatsApp assistant (migration 044): who is writing, the debounce of a burst, the numbers it
 * answers with, and the daily summary pushed to n8n's webhook.
 */
const KEY = 'chave-de-teste-123';
const headers = { 'x-n8n-key': KEY };

async function platform() {
  process.env.N8N_API_KEY = KEY;
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
  // Tuesday 2026-10-06, the default shift 07:00-17:00 at the plant: 120 pallets.
  for (let minute = 0; minute < 10 * 60; minute += 5)
    await db.query(
      `INSERT INTO production_buckets(tenant_id,device_id,bucket,product_code,pieces,pallets,tons,producing_s,idle_s,manual_s)
       VALUES($1,$2,$3,'9x19x19',1200,1,3,280,20,0)`,
      [TENANT, HAIWELL, new Date(new Date('2026-10-06T10:00:00Z').getTime() + minute * 60_000)],
    );
  const user = (
    await db.query<{ id: string }>(
      `INSERT INTO app_users(tenant_id,email,full_name,role,password_hash,must_change_password,phone)
       VALUES($1,'ana@lab.test','Ana Supervisora','user','x',false,'5527999998888') RETURNING id`,
      [TENANT],
    )
  ).rows[0].id;
  await db.query('INSERT INTO user_device_access(tenant_id,user_id,device_id) VALUES($1,$2,$3)', [
    TENANT,
    user,
    HAIWELL,
  ]);
  const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: true });
  return { db, api, user };
}

afterEach(() => {
  delete process.env.N8N_API_KEY;
  delete process.env.N8N_SUMMARY_WEBHOOK_URL;
  delete process.env.EVOLUTION_URL;
  delete process.env.EVOLUTION_INSTANCE;
  delete process.env.EVOLUTION_APIKEY;
  vi.unstubAllGlobals();
});

describe('assistente do WhatsApp', () => {
  it('finds a phone with or without the ninth digit, and a machine by part of its name', () => {
    expect(phoneCandidates('5527999998888@s.whatsapp.net')).toContain('552799998888');
    expect(phoneCandidates('552799998888@s.whatsapp.net')).toContain('5527999998888');
    const devices = [
      { id: '1', name: 'Cerâmica Campo Forte' },
      { id: '2', name: 'Cerâmica Capixaba' },
    ];
    expect(pickDevices(devices, 'campo forte').map((d) => d.id)).toEqual(['1']);
    expect(pickDevices(devices, 'capixaba').map((d) => d.id)).toEqual(['2']);
    expect(pickDevices(devices, '').length).toBe(2);
  });

  it('lets only the newest message of a burst through, with the burst joined', async () => {
    const { api } = await platform();
    const jid = '552799998888@s.whatsapp.net'; // written without the ninth digit
    const send = async (text: string, messageId: string) =>
      (
        await api.inject({
          method: 'POST',
          url: '/api/n8n/whatsapp/inbound',
          headers,
          payload: { jid, text, messageId },
        })
      ).json();
    const first = await send('quanto', 'm1');
    const second = await send('produziu ontem?', 'm2');
    expect(first.known).toBe(true);
    // Evolution delivering the same message twice keeps it once.
    expect((await send('produziu ontem?', 'm2')).duplicate).toBe(true);
    // The same id with another text is a run replayed in the n8n editor: a new message.
    const replay = await send('e hoje?', 'm2');
    expect(replay.duplicate).toBe(false);
    const collect = async (token: string) =>
      (
        await api.inject({
          method: 'POST',
          url: '/api/n8n/whatsapp/collect',
          headers,
          payload: { jid, token },
        })
      ).json();
    expect((await collect(first.token)).process).toBe(false);
    expect((await collect(second.token)).process).toBe(false);
    const last = await collect(replay.token);
    expect(last.process).toBe(true);
    expect(last.text).toBe('quanto\nproduziu ontem?\ne hoje?');
    // Collected once: a second collect of the same burst gives nothing.
    expect((await collect(replay.token)).process).toBe(false);
    await api.close();
  }, 30_000);

  it('answers with the person and the numbers of a day', async () => {
    const { api } = await platform();
    expect((await api.inject('/api/n8n/whatsapp/contact?phone=5527999998888')).statusCode).toBe(401);
    const contact = (
      await api.inject({ url: '/api/n8n/whatsapp/contact?phone=552799998888', headers })
    ).json();
    expect(contact.known).toBe(true);
    expect(contact.name).toBe('Ana Supervisora');
    expect(contact.devices).toEqual(['Haiwell A7 Teste']);
    const day = (
      await api.inject({
        url: '/api/n8n/whatsapp/production?phone=5527999998888&from=2026-10-06',
        headers,
      })
    ).json();
    expect(day.found).toBe(true);
    expect(day.days[0]).toMatchObject({ date: '2026-10-06', made: 120, unit: 'paletes', target: 100, targetShare: 120 });
    const stranger = await api.inject({
      url: '/api/n8n/whatsapp/production?phone=5511000000000&from=2026-10-06',
      headers,
    });
    expect(stranger.statusCode).toBe(404);
    await api.close();
  }, 30_000);

  it('pushes the next summary to n8n, and takes it back when the webhook fails', async () => {
    const { db, api, user } = await platform();
    await db.query(
      `INSERT INTO production_messages(tenant_id,user_id,kind,production_date,phone,body,due_at)
       VALUES($1,$2,'test','2026-10-07','5527999998888','{{saudacao}} teste','2026-10-07T12:00:00Z')`,
      [TENANT, user],
    );
    process.env.N8N_SUMMARY_WEBHOOK_URL = 'https://n8n.example/webhook/resumo';
    process.env.EVOLUTION_URL = 'https://evo.example/';
    process.env.EVOLUTION_INSTANCE = 'Bell IA';
    process.env.EVOLUTION_APIKEY = 'chave-evo';
    const posted: Array<{ url: string; body: Record<string, unknown>; key: string | null }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posted.push({
        url,
        body: JSON.parse(String(init.body)),
        key: new Headers(init.headers).get('x-n8n-key'),
      });
      return new Response('{}', { status: 500 });
    });
    // 10:00 at the plant, inside the window.
    expect(await dispatchProductionMessages(db, new Date('2026-10-07T13:00:00Z'))).toBe(0);
    expect(posted[0].url).toBe('https://n8n.example/webhook/resumo');
    expect(posted[0].key).toBe(KEY);
    expect(posted[0].body).toMatchObject({ number: '5527999998888', name: 'Ana Supervisora' });
    // The Evolution connection goes with it, so the n8n flow needs no copy of it.
    expect(posted[0].body.evolution).toEqual({ url: 'https://evo.example', instance: 'Bell IA', apikey: 'chave-evo' });
    expect(String(posted[0].body.text)).toMatch(/^Bom dia, Ana/);
    // The day's two images go with it, as PNG.
    const images = posted[0].body.images as Array<{ kind: string; base64: string; mimetype: string }>;
    expect(images.map((image) => image.kind)).toEqual(['producao', 'paradas']);
    expect(images[0].mimetype).toBe('image/png');
    expect(Buffer.from(images[0].base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const back = (await db.query<{ status: string }>('SELECT status FROM production_messages')).rows[0];
    expect(back.status).toBe('pending');
    await api.close();
  }, 30_000);
});
