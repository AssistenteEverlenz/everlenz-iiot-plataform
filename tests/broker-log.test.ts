import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../packages/database/src/index.js';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, HAIWELL } from '../packages/database/src/seed.js';
import { ConnectionRecorder, parseBrokerLine } from '../apps/ingestor/src/broker-log.js';

describe('parseBrokerLine', () => {
  it('reads a connection with its address, client id and user', () => {
    expect(
      parseBrokerLine(
        "1761742353: New client connected from 167.249.71.5:51234 as HW-7f3a (p2, c1, k60, u'evl-a7-0001').",
      ),
    ).toEqual({
      kind: 'connect',
      at: new Date(1761742353 * 1000),
      ip: '167.249.71.5',
      clientId: 'HW-7f3a',
      username: 'evl-a7-0001',
    });
  });

  it('reads an IPv6 address', () => {
    const event = parseBrokerLine(
      "1761742353: New client connected from ::ffff:10.0.1.7:40000 as everlenz-ingestor (p2, c0, k60, u'ingestor').",
    );
    expect(event).toMatchObject({
      kind: 'connect',
      ip: '::ffff:10.0.1.7',
      clientId: 'everlenz-ingestor',
    });
  });

  it('reads every way a client goes away', () => {
    const at = '1761742400';
    expect(parseBrokerLine(`${at}: Client HW-7f3a closed its connection.`)).toMatchObject({
      kind: 'disconnect',
      clientId: 'HW-7f3a',
      reason: 'closed',
    });
    expect(
      parseBrokerLine(`${at}: Client HW-7f3a [167.249.71.5:51234] disconnected.`),
    ).toMatchObject({
      reason: 'disconnected',
    });
    expect(
      parseBrokerLine(`${at}: Client HW-7f3a has exceeded timeout, disconnecting.`),
    ).toMatchObject({
      reason: 'timeout',
    });
    expect(
      parseBrokerLine(`${at}: Client HW-7f3a already connected, closing old connection.`),
    ).toMatchObject({ reason: 'replaced' });
  });

  it('ignores everything else', () => {
    expect(parseBrokerLine('1761742353: New connection from 1.2.3.4:5 on port 8883.')).toBeNull();
    expect(
      parseBrokerLine('1761742353: Client <unknown> disconnected, not authorised.'),
    ).toBeNull();
    expect(parseBrokerLine('1761742353: mosquitto version 2.0.18 running')).toBeNull();
    expect(parseBrokerLine('not a log line')).toBeNull();
  });
});

describe('ConnectionRecorder', () => {
  const T = Date.parse('2026-10-30T10:00:00Z');
  const connect = (seconds: number, clientId: string, ip = '167.249.71.5') => ({
    kind: 'connect' as const,
    at: new Date(T + seconds * 1000),
    ip,
    clientId,
    username: 'oliveira',
  });
  const gone = (seconds: number, clientId: string, reason: 'closed' | 'replaced' = 'closed') => ({
    kind: 'disconnect' as const,
    at: new Date(T + seconds * 1000),
    clientId,
    reason,
  });

  // One migrated database for the block (migrating takes seconds); each test starts empty.
  let db: Database;
  beforeAll(async () => {
    db = (await memoryDatabase()).db;
    await migrate(db);
    await seed(db);
    await db.query("UPDATE devices SET mqtt_username='oliveira' WHERE id=$1", [HAIWELL]);
  }, 60_000);
  beforeEach(async () => {
    await db.query('DELETE FROM device_connections');
  });

  function setup() {
    const rows = async () =>
      (
        await db.query<{
          client_id: string;
          new_client: boolean;
          overlapped: boolean;
          end_reason: string | null;
        }>(
          'SELECT client_id,new_client,overlapped,end_reason FROM device_connections ORDER BY connected_at,id',
        )
      ).rows;
    return { db, recorder: new ConnectionRecorder(db), rows };
  }

  it('takes the first connection as the baseline and reconnections as nothing to report', async () => {
    const { recorder, rows } = setup();
    await recorder.apply(connect(0, 'HW-real'));
    await recorder.apply(gone(3600, 'HW-real'));
    await recorder.apply(connect(3700, 'HW-real', '167.249.71.43'));
    expect(await rows()).toEqual([
      { client_id: 'HW-real', new_client: false, overlapped: false, end_reason: 'closed' },
      { client_id: 'HW-real', new_client: false, overlapped: false, end_reason: null },
    ]);
  });

  it('flags a client id the device never used, and two clients at once', async () => {
    const { recorder, rows } = setup();
    await recorder.apply(connect(0, 'HW-real'));
    await recorder.apply(connect(60, 'HW-clone', '200.1.2.3'));
    expect((await rows())[1]).toMatchObject({
      client_id: 'HW-clone',
      new_client: true,
      overlapped: true,
    });
  });

  it('flags a connection that pushed the device off its own client id', async () => {
    const { recorder, rows } = setup();
    await recorder.apply(connect(0, 'HW-real'));
    await recorder.apply(gone(60, 'HW-real', 'replaced'));
    await recorder.apply(connect(60, 'HW-real', '200.1.2.3'));
    const [first, second] = await rows();
    expect(first.end_reason).toBe('replaced');
    expect(second).toMatchObject({ new_client: false, overlapped: true });
  });

  it('ignores users that are not devices and reads the same lines twice without doubling', async () => {
    const { recorder, rows } = setup();
    await recorder.apply({ ...connect(0, 'everlenz-ingestor'), username: 'ingestor' });
    await recorder.apply(connect(10, 'HW-real'));
    await recorder.apply(connect(10, 'HW-real'));
    expect(await rows()).toHaveLength(1);
  });
});
