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
