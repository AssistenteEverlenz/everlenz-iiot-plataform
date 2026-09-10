import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL, GENERIC } from '../packages/database/src/seed.js';
import { IngestionPipeline } from '../apps/ingestor/src/pipeline.js';
import { simulatedMessage } from '../apps/simulator/src/messages.js';
import { createApp } from '../apps/api/src/app.js';
import type { Database } from '../packages/database/src/index.js';
import { hashPassword, sessionTokenHash } from '../packages/shared/src/index.js';
let db: Database, close: () => Promise<void>, pipeline: IngestionPipeline;
beforeAll(async () => {
  ({ db, close } = await memoryDatabase());
  await migrate(db);
  await seed(db);
  pipeline = new IngestionPipeline(db);
}, 30000);
afterAll(async () => close());
const ingest = (topic: string, payload: string | Buffer) =>
  pipeline.ingest({
    topic,
    payload: Buffer.from(payload),
    qos: 1,
    retain: false,
    receivedAt: new Date(),
  });
describe('SQL integration (PostgreSQL engine via PGlite, not Docker/Mosquitto)', () => {
  it('migrations and seed are idempotent', async () => {
    await migrate(db);
    await seed(db);
    expect((await db.query('SELECT * FROM devices')).rows).toHaveLength(2);
  });
  it.each(['haiwell', 'generic'] as const)(
    '%s simulator -> RAW -> adapter -> samples -> API',
    async (mode) => {
      const m = simulatedMessage(mode, 0);
      const result = await ingest(m.topic, m.payload);
      expect(result.status).toBe('processed');
      const samples = await db.query<{
        value_number: number | null;
        value_boolean: boolean | null;
      }>('SELECT * FROM telemetry_samples WHERE raw_message_id=$1', [result.rawId]);
      expect(samples.rows).toHaveLength(4);
      expect(samples.rows.some((s) => s.value_number === 70)).toBe(true);
      expect(samples.rows.some((s) => s.value_boolean === true)).toBe(true);
      const raw = await db.query<{
        payload_hex: string;
        processing_status: string;
        processed_at: string | null;
      }>('SELECT * FROM mqtt_messages_raw WHERE id=$1', [result.rawId]);
      expect(raw.rows[0].payload_hex).toBe(Buffer.from(m.payload).toString('hex'));
      expect(raw.rows[0].processed_at).not.toBeNull();
      const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
      try {
        const response = await api.inject(
          `/api/devices/${mode === 'haiwell' ? HAIWELL : GENERIC}/latest`,
        );
        expect(response.statusCode).toBe(200);
        expect(response.json()).toHaveLength(4);
      } finally {
        await api.close();
      }
    },
  );
  it('processes a burst without leaving a RAW backlog', async () => {
    const results = [];
    for (let step = 0; step < 20; step += 1) {
      const message = simulatedMessage('haiwell', step);
      results.push(await ingest(message.topic, message.payload));
    }
    expect(results.every((result) => result.status === 'processed')).toBe(true);
    const pending = await db.query<{ count: number }>(
      "SELECT count(*)::int count FROM mqtt_messages_raw WHERE processing_status='pending'",
    );
    expect(pending.rows[0].count).toBe(0);
  });
  it('rolls numeric telemetry up and preserves counter increments across a reset', async () => {
    const tag = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type,unit)
         VALUES($1,$2,'test_counter_rollup','Contador de teste','number','un') RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO telemetry_samples(
        tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,quality
       ) VALUES
        ($1,'22222222-2222-4222-8222-222222222222',$2,$3,'2026-09-10T10:00:00Z',now(),10,'good'),
        ($1,'22222222-2222-4222-8222-222222222222',$2,$3,'2026-09-10T10:01:00Z',now(),15,'good'),
        ($1,'22222222-2222-4222-8222-222222222222',$2,$3,'2026-09-10T10:02:00Z',now(),2,'good')`,
      [TENANT, HAIWELL, tag.id],
    );
    const rollup = (
      await db.query<{ sample_count: number; positive_delta: number }>(
        `SELECT sample_count::int sample_count,positive_delta
         FROM telemetry_hourly_rollups WHERE device_id=$1 AND tag_id=$2`,
        [HAIWELL, tag.id],
      )
    ).rows[0];
    expect(rollup).toMatchObject({ sample_count: 3, positive_delta: 7 });
    await db.query('DELETE FROM telemetry_samples WHERE tag_id=$1', [tag.id]);
    await db.query('DELETE FROM tags WHERE id=$1', [tag.id]);
  });
  it('attributes counter increments to the HMI recipe and falls back to the configured product', async () => {
    const tag = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type,unit)
         VALUES($1,$2,'QuantidadePaletesProduto','Paletes por produto','number','paletes')
         RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO production_context_settings(
         tenant_id,device_id,product_key,fallback_product_code
       ) VALUES($1,$2,'receita','PRODUTO PADRAO')`,
      [TENANT, HAIWELL],
    );
    const productPipeline = new IngestionPipeline(db);
    const send = (receita: string, value: number) =>
      productPipeline.ingest({
        topic: 'data/POC/group1/A7-001',
        payload: Buffer.from(
          JSON.stringify({
            _terminalTime: new Date(Date.now() + value * 1000).toISOString(),
            _groupName: 'group1',
            receita,
            QuantidadePaletesProduto: String(value),
          }),
        ),
        qos: 1,
        retain: false,
        receivedAt: new Date(Date.now() + value * 1000),
      });
    await send('BLOCO A', 10);
    await send('BLOCO A', 14);
    await send('BLOCO B', 18);
    await db.query('UPDATE production_context_settings SET product_key=NULL WHERE device_id=$1', [
      HAIWELL,
    ]);
    const fallbackPipeline = new IngestionPipeline(db);
    await fallbackPipeline.ingest({
      topic: 'data/POC/group1/A7-001',
      payload: Buffer.from(
        JSON.stringify({
          _terminalTime: new Date(Date.now() + 21000).toISOString(),
          _groupName: 'group1',
          QuantidadePaletesProduto: '20',
        }),
      ),
      qos: 1,
      retain: false,
      receivedAt: new Date(Date.now() + 21000),
    });
    const rollups = await db.query<{ product_code: string; positive_delta: number }>(
      `SELECT product_code,sum(positive_delta) positive_delta
       FROM telemetry_hourly_rollups WHERE device_id=$1 AND tag_id=$2
       GROUP BY product_code ORDER BY product_code`,
      [HAIWELL, tag.id],
    );
    expect(rollups.rows).toEqual([
      { product_code: 'BLOCO A', positive_delta: 4 },
      { product_code: 'BLOCO B', positive_delta: 4 },
      { product_code: 'PRODUTO PADRAO', positive_delta: 2 },
    ]);
    await db.query('DELETE FROM telemetry_samples WHERE tag_id=$1', [tag.id]);
    await db.query('DELETE FROM production_context_settings WHERE device_id=$1', [HAIWELL]);
    await db.query(
      `DELETE FROM device_signal_catalog
       WHERE device_id=$1 AND key IN ('receita','QuantidadePaletesProduto')`,
      [HAIWELL],
    );
    await db.query('DELETE FROM tags WHERE id=$1', [tag.id]);
  });
  it('preserves unknown binary and invalid JSON, then processes next valid message', async () => {
    const binary = await ingest('unknown/device', Buffer.from([0xff, 0x00, 0xfe]));
    expect(binary.status).toBe('unrecognized');
    const invalid = await ingest('data/POC/group1/A7-001', '{bad-json');
    expect(invalid.status).toBe('unrecognized');
    const row = await db.query<{ payload_hex: string; payload_text: string | null }>(
      'SELECT * FROM mqtt_messages_raw WHERE id=$1',
      [binary.rawId],
    );
    expect(row.rows[0]).toMatchObject({ payload_hex: 'ff00fe', payload_text: null });
    const m = simulatedMessage('haiwell', 2);
    expect((await ingest(m.topic, m.payload)).status).toBe('processed');
  });
  it('puts a talking device online even when its message stores no samples', async () => {
    const status = () =>
      db.query<{ online: boolean; last_message_at: Date }>(
        'SELECT online,last_message_at FROM device_status WHERE device_id=$1',
        [HAIWELL],
      );
    const send = (payload: unknown, offsetSeconds: number) =>
      pipeline.ingest({
        topic: 'data/POC/group1/A7-001',
        payload: Buffer.from(JSON.stringify(payload)),
        qos: 1,
        retain: false,
        receivedAt: new Date(Date.now() + offsetSeconds * 1000),
      });
    await db.query('UPDATE device_status SET online=false WHERE device_id=$1', [HAIWELL]);

    // Freshly commissioned: only variables nobody configured yet.
    const noTags = await send(
      { _terminalTime: 'x', _groupName: 'group1', variavel_nova: '1' },
      120,
    );
    expect(noTags.status).toBe('unrecognized');
    expect((await status()).rows[0].online).toBe(true);
    const raw = await db.query<{ device_id: string; processing_error: string }>(
      'SELECT device_id,processing_error FROM mqtt_messages_raw WHERE id=$1',
      [noTags.rawId],
    );
    expect(raw.rows[0]).toMatchObject({
      device_id: HAIWELL,
      processing_error: 'No configured tags in payload',
    });

    // A payload in another format still proves the link works.
    await db.query('UPDATE device_status SET online=false WHERE device_id=$1', [HAIWELL]);
    const otherFormat = await send({ formato: 'desconhecido' }, 180);
    expect(otherFormat.status).toBe('unrecognized');
    const seen = (await status()).rows[0];
    expect(seen.online).toBe(true);
    expect(new Date(seen.last_message_at).getTime()).toBeGreaterThan(Date.now() + 150_000);
  });
  it('deletes a device and everything recorded for it', async () => {
    const device = 'a1b2c3d4-0000-4000-8000-00000000d31e';
    const topic = 'iiot/tenant-z/site-z/evl-apagar-teste/telemetry';
    await db.query(
      `INSERT INTO devices(id,tenant_id,site_id,slug,device_code,name,manufacturer,model,mqtt_identifier,adapter_type,mqtt_username)
       VALUES($1,$2,'22222222-2222-4222-8222-222222222222','apagar-teste','EVL-DEL-APAGAR','Apagar teste','Delta','DOP-107EV',$3,'generic','evl-del-apagar')`,
      [device, TENANT, `device-${device}`],
    );
    await db.query(
      `INSERT INTO device_topic_mappings(tenant_id,device_id,kind,topic) VALUES($1,$2,'exact',$3)`,
      [TENANT, device, topic],
    );
    await db.query(
      `INSERT INTO tags(tenant_id,device_id,key,name,data_type) VALUES($1,$2,'contagem','Contagem','number')`,
      [TENANT, device],
    );
    await db.query(
      `INSERT INTO dashboards(tenant_id,device_id,name,slug) VALUES($1,$2,'Apagar teste','apagar-teste')`,
      [TENANT, device],
    );
    const sent = await pipeline.ingest({
      topic,
      payload: Buffer.from(JSON.stringify({ values: { contagem: 5, nova: 1 } })),
      qos: 1,
      retain: false,
      receivedAt: new Date(),
    });
    expect(sent.status).toBe('processed');
    // The signal catalog is written asynchronously after ingestion.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      expect(
        (await api.inject({ method: 'DELETE', url: `/api/devices/${device}` })).statusCode,
      ).toBe(204);
      for (const table of [
        'telemetry_samples',
        'mqtt_messages_raw',
        'device_status',
        'dashboards',
        'tags',
        'device_topic_mappings',
        'device_signal_catalog',
      ]) {
        const left = await db.query<{ count: number }>(
          `SELECT count(*)::int count FROM ${table} WHERE device_id=$1`,
          [device],
        );
        expect({ table, count: left.rows[0].count }).toEqual({ table, count: 0 });
      }
      const gone = await db.query('SELECT 1 FROM devices WHERE id=$1', [device]);
      expect(gone.rows).toHaveLength(0);
      // A second delete finds nothing.
      expect(
        (await api.inject({ method: 'DELETE', url: `/api/devices/${device}` })).statusCode,
      ).toBe(404);
    } finally {
      await api.close();
    }
  });
  it('serves chart history averaged per minute', async () => {
    const tag = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type)
         VALUES($1,$2,'grafico_minuto','Gráfico por minuto','number') RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    const sample = (at: string, value: number) =>
      db.query(
        `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,quality)
         VALUES($1,'22222222-2222-4222-8222-222222222222',$2,$3,$4,now(),$5,'good')`,
        [TENANT, HAIWELL, tag, at, value],
      );
    await sample('2026-03-01T10:00:05Z', 10);
    await sample('2026-03-01T10:00:25Z', 20);
    await sample('2026-03-01T10:00:55Z', 30);
    await sample('2026-03-01T10:01:10Z', 40);
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      const rows = (
        await api.inject(
          `/api/telemetry?deviceId=${HAIWELL}&tagId=${tag}&from=2026-03-01T09:59:00Z&to=2026-03-01T10:05:00Z&bucket=minute`,
        )
      ).json() as { tag_id: string; timestamp: string; value_number: number }[];
      // Newest first, as the raw history: one point per minute, the minute's average.
      expect(rows.map((row) => [new Date(row.timestamp).toISOString(), row.value_number])).toEqual([
        ['2026-03-01T10:01:00.000Z', 40],
        ['2026-03-01T10:00:00.000Z', 20],
      ]);
      expect(rows.every((row) => row.tag_id === tag)).toBe(true);
    } finally {
      await api.close();
      await db.query('DELETE FROM telemetry_samples WHERE tag_id=$1', [tag]);
      await db.query('DELETE FROM tags WHERE id=$1', [tag]);
    }
  });
  it('stores valid UTF8 containing NUL without losing original bytes', async () => {
    const result = await ingest('unknown/nul', 'a\u0000b');
    expect(result.status).toBe('unrecognized');
    expect(
      (
        await db.query<{ payload_hex: string }>(
          'SELECT payload_hex FROM mqtt_messages_raw WHERE id=$1',
          [result.rawId],
        )
      ).rows[0].payload_hex,
    ).toBe('610062');
  });
  it('bad tag rolls back normalized values while preserving RAW error', async () => {
    const result = await ingest(
      'data/POC/group1/A7-001',
      JSON.stringify({
        _terminalTime: new Date().toISOString(),
        _groupName: 'g',
        temperatura: '65',
        status: 'maybe',
      }),
    );
    expect(result.status).toBe('error');
    expect(
      (await db.query('SELECT * FROM telemetry_samples WHERE raw_message_id=$1', [result.rawId]))
        .rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query<{ processing_status: string }>(
          'SELECT * FROM mqtt_messages_raw WHERE id=$1',
          [result.rawId],
        )
      ).rows[0].processing_status,
    ).toBe('error');
  });
  it('foreign keys prevent mixing tenant IDs', async () => {
    await db.query("INSERT INTO tenants(id,slug,name) VALUES($1,'other','Other tenant')", [
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]);
    await expect(
      db.query(
        "INSERT INTO tags(tenant_id,device_id,key,name,data_type) VALUES($1,$2,'cross','cross','number')",
        ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', HAIWELL],
      ),
    ).rejects.toThrow();
  });
  it('malformed escaped Unicode cannot prevent RAW persistence or the next message', async () => {
    const payload =
      '{"_terminalTime":"2026-01-01T00:00:00Z","_groupName":"g","temperatura":"\\ud800"}';
    const result = await ingest('data/POC/group1/A7-001', payload);
    expect(result.status).toBe('error');
    const raw = await db.query<{ payload_hex: string; tenant_id: string }>(
      'SELECT * FROM mqtt_messages_raw WHERE id=$1',
      [result.rawId],
    );
    expect(raw.rows[0].payload_hex).toBe(Buffer.from(payload).toString('hex'));
    expect(raw.rows[0].tenant_id).toBe(TENANT);
    const good = simulatedMessage('haiwell', 5);
    expect((await ingest(good.topic, good.payload)).status).toBe('processed');
  });
  it('deeply nested JSON is retained even if serialization fails', async () => {
    const payload = '['.repeat(15000) + '0' + ']'.repeat(15000);
    const result = await ingest('unknown/deep', payload);
    expect(['error', 'unrecognized']).toContain(result.status);
    const raw = await db.query<{ payload_hex: string }>(
      'SELECT payload_hex FROM mqtt_messages_raw WHERE id=$1',
      [result.rawId],
    );
    expect(raw.rows[0].payload_hex).toBe(Buffer.from(payload).toString('hex'));
  });
  it('tenant scope cannot be bypassed with a header or query parameter', async () => {
    const api = await createApp(db, {
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operatorRaw: false,
    });
    try {
      for (const url of [
        '/api/tenants',
        '/api/sites',
        '/api/devices',
        `/api/devices/${HAIWELL}/tags`,
        `/api/devices/${HAIWELL}/latest`,
        `/api/telemetry?deviceId=${HAIWELL}`,
        '/api/mqtt/raw',
        '/api/mqtt/topics',
      ]) {
        const response = await api.inject({ url, headers: { 'x-tenant-id': TENANT } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([]);
      }
      expect((await api.inject(`/api/devices/${HAIWELL}?tenantId=${TENANT}`)).statusCode).toBe(404);
    } finally {
      await api.close();
    }
  });
  it('operator can inspect unresolved raw without exposing another known tenant', async () => {
    const api = await createApp(db, {
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operatorRaw: true,
    });
    try {
      const response = await api.inject('/api/mqtt/raw');
      expect(response.json().length).toBeGreaterThan(0);
      expect(response.json().every((r: { tenant_id: string | null }) => r.tenant_id === null)).toBe(
        true,
      );
    } finally {
      await api.close();
    }
  });
  it('API validates pagination, UUIDs, ranges and processing status', async () => {
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      for (const url of [
        '/api/devices/bad',
        '/api/devices?limit=9999',
        '/api/mqtt/raw?offset=-1',
        '/api/mqtt/raw?processingStatus=nope',
        `/api/telemetry?deviceId=${HAIWELL}&from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z`,
      ])
        expect((await api.inject(url)).statusCode).toBe(400);
    } finally {
      await api.close();
    }
  });
  it('API exact-topic filter, pagination and telemetry tag filter work', async () => {
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      const response = await api.inject('/api/mqtt/raw?topic=data%2FPOC%2Fgroup1%2FA7-001&limit=1');
      expect(response.json()).toHaveLength(1);
      expect(response.json()[0].topic).toBe('data/POC/group1/A7-001');
      const tags = (await api.inject(`/api/devices/${HAIWELL}/tags`)).json() as {
        id: string;
        key: string;
      }[];
      const tag = tags.find((t) => t.key === 'temperatura')!;
      const samples = (
        await api.inject(`/api/telemetry?deviceId=${HAIWELL}&tagId=${tag.id}&limit=1`)
      ).json();
      expect(samples).toHaveLength(1);
      expect(samples[0].key).toBe('temperatura');
      const overview = (await api.inject('/api/overview')).json();
      expect(overview.devices).toBe(2);
      expect(overview.messagesPerMinute).toBeGreaterThan(0);
      expect(overview.messages).toBeUndefined();
    } finally {
      await api.close();
    }
  });
  it('discovers signals and supports dashboard, CSV and guided device APIs', async () => {
    const message = simulatedMessage('haiwell', 9);
    expect((await ingest(message.topic, message.payload)).status).toBe('processed');
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      const signals = (await api.inject(`/api/devices/${HAIWELL}/signals`)).json() as {
        key: string;
        configured: boolean;
        tag_id: string;
      }[];
      expect(signals.map((signal) => signal.key)).toEqual(
        expect.arrayContaining(['temperatura', 'corrente_motor', 'velocidade', 'status']),
      );
      expect(
        signals
          .filter((signal) =>
            ['temperatura', 'corrente_motor', 'velocidade', 'status'].includes(signal.key),
          )
          .every((signal) => signal.configured),
      ).toBe(true);

      const dashboards = (await api.inject('/api/dashboards')).json() as { id: string }[];
      expect(dashboards).toHaveLength(1);
      const dashboard = (await api.inject(`/api/dashboards/${dashboards[0].id}`)).json() as {
        widgets: unknown[];
      };
      expect(dashboard.widgets.length).toBeGreaterThanOrEqual(4);

      const production = await api.inject({
        method: 'POST',
        url: `/api/dashboards/${dashboards[0].id}/widgets`,
        payload: {
          deviceId: HAIWELL,
          tagId: signals.find((signal) => signal.key === 'temperatura')!.tag_id,
          widgetType: 'production',
          title: 'Produção operacional',
          width: 'large',
          config: { productionPeriodMinutes: 30, productionMinimumValue: 1 },
        },
      });
      expect(production.statusCode).toBe(201);
      const dashboardStatistics = (
        await api.inject(`/api/dashboards/${dashboards[0].id}/statistics`)
      ).json();
      expect(dashboardStatistics).toEqual([
        expect.objectContaining({
          widget_id: production.json().id,
          period_minutes: 10080,
          period: '7d',
          minimum_value: 1,
          samples: expect.any(Number),
          product_breakdown: expect.any(Array),
        }),
      ]);

      const statistics = (
        await api.inject(`/api/devices/${HAIWELL}/statistics?hours=24`)
      ).json() as { key: string; maximum: number | null }[];
      expect(statistics.find((item) => item.key === 'temperatura')?.maximum).toBeTypeOf('number');

      const exportResponse = await api.inject(
        `/api/export/telemetry.csv?deviceId=${HAIWELL}&limit=10`,
      );
      expect(exportResponse.statusCode).toBe(200);
      expect(exportResponse.headers['content-type']).toContain('text/csv');
      expect(exportResponse.body).toContain('device_code');

      const created = await api.inject({
        method: 'POST',
        url: '/api/devices',
        payload: {
          siteId: '22222222-2222-4222-8222-222222222222',
          name: 'Forno túnel teste',
          manufacturer: 'Haiwell',
          model: 'A7',
          adapterType: 'haiwell',
          topic: 'data/POC/group1/A7-INTEGRATION-TEST',
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().device.device_code).toMatch(/^EVL-HAI-/);
      expect(created.json().dashboardId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(created.json().device.provisioning_status).toBe('awaiting_connection');
      expect(created.json().connection.username).toBe(
        created.json().device.device_code.toLowerCase(),
      );
      expect(created.json().connection.password).toHaveLength(20);
      expect(created.json().connection.topic).toMatch(/^iiot\//);
      const dashboardsAfterCreate = (await api.inject('/api/dashboards')).json() as {
        id: string;
        device_name: string;
        site_name: string;
        device_online: boolean;
        device_deactivated: boolean;
      }[];
      expect(dashboardsAfterCreate).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: created.json().dashboardId,
            device_name: 'Forno túnel teste',
            site_name: 'Laboratório',
            device_online: false,
            device_deactivated: false,
          }),
        ]),
      );
    } finally {
      await api.close();
    }
  });
  it('authenticates the master, enforces first access and isolates users by device', async () => {
    const masterPassword = 'InitialMaster9!';
    const masterHash = await hashPassword(masterPassword);
    await db.query(
      `INSERT INTO app_users(tenant_id,email,full_name,role,password_hash,must_change_password)
       VALUES($1,'master@integration.test','Master Test','master',$2,true)`,
      [TENANT, masterHash],
    );
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: true });
    try {
      expect((await api.inject('/api/devices')).statusCode).toBe(401);
      const masterLogin = await api.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'master@integration.test', password: masterPassword },
      });
      expect(masterLogin.statusCode).toBe(200);
      const firstMasterToken = masterLogin.json().token as string;
      expect(
        (
          await api.inject({
            url: '/api/devices',
            headers: { authorization: `Bearer ${firstMasterToken}` },
          })
        ).statusCode,
      ).toBe(428);
      const masterChange = await api.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { authorization: `Bearer ${firstMasterToken}` },
        payload: { password: 'PermanentMaster9!', confirmation: 'PermanentMaster9!' },
      });
      expect(masterChange.statusCode).toBe(200);
      const masterToken = masterChange.json().token as string;
      const brandingUpdate = await api.inject({
        method: 'PATCH',
        url: '/api/branding',
        headers: { authorization: `Bearer ${masterToken}` },
        payload: {
          productName: 'Everlenz IIoT',
          subtitle: 'Industrial Intelligence',
          logoUrl: `data:image/png;base64,${'A'.repeat(700_000)}`,
          primaryColor: '#0b2028',
          accentColor: '#12b8a6',
        },
      });
      expect(brandingUpdate.statusCode).toBe(200);
      const created = await api.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${masterToken}` },
        payload: {
          email: 'client@integration.test',
          fullName: 'Client Test',
          status: 'active',
          deviceIds: [HAIWELL],
        },
      });
      expect(created.statusCode).toBe(201);
      const clientId = created.json().user.id as string;
      const clientLogin = await api.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'client@integration.test',
          password: created.json().temporaryPassword,
        },
      });
      const firstClientToken = clientLogin.json().token as string;
      const clientChange = await api.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { authorization: `Bearer ${firstClientToken}` },
        payload: { password: 'PermanentClient9!', confirmation: 'PermanentClient9!' },
      });
      const clientToken = clientChange.json().token as string;
      const clientDevices = await api.inject({
        url: '/api/devices',
        headers: { authorization: `Bearer ${clientToken}` },
      });
      expect(clientDevices.json().map((device: { id: string }) => device.id)).toEqual([HAIWELL]);
      expect(
        (
          await api.inject({
            url: `/api/devices/${GENERIC}/latest`,
            headers: { authorization: `Bearer ${clientToken}` },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await api.inject({
            url: '/api/users',
            headers: { authorization: `Bearer ${clientToken}` },
          })
        ).statusCode,
      ).toBe(403);
      const masterDashboard = await api.inject({
        url: '/api/dashboards/55555555-5555-4555-8555-555555555555',
        headers: { authorization: `Bearer ${masterToken}` },
      });
      const clientDashboard = await api.inject({
        method: 'PATCH',
        url: '/api/dashboards/55555555-5555-4555-8555-555555555555',
        headers: { authorization: `Bearer ${clientToken}` },
        payload: { refreshMs: 1000 },
      });
      expect(clientDashboard.statusCode).toBe(200);
      expect(clientDashboard.json().refresh_ms).toBe(1000);
      const clientTags = await api.inject({
        url: `/api/devices/${HAIWELL}/tags`,
        headers: { authorization: `Bearer ${clientToken}` },
      });
      const addedWidget = await api.inject({
        method: 'POST',
        url: '/api/dashboards/55555555-5555-4555-8555-555555555555/widgets',
        headers: { authorization: `Bearer ${clientToken}` },
        payload: {
          deviceId: HAIWELL,
          tagId: clientTags.json()[0].id,
          widgetType: 'value',
          title: 'Visão compartilhada',
          width: 'small',
          config: { decimals: 2 },
        },
      });
      expect(addedWidget.statusCode).toBe(201);
      const clientView = await api.inject({
        url: '/api/dashboards/55555555-5555-4555-8555-555555555555',
        headers: { authorization: `Bearer ${clientToken}` },
      });
      expect(clientView.json().widgets).toHaveLength(masterDashboard.json().widgets.length + 1);
      const masterViewAfter = await api.inject({
        url: '/api/dashboards/55555555-5555-4555-8555-555555555555',
        headers: { authorization: `Bearer ${masterToken}` },
      });
      expect(masterViewAfter.json().widgets).toHaveLength(
        masterDashboard.json().widgets.length + 1,
      );
      expect(masterViewAfter.json().widgets.at(-1).title).toBe('Visão compartilhada');
      expect(masterViewAfter.json().refresh_ms).toBe(1000);
      expect(
        (
          await api.inject({
            method: 'PATCH',
            url: `/api/users/${clientId}`,
            headers: { authorization: `Bearer ${masterToken}` },
            payload: { status: 'inactive' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api.inject({
            url: '/api/devices',
            headers: { authorization: `Bearer ${clientToken}` },
          })
        ).statusCode,
      ).toBe(401);
      const masterId = masterLogin.json().user.id as string;
      expect(
        (
          await api.inject({
            method: 'PATCH',
            url: `/api/users/${masterId}`,
            headers: { authorization: `Bearer ${masterToken}` },
            payload: { status: 'inactive' },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await api.close();
    }
  });
  it('never stores broker passwords, records an audit trail and locks out brute force', async () => {
    const password = 'SecurityMaster9!';
    await db.query(
      `INSERT INTO app_users(tenant_id,email,full_name,role,password_hash,must_change_password)
       VALUES($1,'security@integration.test','Security Master','master',$2,false)`,
      [TENANT, await hashPassword(password)],
    );
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: true });
    try {
      const login = await api.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'security@integration.test', password },
      });
      const token = login.json().token as string;
      const auth = { authorization: `Bearer ${token}` };

      // Item 12: the generated password is returned exactly once and never persisted.
      const siteId = (await api.inject({ url: '/api/sites', headers: auth })).json()[0].id;
      const createdDevice = await api.inject({
        method: 'POST',
        url: '/api/devices',
        headers: auth,
        payload: { siteId, name: 'Prensa Segura', manufacturer: 'Haiwell', model: 'A7' },
      });
      expect(createdDevice.statusCode).toBe(201);
      expect(createdDevice.json().connection.password).toMatch(/^.{20}$/);
      const deviceId = createdDevice.json().device.id as string;
      expect(createdDevice.json().device).not.toHaveProperty('mqtt_password');
      const listed = (await api.inject({ url: '/api/devices', headers: auth })).json();
      for (const device of listed) expect(device).not.toHaveProperty('mqtt_password');
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='devices' AND column_name='mqtt_password'`,
      );
      expect(columns.rows).toHaveLength(0);

      // Rotation is the only way back to a usable secret, and it differs from the first.
      const rotated = await api.inject({
        method: 'POST',
        url: `/api/devices/${deviceId}/mqtt-credential`,
        headers: auth,
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().connection.password).not.toBe(createdDevice.json().connection.password);

      // Item 16: both the creation and the rotation are attributable.
      const trail = await db.query<{ action: string; actor_email: string; target_id: string }>(
        'SELECT action,actor_email,target_id FROM audit_log WHERE target_id=$1 ORDER BY id',
        [deviceId],
      );
      expect(trail.rows.map((row) => row.action)).toEqual([
        'device.create',
        'device.mqtt_credential.rotate',
      ]);
      expect(trail.rows[0].actor_email).toBe('security@integration.test');

      // Item 4: a viewer cannot rewrite tag scaling.
      const viewer = await api.inject({
        method: 'POST',
        url: '/api/users',
        headers: auth,
        payload: {
          email: 'viewer@integration.test',
          fullName: 'Viewer Test',
          status: 'active',
          deviceIds: [HAIWELL],
        },
      });
      const viewerFirst = await api.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'viewer@integration.test',
          password: viewer.json().temporaryPassword,
        },
      });
      const viewerToken = (
        await api.inject({
          method: 'POST',
          url: '/api/auth/change-password',
          headers: { authorization: `Bearer ${viewerFirst.json().token}` },
          payload: { password: 'PermanentViewer9!', confirmation: 'PermanentViewer9!' },
        })
      ).json().token as string;
      expect(
        (
          await api.inject({
            method: 'POST',
            url: `/api/devices/${HAIWELL}/tags`,
            headers: { authorization: `Bearer ${viewerToken}` },
            payload: { key: 'forjada', name: 'Forjada', dataType: 'number', scaleMultiplier: 1000 },
          })
        ).statusCode,
      ).toBe(403);

      // Item 7b: the lockout is durable and survives coming from fresh addresses, which
      // is exactly what defeats the per-origin memory throttle.
      for (let attempt = 0; attempt < 10; attempt += 1)
        expect(
          (
            await api.inject({
              method: 'POST',
              url: '/api/auth/login',
              remoteAddress: `198.51.100.${attempt + 1}`,
              payload: { email: 'viewer@integration.test', password: 'WrongPassword9!' },
            })
          ).statusCode,
        ).toBe(401);
      const locked = await db.query<{ failed_attempts: number; locked_until: Date | null }>(
        'SELECT failed_attempts,locked_until FROM app_users WHERE email=$1',
        ['viewer@integration.test'],
      );
      expect(locked.rows[0].failed_attempts).toBe(10);
      expect(locked.rows[0].locked_until).not.toBeNull();
      // The correct password is now refused, with the same opaque 401 as a wrong one.
      const refused = await api.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '198.51.100.200',
        payload: { email: 'viewer@integration.test', password: 'PermanentViewer9!' },
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.json().error).toBe('Invalid email or password');

      // A master reset is the administrative way out of a deliberate lockout.
      const reset = await api.inject({
        method: 'POST',
        url: `/api/users/${viewer.json().user.id}/reset-password`,
        headers: auth,
      });
      expect(reset.statusCode).toBe(200);
      const unlocked = await api.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '198.51.100.201',
        payload: {
          email: 'viewer@integration.test',
          password: reset.json().temporaryPassword,
        },
      });
      expect(unlocked.statusCode).toBe(200);
    } finally {
      await api.close();
    }
  });
  it('records the real client behind the web proxy and ignores a forged address', async () => {
    // Regression for the 2026-09-10 outage: the API only ever sees the web container
    // (a 10.x Docker peer), so without the forwarded address every user collapsed into
    // one rate-limit bucket and every session and audit row recorded the container.
    const password = 'ProxyClient9!aa';
    await db.query(
      `INSERT INTO app_users(tenant_id,email,full_name,role,password_hash,must_change_password)
       VALUES($1,'proxy@integration.test','Proxy Client','user',$2,false)`,
      [TENANT, await hashPassword(password)],
    );
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: true });
    const sessionAddress = async (forwardedFor: string) => {
      const login = await api.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '10.0.1.16',
        headers: { 'x-forwarded-for': forwardedFor },
        payload: { email: 'proxy@integration.test', password },
      });
      expect(login.statusCode).toBe(200);
      const row = await db.query<{ ip_address: string }>(
        'SELECT ip_address FROM app_sessions WHERE token_hash=$1',
        [sessionTokenHash(login.json().token)],
      );
      return row.rows[0].ip_address;
    };
    try {
      expect(await sessionAddress('198.51.100.77')).toBe('198.51.100.77');
      // A client can prepend anything; only the right-most entry, appended by Traefik,
      // is ever used, because the API trusts exactly one hop.
      expect(await sessionAddress('6.6.6.6, 198.51.100.78')).toBe('198.51.100.78');
    } finally {
      await api.close();
    }
  });
  it('builds the managerial overview by product, integrating t/h into tons', async () => {
    const site = '22222222-2222-4222-8222-222222222222';
    const tag = async (key: string, dataType: 'number' | 'boolean') =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO tags(tenant_id,device_id,key,name,data_type) VALUES($1,$2,$3,$3,$4) RETURNING id`,
          [TENANT, HAIWELL, key, dataType],
        )
      ).rows[0].id;
    const pallets = await tag('QuantidadePaletes', 'number');
    const rate = await tag('TonHora', 'number');
    const running = await tag('StatusLinha', 'boolean');
    // 01:00 local today, so every sample lands on the same local day as "today".
    const base = `(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') + interval '1 hour')
      AT TIME ZONE 'America/Sao_Paulo'`;
    const sample = (
      tagId: string,
      minutes: number,
      column: string,
      value: unknown,
      product: string,
    ) =>
      db.query(
        `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,${column},quality,product_code)
         VALUES($1,$2,$3,$4,${base} + ($5::int * interval '1 minute'),now(),$6,'good',$7)`,
        [TENANT, site, HAIWELL, tagId, minutes, value, product],
      );
    // Counter 0 -> 3 on A, then 5 and a reset to 1 and 2 on B: A=3, B=2+1+1=4.
    await sample(pallets, 0, 'value_number', 0, 'BLOCO A');
    await sample(pallets, 1, 'value_number', 3, 'BLOCO A');
    await sample(pallets, 2, 'value_number', 5, 'BLOCO B');
    await sample(pallets, 3, 'value_number', 1, 'BLOCO B');
    await sample(pallets, 4, 'value_number', 2, 'BLOCO B');
    // 10 t/h held for 30 minutes = 5 t.
    await sample(rate, 0, 'value_number', 10, 'BLOCO A');
    await sample(rate, 30, 'value_number', 10, 'BLOCO A');
    // Running for 8 minutes, then stopped.
    await sample(running, 0, 'value_boolean', true, 'BLOCO A');
    await sample(running, 4, 'value_boolean', true, 'BLOCO A');
    await sample(running, 8, 'value_boolean', false, 'BLOCO A');

    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      const overview = (await api.inject(`/api/devices/${HAIWELL}/production-overview`)).json();
      expect(overview.roles).toMatchObject({
        inferred: true,
        pallets: 'QuantidadePaletes',
        rate: 'TonHora',
        run_status: 'StatusLinha',
        tons_source: 'rate_integral',
      });
      expect(overview.pallets.today.total).toBe(7);
      expect(
        overview.pallets.today.products.map((p: { product_code: string }) => p.product_code),
      ).toEqual(['BLOCO B', 'BLOCO A']);
      expect(overview.tons.today.total).toBeCloseTo(5, 5);
      expect(overview.blocks.configured).toBe(false);
      expect(overview.oee.running_hours_today).toBeCloseTo(480 / 3600, 5);

      // Roles must belong to the device; a tag from another device is refused.
      const foreign = (
        await db.query<{ id: string }>('SELECT id FROM tags WHERE device_id=$1 LIMIT 1', [GENERIC])
      ).rows[0].id;
      const settings = {
        palletsTagId: pallets,
        blocksTagId: null,
        tonsTotalTagId: null,
        rateTagId: rate,
        runStatusTagId: running,
        plannedMinutesPerDay: 1440,
        nominalTonsPerHour: 20,
      };
      expect(
        (
          await api.inject({
            method: 'PATCH',
            url: `/api/devices/${HAIWELL}/production-settings`,
            payload: { ...settings, blocksTagId: foreign },
          })
        ).statusCode,
      ).toBe(400);
      const saved = await api.inject({
        method: 'PATCH',
        url: `/api/devices/${HAIWELL}/production-settings`,
        payload: settings,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().inferred).toBe(false);
      const after = (await api.inject(`/api/devices/${HAIWELL}/production-overview`)).json();
      expect(after.roles.inferred).toBe(false);
      expect(after.oee.performance).toBeCloseTo(10 / 20, 5);
    } finally {
      await api.close();
      await db.query('DELETE FROM production_settings WHERE device_id=$1', [HAIWELL]);
      await db.query('DELETE FROM telemetry_samples WHERE tag_id=ANY($1::uuid[])', [
        [pallets, rate, running],
      ]);
      await db.query('DELETE FROM tags WHERE id=ANY($1::uuid[])', [[pallets, rate, running]]);
    }
  });
  it('zeroes a counter by moment and keeps counting through an HMI reset', async () => {
    const dashboardId = '55555555-5555-4555-8555-555555555555';
    const counterTag = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type)
         VALUES($1,$2,'contador_zerar','Contador zerar','number') RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    const sample = (offsetSeconds: number, value: number) =>
      db.query(
        `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,quality)
         VALUES($1,'22222222-2222-4222-8222-222222222222',$2,$3,now()+($4::int*interval '1 second'),now(),$5,'good')`,
        [TENANT, HAIWELL, counterTag, offsetSeconds, value],
      );
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      const added = await api.inject({
        method: 'POST',
        url: `/api/dashboards/${dashboardId}/widgets`,
        payload: {
          deviceId: HAIWELL,
          tagId: counterTag,
          widgetType: 'value',
          title: 'Contador para zerar',
          width: 'small',
          config: { counterMode: true, counterBaseline: 12 },
        },
      });
      expect(added.statusCode).toBe(201);
      const view = (await api.inject(`/api/dashboards/${dashboardId}`)).json();
      const widget = view.widgets.find(
        (item: { title: string }) => item.title === 'Contador para zerar',
      );
      // Raw history before the reset: must not count.
      await sample(-600, 10);
      await sample(-300, 12);
      const reset = await api.inject({
        method: 'POST',
        url: `/api/dashboards/${dashboardId}/widgets/${widget.id}/reset-counter`,
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().config.counterResetAt).toEqual(expect.any(String));
      expect(reset.json().config).not.toHaveProperty('counterBaseline');
      // After the reset: 12 -> 15 (+3), HMI rolls back to 2 (+2), then 5 (+3) = 8.
      await sample(60, 15);
      await sample(120, 2);
      await sample(180, 5);
      const counters = (await api.inject(`/api/dashboards/${dashboardId}/counters`)).json();
      expect(counters).toEqual([expect.objectContaining({ widget_id: widget.id, since_reset: 8 })]);
      // A text or status widget cannot be zeroed.
      const statusWidget = view.widgets.find(
        (item: { data_type: string }) => item.data_type === 'boolean',
      );
      if (statusWidget)
        expect(
          (
            await api.inject({
              method: 'POST',
              url: `/api/dashboards/${dashboardId}/widgets/${statusWidget.id}/reset-counter`,
            })
          ).statusCode,
        ).toBe(400);
    } finally {
      await api.close();
      await db.query('DELETE FROM telemetry_samples WHERE tag_id=$1', [counterTag]);
      await db.query('DELETE FROM tags WHERE id=$1', [counterTag]);
    }
  });
  it('zeroes the PLC count through the HMI only after the broker accepted the command', async () => {
    const dashboardId = '55555555-5555-4555-8555-555555555555';
    const counterTag = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type)
         VALUES($1,$2,'contador_clp','Contador CLP','number') RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO device_topic_mappings(tenant_id,device_id,kind,topic)
       VALUES($1,$2,'exact','iiot/tenant-x/site-y/evl-hai-test/telemetry')`,
      [TENANT, HAIWELL],
    );
    const sent: Array<[string, Record<string, unknown>]> = [];
    const api = await createApp(db, {
      tenantId: TENANT,
      operatorRaw: false,
      publishCommand: async (topic, payload) => {
        sent.push([topic, payload]);
      },
    });
    const failing = await createApp(db, {
      tenantId: TENANT,
      operatorRaw: false,
      publishCommand: async () => {
        throw new Error('broker offline');
      },
    });
    try {
      const added = await api.inject({
        method: 'POST',
        url: `/api/dashboards/${dashboardId}/widgets`,
        payload: {
          deviceId: HAIWELL,
          tagId: counterTag,
          widgetType: 'value',
          title: 'Contador com reset no CLP',
          width: 'small',
          config: { counterMode: true, resetVariable: 'ResetPaletes' },
        },
      });
      expect(added.statusCode).toBe(201);
      const widgetId = added.json().id;
      const url = `/api/dashboards/${dashboardId}/widgets/${widgetId}/reset-counter`;

      // Broker down: nothing is zeroed, neither the machine nor the panel.
      const refused = await failing.inject({ method: 'POST', url });
      expect(refused.statusCode).toBe(502);
      const untouched = (await api.inject(`/api/dashboards/${dashboardId}`))
        .json()
        .widgets.find((item: { id: string }) => item.id === widgetId);
      expect(untouched.config).not.toHaveProperty('counterResetAt');

      // Broker up: the bit goes to 1 on the device's own command topic, then the panel zeroes.
      const reset = await api.inject({ method: 'POST', url });
      expect(reset.statusCode).toBe(200);
      expect(sent[0]).toEqual(['iiot/tenant-x/site-y/evl-hai-test/command', { ResetPaletes: 1 }]);
      expect(reset.json().config.counterResetAt).toEqual(expect.any(String));
    } finally {
      await api.close();
      await failing.close();
      await db.query(`DELETE FROM device_topic_mappings WHERE topic LIKE 'iiot/tenant-x/%'`);
      await db.query('DELETE FROM dashboard_widgets WHERE tag_id=$1', [counterTag]);
      await db.query('DELETE FROM tags WHERE id=$1', [counterTag]);
    }
  });
  it('answers one production chart at a time with calendar periods', async () => {
    const dashboardId = '55555555-5555-4555-8555-555555555555';
    const tagId = (
      await db.query<{ id: string }>(
        `SELECT id FROM tags WHERE device_id=$1 AND key='temperatura'`,
        [HAIWELL],
      )
    ).rows[0].id;
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    let widgetId: string | undefined;
    try {
      const add = (title: string) =>
        api.inject({
          method: 'POST',
          url: `/api/dashboards/${dashboardId}/widgets`,
          payload: {
            deviceId: HAIWELL,
            tagId,
            widgetType: 'production',
            title,
            width: 'large',
            config: { productionMetricKind: 'rate_average' },
          },
        });
      expect((await add('Produção A')).statusCode).toBe(201);
      expect((await add('Produção B')).statusCode).toBe(201);
      const view = (await api.inject(`/api/dashboards/${dashboardId}`)).json();
      widgetId = view.widgets.find((item: { title: string }) => item.title === 'Produção A').id;
      const only = (period: string) =>
        api
          .inject(`/api/dashboards/${dashboardId}/statistics?widgetId=${widgetId}&period=${period}`)
          .then((response) => response.json());
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const month = await only('month');
      expect(month).toHaveLength(1);
      expect(month[0]).toMatchObject({ widget_id: widgetId, period: 'month' });
      expect(month[0].trend_days).toBe(Number(today.slice(8, 10)));
      const week = await only('week');
      expect(week[0].trend_days).toBeGreaterThanOrEqual(1);
      expect(week[0].trend_days).toBeLessThanOrEqual(7);
      const year = await only('year');
      expect(year[0].bucket_granularity).toBe(year[0].trend_days > 60 ? 'month' : 'day');
      // Without a widget filter every production chart is still answered together.
      const all = (await api.inject(`/api/dashboards/${dashboardId}/statistics?period=7d`)).json();
      expect(all.length).toBeGreaterThanOrEqual(2);
    } finally {
      const view = (await api.inject(`/api/dashboards/${dashboardId}`)).json();
      for (const widget of view.widgets.filter((item: { title: string }) =>
        item.title.startsWith('Produção '),
      ))
        await api.inject({
          method: 'DELETE',
          url: `/api/dashboards/${dashboardId}/widgets/${widget.id}`,
        });
      await api.close();
    }
  });
  it('hides a test product from totals and rankings, and restores it intact', async () => {
    const dashboardId = '55555555-5555-4555-8555-555555555555';
    const tagId = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type)
         VALUES($1,$2,'paletes_ocultar','Paletes ocultar','number') RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    const sample = (seconds: number, value: number, product: string) =>
      db.query(
        `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,quality,product_code)
         VALUES($1,'22222222-2222-4222-8222-222222222222',$2,$3,now()-($4::int*interval '1 second'),now(),$5,'good',$6)`,
        [TENANT, HAIWELL, tagId, seconds, value, product],
      );
    // 0 -> 5 on the real product (+5), then 5 -> 8 on a test recipe (+3).
    await sample(50, 0, 'BLOCO REAL');
    await sample(40, 5, 'BLOCO REAL');
    await sample(30, 8, 'RECEITA TESTE');
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      const added = await api.inject({
        method: 'POST',
        url: `/api/dashboards/${dashboardId}/widgets`,
        payload: {
          deviceId: HAIWELL,
          tagId,
          widgetType: 'production',
          title: 'Ocultar produto',
          width: 'large',
          config: { productionMetricKind: 'counter_delta' },
        },
      });
      expect(added.statusCode).toBe(201);
      const view = (await api.inject(`/api/dashboards/${dashboardId}`)).json();
      const widgetId = view.widgets.find(
        (item: { title: string }) => item.title === 'Ocultar produto',
      ).id;
      const stats = async () =>
        (
          await api.inject(
            `/api/dashboards/${dashboardId}/statistics?widgetId=${widgetId}&period=today`,
          )
        ).json()[0];
      const codes = (breakdown: Array<{ product_code: string }>) =>
        breakdown.map((product) => product.product_code);
      const hide = (hidden: boolean) =>
        api.inject({
          method: 'POST',
          url: `/api/devices/${HAIWELL}/hidden-products`,
          payload: { productCode: 'RECEITA TESTE', hidden },
        });

      let current = await stats();
      expect(current.current_period_value).toBe(8);
      expect(codes(current.product_breakdown)).toEqual(['BLOCO REAL', 'RECEITA TESTE']);

      expect((await hide(true)).statusCode).toBe(200);
      current = await stats();
      expect(current.current_period_value).toBe(5);
      expect(codes(current.product_breakdown)).toEqual(['BLOCO REAL']);
      expect(current.hidden_products).toEqual(['RECEITA TESTE']);
      const audit = await db.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE action LIKE 'device.product.%' ORDER BY id`,
      );
      expect(audit.rows.map((row) => row.action)).toContain('device.product.hide');

      // Restoring brings the full history back: nothing was deleted.
      expect((await hide(false)).statusCode).toBe(200);
      current = await stats();
      expect(current.current_period_value).toBe(8);
      expect(current.hidden_products).toEqual([]);
    } finally {
      await api.close();
      await db.query('DELETE FROM hidden_products WHERE device_id=$1', [HAIWELL]);
      await db.query('DELETE FROM telemetry_samples WHERE tag_id=$1', [tagId]);
      await db.query('DELETE FROM tags WHERE id=$1', [tagId]);
    }
  });
  it('offers quick donut and bar charts over a production metric', async () => {
    const dashboardId = '55555555-5555-4555-8555-555555555555';
    const tagId = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type)
         VALUES($1,$2,'paletes_rapidos','Paletes rápidos','number') RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    const sample = (seconds: number, value: number, product: string) =>
      db.query(
        `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,quality,product_code)
         VALUES($1,'22222222-2222-4222-8222-222222222222',$2,$3,now()-($4::int*interval '1 second'),now(),$5,'good',$6)`,
        [TENANT, HAIWELL, tagId, seconds, value, product],
      );
    // 0 -> 4 on A (+4), then 4 -> 7 on B (+3).
    await sample(50, 0, 'BLOCO A');
    await sample(40, 4, 'BLOCO A');
    await sample(30, 7, 'BLOCO B');
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      for (const widgetType of ['donut', 'bar_vertical', 'bar_horizontal']) {
        const added = await api.inject({
          method: 'POST',
          url: `/api/dashboards/${dashboardId}/widgets`,
          payload: {
            deviceId: HAIWELL,
            tagId,
            widgetType,
            title: `Rápido ${widgetType}`,
            width: 'medium',
            config: { productionMetricKind: 'counter_delta', chartDimension: 'product' },
          },
        });
        expect(added.statusCode).toBe(201);
        const stats = (
          await api.inject(
            `/api/dashboards/${dashboardId}/statistics?widgetId=${added.json().id}&period=today`,
          )
        ).json();
        expect(stats).toHaveLength(1);
        expect(stats[0].current_period_value).toBe(7);
        expect(
          stats[0].product_breakdown.map(
            (product: { product_code: string }) => product.product_code,
          ),
        ).toEqual(['BLOCO A', 'BLOCO B']);
      }
    } finally {
      await api.close();
      await db.query('DELETE FROM telemetry_samples WHERE tag_id=$1', [tagId]);
      await db.query('DELETE FROM tags WHERE id=$1', [tagId]);
    }
  });
  it('keeps simultaneous card edits instead of letting the last write erase the others', async () => {
    // Regression: every card edit used to rewrite the whole dashboard from a copy read a
    // moment earlier, so resizing one card while another change was saving undid it.
    const dashboardId = '55555555-5555-4555-8555-555555555555';
    const api = await createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      const view = (await api.inject(`/api/dashboards/${dashboardId}`)).json();
      expect(view.widgets.length).toBeGreaterThanOrEqual(2);
      const [first, second] = view.widgets as Array<{ id: string }>;
      const reversed = [...view.widgets].reverse().map((widget: { id: string }) => widget.id);
      const results = await Promise.all([
        api.inject({
          method: 'PATCH',
          url: `/api/dashboards/${dashboardId}/widgets/${first.id}`,
          payload: { config: { colSpan: 7, rowSpan: 5 } },
        }),
        api.inject({
          method: 'PATCH',
          url: `/api/dashboards/${dashboardId}/widgets/${second.id}`,
          payload: { config: { colSpan: 5 } },
        }),
        api.inject({
          method: 'PATCH',
          url: `/api/dashboards/${dashboardId}`,
          payload: { refreshMs: 5000 },
        }),
        api.inject({
          method: 'PATCH',
          url: `/api/dashboards/${dashboardId}/layout`,
          payload: { widgetIds: reversed },
        }),
      ]);
      expect(results.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
      const after = (await api.inject(`/api/dashboards/${dashboardId}`)).json();
      const byId = new Map(
        after.widgets.map((widget: { id: string }) => [widget.id, widget]),
      ) as Map<string, { config: Record<string, unknown> }>;
      expect(byId.get(first.id)?.config).toMatchObject({ colSpan: 7, rowSpan: 5 });
      expect(byId.get(second.id)?.config).toMatchObject({ colSpan: 5 });
      expect(after.refresh_ms).toBe(5000);
      expect(after.widgets.map((widget: { id: string }) => widget.id)).toEqual(reversed);
    } finally {
      await api.close();
    }
  });
});
