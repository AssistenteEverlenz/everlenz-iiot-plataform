/**
 * How a board names a shift that followed the line (effective-shifts.ts): by its registered
 * hours, with the hours really worked beside them when the line started before or kept going
 * after -- "Turno padrão · 07:00–17:00 · trabalhado 05:00–20:30".
 */
type WorkedOccurrence = {
  name: string;
  start: string;
  end: string;
  plannedStart?: string;
  plannedEnd?: string;
  extra?: boolean;
};

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });

/** The line is still in the stretch: the shift's end is now. */
const isNow = (end: string, now: string) =>
  Math.abs(new Date(end).getTime() - new Date(now).getTime()) < 90_000;

/** " · trabalhado 05:00–20:30" when the shifts were stretched, else nothing. */
export function workedNote(shifts: WorkedOccurrence[], now: string) {
  const stretched = shifts.some(
    (item) =>
      !item.extra &&
      item.plannedStart &&
      item.plannedEnd &&
      (item.start !== item.plannedStart || item.end !== item.plannedEnd),
  );
  if (!stretched || !shifts.length) return '';
  const start = shifts.reduce((first, item) => (item.start < first ? item.start : first), shifts[0].start);
  const end = shifts.reduce((last, item) => (item.end > last ? item.end : last), shifts[0].end);
  return ` · trabalhado ${hhmm(start)}–${isNow(end, now) ? 'agora' : hhmm(end)}`;
}

/** "Turno padrão · 07:00–17:00 · trabalhado 05:00–20:30", or the extra shift's own hours. */
export function shiftTitle(shift: WorkedOccurrence, now: string) {
  const start = shift.plannedStart ?? shift.start;
  const end = shift.plannedEnd ?? shift.end;
  if (shift.extra)
    return `${shift.name} · ${hhmm(shift.start)}–${isNow(shift.end, now) ? 'agora' : hhmm(shift.end)}`;
  return `${shift.name} · ${hhmm(start)}–${hhmm(end)}${workedNote([shift], now)}`;
}

/** The registered shift is over but the line kept producing: hours past the shift. */
export function inOvertime(shift: WorkedOccurrence | undefined, now: string) {
  return Boolean(
    shift &&
      !shift.extra &&
      shift.plannedEnd &&
      new Date(now).getTime() > new Date(shift.plannedEnd).getTime() &&
      isNow(shift.end, now),
  );
}
