import { describe, expect, it } from 'vitest';
import { mergeStops } from '../apps/api/src/stop-consolidation.js';

/** Stops as the ceramist counts them (apps/api/src/stop-consolidation.ts). */
const at = (clock: string) => new Date(`2026-10-09T${clock}:00-03:00`);
const part = (from: string, to: string, state: string) => ({ start: at(from), end: at(to), state });

describe('consolidação das paradas', () => {
  it('joins the rows of the end-of-day shutdown into one stop, with the reason that took longest', () => {
    // Campo Forte, 09/10: idle, manual, offline, manual, manual, never producing in between.
    const merged = mergeStops([
      part('16:59', '17:18', 'idle'),
      part('17:18', '17:32', 'manual'),
      part('17:32', '17:51', 'offline'),
      part('17:51', '17:56', 'manual'),
      part('17:57', '18:09', 'manual'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].state).toBe('manual');
    expect(merged[0].start).toEqual(at('16:59'));
    expect(merged[0].end).toEqual(at('18:09'));
  });

  it('keeps stops apart when the line really produced between them', () => {
    expect(mergeStops([part('10:00', '10:10', 'idle'), part('10:15', '10:20', 'idle')])).toHaveLength(2);
  });

  it('counts an overlap once, and leaves the production moment out of the stopped time', () => {
    const [stop] = mergeStops([
      part('08:00', '08:10', 'manual'),
      part('08:05', '08:20', 'idle'),
      part('08:21', '08:30', 'idle'),
    ]);
    const stopped = stop.covered.reduce((sum, c) => sum + (c.end.getTime() - c.start.getTime()), 0);
    // 08:00-08:20 and 08:21-08:30: 29 minutes, the minute of production left out.
    expect(stopped).toBe(29 * 60_000);
    expect(stop.state).toBe('idle');
  });
});
