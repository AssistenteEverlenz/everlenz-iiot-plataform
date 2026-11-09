'use client';

import { useEffect, useRef } from 'react';

// Where a screen confuses, for Everlenz to read from the database (migration 056, skill PNL).
// useUsageBeat counts the minutes; this records the moments in between:
//   screen          time spent on a page before leaving it
//   click           the control used (its name, never a value: the API masks digits)
//   repeat          3 clicks in 0.8 s on one spot: something looked clickable or was slow
//   dead            a click on a card where nothing reacts: the person expected an action
//   modal           a window closed in under 2 s without saving: the wrong way in
//   form_abandoned  typed in a window and closed it without saving
//   empty_search    a search that found nothing (useEmptySearch, from the page that knows)
//   error           a script error the person met without knowing
// Never what was typed. TV boards on a wall have nobody in front of them and are skipped.
// Sent in batches; a batch that cannot be sent is lost, which costs nothing.

type Kind =
  'screen' | 'click' | 'repeat' | 'dead' | 'modal' | 'form_abandoned' | 'empty_search' | 'error';
interface UsageEvent {
  kind: Kind;
  path: string;
  target: string | null;
  ms: number | null;
}

const FLUSH_MS = 15_000;
const FLUSH_AT = 20;
const REPEAT_MS = 800;
const REPEAT_PX = 30;
const QUICK_CLOSE_MS = 2_000;
const INTERACTIVE =
  'a,button,input,select,textarea,label,summary,option,[role=button],[role=tab],[role=link],[role=checkbox],[role=switch],[role=menuitem],[data-usage]';
const CANCEL = /^(cancelar|fechar|voltar|sair|não|nao|agora não|×|x|✕)$/i;
/**
 * A click worth keeping: a named control. Closing a window, the TV "touch to open" cover and a
 * card whose text is mostly figures ("12x30x2,5 kg") say nothing about how the platform is used.
 * Same rule as meaningfulClick in the API, which also hides what was recorded before.
 */
const worthCounting = (label: string) =>
  !CANCEL.test(label) &&
  !/^ok$/i.test(label) &&
  !/^toque em qualquer lugar/i.test(label) &&
  /\p{L}{3,}/u.test(label.replace(/\d/g, ''));

const state = {
  on: false,
  path: '',
  queue: [] as UsageEvent[],
  session: '',
};

function deviceKind(path: string) {
  if (/\/tv$/.test(path)) return 'tv';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  return coarse && window.innerWidth < 900 ? 'mobile' : 'desktop';
}

function flush() {
  const events = state.queue.splice(0);
  if (!events.length) return;
  void fetch('/api/usage/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: state.session, device: deviceKind(state.path), events }),
    keepalive: true,
  }).catch(() => undefined);
}

function push(kind: Kind, target?: string | null, ms?: number | null, path = state.path) {
  if (!state.on || !path || /\/tv$/.test(path)) return;
  state.queue.push({
    kind,
    path,
    target: target ? target.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
    ms: ms == null ? null : Math.max(0, Math.round(ms)),
  });
  if (state.queue.length >= FLUSH_AT) flush();
}

const short = (text: string | null | undefined) =>
  (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** A control's name as the person reads it: its own label, never what was typed into it. */
function labelOf(element: Element): string {
  const html = element as HTMLElement;
  const explicit =
    html.dataset?.usage || element.getAttribute('aria-label') || element.getAttribute('title');
  if (explicit) return short(explicit);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const kind = element instanceof HTMLInputElement ? element.type : 'textarea';
    const name =
      element.labels?.[0]?.textContent || element.getAttribute('placeholder') || element.name;
    return short(`${kind}: ${name ?? ''}`);
  }
  if (element instanceof HTMLSelectElement) {
    return short(`select: ${element.labels?.[0]?.textContent ?? element.name ?? ''}`);
  }
  const text = short(element.textContent);
  return text || describe(element);
}

/** For something with no name: its tag and first class, and the card it sits in. */
function describe(element: Element): string {
  // The first class that says something ("card" alone does not); the API masks digits, so a
  // heading tag is named in words.
  const cls = (el: Element) =>
    (el.getAttribute('class') ?? '')
      .trim()
      .split(/\s+/)
      .find((name) => name && name !== 'card') ?? '';
  const tag = /^H\d$/.test(element.tagName) ? 'título' : element.tagName.toLowerCase();
  const own = `${tag}${cls(element) ? `.${cls(element)}` : ''}`;
  const card = element.closest('.card');
  if (!card) return own;
  const heading = card.querySelector('h1,h2,h3,h4,.shift-section-title,.card-title,.eyebrow');
  const where = short(heading?.textContent).slice(0, 40) || (cls(card) ? `.${cls(card)}` : 'card');
  return card === element ? `card ${where}` : `${own} em ${where}`;
}

/** Clickable by its looks even without being a button (a row with onClick, a chart bar). */
function looksClickable(element: Element) {
  let node: Element | null = element;
  for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
    if (getComputedStyle(node).cursor === 'pointer') return node;
  }
  return null;
}

export function useUsageEvents(enabled: boolean, pathname: string) {
  // When the current page came on screen; null once its time is recorded, so leaving the page
  // (pagehide, then visibilitychange) or hiding the tab records it once.
  const shownSince = useRef<number | null>(Date.now());
  const closeScreen = (path = state.path) => {
    if (shownSince.current == null) return;
    push('screen', null, Date.now() - shownSince.current, path);
    shownSince.current = null;
  };

  // A page change closes the time on the previous one.
  useEffect(() => {
    if (!enabled) return;
    const previous = state.path;
    if (previous && previous !== pathname) closeScreen(previous);
    state.path = pathname;
    shownSince.current = document.visibilityState === 'visible' ? Date.now() : null;
    // closeScreen only reads refs and module state, so it is not a dependency.
  }, [enabled, pathname]);

  useEffect(() => {
    if (!enabled) return undefined;
    state.on = true;
    state.session ||=
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `00000000-0000-4000-8000-${String(Date.now()).padStart(12, '0').slice(-12)}`;
    let clicks: Array<{ t: number; x: number; y: number }> = [];
    let lastLabel = '';
    let modal: { opener: string; at: number; typed: boolean; sent: boolean } | null = null;

    const onClick = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      if (!element) return;
      const now = Date.now();
      clicks = clicks.filter(
        (c) =>
          now - c.t < REPEAT_MS &&
          Math.abs(c.x - event.clientX) < REPEAT_PX &&
          Math.abs(c.y - event.clientY) < REPEAT_PX,
      );
      clicks.push({ t: now, x: event.clientX, y: event.clientY });

      const control = element.closest(INTERACTIVE);
      const clickable = control ?? looksClickable(element);
      const label = clickable ? labelOf(clickable) : describe(element);
      if (clicks.length === 3) push('repeat', label);

      if (control) {
        lastLabel = label;
        const disabled =
          (control as HTMLButtonElement).disabled ||
          control.getAttribute('aria-disabled') === 'true';
        if (
          modal &&
          control.closest('.modal-backdrop') &&
          (control.closest('.modal-actions') || control.getAttribute('type') === 'submit') &&
          !CANCEL.test(label) &&
          !disabled
        )
          modal.sent = true;
        if (worthCounting(label)) push('click', disabled ? `${label} (desativado)` : label);
      } else if (clickable) {
        lastLabel = label;
        if (worthCounting(label)) push('click', label);
      } else if (
        element.closest('.card') &&
        !element.closest('.modal-backdrop') &&
        (window.getSelection()?.isCollapsed ?? true)
      ) {
        push('dead', label);
      }
    };

    const onInput = (event: Event) => {
      if (modal && event.target instanceof Element && event.target.closest('.modal-backdrop'))
        modal.typed = true;
    };
    const onSubmit = (event: Event) => {
      if (modal && event.target instanceof Element && event.target.closest('.modal-backdrop'))
        modal.sent = true;
    };

    // A window is open while a .modal-backdrop is on the page, wherever it was rendered.
    let open = Boolean(document.querySelector('.modal-backdrop'));
    let pending = false;
    const checkModal = () => {
      pending = false;
      const now = Boolean(document.querySelector('.modal-backdrop'));
      if (now === open) return;
      open = now;
      if (now) {
        modal = { opener: lastLabel, at: Date.now(), typed: false, sent: false };
        return;
      }
      const closed = modal;
      modal = null;
      if (!closed || closed.sent) return;
      if (closed.typed) push('form_abandoned', closed.opener);
      else if (Date.now() - closed.at < QUICK_CLOSE_MS)
        push('modal', closed.opener, Date.now() - closed.at);
    };
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      queueMicrotask(checkModal);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const onError = (event: ErrorEvent) => push('error', String(event.message || 'erro'));
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { message?: string } | string | undefined;
      push('error', String((typeof reason === 'object' && reason?.message) || reason || 'erro'));
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        closeScreen();
        flush();
      } else shownSince.current = Date.now();
    };
    const onLeave = () => {
      closeScreen();
      flush();
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    const timer = window.setInterval(flush, FLUSH_MS);
    return () => {
      observer.disconnect();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.clearInterval(timer);
      flush();
      state.on = false;
    };
  }, [enabled]);
}

/**
 * A search that finds nothing means the person calls the thing by another name. Recorded once
 * the typing stops (1.5 s), with the list's name and how long the search was, never the words.
 */
export function useEmptySearch(list: string, query: string, results: number) {
  useEffect(() => {
    const letters = query.trim().length;
    if (!letters || results > 0) return undefined;
    // Digits are masked by the API, so the length goes as a word.
    const size = letters <= 3 ? 'curta' : letters <= 10 ? 'média' : 'longa';
    const timer = window.setTimeout(() => push('empty_search', `${list} · busca ${size}`), 1_500);
    return () => window.clearTimeout(timer);
  }, [list, query, results]);
}
