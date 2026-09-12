// Plant shift calendar. A shift is a weekly rule (weekdays, start, end, pauses); expanding it
// over dates gives the planned production windows the platform accounts against.
//
// Plant time is Brasília: Brazil has had no daylight saving time since 2019, so it is UTC-03:00
// all year and a fixed offset is exact. A shift that crosses midnight (22:00-06:00) belongs to
// the day it starts on. Times are multiples of 5 minutes so they line up with the 5-minute
// production buckets.

export const PLANT_UTC_OFFSET = '-03:00';
const PLANT_OFFSET_MS = -3 * 3600 * 1000;
export const BUCKET_SECONDS = 300;
const DAY_MS = 86400 * 1000;

export interface ShiftBreak {
  start: string;
  end: string;
}
export interface ShiftDefinition {
  id: string | null;
  name: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  start: string;
  end: string;
  breaks: ShiftBreak[];
}
export interface TimeWindow {
  start: Date;
  end: Date;
}
export interface ShiftOccurrence {
  shiftId: string | null;
  name: string;
  /** Plant date the shift belongs to (the day it starts). */
  productionDate: string;
  start: Date;
  end: Date;
  breaks: TimeWindow[];
  /** Shift span minus pauses, in seconds. */
  plannedSeconds: number;
}

/** Used while a plant has no shift registered. */
export const DEFAULT_SHIFTS: ShiftDefinition[] = [
  {
    id: null,
    name: 'Turno padrão',
    weekdays: [1, 2, 3, 4, 5],
    start: '07:00',
    end: '17:00',
    breaks: [],
  },
];

export const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function minutesOf(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function isValidShiftTime(time: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && minutesOf(time) % 5 === 0;
}

export function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Plant calendar date of an instant. */
export function plantDate(at: Date) {
  return new Date(at.getTime() + PLANT_OFFSET_MS).toISOString().slice(0, 10);
}

export function plantInstant(date: string, time: string) {
  return new Date(`${date}T${time}:00${PLANT_UTC_OFFSET}`);
}

export function weekdayOf(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function mergeWindows(windows: TimeWindow[]) {
  const sorted = [...windows].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: TimeWindow[] = [];
  for (const window of sorted) {
    const last = merged.at(-1);
    if (last && window.start.getTime() <= last.end.getTime()) {
      if (window.end.getTime() > last.end.getTime()) last.end = window.end;
    } else merged.push({ start: window.start, end: window.end });
  }
  return merged;
}

export function overlapSeconds(a: TimeWindow, b: TimeWindow) {
  const start = Math.max(a.start.getTime(), b.start.getTime());
  const end = Math.min(a.end.getTime(), b.end.getTime());
  return end > start ? (end - start) / 1000 : 0;
}

/** One shift rule on one date. Pauses outside the span are dropped (validation rejects them). */
export function occurrenceOf(shift: ShiftDefinition, date: string): ShiftOccurrence {
  const startMinutes = minutesOf(shift.start);
  const endMinutes = minutesOf(shift.end);
  const start = plantInstant(date, shift.start);
  const end = plantInstant(endMinutes > startMinutes ? date : addDays(date, 1), shift.end);
  // A time earlier than the shift start belongs to the next day (overnight shifts).
  const at = (time: string) =>
    plantInstant(minutesOf(time) >= startMinutes ? date : addDays(date, 1), time);
  const breaks = mergeWindows(
    shift.breaks
      .map((pause) => {
        const breakStart = at(pause.start);
        let breakEnd = at(pause.end);
        if (breakEnd.getTime() <= breakStart.getTime())
          breakEnd = new Date(breakEnd.getTime() + DAY_MS);
        return {
          start: new Date(Math.max(breakStart.getTime(), start.getTime())),
          end: new Date(Math.min(breakEnd.getTime(), end.getTime())),
        };
      })
      .filter((pause) => pause.end.getTime() > pause.start.getTime()),
  );
  const pauseSeconds = breaks.reduce(
    (total, pause) => total + (pause.end.getTime() - pause.start.getTime()) / 1000,
    0,
  );
  return {
    shiftId: shift.id,
    name: shift.name,
    productionDate: date,
    start,
    end,
    breaks,
    plannedSeconds: Math.round((end.getTime() - start.getTime()) / 1000 - pauseSeconds),
  };
}

/** Every shift occurrence whose production date lies in [fromDate, toDate], by start time. */
export function expandShifts(shifts: ShiftDefinition[], fromDate: string, toDate: string) {
  const occurrences: ShiftOccurrence[] = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    for (const shift of shifts)
      if (shift.weekdays.includes(weekday)) occurrences.push(occurrenceOf(shift, date));
  }
  return occurrences.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** The shift span without its pauses. */
export function productiveWindows(occurrence: ShiftOccurrence): TimeWindow[] {
  const windows: TimeWindow[] = [];
  let cursor = occurrence.start;
  for (const pause of occurrence.breaks) {
    if (pause.start.getTime() > cursor.getTime()) windows.push({ start: cursor, end: pause.start });
    cursor = pause.end;
  }
  if (occurrence.end.getTime() > cursor.getTime())
    windows.push({ start: cursor, end: occurrence.end });
  return windows;
}

/** Planned (productive) seconds of the given windows that fall inside [from, to). */
export function productiveSecondsIn(windows: TimeWindow[], from: Date, to: Date) {
  return windows.reduce(
    (total, window) => total + overlapSeconds(window, { start: from, end: to }),
    0,
  );
}

/**
 * Rejects what would make the accounting wrong: bad times, empty weekdays, pauses outside the
 * shift or overlapping each other, and two shifts covering the same moment.
 */
export function validateShifts(shifts: ShiftDefinition[]): string | null {
  for (const shift of shifts) {
    const label = `Turno "${shift.name || 'sem nome'}"`;
    if (!shift.name.trim()) return 'Todo turno precisa de um nome.';
    if (!shift.weekdays.length) return `${label}: escolha pelo menos um dia da semana.`;
    if (!isValidShiftTime(shift.start) || !isValidShiftTime(shift.end))
      return `${label}: use horários em múltiplos de 5 minutos (ex.: 07:00, 17:30).`;
    if (shift.start === shift.end) return `${label}: início e fim não podem ser iguais.`;
    const occurrence = occurrenceOf({ ...shift, breaks: [] }, '2026-01-05');
    const pauses: TimeWindow[] = [];
    for (const pause of shift.breaks) {
      if (!isValidShiftTime(pause.start) || !isValidShiftTime(pause.end))
        return `${label}: pausas em múltiplos de 5 minutos.`;
      const single = occurrenceOf({ ...shift, breaks: [pause] }, '2026-01-05').breaks[0];
      const expected = ((minutesOf(pause.end) - minutesOf(pause.start) + 1440) % 1440) * 60;
      if (
        !single ||
        (single.end.getTime() - single.start.getTime()) / 1000 !== expected ||
        expected === 0
      )
        return `${label}: a pausa ${pause.start}–${pause.end} precisa ficar dentro do horário do turno.`;
      if (pauses.some((other) => overlapSeconds(other, single) > 0))
        return `${label}: pausas sobrepostas.`;
      pauses.push(single);
    }
    if (occurrence.end.getTime() - occurrence.start.getTime() <= 0)
      return `${label}: horário inválido.`;
  }
  // Two weeks of occurrences cover every weekday pair, including overnight spill-over.
  const occurrences = expandShifts(shifts, '2026-01-04', '2026-01-17');
  for (let index = 1; index < occurrences.length; index += 1) {
    const previous = occurrences[index - 1];
    const current = occurrences[index];
    if (current.start.getTime() < previous.end.getTime())
      return `Os turnos "${previous.name}" e "${current.name}" se sobrepõem em ${
        WEEKDAY_LABELS[weekdayOf(current.productionDate)]
      }.`;
  }
  return null;
}
