import { createApp } from './app.js';
import { env } from '@iiot/shared';
import { pool } from '@iiot/database';
const app = createApp();
await app.listen({ port: env.API_PORT, host: process.env.API_HOST ?? '127.0.0.1' });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  app.log.info({ event: 'shutdown' });
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  await app.close();
  await pool.end();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
