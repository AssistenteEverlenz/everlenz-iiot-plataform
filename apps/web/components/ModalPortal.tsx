'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A modal belongs to the screen, not to the card that opened it.
 *
 * Two things inside a card reach for it otherwise. The card hides what overflows it, and -- less
 * obviously -- a card that animates itself when it appears becomes the containing block of its
 * own fixed children, because an element with a transform animation always does. A modal
 * written inside the card then lands inside the card's frame and is cut by it. Rendering it
 * into the body puts it out of that reach whatever the card is doing.
 *
 * The flag is there because the body only exists in the browser: on the server the modal simply
 * is not drawn, which is right -- it is never open on a first render.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
