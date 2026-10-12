/**
 * Stops as the ceramist counts them.
 *
 * The recorder (production-stops.ts) writes a row every time the machine's state changes, which
 * is exact but not what a person calls a stop: in one week of the plants, 60 % of the rows lasted
 * less than three minutes (21 h of 981 h stopped), a third began less than two minutes after the
 * previous one ended (the line moved for a moment and stopped again), and some overlapped (the
 * same stop written twice when its reason changed). Read as rows, a day showed 62 stops.
 *
 * So, when stops are counted:
 *   - rows that overlap, or that are separated by less than MERGE_GAP of production, are one stop;
 *     its reason is the one that took most of its time;
 *   - a stop shorter than MINIMUM is a micro-stop, counted apart, not a stop.
 * The stored rows are never rewritten, so the history comes out the same way. The time stopped
 * is not taken from here: it comes from the production board's own five-minute blocks.
 */
export const MERGE_GAP_MS = 2 * 60_000;
export const MINIMUM_SECONDS = 3 * 60;

export interface StopPart {
  start: Date;
  end: Date;
  state: string;
}

export interface MergedStop<T extends StopPart> {
  start: Date;
  end: Date;
  /** The reason that took most of the stop's time. */
  state: string;
  parts: T[];
  /** The stretches actually stopped, overlaps removed and the short production gaps left out. */
  covered: Array<{ start: Date; end: Date }>;
}

export function mergeStops<T extends StopPart>(parts: T[], gapMs = MERGE_GAP_MS): Array<MergedStop<T>> {
  const sorted = [...parts]
    .filter((part) => part.end.getTime() > part.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Array<MergedStop<T> & { byState: Map<string, number> }> = [];
  for (const part of sorted) {
    const last = merged.at(-1);
    if (last && part.start.getTime() <= last.end.getTime() + gapMs) {
      // Only the part of it not already counted adds time.
      const from = Math.max(part.start.getTime(), last.end.getTime());
      const added = Math.max(0, part.end.getTime() - from);
      last.byState.set(part.state, (last.byState.get(part.state) ?? 0) + added);
      if (part.start.getTime() > last.end.getTime())
        last.covered.push({ start: part.start, end: part.end });
      else if (part.end.getTime() > last.end.getTime()) last.covered.at(-1)!.end = part.end;
      if (part.end.getTime() > last.end.getTime()) last.end = part.end;
      last.parts.push(part);
      continue;
    }
    merged.push({
      start: part.start,
      end: part.end,
      state: part.state,
      parts: [part],
      covered: [{ start: part.start, end: part.end }],
      byState: new Map([[part.state, part.end.getTime() - part.start.getTime()]]),
    });
  }
  return merged.map(({ byState, ...stop }) => ({
    ...stop,
    state: [...byState.entries()].sort((a, b) => b[1] - a[1])[0][0],
  }));
}
