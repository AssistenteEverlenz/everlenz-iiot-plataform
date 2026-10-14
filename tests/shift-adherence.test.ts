import { describe, expect, it } from 'vitest';
import { expandShifts, type ShiftDefinition } from '../packages/shared/src/index.js';
import { adherenceOf } from '../apps/api/src/shift-adherence.js';
// @ts-expect-error the web component's pure part, read by the API tests too
import { rowsOf } from '../apps/web/components/ShiftAdherence.tsx';

/** The shift as it happened against the shift as registered (shift-adherence.ts). */
const shift: ShiftDefinition = {
  id: 's1',
  name: 'Turno',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  start: '06:00',
  end: '17:30',
  breaks: [{ start: '11:00', end: '12:30' }],
};
const day = '2026-10-13';
const occurrences = expandShifts([shift], day, day);
// Plant time is UTC-3.
const at = (time: string) => new Date(`${day}T${time}:00-03:00`);
const stop = (from: string, to: string, state = 'idle') => ({ start: at(from), end: at(to), state });

describe('turno previsto × real', () => {
  it('reads the real start, pause and end from the stops, to the second', () => {
    const result = adherenceOf(
      occurrences,
      [
        // Quiet all night, then a pallet counted in passing at 05:40 (one minute) and quiet again:
        // a moment of production between two stops is not the start.
        stop('02:00', '05:40'),
        stop('05:41', '06:12', 'offline'),
        stop('10:59', '12:49'),
        stop('17:01', '23:00'),
      ],
      at('21:00'),
    );
    expect(result.blocks[0].start).toBe(at('06:12').toISOString());
    expect(result.blocks[0].end).toBe(at('17:01').toISOString());
    expect(result.pauses[0]).toMatchObject({ start: at('10:59').toISOString(), end: at('12:49').toISOString(), open: false });
  });

  it('says nothing of the end while the shift runs, and keeps a pause the line is in open', () => {
    const result = adherenceOf(occurrences, [stop('02:00', '05:55'), stop('11:05', '11:40')], at('11:40'));
    expect(result.blocks[0].start).toBe(at('05:55').toISOString());
    expect(result.blocks[0].end).toBeNull();
    expect(result.pauses[0].open).toBe(true);
    expect(result.pauses[0].end).toBeNull();
  });

  it('tells a pause the line ran through, and one still ahead', () => {
    const through = adherenceOf(occurrences, [stop('02:00', '06:00')], at('13:00'));
    expect(through.pauses[0]).toMatchObject({ start: null, ahead: false });
    const ahead = adherenceOf(occurrences, [stop('02:00', '06:00')], at('09:00'));
    expect(ahead.pauses[0].ahead).toBe(true);
    expect(ahead.blocks[0].running).toBe(true);
  });

  it('writes the board rows with what each difference cost the shift', () => {
    const rows = rowsOf(
      adherenceOf(occurrences, [stop('02:00', '06:12'), stop('10:59', '12:49'), stop('17:01', '23:00')], at('21:00')),
    );
    const by = Object.fromEntries(rows.map((row: { label: string }) => [row.label, row]));
    expect(by['Início']).toMatchObject({ planned: '06:00', real: '06:12', shift: 12, effect: -12 });
    // Times only in the time columns: a pause ahead is its two rows with a dash for the real one.
    const ahead = rowsOf(adherenceOf(occurrences, [stop('02:00', '06:00')], at('09:00')));
    expect(ahead.map((row: { label: string }) => row.label)).toEqual(['Início', 'Pausa · saída', 'Pausa · volta', 'Fim']);
    expect(ahead.slice(1).every((row: { real: string | null }) => row.real === null)).toBe(true);
    expect(by['Pausa · saída']).toMatchObject({ shift: -1, effect: -1 });
    expect(by['Pausa · volta']).toMatchObject({ shift: 19, effect: -19 });
    expect(by['Fim']).toMatchObject({ planned: '17:30', real: '17:01', shift: -29, effect: -29 });
  });
});
