'use client';

import { useEffect, useState } from 'react';

/**
 * True while a chart is being drawn for the first time, false ever after.
 *
 * The charts carry `isAnimationActive={false}` for a good reason: a panel refreshes every two
 * seconds, and a line that redraws itself from zero on every refresh is unreadable. But the
 * first draw is different -- it tells the reader the card has finished loading and where the
 * line came from -- so the flag starts true and is turned off once, after the one animation.
 *
 * The cards of a tab are mounted when that tab opens and unmounted when it closes, so this
 * resets by itself on every tab change without anything having to notice the tab.
 */
export function useFirstDraw(ready: boolean = true, ms = 700) {
  const [drawing, setDrawing] = useState(true);
  useEffect(() => {
    // Counting from the mount was wrong: the data arrives a second or two later and the
    // window had already closed, so the chart never drew itself. It starts when there is
    // something to draw.
    if (!ready) return undefined;
    const timer = setTimeout(() => setDrawing(false), ms);
    return () => clearTimeout(timer);
  }, [ready, ms]);
  return drawing;
}
