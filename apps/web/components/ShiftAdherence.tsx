'use client';

import { usePoll } from './data';

/**
 * "Turno previsto × real", under the machine's states on the production board: when the line
 * really started, left for and came back from each pause, and stopped, beside the registered
 * time and the difference. Exact times from the stop recorder (apps/api/src/shift-adherence.ts).
 *
 * No tolerance (the user, 2026-10-14): every difference is shown as it is. Red is time the
 * shift lost (a late start, an early leave, a late return, an early end); green is time it
 * gained; a pause the line ran through is said in words.
 */

interface Adherence {
  blocks: Array<{
    planned: { start: string; end: string };
    start: string | null;
    end: string | null;
    running: boolean;
  }>;
  pauses: Array<{
    planned: { start: string; end: string };
    start: string | null;
    end: string | null;
    open: boolean;
    ahead: boolean;
  }>;
}

interface Row {
  key: string;
  label: string;
  planned: string;
  /** The real time, or a word for what is happening instead. */
  real: string;
  realIsTime: boolean;
  /** Minutes the shift gained (+) or lost (−) at this event; null when not known yet. */
  effect: number | null;
  /** Minutes away from the registered time, as a clock reads it (later is +). */
  shift: number | null;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const minutesBetween = (real: string, planned: string) =>
  Math.round((new Date(real).getTime() - new Date(planned).getTime()) / 60000);
const signed = (minutes: number) => (minutes === 0 ? '0 min' : `${minutes > 0 ? '+' : '−'}${Math.abs(minutes)} min`);
const hours = (minutes: number) =>
  minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`;

export function rowsOf(data: Adherence): Row[] {
  const rows: Row[] = [];
  const several = data.blocks.length > 1;
  data.blocks.forEach((block, index) => {
    const tag = several ? ` ${index + 1}` : '';
    const late = block.start ? minutesBetween(block.start, block.planned.start) : null;
    rows.push({
      key: `start-${index}`,
      label: `Início${tag}`,
      planned: clock(block.planned.start),
      real: block.start ? clock(block.start) : 'aguardando',
      realIsTime: Boolean(block.start),
      // Starting late loses the shift time; starting early gains it.
      effect: late == null ? null : -late,
      shift: late,
    });
    const pauses = data.pauses.filter(
      (pause) => pause.planned.start >= block.planned.start && pause.planned.end <= block.planned.end,
    );
    pauses.forEach((pause, at) => {
      const name = pauses.length > 1 ? `Pausa ${at + 1}` : 'Pausa';
      if (pause.ahead) {
        rows.push({ key: `p${index}-${at}`, label: name, planned: `${clock(pause.planned.start)}–${clock(pause.planned.end)}`, real: 'a seguir', realIsTime: false, effect: null, shift: null });
        return;
      }
      if (!pause.start) {
        rows.push({ key: `p${index}-${at}`, label: name, planned: `${clock(pause.planned.start)}–${clock(pause.planned.end)}`, real: 'produziu direto', realIsTime: false, effect: null, shift: null });
        return;
      }
      const leave = minutesBetween(pause.start, pause.planned.start);
      rows.push({
        key: `p${index}-${at}-out`,
        label: `${name} · saída`,
        planned: clock(pause.planned.start),
        real: clock(pause.start),
        realIsTime: true,
        // Leaving for it later keeps the line running longer.
        effect: leave,
        shift: leave,
      });
      const back = pause.end ? minutesBetween(pause.end, pause.planned.end) : null;
      rows.push({
        key: `p${index}-${at}-in`,
        label: `${name} · volta`,
        planned: clock(pause.planned.end),
        real: pause.end ? clock(pause.end) : 'em pausa',
        realIsTime: Boolean(pause.end),
        effect: back == null ? null : -back,
        shift: back,
      });
    });
    const early = block.end ? minutesBetween(block.end, block.planned.end) : null;
    rows.push({
      key: `end-${index}`,
      label: `Fim${tag}`,
      planned: clock(block.planned.end),
      real: block.end ? clock(block.end) : block.running ? 'produzindo' : 'aguardando',
      realIsTime: Boolean(block.end),
      // Stopping before the end loses time; running past it is extra time.
      effect: early,
      shift: early,
    });
  });
  return rows;
}

export function ShiftAdherence({
  deviceId,
  date,
  span,
}: {
  deviceId: string;
  date: string;
  /** The shift (or day) the board shows: only its shifts are read. */
  span: { start: string; end: string };
}) {
  const data = usePoll<{ adherence: Adherence | null }>(
    `/devices/${deviceId}/shift-adherence?date=${date}&start=${encodeURIComponent(span.start)}&end=${encodeURIComponent(span.end)}`,
    60000,
  );
  const adherence = data.data?.adherence;
  if (!adherence?.blocks.length) return null;
  const rows = rowsOf(adherence);
  const lost = rows.reduce((sum, row) => sum + Math.min(0, row.effect ?? 0), 0);
  const gained = rows.reduce((sum, row) => sum + Math.max(0, row.effect ?? 0), 0);
  return (
    <div className="shift-adherence">
      <div className="shift-adherence-title">Turno previsto × real</div>
      <div className="shift-adherence-table" role="table" aria-label="Horários previstos e reais do turno">
        <div className="shift-adherence-head" role="row">
          <span role="columnheader">Evento</span>
          <span role="columnheader">Previsto</span>
          <span role="columnheader">Real</span>
          <span role="columnheader">Diferença</span>
        </div>
        {rows.map((row) => (
          <div key={row.key} className="shift-adherence-row" role="row">
            <span role="cell">{row.label}</span>
            <span role="cell" className="planned">{row.planned}</span>
            <b role="cell" className={row.realIsTime ? 'real' : 'real pending'}>{row.real}</b>
            <em
              role="cell"
              className={row.effect == null || row.effect === 0 ? 'even' : row.effect < 0 ? 'lost' : 'gained'}
              title={
                row.effect == null
                  ? undefined
                  : row.effect < 0
                    ? `${Math.abs(row.effect)} min de turno perdidos`
                    : row.effect > 0
                      ? `${row.effect} min a mais de turno`
                      : 'No horário'
              }
            >
              {row.shift == null ? '—' : signed(row.shift)}
            </em>
          </div>
        ))}
      </div>
      {(lost < 0 || gained > 0) && (
        <div className="shift-adherence-total">
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
