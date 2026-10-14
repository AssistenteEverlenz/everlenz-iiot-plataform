import type { Database } from '@iiot/database';
import type { ShiftOccurrence } from '@iiot/shared';
import { mergeStops } from './stop-consolidation.js';

/**
 * The shift as it happened against the shift as registered: when the line really started, when
 * each pause really began and ended, when the line really stopped for the day.
 *
 * Read from the stop recorder (production-stops.ts), which runs around the clock and writes the
 * instant the counter goes quiet and the instant it moves again, so the times are exact, not
 * rounded to the five-minute blocks. Stops a moment of production apart are one (the same rule
 * as the stop count, stop-consolidation.ts): a pallet counted in passing does not start a shift.
 *
 * No tolerance on purpose (the user, 2026-10-14): the real time is shown with its difference,
 * whatever it is, and the plant reads it.
 */

/** How far before the planned start, and after the planned end, the line is looked for. */
const REACH_MS = 3 * 3600_000;

export interface Window {
  start: Date;
  end: Date;
}

export interface Adherence {
  /** Contiguous shifts read as one: the line runs through the change of shift. */
  blocks: Array<{
    planned: { start: string; end: string };
    /** First production; null when the line has not produced yet. */
    start: string | null;
    /** Last production; null while it still produces (or has not started). */
    end: string | null;
    /** Still producing now, so the end is not known yet. */
    running: boolean;
  }>;
  pauses: Array<{
    planned: { start: string; end: string };
    /** The stop that covered the pause; null when the line ran through it. */
    start: string | null;
    end: string | null;
    /** The pause has not ended yet (the line is still stopped in it). */
    open: boolean;
    /** The pause is still ahead. */
    ahead: boolean;
  }>;
}

/** The registered shifts joined where one ends as the next begins. */
function blocksOf(occurrences: ShiftOccurrence[]) {
  const sorted = [...occurrences].sort((a, b) => a.start.getTime() - b.start.getTime());
  const blocks: Array<Window & { breaks: Window[] }> = [];
  for (const item of sorted) {
    const last = blocks.at(-1);
    if (last && item.start.getTime() <= last.end.getTime()) {
      last.end = new Date(Math.max(last.end.getTime(), item.end.getTime()));
      last.breaks.push(...item.breaks);
    } else blocks.push({ start: item.start, end: item.end, breaks: [...item.breaks] });
  }
  return blocks;
}

/** The stretches of production inside [from, to]: what the stops leave. */
function producingIn(stops: Window[], from: Date, to: Date) {
  const runs: Window[] = [];
  let cursor = from.getTime();
  for (const stop of stops) {
    if (stop.end.getTime() <= cursor || stop.start.getTime() >= to.getTime()) {
      if (stop.start.getTime() >= to.getTime()) break;
      continue;
    }
    if (stop.start.getTime() > cursor) runs.push({ start: new Date(cursor), end: stop.start });
    cursor = Math.max(cursor, stop.end.getTime());
  }
  if (cursor < to.getTime()) runs.push({ start: new Date(cursor), end: to });
  return runs;
}

/**
 * Pure: the registered shifts, the stops (any order, open ones ending now) and the instant now.
 * `known` is when the recorder has readings from: before it, nothing can be said.
 */
export function adherenceOf(occurrences: ShiftOccurrence[], parts: Array<Window & { state: string }>, now: Date): Adherence {
  const stops = mergeStops(parts).map((stop) => ({ start: stop.start, end: stop.end }));
  const blocks = blocksOf(occurrences);
  const result: Adherence = { blocks: [], pauses: [] };
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    const next = blocks[index + 1];
    const from = new Date(Math.max(block.start.getTime() - REACH_MS, previous ? previous.end.getTime() : 0));
    const to = new Date(
      Math.min(now.getTime(), block.end.getTime() + REACH_MS, next ? next.start.getTime() : Number.POSITIVE_INFINITY),
    );
    const runs = to > from ? producingIn(stops, from, to) : [];
    // A run that is still going at "now" has no end yet.
    const lastRun = runs.at(-1);
    const running = Boolean(lastRun && lastRun.end.getTime() >= now.getTime() - 1000 && to.getTime() >= now.getTime() - 1000);
    result.blocks.push({
      planned: { start: block.start.toISOString(), end: block.end.toISOString() },
      start: runs[0]?.start.toISOString() ?? null,
      // Before the planned end, a quiet line is a stop or a pause, not the end of the day.
      end: lastRun && !running && now.getTime() >= block.end.getTime() ? lastRun.end.toISOString() : null,
      running,
    });
    for (const pause of block.breaks) {
      const ahead = pause.start.getTime() > now.getTime();
      // The stop, or stops, that touched the pause: when the line left and when it came back.
      const touching = stops.filter(
        (stop) => stop.start.getTime() < pause.end.getTime() && stop.end.getTime() > pause.start.getTime(),
      );
      const first = touching[0];
      const last = touching.at(-1);
      const open = Boolean(last && last.end.getTime() >= now.getTime() - 1000);
      result.pauses.push({
        planned: { start: pause.start.toISOString(), end: pause.end.toISOString() },
        start: first ? first.start.toISOString() : null,
        end: last && !open ? last.end.toISOString() : null,
        open,
        ahead: ahead && !first,
      });
    }
  });
  return result;
}

/** The recorder's stops around the given shifts, read and turned into the shift as it happened. */
export async function loadAdherence(db: Database, deviceId: string, occurrences: ShiftOccurrence[], now: Date) {
  if (!occurrences.length) return null;
  const from = new Date(Math.min(...occurrences.map((item) => item.start.getTime())) - REACH_MS);
  const to = new Date(Math.max(...occurrences.map((item) => item.end.getTime())) + REACH_MS);
  const rows = await db.query<{ state: string; started_at: Date; ended_at: Date | null }>(
    `SELECT state,started_at,ended_at FROM production_stops
     WHERE device_id=$1 AND started_at < $3 AND coalesce(ended_at,now()) > $2
     ORDER BY started_at`,
    [deviceId, from, to],
  );
  // No reading at all around the shift (a machine added today): nothing to say.
  const first = await db.query<{ at: Date | null }>(
    'SELECT min(started_at) at FROM production_stops WHERE device_id=$1',
    [deviceId],
  );
  if (!first.rows[0]?.at || new Date(first.rows[0].at) > to) return null;
  return adherenceOf(
    occurrences,
    rows.rows.map((row) => ({
      start: new Date(row.started_at),
      end: row.ended_at ? new Date(row.ended_at) : now,
      state: row.state,
    })),
    now,
  );
}
