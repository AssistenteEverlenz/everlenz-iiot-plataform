'use client';

// The "i" beside a field label: the explanation shows on hover or keyboard focus, so the form
// stays short and the help is there when someone looks for it.

export function Hint({ text, align = 'center' }: { text: string; align?: 'center' | 'left' }) {
  return (
    <i
      className={`hint ${align === 'left' ? 'left' : ''}`}
      data-hint={text}
      tabIndex={0}
      role="note"
      aria-label={text}
    >
      i
    </i>
  );
}
