'use client';

import type { Adherence } from './ShiftAdherence';

/**
 * The shift of the day at a glance, in the panel's summary: the registered shift as a thin grey
 * lane (its pauses as gaps) and, under it on the same clock, the line as it really ran. Where the
 * real lane leaves the registered one by more than the tolerance it turns red (time the shift
 * lost: a late start, an early leave, a late return, an early end) or green (time it gained);
 * within the tolerance it keeps the accent. The headline says how the shift started; the times
 * themselves sit under it, small. The board's card keeps the full table (ShiftAdherence.tsx).
 */

type Kind = 'start' | 'out' | 'back' | 'end';
interface Mark {
  kind: Kind;
  planned: number;
  real: number | null;
}

const MINUTE = 60_000;
const clock = (at: number) =>
  new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const span = (minutes: number) =>
  minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`;
const time = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

/** Lost (−) or gained (+) minutes at one event, 0 within the tolerance. */
function effectOf(mark: Mark, tolerance: number) {
  if (mark.real == null) return null;
  const late = Math.round((mark.real - mark.planned) / MINUTE);
  if (late === 0 || Math.abs(late) <= tolerance) return 0;
  // A later start or return loses time; a later leave or end gains it.
  return mark.kind === 'start' || mark.kind === 'back' ? -late : late;
}

export function BriefingShift({
  adherence,
  tolerance,
  now,
}: {
  adherence: Adherence;
  tolerance: number;
  now: string;
}) {
  const nowAt = new Date(now).getTime();
  const blocks = adherence.blocks.map((block) => {
    const start = time(block.planned.start)!;
    const end = time(block.planned.end)!;
    const pauses = adherence.pauses
      .filter((pause) => time(pause.planned.start)! >= start && time(pause.planned.end)! <= end)
      .sort((a, b) => a.planned.start.localeCompare(b.planned.start));
    return { block, start, end, pauses };
  });
  if (!blocks.length) return null;

  // The clock the two lanes share: the registered shift, widened to where the line really was.
  const instants = blocks.flatMap(({ block, start, end }) =>
    [start, end, time(block.start), time(block.end), block.running ? nowAt : null].filter(
      (at): at is number => at != null,
    ),
  );
  const from = Math.min(...instants);
  const to = Math.max(...instants);
  const at = (instant: number) => `${((Math.min(Math.max(instant, from), to) - from) / (to - from)) * 100}%`;
  const width = (a: number, b: number) => `${((Math.min(b, to) - Math.max(a, from)) / (to - from)) * 100}%`;

  const planned: Array<[number, number]> = [];
  const real: Array<[number, number]> = [];
  const marks: Mark[] = [];
  for (const { block, start, end, pauses } of blocks) {
    // Registered: the shift with its pauses taken out.
    let cursor = start;
    for (const pause of pauses) {
      planned.push([cursor, time(pause.planned.start)!]);
      cursor = time(pause.planned.end)!;
    }
    planned.push([cursor, end]);
    marks.push({ kind: 'start', planned: start, real: time(block.start) });

    // Real: from the start that held, around each pause the line left for, to the end or now.
    let running = time(block.start);
    for (const pause of pauses) {
      const left = time(pause.start);
      if (!pause.ahead && left) {
        marks.push({ kind: 'out', planned: time(pause.planned.start)!, real: left });
        marks.push({ kind: 'back', planned: time(pause.planned.end)!, real: time(pause.end) });
        if (running != null && left > running) real.push([running, left]);
        running = time(pause.end);
      }
    }
    const stop = time(block.end) ?? (block.start ? Math.min(nowAt, to) : null);
    if (running != null && stop != null && stop > running) real.push([running, stop]);
    marks.push({ kind: 'end', planned: end, real: time(block.end) });
  }

  // The stretches between registered and real that count, painted on the real lane.
  const deviations = marks
    .map((mark) => ({ mark, effect: effectOf(mark, tolerance) }))
    .filter((item) => item.effect)
    .map(({ mark, effect }) => ({
      from: Math.min(mark.planned, mark.real!),
      to: Math.max(mark.planned, mark.real!),
      tone: (effect ?? 0) < 0 ? 'lost' : 'gained',
    }));

  // The headline: how the shift started.
  const first = marks[0];
  const firstEffect = effectOf(first, tolerance);
  const headline =
    first.real == null
      ? nowAt < first.planned + tolerance * MINUTE
        ? { tone: 'muted', text: `Começa às ${clock(first.planned)}` }
        : { tone: 'lost', text: `Ainda não começou · previsto ${clock(first.planned)}` }
      : firstEffect === 0
        ? { tone: 'good', text: `Começou no horário, às ${clock(first.real)}` }
        : (firstEffect ?? 0) < 0
          ? { tone: 'lost', text: `Começou ${span(-(firstEffect ?? 0))} atrasado` }
          : { tone: 'gained', text: `Começou ${span(firstEffect ?? 0)} antes` };

  const lost = marks.reduce((sum, mark) => sum + Math.min(0, effectOf(mark, tolerance) ?? 0), 0);
  const firstPause = blocks.flatMap((item) => item.pauses)[0];

  return (
    <section className="briefing-shift" aria-label="Turno previsto e real">
      <header>
        <span>Turno de hoje</span>
        <b className={headline.tone}>{headline.text}</b>
      </header>
      <div className="bs-lanes">
        <small>Previsto</small>
        <div className="bs-lane planned">
          {planned.map(([a, b]) => (
            <i key={a} style={{ left: at(a), width: width(a, b) }} />
          ))}
        </div>
        <small>Real</small>
        <div className="bs-lane real">
          {real.map(([a, b]) => (
            <i key={a} style={{ left: at(a), width: width(a, b) }} />
          ))}
          {deviations.map((item) => (
            <u key={`${item.from}-${item.tone}`} className={item.tone} style={{ left: at(item.from), width: width(item.from, item.to) }} />
          ))}
          {nowAt > from && nowAt < to && <em className="bs-now" style={{ left: at(nowAt) }} title={`Agora, ${clock(nowAt)}`} />}
        </div>
      </div>
      <div className="bs-facts">
        <span>
          Início <b>{first.real == null ? '—' : clock(first.real)}</b>
          <small>prev. {clock(first.planned)}</small>
        </span>
        {firstPause && (
          <span>
            Pausa{' '}
            <b>
              {firstPause.start ? clock(time(firstPause.start)!) : firstPause.ahead ? '—' : 'sem parar'}
              {firstPause.start && ` – ${firstPause.end ? clock(time(firstPause.end)!) : '…'}`}
            </b>
            <small>
              prev. {clock(time(firstPause.planned.start)!)} – {clock(time(firstPause.planned.end)!)}
            </small>
          </span>
        )}
        <span>
          Fim <b>{marks.at(-1)?.real == null ? '—' : clock(marks.at(-1)!.real!)}</b>
          <small>prev. {clock(marks.at(-1)!.planned)}</small>
        </span>
        {lost < 0 && (
          <span className="bs-lost">
            <b>{span(-lost)}</b>
            <small>perdidos nos horários{tolerance > 0 ? ` · tolerância ${tolerance} min` : ''}</small>
          </span>
        )}
      </div>
    </section>
  );
}
