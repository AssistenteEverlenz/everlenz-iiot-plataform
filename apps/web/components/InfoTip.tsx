'use client';

/**
 * The "i" beside a figure: what it is and where it comes from, for whoever reads the page
 * without having built it. Opens on hover and on focus (tab or tap), so phones read it too.
 */
export function InfoTip({ text, align = 'center' }: { text: string; align?: 'center' | 'end' }) {
  return (
    <span
      className={`info-tip${align === 'end' ? ' end' : ''}`}
      tabIndex={0}
      role="note"
      aria-label={text}
      data-info={text}
    >
      i
    </span>
  );
}
