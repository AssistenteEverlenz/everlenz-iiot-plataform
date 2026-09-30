'use client';

// The "i" beside a field label: the explanation shows on hover or keyboard focus, so the form
// stays short and the help is there when someone looks for it.
//
// The balloon is drawn in a portal, at fixed coordinates measured from the "i". As a child it
// was clipped by the first ancestor that scrolls -- inside a modal the top of every message
// was eaten by the card's own edge -- and no amount of z-index fixes that, because clipping
// happens before stacking.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 8;
const EDGE = 10;

export function Hint({ text, align = 'center' }: { text: string; align?: 'center' | 'left' }) {
  const anchor = useRef<HTMLElement>(null);
  const balloon = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number; below: boolean } | null>(null);

  // Measured after the balloon is in the document, so its real size decides the side it opens
  // to. Above by default; below when there is no room, which is what the top of a modal does.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !balloon.current) return;
    const mark = anchor.current.getBoundingClientRect();
    const size = balloon.current.getBoundingClientRect();
    const below = mark.top - size.height - GAP < EDGE;
    const left = Math.min(
      Math.max(EDGE, mark.left + mark.width / 2 - size.width / 2),
      window.innerWidth - size.width - EDGE,
    );
    setAt({
      top: below ? mark.bottom + GAP : mark.top - size.height - GAP,
      left,
      below,
    });
  }, [open, text]);

  // A balloon that stays behind while the page moves under it is worse than none.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <>
      <i
        ref={anchor}
        className={`hint${align === 'left' ? ' left' : ''}${open ? ' showing' : ''}`}
        tabIndex={0}
        role="note"
        aria-label={text}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        i
      </i>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={balloon}
            className={`hint-balloon${at?.below ? ' below' : ''}`}
            style={
              at
                ? { top: at.top, left: at.left, visibility: 'visible' }
                : { top: 0, left: 0, visibility: 'hidden' }
            }
            role="tooltip"
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
