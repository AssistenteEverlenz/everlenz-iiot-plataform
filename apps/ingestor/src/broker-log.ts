import { open, stat } from 'node:fs/promises';
import type { Database } from '@iiot/database';

/*
 * Who connects with each device's credential, read from Mosquitto's own log (migration 054).
 *
 * A restored backup of an HMI carries the real device's credential and publishes on its topic;
 * the payloads can be identical, but the broker sees two clients: it logs each connection with
 * the client id and the address it came from. This reads that log, keeps one row per connection
 * and flags the ones worth a look. It records only: nothing is refused or dropped here, and it
 * never touches the ingestion of messages -- every failure stays inside this module.
 */

export type BrokerEvent =
  | { kind: 'connect'; at: Date; ip: string | null; clientId: string; username: string }
  | {
      kind: 'disconnect';
      at: Date;
      clientId: string;
      reason: 'closed' | 'disconnected' | 'timeout' | 'replaced';
    };

// Mosquitto 2 prefixes each line with the epoch second unless log_timestamp_format says otherwise.
const STAMP = /^(\d{9,11}):\s+(.*)$/;
// "New client connected from 1.2.3.4:51234 as A7-001 (p2, c1, k60, u'a7-001')."
const CONNECT = /^New client connected from (.+?):(\d+) as (\S+) \(.*?u'([^']*)'\)/;
// "Client A7-001 closed its connection." / "Client A7-001 [1.2.3.4:51234] disconnected."
// "Client A7-001 has exceeded timeout, disconnecting." / "... already connected, closing old connection."
const CLIENT =
  /^Client (\S+)(?: \[[^\]]*\])? (closed its connection|disconnected|has exceeded timeout|already connected, closing old connection)/;

/** One log line as an event, or null for everything else the broker writes. */
export function parseBrokerLine(line: string): BrokerEvent | null {
  const stamped = STAMP.exec(line.trim());
  if (!stamped) return null;
  const at = new Date(Number(stamped[1]) * 1000);
  const text = stamped[2];
  const connect = CONNECT.exec(text);
  if (connect)
    return {
      kind: 'connect',
      at,
      ip: connect[1].replace(/^\[|\]$/g, '') || null,
      clientId: connect[3],
      username: connect[4],
    };
  const client = CLIENT.exec(text);
  if (!client || client[1] === '<unknown>') return null;
  const reason = client[2].startsWith('closed')
    ? 'closed'
    : client[2].startsWith('has exceeded')
      ? 'timeout'
      : client[2].startsWith('already')
        ? 'replaced'
        : 'disconnected';
  return { kind: 'disconnect', at, clientId: client[1], reason };
}

type DeviceRef = { id: string; tenantId: string };

/** Keeps device_connections in step with the broker's events. */
export class ConnectionRecorder {
  private devices = new Map<string, DeviceRef>();
  private devicesAt = 0;

  constructor(private readonly db: Database) {}

  private async deviceFor(username: string) {
    if (Date.now() - this.devicesAt > 60_000) {
      const rows = (
        await this.db.query<{ id: string; tenant_id: string; mqtt_username: string }>(
          'SELECT id,tenant_id,mqtt_username FROM devices WHERE mqtt_username IS NOT NULL',
        )
      ).rows;
      this.devices = new Map(
        rows.map((row) => [row.mqtt_username, { id: row.id, tenantId: row.tenant_id }]),
      );
      this.devicesAt = Date.now();
    }
    return this.devices.get(username) ?? null;
  }

  async apply(event: BrokerEvent) {
    if (event.kind === 'disconnect') {
      // "already connected" names the client that is being pushed out: its open row closes and
      // the connection that pushed it arrives as the next line.
      await this.db.query(
        `UPDATE device_connections SET disconnected_at=$2,end_reason=$3
         WHERE client_id=$1 AND disconnected_at IS NULL AND connected_at<=$2`,
        [event.clientId, event.at, event.reason],
      );
      return;
    }
    const device = await this.deviceFor(event.username);
    // The ingestor, the simulator, the command user: not a device.
    if (!device) return;
    const history = (
      await this.db.query<{ known: boolean; any: boolean; open_other: boolean; replaced: boolean }>(
        `SELECT
           EXISTS(SELECT 1 FROM device_connections WHERE device_id=$1 AND client_id=$2 AND connected_at<$3) known,
           EXISTS(SELECT 1 FROM device_connections WHERE device_id=$1 AND connected_at<$3) "any",
           EXISTS(SELECT 1 FROM device_connections WHERE device_id=$1 AND client_id<>$2
             AND connected_at<$3 AND (disconnected_at IS NULL OR disconnected_at>$3)) open_other,
           EXISTS(SELECT 1 FROM device_connections WHERE device_id=$1 AND client_id=$2
             AND end_reason='replaced' AND disconnected_at BETWEEN $3::timestamptz - interval '5 seconds' AND $3) replaced`,
        [device.id, event.clientId, event.at],
      )
    ).rows[0];
    await this.db.query(
      `INSERT INTO device_connections(tenant_id,device_id,client_id,ip,connected_at,new_client,overlapped)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (device_id,client_id,connected_at) DO NOTHING`,
      [
        device.tenantId,
        device.id,
        event.clientId,
        event.ip,
        event.at,
        // The very first connection a device ever makes is its baseline, not a warning.
        Boolean(history?.any && !history.known),
        // Two clients at once, or one that pushed another off the same client id.
        Boolean(history?.open_other || history?.replaced),
      ],
    );
  }
}

const BACKLOG_BYTES = 2 * 1024 * 1024;

/**
 * Follows the broker log file: on start the last 2 MB (rows are idempotent), then whatever is
 * appended. A truncated or rotated file starts over from its beginning.
 */
export function followBrokerLog(
  db: Database,
  path: string,
  log: { info: (o: object) => void; warn: (o: object) => void },
  intervalMs = 2000,
) {
  const recorder = new ConnectionRecorder(db);
  let offset = -1;
  let partial = '';
  let busy = false;
  let lastProblem = '';
  const problem = (event: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // One line per distinct problem, not one every two seconds.
    if (message !== lastProblem) log.warn({ event, error: message });
    lastProblem = message;
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const size = (await stat(path)).size;
      if (offset < 0) offset = Math.max(0, size - BACKLOG_BYTES);
      if (size < offset) {
        offset = 0;
        partial = '';
      }
      if (size === offset) return;
      const file = await open(path, 'r');
      try {
        const length = Math.min(size - offset, BACKLOG_BYTES);
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, offset);
        const lines = (partial + buffer.toString('utf8')).split('\n');
        const rest = lines.pop() ?? '';
        let recorded = 0;
        for (const line of lines) {
          const event = parseBrokerLine(line);
          if (!event) continue;
          await recorder.apply(event);
          recorded += 1;
        }
        // Only now: a database failure above reads the same lines again (rows are idempotent).
        offset += length;
        partial = rest;
        if (recorded) log.info({ event: 'broker_log_read', recorded });
        lastProblem = '';
      } finally {
        await file.close();
      }
    } catch (error) {
      problem('broker_log_unavailable', error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => clearInterval(timer);
}
