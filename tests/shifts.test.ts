import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHIFTS,
  expandShifts,
  occurrenceOf,
  plantDate,
  productiveSecondsIn,
  productiveWindows,
  validateShifts,
  type ShiftDefinition,
} from '../packages/shared/src/shifts.js';
import { summarize } from '../apps/api/src/shift-production.js';

const shift = (patch: Partial<ShiftDefinition>): ShiftDefinition => ({
  id: null,
  name: 'A',
  weekdays: [1, 2, 3, 4, 5],
  start: '07:00',
  end: '17:00',
  breaks: [],
  ...patch,
});

describe('shift calendar', () => {
  it('uses the default Monday-Friday 07:00-17:00 shift, in Brasília time', () => {
    // 2026-09-07 is a Monday; 2026-09-12/13 is the weekend.
    const occurrences = expandShifts(DEFAULT_SHIFTS, '2026-09-07', '2026-09-13');
    expect(occurrences).toHaveLength(5);
    expect(occurrences[0].start.toISOString()).toBe('2026-09-07T10:00:00.000Z');
    expect(occurrences[0].end.toISOString()).toBe('2026-09-07T20:00:00.000Z');
    expect(occurrences[0].plannedSeconds).toBe(10 * 3600);
  });

  it('keeps an overnight shift on the day it starts and discounts its pauses', () => {
    const night = occurrenceOf(
      shift({
        name: 'Noite',
        start: '22:00',
        end: '06:00',
        breaks: [{ start: '02:00', end: '02:30' }],
      }),
      '2026-09-08',
    );
    expect(night.productionDate).toBe('2026-09-08');
    expect(night.start.toISOString()).toBe('2026-09-09T01:00:00.000Z');
    expect(night.end.toISOString()).toBe('2026-09-09T09:00:00.000Z');
    expect(night.breaks[0].start.toISOString()).toBe('2026-09-09T05:00:00.000Z');
    expect(night.plannedSeconds).toBe(7.5 * 3600);
  });

  it('counts only productive time inside the windows', () => {
    const day = occurrenceOf(
      shift({
        breaks: [
          { start: '11:00', end: '12:00' },
          { start: '15:00', end: '15:15' },
        ],
      }),
      '2026-09-08',
    );
    const windows = productiveWindows(day);
    expect(windows).toHaveLength(3);
    expect(day.plannedSeconds).toBe((10 - 1 - 0.25) * 3600);
    // 10:00-13:00 local: two hours of it are productive (11-12 is the lunch pause).
    expect(
      productiveSecondsIn(
        windows,
        new Date('2026-09-08T13:00:00Z'),
        new Date('2026-09-08T16:00:00Z'),
      ),
    ).toBe(2 * 3600);
  });

  it('rejects overlapping shifts, pauses outside the shift and odd minutes', () => {
    expect(validateShifts([shift({}), shift({ name: 'B', start: '16:00', end: '22:00' })])).toMatch(
      /sobrepõem/,
    );
    expect(validateShifts([shift({ breaks: [{ start: '06:00', end: '06:30' }] })])).toMatch(
      /dentro/,
    );
    expect(validateShifts([shift({ start: '07:03' })])).toMatch(/5 minutos/);
    expect(
      validateShifts([
        shift({
          name: 'Manhã',
          start: '06:00',
          end: '14:00',
          breaks: [{ start: '10:00', end: '10:15' }],
        }),
        shift({ name: 'Tarde', start: '14:00', end: '22:00' }),
        shift({ name: 'Noite', start: '22:00', end: '06:00', weekdays: [1, 2, 3, 4] }),
      ]),
    ).toBeNull();
  });

  it('reads the plant date of an instant', () => {
    expect(plantDate(new Date('2026-09-12T02:30:00Z'))).toBe('2026-09-11');
  });
});

describe('a pause the plant works through', () => {
  const day = occurrenceOf(shift({ breaks: [{ start: '11:00', end: '12:00' }] }), '2026-09-08');
  const windows = productiveWindows(day);
  // One 5-minute bucket at 11:10 local (14:10Z): inside the lunch pause.
  const bucket = (patch: { producing_s?: number; idle_s?: number; pallets?: number }) => [
    {
      bucket: '2026-09-08T14:10:00.000Z',
      product_code: 'ITEM GERAL',
      pieces: 0,
      pallets: patch.pallets ?? 0,
      tons: 0,
      producing_s: patch.producing_s ?? 0,
      idle_s: patch.idle_s ?? 0,
      manual_s: 0,
    },
  ];
  const until = new Date('2026-09-08T14:15:00.000Z');

  it('counts the machine running during the pause as production time', () => {
    const summary = summarize(bucket({ producing_s: 300, pallets: 2 }), day, windows, until);
    expect(summary.producing).toBe(300);
    expect(summary.producingInPause).toBe(300);
    // 07:00 to 11:15 local minus the 15 min of pause already elapsed, plus the 5 min worked.
    expect(summary.elapsedProductive).toBe(4 * 3600 + 300);
    expect(summary.pallets).toBe(2);
  });

  it('leaves a pause that really happened out of the machine time', () => {
    const summary = summarize(bucket({ idle_s: 300 }), day, windows, until);
    expect(summary.producing).toBe(0);
    expect(summary.idle).toBe(0);
    expect(summary.producingInPause).toBe(0);
    expect(summary.elapsedProductive).toBe(4 * 3600);
  });
});
