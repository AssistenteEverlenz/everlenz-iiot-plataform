'use client';

import { useEffect, useRef } from 'react';

// Tells the API once a minute that the platform is on this person's screen, for the master's
// usage page. Only while the tab is visible: a platform left in a hidden tab is not being used.
// "Active" means the page was touched in the last two minutes, so a screen left open on a desk
// counts as open but not as in use. Losing a report costs nothing, so errors are ignored.

const EVERY_MS = 60_000;
const ACTIVE_MS = 120_000;

function deviceKind(path: string) {
  if (/\/tv$/.test(path)) return 'tv';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  return coarse && window.innerWidth < 900 ? 'mobile' : 'desktop';
}

export function useUsageBeat(enabled: boolean, pathname: string) {
  const touched = useRef(Date.now());
  const path = useRef(pathname);
  path.current = pathname;

  useEffect(() => {
    if (!enabled) return undefined;
    const touch = () => {
      touched.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'pointermove'];
    for (const name of events) window.addEventListener(name, touch, { passive: true, capture: true });
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      void fetch('/api/usage/beat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: path.current,
          active: Date.now() - touched.current < ACTIVE_MS,
          device: deviceKind(path.current),
        }),
        keepalive: true,
      }).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, EVERY_MS);
    const shown = () => document.visibilityState === 'visible' && beat();
    document.addEventListener('visibilitychange', shown);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
      for (const name of events) window.removeEventListener(name, touch, { capture: true });
    };
  }, [enabled]);
}
