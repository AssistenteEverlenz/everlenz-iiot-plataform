import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseConnect,
  startLegacyMqttProxy,
  type LegacyDevice,
} from '../apps/api/src/legacy-mqtt.js';

function str(value: string) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function connectPacket({
  level = 4,
  clientId = 'evl-del-1',
  username = 'evl-del-1',
  password = 'secret',
  will = false,
}: {
  level?: number;
  clientId?: string;
  username?: string | null;
  password?: string | null;
  will?: boolean;
} = {}) {
  let flags = 0x02;
  if (will) flags |= 0x04;
  if (username !== null) flags |= 0x80;
  if (password !== null) flags |= 0x40;
  const parts = [str('MQTT'), Buffer.from([level, flags, 0x00, 0x3c])];
  if (level === 5) parts.push(Buffer.from([0x00]));
  parts.push(str(clientId));
  if (will) {
    if (level === 5) parts.push(Buffer.from([0x00]));
    parts.push(str('will/topic'), str('bye'));
  }
  if (username !== null) parts.push(str(username));
  if (password !== null) parts.push(str(password));
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x10, body.length]), body]);
}

describe('parseConnect', () => {
  it('reads the user of an MQTT 3.1.1 CONNECT', () => {
    const parsed = parseConnect(connectPacket());
    expect(parsed).toMatchObject({ status: 'ok', protocolLevel: 4, username: 'evl-del-1' });
  });
  it('skips MQTT 5 properties and the will message', () => {
    const parsed = parseConnect(connectPacket({ level: 5, will: true, username: 'dop' }));
    expect(parsed).toMatchObject({ status: 'ok', protocolLevel: 5, username: 'dop' });
  });
  it('waits for the rest of a split packet', () => {
    const packet = connectPacket();
    expect(parseConnect(packet.subarray(0, 8))).toEqual({ status: 'incomplete' });
  });
  it('rejects anything that is not a CONNECT (a TLS hello, for instance)', () => {
    expect(parseConnect(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05]))).toEqual({
      status: 'invalid',
    });
  });
  it('reports a CONNECT without user', () => {
    expect(parseConnect(connectPacket({ username: null, password: null }))).toMatchObject({
      status: 'ok',
      username: null,
    });
  });
});

describe('legacy MQTT proxy', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });
  function listening(server: net.Server) {
    servers.push(server);
    return new Promise<number>((resolve) => {
      if (server.listening) resolve((server.address() as net.AddressInfo).port);
      else server.once('listening', () => resolve((server.address() as net.AddressInfo).port));
    });
  }
  function exchange(port: number, packet: Buffer) {
    return new Promise<Buffer>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(packet));
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        socket.end();
      });
      socket.on('close', () => resolve(Buffer.concat(chunks)));
      socket.on('error', () => resolve(Buffer.concat(chunks)));
    });
  }

  async function setup(device: LegacyDevice | null) {
    // Stand-in broker: answers CONNACK accepted to whatever it receives.
    const received: Buffer[] = [];
    const broker = net.createServer((socket) =>
      socket.on('data', (chunk) => {
        received.push(chunk);
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
      }),
    );
    broker.listen(0, '127.0.0.1');
    const brokerPort = await listening(broker);
    const attempts: string[] = [];
    const proxy = startLegacyMqttProxy({
      port: 0,
      host: '127.0.0.1',
      upstreamHost: '127.0.0.1',
      upstreamPort: brokerPort,
      lookup: async () => device,
      recordAttempt: async (_device: LegacyDevice, ip: string) => {
        attempts.push(ip);
      },
      log: { info: () => undefined, warn: () => undefined },
    });
    return { port: await listening(proxy), received, attempts };
  }

  it('passes a released address through to the broker, CONNECT included', async () => {
    const { port, received } = await setup({
      deviceId: 'd',
      tenantId: 't',
      legacy: true,
      allowedIps: ['127.0.0.1'],
    });
    const reply = await exchange(port, connectPacket());
    expect([...reply]).toEqual([0x20, 0x02, 0x00, 0x00]);
    expect(Buffer.concat(received).equals(connectPacket())).toBe(true);
  });

  it('refuses and records an address that was not released', async () => {
    const { port, received, attempts } = await setup({
      deviceId: 'd',
      tenantId: 't',
      legacy: true,
      allowedIps: ['10.0.0.9'],
    });
    const reply = await exchange(port, connectPacket());
    expect([...reply]).toEqual([0x20, 0x02, 0x00, 0x05]);
    expect(received).toHaveLength(0);
    expect(attempts).toEqual(['127.0.0.1']);
  });

  it('refuses a device that is not in legacy mode even from a released address', async () => {
    const { port, attempts } = await setup({
      deviceId: 'd',
      tenantId: 't',
      legacy: false,
      allowedIps: ['127.0.0.1'],
    });
    const reply = await exchange(port, connectPacket({ level: 5 }));
    expect([...reply]).toEqual([0x20, 0x03, 0x00, 0x87, 0x00]);
    expect(attempts).toEqual(['127.0.0.1']);
  });

  it('drops unknown users without recording anything', async () => {
    const { port, attempts } = await setup(null);
    const reply = await exchange(port, connectPacket());
    expect([...reply]).toEqual([0x20, 0x02, 0x00, 0x05]);
    expect(attempts).toHaveLength(0);
  });
});
