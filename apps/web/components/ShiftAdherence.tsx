'use client';

import { usePoll } from './data';

/**
 * "Turno previsto × real", under the machine's states on the production board: when the line
 * really started, left for and came back from each pause, and stopped, beside the registered
 * time and the difference. Exact times from the stop recorder (apps/api/src/shift-adherence.ts).
 * A start is production that holds, not the first blocks of adjusting the line; those are kept,
 * on hover.
 *
 * Every difference is shown as it is. Red is time the shift lost (a late start, an early leave, a
 * late return, an early end); green is time it gained; a pause the line ran through is said in
 * words. A difference within the machine's tolerance (migration 050, the pencil of the card; 0 by
 * default) is on time: shown in grey and left out of the totals. Past it, all of it counts.
 */

interface Adherence {
  blocks: Array<{
    planned: { start: string; end: string };
    start: string | null;
    firstBlocks: string | null;
    end: string | null;
    lastBlocks: string | null;
    running: boolean;
  }>;
  pauses: Array<{
    planned: { start: string; end: string };
    start: string | null;
    end: string | null;
    firstBlocks: string | null;
    open: boolean;
    ahead: boolean;
  }>;
}

interface Row {
  key: string;
  label: string;
  /** Always a time: the registered one. */
  planned: string;
  /** The real time; null while it has not happened. */
  real: string | null;
  /** Minutes the shift gained (+) or lost (−) at this event; null when not known yet. */
  effect: number | null;
  /** Minutes away from the registered time, as a clock reads it (later is +). */
  shift: number | null;
  /** A word for the difference column when there is no time to compare (a pause run through). */
  note?: string;
  /** Blocks that passed around it before production held (or after it ended), shown on hover. */
  hint?: string;
  /** Within the tolerance: shown, not counted. */
  tolerated?: boolean;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const minutesBetween = (real: string, planned: string) =>
  Math.round((new Date(real).getTime() - new Date(planned).getTime()) / 60000);
const signed = (minutes: number) => (minutes === 0 ? '0 min' : `${minutes > 0 ? '+' : '−'}${Math.abs(minutes)} min`);
const hours = (minutes: number) =>
  minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`;

/**
 * One row per event, every cell in its place: the registered time, the real time (a dash until
 * it happens) and the difference. A pause is always two rows, leaving and coming back, so the
 * columns hold times only and line up.
 */
export function rowsOf(data: Adherence, unitWord = 'blocos', tolerance = 0): Row[] {
  const rows: Row[] = [];
  // Inside the tolerance either way, a difference costs and gains nothing.
  const push = (row: Row) =>
    rows.push(
      tolerance > 0 && row.shift != null && row.shift !== 0 && Math.abs(row.shift) <= tolerance
        ? { ...row, effect: 0, tolerated: true }
        : row,
    );
  const several = data.blocks.length > 1;
  data.blocks.forEach((block, index) => {
    const tag = several ? ` ${index + 1}` : '';
    const late = block.start ? minutesBetween(block.start, block.planned.start) : null;
    // Starting late loses shift time; starting early gains it.
    push({
      key: `start-${index}`,
      label: `Início${tag}`,
      planned: clock(block.planned.start),
      real: block.start ? clock(block.start) : null,
      effect: late == null ? null : -late,
      shift: late,
      hint:
        block.firstBlocks && block.start
          ? `Primeiros ${unitWord} às ${clock(block.firstBlocks)} · ${minutesBetween(block.start, block.firstBlocks)} min de ajuste até a produção firme`
          : block.firstBlocks
            ? `Primeiros ${unitWord} às ${clock(block.firstBlocks)}, produção ainda não firme`
            : undefined,
    });
    const pauses = data.pauses.filter(
      (pause) => pause.planned.start >= block.planned.start && pause.planned.end <= block.planned.end,
    );
    pauses.forEach((pause, at) => {
      const name = pauses.length > 1 ? `Pausa ${at + 1}` : 'Pausa';
      // The line ran through the pause: there is no leaving or coming back to compare.
      const through = !pause.ahead && !pause.start;
      const leave = pause.start ? minutesBetween(pause.start, pause.planned.start) : null;
      const back = pause.end ? minutesBetween(pause.end, pause.planned.end) : null;
      push({
        key: `p${index}-${at}-out`,
        label: `${name} · saída`,
        planned: clock(pause.planned.start),
        real: pause.start ? clock(pause.start) : null,
        // Leaving for it later keeps the line running longer.
        effect: leave,
        shift: leave,
        note: through ? 'sem parar' : undefined,
      });
      push({
        key: `p${index}-${at}-in`,
        label: `${name} · volta`,
        planned: clock(pause.planned.end),
        real: pause.end ? clock(pause.end) : null,
        effect: back == null ? null : -back,
        shift: back,
        note: through ? 'sem parar' : undefined,
        hint:
          pause.firstBlocks && pause.end
            ? `Primeiros blocos às ${clock(pause.firstBlocks)} · produção firme a partir de ${clock(pause.end)}`
            : undefined,
      });
    });
    const early = block.end ? minutesBetween(block.end, block.planned.end) : null;
    // Stopping before the end loses time; running past it is extra time.
    push({
      key: `end-${index}`,
      label: `Fim${tag}`,
      planned: clock(block.planned.end),
      real: block.end ? clock(block.end) : null,
      effect: early,
      shift: early,
      hint: block.lastBlocks ? `Últimos blocos às ${clock(block.lastBlocks)}, depois da produção firme` : undefined,
    });
  });
  return rows;
}

export function ShiftAdherence({
  deviceId,
  date,
  span,
  source = 'shift-adherence',
  unitWord,
}: {
  deviceId: string;
  date: string;
  /** The shift (or day) the board shows: only its shifts are read. */
  span: { start: string; end: string };
  /** The route under the device that reads it: the ceramic board's, or the bagger's. */
  source?: string;
  /** What the line counts, for the hint on a start ("Primeiros sacos às…"). */
  unitWord?: string;
}) {
  const data = usePoll<{ adherence: Adherence | null; tolerance?: number }>(
    `/devices/${deviceId}/${source}?date=${date}&start=${encodeURIComponent(span.start)}&end=${encodeURIComponent(span.end)}`,
    60000,
  );
  const adherence = data.data?.adherence;
  if (!adherence?.blocks.length) return null;
  const tolerance = data.data?.tolerance ?? 0;
  const rows = rowsOf(adherence, unitWord, tolerance);
  const lost = rows.reduce((sum, row) => sum + Math.min(0, row.effect ?? 0), 0);
  const gained = rows.reduce((sum, row) => sum + Math.max(0, row.effect ?? 0), 0);
  return (
    <div className="shift-adherence">
      <div className="shift-adherence-table" role="table" aria-label="Turno previsto × real">
        <div className="shift-adherence-head" role="row">
          <span role="columnheader">Turno</span>
          <span role="columnheader">Previsto</span>
          <span role="columnheader">Real</span>
          <span role="columnheader">Dif.</span>
        </div>
        {rows.map((row) => (
          <div key={row.key} className="shift-adherence-row" role="row">
            <span role="cell">{row.label}</span>
            <span role="cell" className="planned">{row.planned}</span>
            <b role="cell" className={`${row.real ? 'real' : 'real pending'}${row.hint ? ' hinted' : ''}`} title={row.hint}>
              {row.real ?? '—'}
            </b>
            <em
              role="cell"
              className={row.tolerated ? 'even tolerated' : row.effect == null || row.effect === 0 ? 'even' : row.effect < 0 ? 'lost' : 'gained'}
              title={
                row.effect == null
                  ? undefined
                  : row.tolerated
                    ? `Dentro da tolerância de ${tolerance} min: não conta`
                    : row.effect < 0
                    ? `${Math.abs(row.effect)} min de turno perdidos`
                    : row.effect > 0
                      ? `${row.effect} min a mais de turno`
                      : 'No horário'
              }
            >
              {row.note ?? (row.shift == null ? '—' : signed(row.shift))}
            </em>
          </div>
        ))}
      </div>
      {(lost < 0 || gained > 0 || tolerance > 0) && (
        <div className="shift-adherence-total">
          {tolerance > 0 && <span className="tolerance">Tolerância de {tolerance} min</span>}
          {lost < 0 && (
            <span className="lost">
              <b>{hours(-lost)}</b> de turno perdidos nos horários
            </span>
          )}
          {gained > 0 && (
            <span className="gained">
              <b>{hours(gained)}</b> a mais
            </span>
          )}
        </div>
      )}
    </div>
  );
}
