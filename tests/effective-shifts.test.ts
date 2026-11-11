import { describe, expect, it } from 'vitest';
import { expandShifts, plantInstant } from '../packages/shared/src/index.js';
import {
  chartSpanOf,
  extendOccurrences,
  type Producing,
} from '../apps/api/src/effective-shifts.js';
import { memoryDatabase } from './pglite.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed, TENANT, HAIWELL } from '../packages/database/src/seed.js';
import {
  closeShiftReports,
  loadConfig,
  productionDetailData,
} from '../apps/api/src/shift-production.js';

/**
 * The shift follows the line: a 07:00-17:00 shift with a lunch, stretched to the production
 * around it (migration 047, 120-minute limit).
 */
const SHIFT = [
  { id: 's1', name: 'Turno', weekdays: [1, 2, 3, 4, 5], start: '07:00', end: '17:00', breaks: [{ start: '11:00', end: '12:00' }] },
];
const DAY = '2026-10-14'; // a Wednesday
const SAT = '2026-10-17';
const at = (date: string, time: string) => plantInstant(date, time).getTime();
/** Producing seconds in every bucket of [from, to). */
function run(producing: Producing, date: string, from: string, to: string, seconds = 300) {
  for (let t = at(date, from); t < at(date, to); t += 300_000) producing.set(t, seconds);
  return producing;
}
const hhmm = (d: Date) =>
  d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const shifts = (date: string) => expandShifts(SHIFT, date, date);
const late = new Date(at('2026-10-19', '12:00'));

describe('effective shifts', () => {
  it('opens the shift at production that holds before it and stretches it after, stops included', () => {
    const producing = run(new Map(), DAY, '05:00', '06:30');
    run(producing, DAY, '07:00', '17:00');
    // A 40-minute stop after the shift, then production until 20:30.
    run(producing, DAY, '17:00', '18:00');
    run(producing, DAY, '18:40', '20:30');
    const [shift] = extendOccurrences(shifts(DAY), producing, late, 120, { from: DAY, to: DAY });
    expect(hhmm(shift.start)).toBe('05:00');
    expect(hhmm(shift.end)).toBe('20:30');
    expect(shift.planned.start.getTime()).toBe(at(DAY, '07:00'));
    expect(shift.extendedBefore).toBe(2 * 3600);
    expect(shift.extendedAfter).toBe(3.5 * 3600);
  });

  it('does not stretch over a stop past the limit, and leaves the later run as an extra shift', () => {
    const producing = run(new Map(), DAY, '07:00', '17:00');
    run(producing, DAY, '19:30', '21:00');
    const all = extendOccurrences(shifts(DAY), producing, late, 120, { from: DAY, to: DAY });
    expect(all.map((item) => `${item.name} ${hhmm(item.start)}-${hhmm(item.end)}`)).toEqual([
      'Turno 07:00-17:00',
      'Turno extra 19:30-21:00',
    ]);
  });

  it('ignores a pallet counted in passing at night', () => {
    const producing = run(new Map(), DAY, '07:00', '17:00');
    producing.set(at(DAY, '18:30'), 40);
    const all = extendOccurrences(shifts(DAY), producing, late, 120, { from: DAY, to: DAY });
    expect(all).toHaveLength(1);
    expect(hhmm(all[0].end)).toBe('17:00');
  });

  it('makes a Saturday with production an extra shift', () => {
    const producing = run(new Map(), SAT, '06:00', '13:45');
    const all = extendOccurrences(shifts(SAT), producing, late, 120, { from: SAT, to: SAT });
    expect(all).toHaveLength(1);
    expect(all[0].extra).toBe(true);
    expect(`${hhmm(all[0].start)}-${hhmm(all[0].end)}`).toBe('06:00-13:45');
  });

  it('keeps whole seconds when the producing seconds are fractional (planned_seconds is an integer)', () => {
    // Campo Forte, 2026-10-17: an extra shift of 12920.022 s stopped the shift close for two days.
    const producing = run(new Map(), SAT, '06:00', '09:30', 299.989);
    producing.set(at(SAT, '05:55'), 200.4);
    producing.set(at(SAT, '09:30'), 120.011);
    const [extra] = extendOccurrences(shifts(SAT), producing, late, 120, { from: SAT, to: SAT });
    expect(Number.isInteger(extra.plannedSeconds)).toBe(true);
    expect(extra.start.getTime() % 1000).toBe(0);
    expect(extra.end.getTime() % 1000).toBe(0);
  });

  it('runs until now while the line is still in the stretch, and keeps the registered shift otherwise', () => {
    const producing = run(new Map(), DAY, '07:00', '18:30');
    // 18:50: twenty minutes stopped after producing until 18:30 -- the stop counts.
    const live = extendOccurrences(shifts(DAY), producing, new Date(at(DAY, '18:50')), 120, { from: DAY, to: DAY });
    expect(hhmm(live[0].end)).toBe('18:50');
    // Once the limit has passed, the shift ends at the last product.
    const after = extendOccurrences(shifts(DAY), producing, new Date(at(DAY, '21:00')), 120, { from: DAY, to: DAY });
    expect(hhmm(after[0].end)).toBe('18:30');
    // A limit of zero keeps the shift as registered.
    const off = extendOccurrences(shifts(DAY), producing, late, 0, { from: DAY, to: DAY });
    expect(`${hhmm(off[0].start)}-${hhmm(off[0].end)}`).toBe('07:00-17:00');
  });
});

describe('the shift as worked, on the board and in the reports', () => {
  it('counts the overtime in the shift and closes the report only once the line is done', async () => {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const pallets = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type)
         VALUES($1,$2,'Paletes','Paletes','number') RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO production_settings(device_id,tenant_id,pallets_tag_id,target_metric,target_per_shift)
       VALUES($1,$2,$3,'pallets',100)
       ON CONFLICT (device_id) DO UPDATE SET pallets_tag_id=$3,target_metric='pallets',target_per_shift=100`,
      [HAIWELL, TENANT, pallets],
    );
    // 2026-10-06, the default shift 07:00-17:00: a pallet every five minutes from 07:00 to 18:00.
    const day = '2026-10-06';
    for (let t = at(day, '07:00'); t < at(day, '18:00'); t += 300_000)
      await db.query(
        `INSERT INTO production_buckets(tenant_id,device_id,bucket,product_code,pieces,pallets,tons,producing_s,idle_s,manual_s)
         VALUES($1,$2,$3,'9x19',1200,1,3,280,20,0)`,
        [TENANT, HAIWELL, new Date(t)],
      );
    const config = (await loadConfig(db, TENANT, HAIWELL))!;
    const detail = await productionDetailData(db, TENANT, HAIWELL, config, {
      date: day,
      kind: 'day',
    });
    expect(detail.board.totals.pallets).toBe(132);
    const [shift] = detail.shifts as Array<{ start: string; end: string; plannedEnd: string }>;
    expect(hhmm(new Date(shift.start))).toBe('07:00');
    expect(hhmm(new Date(shift.end))).toBe('17:59');
    expect(hhmm(new Date(shift.plannedEnd))).toBe('17:00');
    // The target stays the registered shift's: 100, not more for the hour worked past it.
    expect(detail.board.target?.value).toBe(100);
    // 18:30: the line stopped half an hour ago and may still come back -- no report yet.
    const options = { deviceId: HAIWELL, fromDate: day, toDate: day };
    expect(await closeShiftReports(db, new Date(at(day, '18:30')), options)).toBe(0);
    // 21:00: past the limit. One report, keyed by the registered shift, with the hour past it.
    await closeShiftReports(db, new Date(at(day, '21:00')), options);
    const reports = (
      await db.query<{ kind: string; pallets: number; planned_start: Date; planned_end: Date }>(
        'SELECT kind,pallets::float pallets,planned_start,planned_end FROM shift_reports WHERE device_id=$1 ORDER BY kind',
        [HAIWELL],
      )
    ).rows;
    expect(
      reports.map(
        (row) =>
          `${row.kind} ${row.pallets} ${hhmm(new Date(row.planned_start))}-${hhmm(new Date(row.planned_end))}`,
      ),
    ).toEqual(['shift 132 07:00-17:00']);
  }, 60_000);
});

describe('each shift says when it closes (057)', () => {
  /** A device with pallets and the given shifts; a pallet every five minutes in [from, to). */
  async function plant(
    shifts: Array<{ name: string; start: string; end: string; closeAfter: number }>,
    day: string,
    runs: Array<[string, string]>,
  ) {
    const { db } = await memoryDatabase();
    await migrate(db);
    await seed(db);
    const pallets = (
      await db.query<{ id: string }>(
        `INSERT INTO tags(tenant_id,device_id,key,name,data_type)
         VALUES($1,$2,'Paletes','Paletes','number') RETURNING id`,
        [TENANT, HAIWELL],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO production_settings(device_id,tenant_id,pallets_tag_id,target_metric,target_per_shift)
       VALUES($1,$2,$3,'pallets',100)
       ON CONFLICT (device_id) DO UPDATE SET pallets_tag_id=$3,target_metric='pallets',target_per_shift=100`,
      [HAIWELL, TENANT, pallets],
    );
    const site = (
      await db.query<{ site_id: string }>('SELECT site_id FROM devices WHERE id=$1', [HAIWELL])
    ).rows[0].site_id;
    for (const [index, shift] of shifts.entries())
      await db.query(
        `INSERT INTO site_shifts(tenant_id,site_id,name,weekdays,start_time,end_time,breaks,sort_order,close_after_minutes)
         VALUES($1,$2,$3,'{0,1,2,3,4,5,6}'::smallint[],$4,$5,'[]'::jsonb,$6,$7)`,
        [TENANT, site, shift.name, shift.start, shift.end, index, shift.closeAfter],
      );
    for (const [from, to] of runs)
      for (let t = at(day, from); t < at(day, to); t += 300_000)
        await db.query(
          `INSERT INTO production_buckets(tenant_id,device_id,bucket,product_code,pieces,pallets,tons,producing_s,idle_s,manual_s)
           VALUES($1,$2,$3,'9x19',1200,1,3,280,20,0)`,
          [TENANT, HAIWELL, new Date(t)],
        );
    const reports = async () =>
      (
        await db.query<{ shift_name: string; pallets: number }>(
          `SELECT shift_name,pallets::float pallets FROM shift_reports
           WHERE device_id=$1 AND kind='shift' AND deleted_at IS NULL ORDER BY planned_start`,
          [HAIWELL],
        )
      ).rows.map((row) => `${row.shift_name} ${row.pallets}`);
    return { db, reports };
  }

  it('closes a shift followed right away by the next one 15 minutes after its end', async () => {
    // Campo Forte, 2026-11-11: Turno 1 02:00-10:00, Turno 2 10:00-18:00, the line never stops.
    const day = '2026-10-06';
    const { db, reports } = await plant(
      [
        { name: 'Turno 1', start: '02:00', end: '10:00', closeAfter: 15 },
        { name: 'Turno 2', start: '10:00', end: '18:00', closeAfter: 15 },
      ],
      day,
      [['02:00', '13:00']],
    );
    const options = { deviceId: HAIWELL, fromDate: day, toDate: day };
    expect(await closeShiftReports(db, new Date(at(day, '10:10')), options)).toBe(0);
    await closeShiftReports(db, new Date(at(day, '10:16')), options);
    // Turno 1 alone, with its eight hours: the next shift stopped the stretch at 10:00.
    expect(await reports()).toEqual(['Turno 1 96']);
  }, 60_000);

  it('reopens a shift that closed early and then worked past the moment it closed', async () => {
    const day = '2026-10-06';
    const { db, reports } = await plant(
      [{ name: 'Turno', start: '07:00', end: '17:00', closeAfter: 15 }],
      day,
      [
        ['07:00', '17:00'],
        // Forty minutes stopped, then back: within the site's 120-minute stretch limit.
        ['17:40', '18:00'],
      ],
    );
    const options = { deviceId: HAIWELL, fromDate: day, toDate: day };
    await closeShiftReports(db, new Date(at(day, '17:20')), options);
    expect(await reports()).toEqual(['Turno 120']);
    // 17:50: the line came back after the report was written -- it goes away until done.
    await closeShiftReports(db, new Date(at(day, '17:50')), options);
    expect(await reports()).toEqual([]);
    // 18:20: a stretched shift runs until the site's limit passes after its last pallet (a stop
    // going on counts in it), so the wait of 15 minutes does not cut it short.
    await closeShiftReports(db, new Date(at(day, '18:20')), options);
    expect(await reports()).toEqual([]);
    // 20:05: past the limit -- written again, with the stretch in it.
    await closeShiftReports(db, new Date(at(day, '20:05')), options);
    expect(await reports()).toEqual(['Turno 124']);
  }, 60_000);
});

describe('the day chart', () => {
  const day = (date: string) => ({
    start: plantInstant(date, '00:00'),
    end: plantInstant(date, '23:59'),
  });
  const chartOf = (producing: Producing) => {
    const shifts = extendOccurrences(expandShifts(SHIFT, DAY, DAY), producing, late, 120, {
      from: DAY,
      to: DAY,
    });
    const chart = chartSpanOf(shifts, day(DAY));
    return `${hhmm(chart.start)}-${hhmm(chart.end)}`;
  };

  it('starts at the shift when the line started inside it, and ends at the registered end', () => {
    expect(chartOf(run(new Map(), DAY, '07:15', '16:40'))).toBe('07:00-17:00');
  });

  it('starts where the line started before the shift, and ends where it kept working', () => {
    const producing = run(new Map(), DAY, '05:00', '18:30');
    expect(chartOf(producing)).toBe('05:00-18:30');
  });

  it('opens to the end of the day when the line worked more than two hours past the shift', () => {
    const producing = run(new Map(), DAY, '07:00', '20:30');
    expect(chartOf(producing)).toBe('07:00-23:59');
  });
});
