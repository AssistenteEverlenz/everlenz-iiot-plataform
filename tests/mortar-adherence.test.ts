import { describe, expect, it } from 'vitest';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT } from '../packages/database/src/seed.js';
import { createApp } from '../apps/api/src/app.js';
import { seedMortarDemo } from '../scripts/mortar-demo.js';
import { addDays, plantDate } from '../packages/shared/src/index.js';

/**
 * The shift as registered against the real one, read from the bagger: the demonstration plant
 * fills bags from 07:00 to 17:00 with lunch at 11:00, so that is what the line really did.
 */
describe('mortar shift adherence', () => {
  it('finds the real start, lunch and end where every spout stopped', async () => {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const demo = await seedMortarDemo(db, TENANT, 6);
    const app = await createApp(db, { tenantId: TENANT, operatorRaw: false, authRequired: false });
    // A weekday two to three days back, so the whole shift is behind us.
    let date = addDays(plantDate(new Date()), -2);
    while ([0, 6].includes(new Date(`${date}T12:00:00-03:00`).getUTCDay())) date = addDays(date, -1);
    const response = await app.inject({
      method: 'GET',
      url: `/api/devices/${demo.deviceId}/mortar/adherence?date=${date}`,
    });
    const { adherence } = response.json();
    const hour = (iso: string) =>
      new Date(iso).toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
      });
    expect(hour(adherence.blocks[0].start)).toBe('07:00');
    expect(hour(adherence.blocks[0].end)).toBe('17:00');
    expect(hour(adherence.pauses[0].start)).toBe('11:00');
    expect(hour(adherence.pauses[0].end)).toBe('12:00');
    await app.close();
  }, 120_000);
});
