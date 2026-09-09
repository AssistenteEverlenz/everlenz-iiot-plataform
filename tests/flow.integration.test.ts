import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL, GENERIC } from '../packages/database/src/seed.js';
import { IngestionPipeline } from '../apps/ingestor/src/pipeline.js';
import { simulatedMessage } from '../apps/simulator/src/messages.js';
import { createApp } from '../apps/api/src/app.js';
import type { Database } from '../packages/database/src/index.js';
import { hashPassword } from '../packages/shared/src/index.js';
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
      const raw = await db.query<{ payload_hex: string; processing_status: string }>(
        'SELECT * FROM mqtt_messages_raw WHERE id=$1',
        [result.rawId],
      );
      expect(raw.rows[0].payload_hex).toBe(Buffer.from(m.payload).toString('hex'));
      const api = createApp(db, { tenantId: TENANT, operatorRaw: false });
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
    const api = createApp(db, {
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
    const api = createApp(db, {
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
    const api = createApp(db, { tenantId: TENANT, operatorRaw: false });
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
    const api = createApp(db, { tenantId: TENANT, operatorRaw: false });
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
      expect((await api.inject('/api/overview')).json().devices).toBe(2);
    } finally {
      await api.close();
    }
  });
  it('discovers signals and supports dashboard, CSV and guided device APIs', async () => {
    const message = simulatedMessage('haiwell', 9);
    expect((await ingest(message.topic, message.payload)).status).toBe('processed');
    const api = createApp(db, { tenantId: TENANT, operatorRaw: false });
    try {
      const signals = (await api.inject(`/api/devices/${HAIWELL}/signals`)).json() as {
        key: string;
        configured: boolean;
      }[];
      expect(signals.map((signal) => signal.key)).toEqual(
        expect.arrayContaining(['temperatura', 'corrente_motor', 'velocidade', 'status']),
      );
      expect(signals.every((signal) => signal.configured)).toBe(true);

      const dashboards = (await api.inject('/api/dashboards')).json() as { id: string }[];
      expect(dashboards).toHaveLength(1);
      const dashboard = (await api.inject(`/api/dashboards/${dashboards[0].id}`)).json() as {
        widgets: unknown[];
      };
      expect(dashboard.widgets.length).toBeGreaterThanOrEqual(4);

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
      expect(created.json().device.provisioning_status).toBe('awaiting_connection');
      expect(created.json().connection.username).toBe(created.json().device.device_code.toLowerCase());
      expect(created.json().connection.password).toHaveLength(20);
      expect(created.json().connection.topic).toMatch(/^iiot\//);
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
    const api = createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: true });
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
          title: 'Visão pessoal',
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
      expect(masterViewAfter.json().widgets).toHaveLength(masterDashboard.json().widgets.length);
      expect(masterViewAfter.json().refresh_ms).toBe(masterDashboard.json().refresh_ms);
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
});
