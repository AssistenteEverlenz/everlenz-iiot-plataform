import net from 'node:net';

// Plain-MQTT compatibility port for HMIs whose TLS client cannot reach the broker (the Delta
// DOP-100 firmware aborts every TLS handshake). TLS on 8883 stays the default for every device.
//
// Each connection is held until its CONNECT packet arrives: the MQTT user named there
// identifies the device. Only a device switched to legacy mode, connecting from one of the
// public addresses released for it, is passed through to the broker's internal listener, which
// still checks the password and the topic ACL. Any other attempt by a known device is recorded,
// so the device page can offer "Liberar", and refused with CONNACK "not authorised". Unknown
// users and anything that is not an MQTT CONNECT are dropped without a trace.

export interface ConnectInfo {
  protocolLevel: number;
  clientId: string;
  username: string | null;
}
export type ConnectParse =
  | { status: 'incomplete' }
  | { status: 'invalid' }
  | ({ status: 'ok'; length: number } & ConnectInfo);

export interface LegacyDevice {
  deviceId: string;
  tenantId: string;
  legacy: boolean;
  allowedIps: string[];
}

export interface LegacyProxyOptions {
  port: number;
  host?: string;
  upstreamHost: string;
  upstreamPort: number;
  lookup(username: string): Promise<LegacyDevice | null>;
  recordAttempt(device: LegacyDevice, ip: string): Promise<void>;
  log: { info(entry: object): void; warn(entry: object): void };
}

const CONNECT_TIMEOUT_MS = 10000;
const MAX_CONNECT_BYTES = 16384;
const MAX_CONNECTIONS = 500;
/** An HMI retries every second or so: one record and one log line per address per interval. */
const ATTEMPT_RECORD_INTERVAL_MS = 30000;

function varint(buffer: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0;
  let multiplier = 1;
  for (let size = 1; size <= 4; size += 1) {
    if (offset + size > buffer.length) return null;
    const byte = buffer[offset + size - 1];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, size };
    multiplier *= 128;
  }
  return { value: -1, size: 4 };
}

/** Reads the CONNECT packet at the start of a stream (MQTT 3.1, 3.1.1 and 5). */
export function parseConnect(buffer: Buffer): ConnectParse {
  if (buffer.length < 2) return { status: 'incomplete' };
  if (buffer[0] !== 0x10) return { status: 'invalid' };
  const remaining = varint(buffer, 1);
  if (!remaining) return { status: 'incomplete' };
  if (remaining.value < 0) return { status: 'invalid' };
  const length = 1 + remaining.size + remaining.value;
  if (length > MAX_CONNECT_BYTES) return { status: 'invalid' };
  if (buffer.length < length) return { status: 'incomplete' };

  let offset = 1 + remaining.size;
  const fail = Symbol('fail');
  const bytes = (count: number) => {
    if (offset + count > length) throw fail;
    const slice = buffer.subarray(offset, offset + count);
    offset += count;
    return slice;
  };
  const field = () => bytes(bytes(2).readUInt16BE(0));
  const skipProperties = () => {
    const properties = varint(buffer, offset);
    if (!properties || properties.value < 0) throw fail;
    bytes(properties.size + properties.value);
  };
  try {
    const protocol = field().toString('utf8');
    if (protocol !== 'MQTT' && protocol !== 'MQIsdp') return { status: 'invalid' };
    const protocolLevel = bytes(1)[0];
    const flags = bytes(1)[0];
    bytes(2); // keep alive
    if (protocolLevel === 5) skipProperties();
    const clientId = field().toString('utf8');
    if (flags & 0x04) {
      if (protocolLevel === 5) skipProperties();
      field(); // will topic
      field(); // will payload
    }
    const username = flags & 0x80 ? field().toString('utf8') : null;
    return { status: 'ok', length, protocolLevel, clientId, username };
  } catch (error) {
    if (error === fail) return { status: 'invalid' };
    throw error;
  }
}

export function normalizeIp(address: string | undefined) {
  return (address ?? '').replace(/^::ffff:/, '');
}

function refuse(socket: net.Socket, protocolLevel: number) {
  // CONNACK "not authorised": reason 0x87 in MQTT 5, return code 5 before it.
  socket.end(
    Buffer.from(protocolLevel === 5 ? [0x20, 0x03, 0x00, 0x87, 0x00] : [0x20, 0x02, 0x00, 0x05]),
  );
}

export function startLegacyMqttProxy(options: LegacyProxyOptions): net.Server {
  const lastRecorded = new Map<string, number>();
  const server = net.createServer((client) => {
    const ip = normalizeIp(client.remoteAddress);
    let buffered = Buffer.alloc(0);
    let decided = false;
    client.setNoDelay(true);
    client.on('error', () => client.destroy());
    const timer = setTimeout(() => client.destroy(), CONNECT_TIMEOUT_MS);

    const decide = async (connect: ConnectInfo) => {
      const device = connect.username ? await options.lookup(connect.username) : null;
      if (device?.legacy && device.allowedIps.includes(ip)) {
        const upstream = net.connect(options.upstreamPort, options.upstreamHost);
        upstream.setNoDelay(true);
        upstream.on('error', () => {
          upstream.destroy();
          client.destroy();
        });
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        upstream.once('connect', () => {
          upstream.write(buffered);
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        });
        options.log.info({ event: 'legacy_mqtt_passed', username: connect.username, ip });
        return;
      }
      if (device) {
        const key = `${device.deviceId}|${ip}`;
        const now = Date.now();
        if (now - (lastRecorded.get(key) ?? 0) >= ATTEMPT_RECORD_INTERVAL_MS) {
          lastRecorded.set(key, now);
          await options.recordAttempt(device, ip);
          options.log.warn({
            event: 'legacy_mqtt_refused',
            username: connect.username,
            ip,
            legacy: device.legacy,
          });
        }
      }
      refuse(client, connect.protocolLevel);
    };

    const onData = (chunk: Buffer) => {
      if (decided) return;
      buffered = Buffer.concat([buffered, chunk]);
      const parsed = parseConnect(buffered);
      if (parsed.status === 'incomplete' && buffered.length <= MAX_CONNECT_BYTES) return;
      decided = true;
      clearTimeout(timer);
      client.off('data', onData);
      client.pause();
      if (parsed.status !== 'ok') {
        client.destroy();
        return;
      }
      decide(parsed).catch((error: unknown) => {
        options.log.warn({
          event: 'legacy_mqtt_error',
          message: error instanceof Error ? error.message : String(error),
        });
        client.destroy();
      });
    };
    client.on('data', onData);
  });
  server.maxConnections = MAX_CONNECTIONS;
  // A port that cannot be opened must not take the API down with it.
  server.on('error', (error) =>
    options.log.warn({ event: 'legacy_mqtt_listen_error', message: error.message }),
  );
  server.listen(options.port, options.host ?? '0.0.0.0', () =>
    options.log.info({ event: 'legacy_mqtt_listening', port: options.port }),
  );
  return server;
}
