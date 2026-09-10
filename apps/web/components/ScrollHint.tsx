'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

// A scroll area with no visible scrollbar. A subtle arrow appears only in a direction that
// still has content, and fades out at each end, so the frame keeps a fixed size however
// many items it holds. Clicking an arrow also scrolls, for screens without a wheel.
export function ScrollHint({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ up: false, down: false });

  useEffect(() => {
    const element = body.current;
    const inner = content.current;
    if (!element || !inner) return;
    const update = () =>
      setEdges({
        up: element.scrollTop > 2,
        down: element.scrollTop + element.clientHeight < element.scrollHeight - 2,
      });
    update();
    element.addEventListener('scroll', update, { passive: true });
    // Items arriving or leaving change the content height without any scroll event.
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(inner);
    return () => {
      element.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  const nudge = (direction: 1 | -1) =>
    body.current?.scrollBy({
      top: direction * body.current.clientHeight * 0.7,
      behavior: 'smooth',
    });

  return (
    <div className={`scroll-hint ${className}`}>
      <button
        type="button"
        className={`scroll-hint-arrow up ${edges.up ? 'visible' : ''}`}
        onClick={() => nudge(-1)}
        aria-label="Rolar para cima"
        tabIndex={edges.up ? 0 : -1}
      >
        <Chevron up />
      </button>
      <div ref={body} className="scroll-hint-body">
        <div ref={content}>{children}</div>
      </div>
      <button
        type="button"
        className={`scroll-hint-arrow down ${edges.down ? 'visible' : ''}`}
        onClick={() => nudge(1)}
        aria-label="Rolar para baixo"
        tabIndex={edges.down ? 0 : -1}
      >
        <Chevron />
      </button>
    </div>
  );
}

function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg width="14" height="8" viewBox="0 0 14 8" aria-hidden="true">
      <path
        d={up ? 'M1 7l6-6 6 6' : 'M1 1l6 6 6-6'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
