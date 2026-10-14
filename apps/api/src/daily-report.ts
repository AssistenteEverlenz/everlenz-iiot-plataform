import type { Database } from '@iiot/database';
import { addDays, plantInstant, productiveSecondsIn, productiveWindows } from '@iiot/shared';
import { utilizationFrom } from '../../web/components/utilizationFormula.js';
import { productionDetailData, loadConfig, loadShiftsFor } from './shift-production.js';
import { MINIMUM_SECONDS, mergeStops } from './stop-consolidation.js';

/**
 * The daily summary sent on WhatsApp, as text.
 *
 * The first line is the verdict, because it is what the lock screen shows. Then the production,
 * the machine with each figure against the average of the last production days (a traffic
 * light), the day hour by hour and the week as small bars, and one sentence about what made the
 * day — worked out by rule from the numbers, never by an AI, so nothing in it is invented.
 *
 * gatherDay reads the facts; composeDevice and composeMessage only write (pure, tested).
 */

const UNITS: Record<string, { unit: string; per: string; decimals: number }> = {
  milheiros: { unit: 'milheiros', per: 'mil/h', decimals: 1 },
  tons: { unit: 't', per: 't/h', decimals: 1 },
  blocks: { unit: 'peças', per: 'peças/h', decimals: 0 },
  pallets: { unit: 'paletes', per: 'pal/h', decimals: 0 },
};
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const BARS = '▁▂▃▄▅▆▇█';
/** Production days the averages are taken over. */
const AVERAGE_DAYS = 7;

export interface DayFacts {
  name: string;
  dashboardId: string | null;
  date: string;
  /** "turno · 06:00 às 17:30", or "2 turnos · 02:00 às 18:00". */
  shifts: string;
  /** First and last hour of the shifts, for the hour-by-hour line (hours with no record are 0). */
  firstHour: number;
  lastHour: number;
  metric: string;
  made: number;
  milheiros: number;
  pallets: number;
  tons: number;
  target: number | null;
  /** Each shift of the day, when there is more than one ("Turno 1", "Turno 2"). */
  perShift: Array<{ name: string; span: string; made: number; target: number | null }>;
  /** Made after the last shift (overtime), in the metric. */
  overtime: number;
  utilization: number | null;
  pacePerHour: number;
  stoppedSeconds: number;
  /** Stops of three minutes or more, consolidated (stop-consolidation.ts). */
  stops: number;
  /** Shorter ones, counted apart. */
  microStops: number;
  longestStop: { seconds: number; at: string } | null;
  /**
   * The production board's S curve: planned (the target spread over the productive time, flat in
   * the breaks) and actual, both accumulated, every five minutes of the day.
   */
  curve: Array<{ t: string; planned: number | null; actual: number | null }>;
  /** Made and stopped seconds per hour of the shifts. */
  hours: Array<{ hour: number; made: number; stopped: number }>;
  /** The previous production day. */
  previous: { date: string; made: number } | null;
  /** Monday of this week up to this day, production days only. */
  week: Array<{ date: string; made: number }>;
  /** Time stopped by reason, in the shifts. */
  reasons: { idle: number; manual: number; offline: number };
  /** The machine every five minutes of the shifts, from timelineStart (the strip, the S curve's area). */
  timelineStart: string;
  timeline: Array<'producing' | 'idle' | 'manual' | 'offline'>;
  /** The longest stops of the day, inside the shifts. */
  topStops: Array<{ at: string; seconds: number; state: string }>;
  /** Every stop of three minutes or more, in the order they happened; open = still stopped. */
  stopList: Array<{ at: string; seconds: number; state: string; open: boolean }>;
  /** Averages over the last production days before this one; null when there are none. */
  average: { made: number; pacePerHour: number; utilization: number | null; stoppedSeconds: number } | null;
}

const dayOfWeek = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const plantClock = (at: Date) =>
  new Date(at.getTime() - 3 * 3600_000).toISOString().slice(11, 16);

function inMetric(metric: string, row: { pieces: number; pallets: number; tons: number }) {
  if (metric === 'pallets') return row.pallets;
  if (metric === 'tons') return row.tons;
  if (metric === 'blocks') return row.pieces;
  return row.pieces / 1000;
}

/** Everything the text needs about one machine's closed day. */
export async function gatherDay(
  db: Database,
  tenantId: string,
  device: { id: string; name: string; dashboard_id: string | null },
  date: string,
): Promise<DayFacts | null> {
  const config = await loadConfig(db, tenantId, device.id);
  if (!config || !(config.blocks_tag_id || config.pallets_tag_id)) return null;
  const occurrences = (await loadShiftsFor(db, tenantId, config.site_id, date)).filter(
    (item) => item.productionDate === date,
  );
  if (!occurrences.length) return null;
  const start = new Date(Math.min(...occurrences.map((item) => item.start.getTime())));
  const end = new Date(Math.max(...occurrences.map((item) => item.end.getTime())));
  const detail = await productionDetailData(db, tenantId, device.id, config, { date, kind: 'day' });
  const board = detail.board;
  const metric = board.metric;
  const made = inMetric(metric, board.totals);

  const [extra, hourly, history, blocks, rows] = await Promise.all([
    db.query<{ pieces: string; pallets: string; tons: string }>(
      `SELECT coalesce(sum(pieces),0) pieces,coalesce(sum(pallets),0) pallets,coalesce(sum(tons),0) tons
       FROM production_buckets WHERE device_id=$1 AND bucket >= $2 AND bucket < $3`,
      [device.id, end, plantInstant(addDays(date, 1), '00:00')],
    ),
    db.query<{ hour_of_day: number; pieces: string; pallets: string; tons: string; stopped: string }>(
      `SELECT extract(hour FROM bucket - interval '3 hours')::int AS hour_of_day,
         sum(pieces) pieces,sum(pallets) pallets,sum(tons) tons,sum(idle_s+manual_s) stopped
       FROM production_buckets WHERE device_id=$1 AND bucket >= $2 AND bucket < $3
       GROUP BY 1 ORDER BY 1`,
      [device.id, start, end],
    ),
    // The closed shifts of the days before: fast, and kept forever.
    db.query<{
      date: string;
      pieces: number;
      pallets: number;
      tons: number;
      producing: number;
      idle: number;
      manual: number;
      offline: number;
    }>(
      `SELECT production_date::text date,sum(pieces) pieces,sum(pallets) pallets,sum(tons) tons,
         sum(producing_s) producing,sum(idle_s) idle,sum(manual_s) manual,sum(offline_s) offline
       FROM shift_reports
       WHERE device_id=$1 AND kind='shift' AND deleted_at IS NULL
         AND production_date < $2 AND production_date >= $3::date
       GROUP BY production_date ORDER BY production_date`,
      [device.id, date, addDays(date, -40)],
    ),
    db.query<{ bucket: Date; producing: string; idle: string; manual: string }>(
      `SELECT bucket,sum(producing_s) producing,sum(idle_s) idle,sum(manual_s) manual
       FROM production_buckets WHERE device_id=$1 AND bucket >= $2 AND bucket < $3
       GROUP BY bucket ORDER BY bucket`,
      [device.id, start, end],
    ),
    // Every stop row of the shifts, consolidated below into stops as the ceramist counts them.
    db.query<{ started_at: Date; ended_at: Date | null; state: string }>(
      `SELECT started_at,ended_at,state FROM production_stops
       WHERE device_id=$1 AND NOT during_pause AND started_at < $3 AND coalesce(ended_at,now()) > $2
       ORDER BY started_at`,
      [device.id, start, end],
    ),
  ]);
  // Rows that overlap or are a moment of production apart are one stop; under three minutes it
  // is a micro-stop. Each counted only inside the shifts' productive time.
  const windows = occurrences.flatMap(productiveWindows);
  const openUntil = Math.min(Date.now(), end.getTime());
  const stillOpen = rows.rows.some((row) => !row.ended_at);
  const merged = mergeStops(
    rows.rows.map((row) => ({
      start: new Date(row.started_at),
      end: row.ended_at ? new Date(row.ended_at) : new Date(Math.min(Date.now(), end.getTime())),
      state: row.state,
    })),
  )
    .map((stop) => ({
      start: new Date(Math.max(stop.start.getTime(), start.getTime())),
      state: stop.state,
      open: stillOpen && stop.end.getTime() >= openUntil - 1000,
      seconds: stop.covered.reduce((sum, part) => sum + productiveSecondsIn(windows, part.start, part.end), 0),
    }))
    .filter((stop) => stop.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  const counted = merged.filter((stop) => stop.seconds >= MINIMUM_SECONDS);
  // Every five minutes of the shifts: the state that took most of it; no block at all is a
  // machine that was not talking.
  const byBucket = new Map(blocks.rows.map((row) => [new Date(row.bucket).getTime(), row]));
  const timeline: DayFacts['timeline'] = [];
  for (let at = start.getTime(); at < end.getTime(); at += 300_000) {
    const row = byBucket.get(at);
    if (!row) {
      timeline.push('offline');
      continue;
    }
    const producing = Number(row.producing);
    const idle = Number(row.idle);
    const manual = Number(row.manual);
    const known = producing + idle + manual;
    timeline.push(
      known < 60
        ? 'offline'
        : producing >= idle && producing >= manual
          ? 'producing'
          : manual > idle
            ? 'manual'
            : 'idle',
    );
  }

  const days = history.rows
    .map((row) => ({
      date: row.date,
      made: inMetric(metric, {
        pieces: Number(row.pieces),
        pallets: Number(row.pallets),
        tons: Number(row.tons),
      }),
      producing: Number(row.producing),
      time: {
        producing: Number(row.producing),
        idle: Number(row.idle),
        manual: Number(row.manual),
        offline: Number(row.offline),
      },
    }))
    .filter((day) => day.made > 0);
  const recent = days.slice(-AVERAGE_DAYS);
  const average = recent.length
    ? {
        made: recent.reduce((sum, day) => sum + day.made, 0) / recent.length,
        // Over the shift's time, stops included, as the board's pace is: over the producing time
        // alone the average came out higher than any real day and the pace was always red.
        pacePerHour:
          recent.reduce((sum, day) => sum + day.made, 0) /
          Math.max(
            1,
            recent.reduce((sum, day) => sum + day.time.producing + day.time.idle + day.time.manual + day.time.offline, 0) /
              3600,
          ),
        utilization: (() => {
          const values = recent
            .map((day) => utilizationFrom(board.utilizationFormula, day.time))
            .filter((value): value is number => value != null);
          return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        })(),
        stoppedSeconds:
          recent.reduce((sum, day) => sum + day.time.idle + day.time.manual + day.time.offline, 0) /
          recent.length,
      }
    : null;
  // Each shift on its own, from the same five-minute blocks, when the day has more than one.
  const perShift =
    occurrences.length > 1
      ? await Promise.all(
          occurrences.map(async (occurrence) => {
            const row = (
              await db.query<{ pieces: string; pallets: string; tons: string }>(
                `SELECT coalesce(sum(pieces),0) pieces,coalesce(sum(pallets),0) pallets,coalesce(sum(tons),0) tons
                 FROM production_buckets WHERE device_id=$1 AND bucket >= $2 AND bucket < $3`,
                [device.id, occurrence.start, occurrence.end],
              )
            ).rows[0];
            return {
              name: occurrence.name,
              span: `${plantClock(occurrence.start)}–${plantClock(occurrence.end)}`,
              made: inMetric(metric, {
                pieces: Number(row.pieces),
                pallets: Number(row.pallets),
                tons: Number(row.tons),
              }),
              // The day's target is the sum of its shifts' targets.
              target: board.target ? board.target.value / occurrences.length : null,
            };
          }),
        )
      : [];
  // Monday of this week.
  const monday = addDays(date, -((dayOfWeek(date) + 6) % 7));
  const overtimeRow = extra.rows[0];
  return {
    name: device.name,
    dashboardId: device.dashboard_id,
    date,
    shifts: `${occurrences.length > 1 ? `${occurrences.length} turnos` : 'turno'} · ${plantClock(start)} às ${plantClock(end)}`,
    firstHour: Number(plantClock(start).slice(0, 2)),
    lastHour: Number(plantClock(new Date(end.getTime() - 60_000)).slice(0, 2)),
    metric,
    made,
    milheiros: board.totals.milheiros,
    pallets: board.totals.pallets,
    tons: board.totals.tons,
    target: board.target?.value ?? null,
    perShift,
    overtime: inMetric(metric, {
      pieces: Number(overtimeRow.pieces),
      pallets: Number(overtimeRow.pallets),
      tons: Number(overtimeRow.tons),
    }),
    utilization: board.utilization,
    pacePerHour: board.pacePerHour,
    stoppedSeconds: board.time.idle + board.time.manual + board.time.offline,
    reasons: { idle: board.time.idle, manual: board.time.manual, offline: board.time.offline },
    timelineStart: start.toISOString(),
    timeline,
    stopList: [...counted]
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((stop) => ({ at: plantClock(stop.start), seconds: stop.seconds, state: stop.state, open: stop.open })),
    topStops: counted.slice(0, 12).map((stop) => ({
      at: plantClock(stop.start),
      seconds: stop.seconds,
      state: stop.state,
    })),
    stops: counted.length,
    microStops: merged.length - counted.length,
    longestStop: counted[0] ? { seconds: counted[0].seconds, at: plantClock(counted[0].start) } : null,
    curve: board.curve.map((point) => ({ t: point.t, planned: point.planned, actual: point.actual })),
    hours: hourly.rows.map((row) => ({
      hour: Number(row.hour_of_day),
      made: inMetric(metric, {
        pieces: Number(row.pieces),
        pallets: Number(row.pallets),
        tons: Number(row.tons),
      }),
      stopped: Number(row.stopped),
    })),
    previous: days.length ? { date: days.at(-1)!.date, made: days.at(-1)!.made } : null,
    week: [...days.filter((day) => day.date >= monday), { date, made }].map((day) => ({
      date: day.date,
      made: day.made,
    })),
    average,
  };
}

// ---------------------------------------------------------------------------------------------
// Writing (pure)
// ---------------------------------------------------------------------------------------------
//
// Measured on a WhatsApp bubble 360 px wide (the narrowest common phone): every line fits on one
// row, the small bars sit inside `code` so they draw in a monospace font that has them, and the
// link stands alone on its line.

const num = (value: number, decimals = 0) =>
  value.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${String(rest).padStart(2, '0')}` : `${hours}h`;
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const dayLabel = (date: string) => `${capital(WEEKDAYS[dayOfWeek(date)])}, ${date.slice(8, 10)}/${date.slice(5, 7)}`;
const bar = (share: number) => {
  const filled = Math.max(0, Math.min(10, Math.round(share * 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
};
const hourLabel = (hour: number) => `${String(hour % 24).padStart(2, '0')}h`;
/** Small bars ▁▂▃▄▅▆▇█, scaled to the largest value. */
export function spark(values: number[]) {
  const top = Math.max(...values, 0);
  return values
    .map((value) => (top > 0 ? BARS[Math.min(7, Math.round((value / top) * 7))] : BARS[0]))
    .join('');
}
/** 🟢 at or better than the average, 🟡 a little worse, 🔴 clearly worse. */
function light(value: number | null, average: number | null | undefined, higherIsBetter: boolean) {
  if (value == null || average == null || average <= 0) return '⚪';
  const ratio = higherIsBetter ? value / average : average / Math.max(value, 1);
  return ratio >= 1 ? '🟢' : ratio >= 0.9 ? '🟡' : '🔴';
}
const short = (name: string) => name.replace(/^cer[aâ]mica\s+/i, '');

/** The writing pieces the WhatsApp assistant's answers share with this summary (assistant-answers.ts). */
export const fmt = { UNITS, WEEKDAYS, num, duration, dayLabel, bar, hourLabel, light, short };

/** The sentence about what made the day, by rule. */
export function highlight(f: DayFacts) {
  const units = UNITS[f.metric] ?? UNITS.pallets;
  const sentences: string[] = [];
  const share = f.target ? f.made / f.target : null;
  const others = f.week.filter((day) => day.date !== f.date);
  if (others.length >= 2 && f.made > Math.max(...others.map((day) => day.made)))
    sentences.push('Melhor dia da semana.');
  const stopped = f.hours.reduce((sum, hour) => sum + hour.stopped, 0);
  const afternoon = f.hours.filter((hour) => hour.hour >= 13).reduce((sum, hour) => sum + hour.stopped, 0);
  if (share != null && share < 1 && f.longestStop && f.longestStop.seconds >= 15 * 60 && f.pacePerHour > 0) {
    const cost = (f.longestStop.seconds / 3600) * f.pacePerHour;
    const gap = f.target! - f.made;
    sentences.push(
      `A parada de ${duration(f.longestStop.seconds)} às ${f.longestStop.at} custou cerca de ${num(cost, units.decimals)} ${units.unit}${
        cost >= gap * 0.8 ? ', quase toda a diferença para a meta' : `, ${Math.round((cost / gap) * 100)}% do que faltou para a meta`
      }.`,
    );
  } else if (stopped >= 30 * 60 && afternoon / stopped >= 0.6)
    sentences.push(`A tarde perdeu ritmo: ${Math.round((afternoon / stopped) * 100)}% do tempo parado foi depois das 13h.`);
  else if (stopped >= 30 * 60 && afternoon / stopped <= 0.4)
    sentences.push(`A manhã concentrou as paradas: ${Math.round(((stopped - afternoon) / stopped) * 100)}% do tempo parado foi antes das 13h.`);
  if (!sentences.length && f.hours.length) {
    const best = [...f.hours].sort((a, b) => b.made - a.made)[0];
    sentences.push(`O pico foi às ${hourLabel(best.hour)}, com ${num(best.made, units.decimals)} ${units.unit}.`);
  }
  return sentences.join(' ');
}

/** The first line: the machine, what it made and the share of the target; the lock screen shows it. */
export function headline(f: DayFacts) {
  const units = UNITS[f.metric] ?? UNITS.pallets;
  const d = units.decimals;
  if (!f.target) return `📦 *${short(f.name)} · ${num(f.made, d)} ${units.unit}*`;
  const share = f.made / f.target;
  const pct = Math.round(share * 100);
  if (share >= 1) return `🟢 *${short(f.name)} · ${num(f.made, d)} ${units.unit} · ${pct}%*`;
  return `${share >= 0.9 ? '🟡' : '🔴'} *${short(f.name)} · ${num(f.made, d)} de ${num(f.target, d)} · ${pct}%*`;
}

/** What the target came to, said in words under the headline. */
function verdict(f: DayFacts) {
  if (!f.target) return '';
  const units = UNITS[f.metric] ?? UNITS.pallets;
  if (f.made >= f.target) return ' · meta batida ✅';
  return ` · faltaram ${num(f.target - f.made, units.decimals)} ${units.unit}`;
}

/** The short link to the machine's panel (apps/web/app/p/[code]). */
export function panelLink(web: string, dashboardId: string | null) {
  return dashboardId ? `${web.replace(/^https?:\/\//, '')}/p/${dashboardId.slice(0, 8)}` : null;
}

/** Between the sections of a machine. */
export const RULE = '_'.repeat(52);
/** Around each machine's headline. */
export const FRAME = '#'.repeat(37);

/** One machine's whole day, framed: what the summary sends for one machine, and the assistant for a day. */
export function composeDay(f: DayFacts, link: string | null) {
  return [FRAME, headline(f), FRAME, '', composeDevice(f, link)].join('\n');
}

/** One machine's body, under the headline. */
export function composeDevice(f: DayFacts, link: string | null) {
  const units = UNITS[f.metric] ?? UNITS.pallets;
  const d = units.decimals;
  const lines: string[] = [];

  lines.push('*RESUMO*', '', `> 📅 _${dayLabel(f.date)}_${verdict(f)}`);
  if (f.target) lines.push(`> 🎯 Meta ${num(f.target, d)}   ${bar(f.made / f.target)}  *${Math.round((f.made / f.target) * 100)}%*`);
  lines.push(`> 🕐 ${f.shifts}`);
  if (f.previous && f.previous.made > 0) {
    const change = Math.round((f.made / f.previous.made - 1) * 100);
    lines.push(
      `> ${change >= 0 ? '📈' : '📉'} ${change >= 0 ? '+' : '−'}${Math.abs(change)}% sobre ${WEEKDAYS[dayOfWeek(f.previous.date)]} (${num(f.previous.made, d)})`,
    );
  }
  if (f.overtime > 0) lines.push(`> ➕ ${num(f.overtime, d)} ${units.unit} após o turno`);
  lines.push('', RULE, '');

  lines.push('*PRODUÇÃO*', '');
  for (const shift of f.perShift) {
    const share = shift.target ? ` · ${Math.round((shift.made / shift.target) * 100)}%` : '';
    // Padded so the dots line up with the total's under a proportional font, near enough.
    lines.push(`🔹 ${shift.name.padEnd(16)}· *${num(shift.made, d)}* ${units.unit}${share}`);
  }
  lines.push(`📋 Total do dia  ·  *${num(f.made, d)} ${units.unit}*`);
  const also = [
    f.metric !== 'pallets' && f.pallets ? `*${num(f.pallets)}* paletes` : '',
    f.metric !== 'milheiros' && f.milheiros ? `*${num(f.milheiros, 1)}* milheiros` : '',
    f.metric !== 'tons' && f.tons ? `*${num(f.tons, 1)}* t` : '',
  ].filter(Boolean);
  if (also.length) lines.push(`        ↳ 🧱${also.join(' · ')}`);
  lines.push('', RULE, '');

  lines.push('*MÁQUINA*', '');
  const best = f.hours.length ? [...f.hours].sort((a, b) => b.made - a.made)[0] : null;
  if (f.utilization != null)
    lines.push(
      `${light(f.utilization, f.average?.utilization, true)} Aproveitamento  - *${Math.round(f.utilization * 100)}%*${
        f.average?.utilization != null ? ` · média ${Math.round(f.average.utilization * 100)}%` : ''
      }`,
    );
  lines.push(
    `${light(f.pacePerHour, f.average?.pacePerHour, true)} Ritmo - *${num(f.pacePerHour, d)} ${units.per}*${
      best && best.made > 0 ? ` · pico ${hourLabel(best.hour)} (${num(best.made, d)})` : ''
    }`,
  );
  lines.push(
    `${light(f.stoppedSeconds, f.average?.stoppedSeconds, false)} Parada - *${duration(f.stoppedSeconds)}*${
      f.average ? ` · média ${duration(f.average.stoppedSeconds)}` : ''
    }`,
  );
  lines.push(
    `     ↳ ${f.stops} parada${f.stops === 1 ? '' : 's'}${
      f.longestStop ? ` · maior: ${duration(f.longestStop.seconds)} (${f.longestStop.at})` : ''
    }`,
  );
  if (f.microStops > 0)
    lines.push(`     ↳ +${f.microStops} microparada${f.microStops === 1 ? '' : 's'} (menos de 3 min)`);

  if (f.hours.length >= 3) {
    // The whole shift, hours with nothing recorded included: a stopped afternoon must show.
    const first = f.firstHour;
    const last = f.lastHour >= f.firstHour ? f.lastHour : f.lastHour + 24;
    const series: number[] = [];
    for (let hour = first; hour <= last; hour += 1) series.push(f.hours.find((h) => h.hour === hour % 24)?.made ?? 0);
    lines.push('', RULE, '', '*AO LONGO DO DIA*', `\`${hourLabel(first)} ${spark(series)} ${hourLabel(last)}\``);
  }
  const sentence = highlight(f);
  if (sentence) lines.push('', f.target && f.made < f.target ? '*ONDE PERDEU*' : '*DESTAQUE DO DIA*', `> ${sentence}`);
  if (link) lines.push('', '🔗 Painel do dia:', link);
  return lines.join('\n');
}

/** The whole message: one machine, or a ranking and then each machine. */
export function composeMessage(days: DayFacts[], web: string, kind: 'daily' | 'test') {
  const parts: string[] = [];
  if (kind === 'test') parts.push('🔔 _Mensagem de teste_', '');
  if (days.length === 1) {
    parts.push(composeDay(days[0], panelLink(web, days[0].dashboardId)));
    return parts.join('\n');
  }
  const ranked = [...days].sort((a, b) => (b.target ? b.made / b.target : 0) - (a.target ? a.made / a.target : 0));
  const medals = ['🥇', '🥈', '🥉'];
  parts.push(`📊 *Fechamento de ${dayLabel(days[0].date).toLowerCase()}*`, '');
  ranked.forEach((f, index) => {
    const units = UNITS[f.metric] ?? UNITS.pallets;
    const share = f.target ? ` · ${Math.round((f.made / f.target) * 100)}%` : '';
    parts.push(`${medals[index] ?? '▫️'} *${short(f.name)}* · ${num(f.made, units.decimals)} ${units.unit}${share}`);
  });
  for (const f of days) parts.push('', composeDay(f, panelLink(web, f.dashboardId)));
  return parts.join('\n');
}
