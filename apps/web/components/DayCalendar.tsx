'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A month calendar that only lets a day with production be chosen.
 *
 * The browser's own date field cannot grey out a day, so it happily accepted a Sunday the
 * plant never ran and the board opened on nothing: no curve, no numbers, a message alone in
 * the middle of an empty card. Here the days that closed a report are the only ones that
 * answer a click, and the arrows stop at the first and the last of them.
 *
 * The sheet is drawn on the screen, not inside the card: a card hides what overflows it, so a
 * calendar opened near its right edge (the comparison's, last in the row) was cut in half. It
 * sits under the button, and moves left or above it when the screen has no room there.
 */
const SHEET_WIDTH = 252;
const GAP = 6;
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** "29/09 (seg)", the way a production date is read on the floor. */
export function dayLabel(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const at = new Date(year, month - 1, day);
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')} (${WEEKDAYS[at.getDay()]})`;
}

export function DayCalendar({
  value,
  available,
  onPick,
  placeholder = 'Escolher dia',
  title,
}: {
  value: string;
  /** The days that have a closed report, in any order. */
  available: string[];
  onPick: (date: string) => void;
  placeholder?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const days = useMemo(() => new Set(available), [available]);
  const sorted = useMemo(() => [...available].sort(), [available]);
  const first = sorted[0];
  const last = sorted.at(-1);
  // The month the calendar opens on: the chosen day, else the last one that produced.
  const [month, setMonth] = useState(() => (value || last || '').slice(0, 7));
  useEffect(() => {
    if (open) setMonth((value || last || '').slice(0, 7));
  }, [open, value, last]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!wrapper.current?.contains(target) && !sheet.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  // Placed from the button on every open, scroll and resize, so it follows a card that moves.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return undefined;
    }
    const measure = () => {
      const button = wrapper.current?.getBoundingClientRect();
      if (!button) return;
      const height = sheet.current?.offsetHeight ?? 320;
      const width = Math.min(SHEET_WIDTH, window.innerWidth - 16);
      const left = Math.max(8, Math.min(button.left, window.innerWidth - width - 8));
      const below = button.bottom + GAP;
      const top =
        below + height > window.innerHeight - 8 && button.top - GAP - height >= 8
          ? button.top - GAP - height
          : below;
      setPlace({ top, left });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, month]);

  const [year, monthIndex] = month ? month.split('-').map(Number) : [0, 0];
  const grid = useMemo(() => {
    if (!month) return [];
    const start = new Date(year, monthIndex - 1, 1);
    const total = new Date(year, monthIndex, 0).getDate();
    // The month starts on its own weekday, so the first row is padded to line the columns up.
    const cells: Array<string | null> = Array.from({ length: start.getDay() }, () => null);
    for (let day = 1; day <= total; day += 1) cells.push(iso(year, monthIndex - 1, day));
    return cells;
  }, [month, year, monthIndex]);

  const shift = (by: number) => {
    const at = new Date(year, monthIndex - 1 + by, 1);
    setMonth(`${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`);
  };
  const canGoBack = first != null && month > first.slice(0, 7);
  const canGoOn = last != null && month < last.slice(0, 7);

  return (
    <div className="day-calendar" ref={wrapper}>
      <button
        type="button"
        className={`day-calendar-trigger${value ? ' chosen' : ''}`}
        onClick={() => setOpen((was) => !was)}
        title={title}
        disabled={!available.length}
      >
        {value ? dayLabel(value) : available.length ? placeholder : 'sem dias fechados'}
      </button>
      {open &&
        createPortal(
        <div
          ref={sheet}
          className="day-calendar-sheet"
          role="dialog"
          aria-label="Escolher dia"
          style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
        >
          <div className="day-calendar-head">
            <button type="button" onClick={() => shift(-1)} disabled={!canGoBack} aria-label="Mês anterior">
              ‹
            </button>
            <strong>
              <b>{MONTHS[monthIndex - 1]}</b> de {year}
            </strong>
            <button type="button" onClick={() => shift(1)} disabled={!canGoOn} aria-label="Próximo mês">
              ›
            </button>
          </div>
          <div className="day-calendar-week">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div className="day-calendar-grid">
            {grid.map((date, index) =>
              date == null ? (
                <i key={`empty-${index}`} />
              ) : (
                <button
                  key={date}
                  type="button"
                  className={date === value ? 'active' : ''}
                  // A day the plant did not close has nothing to show, so it cannot be opened.
                  disabled={!days.has(date)}
                  title={days.has(date) ? undefined : 'sem produção fechada nesse dia'}
                  onClick={() => {
                    onPick(date);
                    setOpen(false);
                  }}
                >
                  {Number(date.slice(8))}
                </button>
              ),
            )}
          </div>
          <div className="day-calendar-foot">Só os dias com produção fechada podem ser abertos.</div>
        </div>,
          document.body,
        )}
    </div>
  );
}
