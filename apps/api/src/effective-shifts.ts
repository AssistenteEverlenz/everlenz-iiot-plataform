import type { Database } from '@iiot/database';
import { addDays, plantInstant, type ShiftOccurrence } from '@iiot/shared';

/**
 * The shift as the line worked it (2026-10-16, migration 047).
 *
 * A registered shift is where the day starts from, not a fence. Plants start before it and keep
 * producing after it: Indusfer ran 05:00 to 21:00 against a 07:00-17:00 shift, a third of its
 * bricks counted "out of shift", and its efficiency never saw those hours. So:
 *   - production that holds before the registered start opens the shift there;
 *   - production after the registered end stretches the shift to the last thing made, chaining
 *     stretches of production while the line is never stopped longer than the site's limit
 *     (sites.shift_extension_minutes, 120 by default) -- from the start of the stretch on,
 *     every stop counts, as inside the shift;
 *   - production on a day without a shift, or far from any shift, is an extra shift of its own.
 * What is not stretched over: a stop past the limit (the tail after the last product stays out,
 * so a line left stopped after the day ends never drags its efficiency down), and a few loose
 * pieces while cleaning or adjusting -- a stretch starts only with production that holds, two
 * thirds of fifteen minutes producing, the rule of the registered-against-real table.
 *
 * Live: while the line is in a stretch (it produced within the limit), the shift runs until now,
 * so a stop going on counts as it would in the shift; once the limit passes with the line quiet,
 * the shift ends at the last product again.
 *
 * Read from 5-minute buckets of producing seconds: the ceramic production buckets, or the
 * bagger's (the line produces while any spout fills bags).
 */
export type EffectiveOccurrence = ShiftOccurrence & {
  /** The registered window (the extra shift's own window, for one with no registration). */
  planned: { start: Date; end: Date };
  /** Production on a day or at an hour no shift covers. */
  extra: boolean;
  /** Seconds added before the registered start and after the registered end. */
  extendedBefore: number;
  extendedAfter: number;
};

export const DEFAULT_EXTENSION_MINUTES = 120;
const BUCKET_MS = 300_000;
const BUCKET_S = 300;
/** Production that holds: two thirds of fifteen minutes producing (shift-adherence.ts). */
const HOLD_BUCKETS = 3;
const HOLD_SHARE = 2 / 3;
/** How far a shift may stretch either way. */
const REACH_MS = 12 * 3600_000;

/** Producing seconds by bucket start (ms). */
export type Producing = Map<number, number>;

function heldForward(producing: Producing, at: number, now: number) {
  let sum = 0;
  let seen = 0;
  for (let index = 0; index < HOLD_BUCKETS; index += 1) {
    const bucket = at + index * BUCKET_MS;
    if (bucket >= now) break;
    sum += Math.min(BUCKET_S, producing.get(bucket) ?? 0);
    seen += 1;
  }
  return seen > 0 && sum >= HOLD_SHARE * BUCKET_S * Math.max(seen, Math.min(HOLD_BUCKETS, 2));
}
function heldBackward(producing: Producing, at: number) {
  let sum = 0;
  for (let index = 0; index < HOLD_BUCKETS; index += 1)
    sum += Math.min(BUCKET_S, producing.get(at - index * BUCKET_MS) ?? 0);
  return sum >= HOLD_SHARE * BUCKET_S * HOLD_BUCKETS;
}
/**
 * Where production in a bucket begins and ends, read as packed at the edge it touches. On the
 * whole second: the producing seconds are fractional, and a shift's length is stored as integer
 * seconds (an extra shift of 12920.022 s stopped the shift close, 2026-10-17).
 */
const startIn = (producing: Producing, at: number) =>
  at + Math.round(BUCKET_S - Math.min(BUCKET_S, producing.get(at) ?? 0)) * 1000;
const endIn = (producing: Producing, at: number) =>
  at + Math.round(Math.min(BUCKET_S, producing.get(at) ?? 0)) * 1000;

/**
 * Pure: the registered shifts of a range of days stretched to the production around them, plus
 * the extra shifts of production no shift covers, sorted by start.
 */
export function extendOccurrences(
  occurrences: ShiftOccurrence[],
  producing: Producing,
  now: Date,
  extensionMinutes: number,
  dates: { from: string; to: string },
): EffectiveOccurrence[] {
  const plain = (item: ShiftOccurrence): EffectiveOccurrence => ({
    ...item,
    planned: { start: item.start, end: item.end },
    extra: false,
    extendedBefore: 0,
    extendedAfter: 0,
  });
  const sorted = [...occurrences].sort((a, b) => a.start.getTime() - b.start.getTime());
  if (extensionMinutes <= 0) return sorted.map(plain);
  const gap = extensionMinutes * 60_000;
  const nowMs = now.getTime();
  const ats = [...producing.entries()]
    .filter(([at, seconds]) => seconds > 0 && at < nowMs)
    .map(([at]) => at)
    .sort((a, b) => a - b);

  const result: EffectiveOccurrence[] = [];
  for (const [index, occurrence] of sorted.entries()) {
    const registeredStart = occurrence.start.getTime();
    const registeredEnd = occurrence.end.getTime();
    const previousEnd = result.at(-1)?.end.getTime() ?? Number.NEGATIVE_INFINITY;
    const nextStart = sorted[index + 1]?.start.getTime() ?? Number.POSITIVE_INFINITY;

    // Before: production that holds, chained backwards from the registered start.
    let start = registeredStart;
    const startLimit = Math.max(previousEnd, registeredStart - REACH_MS);
    for (let at = ats.length - 1; at >= 0; at -= 1) {
      const bucket = ats[at];
      if (bucket >= registeredStart) continue;
      if (bucket < startLimit) break;
      if (start - (bucket + BUCKET_MS) > gap) break;
      if (heldForward(producing, bucket, nowMs)) start = Math.min(start, startIn(producing, bucket));
    }
    start = Math.max(start, startLimit);

    // After: production chained forwards from the registered end, while no stop passes the limit.
    let lastProduct = registeredEnd;
    const endLimit = Math.min(nextStart, registeredEnd + REACH_MS);
    for (const bucket of ats) {
      if (bucket < registeredEnd) continue;
      if (bucket >= endLimit) break;
      if (bucket - lastProduct > gap) break;
      if (heldForward(producing, bucket, nowMs) || heldBackward(producing, bucket))
        lastProduct = Math.max(lastProduct, endIn(producing, bucket));
    }
    let end = Math.min(lastProduct, endLimit);
    // Still in the stretch: the shift runs until now, and a stop going on counts.
    // (A second past now, so "the shift running now" -- start <= now < end -- finds it.)
    if (end > registeredEnd && nowMs - end <= gap && nowMs < endLimit)
      end = Math.max(end, nowMs + 1000);

    result.push({
      ...occurrence,
      start: new Date(start),
      end: new Date(end),
      planned: { start: occurrence.start, end: occurrence.end },
      extra: false,
      extendedBefore: (registeredStart - start) / 1000,
      extendedAfter: Math.max(0, (end - registeredEnd) / 1000),
    });
  }

  // Production no shift took in: an extra shift, from production that holds to the last product.
  const covered = (at: number) =>
    result.some((item) => at >= item.start.getTime() - BUCKET_MS && at < item.end.getTime());
  for (let date = dates.from; date <= dates.to; date = addDays(date, 1)) {
    const dayStart = plantInstant(date, '00:00').getTime();
    const dayEnd = plantInstant(addDays(date, 1), '00:00').getTime();
    let island: { start: number; last: number } | null = null;
    const close = () => {
      if (!island) return;
      let end = island.last;
      if (nowMs - end <= gap && nowMs < dayEnd) end = Math.max(end, nowMs + 1000);
      const window = { start: new Date(island.start), end: new Date(end) };
      result.push({
        shiftId: `extra:${window.start.toISOString()}`,
        name: 'Turno extra',
        productionDate: date,
        start: window.start,
        end: window.end,
        breaks: [],
        plannedSeconds: Math.round((end - island.start) / 1000),
        planned: window,
        extra: true,
        extendedBefore: 0,
        extendedAfter: 0,
      });
      island = null;
    };
    for (const bucket of ats) {
      if (bucket < dayStart) continue;
      if (bucket >= dayEnd) break;
      if (covered(bucket)) {
        close();
        continue;
      }
      if (island && bucket - island.last > gap) close();
      if (!island) {
        if (heldForward(producing, bucket, nowMs))
          island = { start: startIn(producing, bucket), last: endIn(producing, bucket) };
        continue;
      }
      if (heldForward(producing, bucket, nowMs) || heldBackward(producing, bucket))
        island.last = Math.max(island.last, endIn(producing, bucket));
    }
    close();
  }
  return result.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** The site's limit, read without naming the column so it works before migration 047. */
export async function extensionMinutesOf(db: Pick<Database, 'query'>, tenantId: string, siteId: string) {
  const row = (
    await db.query<{ minutes: string | null }>(
      `SELECT to_jsonb(s)->>'shift_extension_minutes' minutes FROM sites s WHERE tenant_id=$1 AND id=$2`,
      [tenantId, siteId],
    )
  ).rows[0];
  const minutes = row?.minutes == null ? DEFAULT_EXTENSION_MINUTES : Number(row.minutes);
  return Number.isFinite(minutes) ? minutes : DEFAULT_EXTENSION_MINUTES;
}

/** Producing seconds by bucket: the ceramic line's, or the bagger's (any spout filling). */
async function producingOf(
  db: Pick<Database, 'query'>,
  tenantId: string,
  deviceId: string,
  source: 'ceramic' | 'mortar',
  from: Date,
  to: Date,
) {
  const rows = (
    await db.query<{ bucket: Date; seconds: number }>(
      source === 'ceramic'
        ? `SELECT bucket,least(300,sum(producing_s))::float seconds FROM production_buckets
           WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4 GROUP BY bucket`
        : `SELECT bucket,least(300,max(seconds))::float seconds FROM (
             SELECT bucket,spout_id,sum(running_s) seconds FROM bagging_buckets
             WHERE tenant_id=$1 AND device_id=$2 AND bucket>=$3 AND bucket<$4
             GROUP BY bucket,spout_id) s GROUP BY bucket`,
      [tenantId, deviceId, from, to],
    )
  ).rows;
  return new Map(rows.map((row) => [new Date(row.bucket).getTime(), Number(row.seconds)]));
}

/**
 * The shifts of a range of production days as the line worked them: the registered occurrences
 * (expandShifts over the range) stretched, plus the day's extra shifts.
 */
export async function effectiveShifts(
  db: Pick<Database, 'query'>,
  input: {
    tenantId: string;
    siteId: string;
    deviceId: string;
    occurrences: ShiftOccurrence[];
    dates: { from: string; to: string };
    now: Date;
    source?: 'ceramic' | 'mortar';
  },
): Promise<EffectiveOccurrence[]> {
  const minutes = await extensionMinutesOf(db, input.tenantId, input.siteId);
  const starts = [
    ...input.occurrences.map((item) => item.start.getTime()),
    plantInstant(input.dates.from, '00:00').getTime(),
  ];
  const ends = [
    ...input.occurrences.map((item) => item.end.getTime()),
    plantInstant(addDays(input.dates.to, 1), '00:00').getTime(),
  ];
  const from = new Date(Math.min(...starts) - REACH_MS);
  const to = new Date(Math.min(input.now.getTime() + BUCKET_MS, Math.max(...ends) + REACH_MS));
  const producing =
    minutes > 0 && from < to
      ? await producingOf(db, input.tenantId, input.deviceId, input.source ?? 'ceramic', from, to)
      : new Map<number, number>();
  return extendOccurrences(input.occurrences, producing, input.now, minutes, input.dates);
}

/** Past this much work after the registered end, the day's chart opens to midnight. */
const OPEN_DAY_MS = 2 * 3600_000;

/**
 * The stretch of the day a day chart draws (the user, 2026-10-16): no empty hours of a machine
 * switched off. It begins at the first shift -- earlier when the line started before it -- and
 * ends at the registered end, or where the line kept working past it; working more than two
 * hours past it opens the chart to the end of the day. The day's totals still count every hour.
 */
export function chartSpanOf(
  occurrences: ShiftOccurrence[],
  day: { start: Date; end: Date },
): { start: Date; end: Date } {
  if (!occurrences.length) return day;
  const plannedOf = (item: ShiftOccurrence) =>
    'planned' in item ? (item as EffectiveOccurrence).planned : { start: item.start, end: item.end };
  const registered = occurrences.filter((item) => !('extra' in item && (item as EffectiveOccurrence).extra));
  const start = Math.min(...occurrences.map((item) => item.start.getTime()));
  const workedEnd = Math.max(...occurrences.map((item) => item.end.getTime()));
  const registeredEnd = registered.length
    ? Math.max(...registered.map((item) => plannedOf(item).end.getTime()))
    : workedEnd;
  const end =
    workedEnd > registeredEnd + OPEN_DAY_MS ? day.end.getTime() : Math.max(registeredEnd, workedEnd);
  return {
    start: new Date(Math.max(start, day.start.getTime())),
    end: new Date(Math.min(end, day.end.getTime())),
  };
}
