import type { Database } from '@iiot/database';
import type { ShiftOccurrence } from '@iiot/shared';
import { mergeStops } from './stop-consolidation.js';

/**
 * The shift as it happened against the shift as registered: when the line really started, when
 * each pause really began and ended, when the line really stopped for the day.
 *
 * Read from the stop recorder (production-stops.ts), which runs around the clock and writes the
 * instant the counter goes quiet and the instant it moves again, so the times are exact, not
 * rounded to the five-minute blocks. The counter is the blocks one wherever it is configured (all
 * the ceramics, 2026-10-14; production-attribution.ts), so the start is the first block through
 * the machine, as the plant counts it, not the first pallet. Stops a moment of production apart are one (the same rule
 * as the stop count, stop-consolidation.ts): a pallet counted in passing does not start a shift.
 *
 * No tolerance on purpose (the user, 2026-10-14): the real time is shown with its difference,
 * whatever it is, and the plant reads it.
 */

/** How far before the planned start, and after the planned end, the line is looked for. */
const REACH_MS = 3 * 3600_000;
/**
 * A start (or a return from a pause) is production that holds: at least two thirds of the next
 * fifteen minutes producing. Blocks counted while the line is being adjusted, the machine going
 * in and out of manual, are not the start: at Oliveira on 2026-10-14 the first blocks passed at
 * 05:55, a few minutes at a time between manual stops (5–15 % of the normal pace), and the line
 * really ran from 06:25. The end is read the same way backwards: a few blocks while cleaning up
 * after the shift do not move it.
 */
const HOLD_MS = 15 * 60_000;
const HOLD_SHARE = 2 / 3;
/** Under this much time watched, a start just begun is not called yet. */
const MIN_WATCH_MS = 3 * 60_000;

export interface Window {
  start: Date;
  end: Date;
}

export interface Adherence {
  /** Contiguous shifts read as one: the line runs through the change of shift. */
  blocks: Array<{
    planned: { start: string; end: string };
    /** Production that held (HOLD_MS); null when the line has not started yet. */
    start: string | null;
    /** The first blocks, when they passed before the start (adjusting the line). */
    firstBlocks: string | null;
    /** Production held until; null while it still produces (or has not started). */
    end: string | null;
    /** The last blocks, when a few passed after the end (emptying, cleaning). */
    lastBlocks: string | null;
    /** Still producing now, so the end is not known yet. */
    running: boolean;
  }>;
  pauses: Array<{
    planned: { start: string; end: string };
    /** The stop that covered the pause; null when the line ran through it. */
    start: string | null;
    /** Back when production held again. */
    end: string | null;
    /** The first blocks after the pause, when they came before production held. */
    firstBlocks: string | null;
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

/** Milliseconds of production inside [from, to]. */
function producedIn(runs: Window[], from: number, to: number) {
  let total = 0;
  for (const run of runs) total += Math.max(0, Math.min(run.end.getTime(), to) - Math.max(run.start.getTime(), from));
  return total;
}

/** The first moment from `after` on where production holds; null when it has not yet. */
function heldFrom(runs: Window[], after: number, horizon: number) {
  for (const run of runs) {
    if (run.end.getTime() <= after) continue;
    const at = Math.max(run.start.getTime(), after);
    const until = Math.min(at + HOLD_MS, horizon);
    if (until - at < Math.min(MIN_WATCH_MS, HOLD_MS)) return null;
    if (producedIn(runs, at, until) >= HOLD_SHARE * (until - at)) return at;
  }
  return null;
}

/** The last moment production held up to (read backwards), not before `floor`. */
function heldUntil(runs: Window[], floor: number) {
  for (const run of [...runs].reverse()) {
    const at = run.end.getTime();
    if (at <= floor) return null;
    const from = Math.max(at - HOLD_MS, floor);
    if (producedIn(runs, from, at) >= HOLD_SHARE * (at - from)) return at;
  }
  return null;
}

/** Pure: the registered shifts, the stops (any order, open ones ending now) and the instant now. */
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
    const start = heldFrom(runs, from.getTime(), to.getTime());
    const end = start == null ? null : heldUntil(runs, start);
    result.blocks.push({
      planned: { start: block.start.toISOString(), end: block.end.toISOString() },
      start: start == null ? null : new Date(start).toISOString(),
      firstBlocks: runs[0] && (start == null || runs[0].start.getTime() < start) ? runs[0].start.toISOString() : null,
      // Before the planned end, a quiet line is a stop or a pause, not the end of the day.
      end: end != null && !running && now.getTime() >= block.end.getTime() ? new Date(end).toISOString() : null,
      lastBlocks:
        end != null && lastRun && !running && now.getTime() >= block.end.getTime() && lastRun.end.getTime() > end
          ? lastRun.end.toISOString()
          : null,
      running,
    });
    for (const pause of block.breaks) {
      const ahead = pause.start.getTime() > now.getTime();
      // The stop, or stops, that touched the pause: when the line left and when it came back.
      const touching = stops.filter(
        (stop) => stop.start.getTime() < pause.end.getTime() && stop.end.getTime() > pause.start.getTime(),
      );
      const first = touching[0];
      // Back when production holds again: running for a minute and stopping again is not back.
      const back = first ? heldFrom(runs, first.start.getTime(), to.getTime()) : null;
      const open = Boolean(first) && back == null;
      const resumed = first ? runs.find((run) => run.start.getTime() >= first.end.getTime()) : undefined;
      result.pauses.push({
        planned: { start: pause.start.toISOString(), end: pause.end.toISOString() },
        start: first ? first.start.toISOString() : null,
        end: back == null ? null : new Date(back).toISOString(),
        firstBlocks: back != null && resumed && resumed.start.getTime() < back ? resumed.start.toISOString() : null,
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
