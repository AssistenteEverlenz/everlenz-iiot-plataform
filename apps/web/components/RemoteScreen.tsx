'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { mutate } from './data';

// "Ver tela da IHM": the HMI's screen in the browser, full screen. The platform asks the API for
// a link that lasts a few minutes (apps/api/src/remote-view.ts) and opens the noVNC gateway in a
// frame that covers everything. Full screen is asked for by openRemoteFullscreen() inside the
// click itself, where browsers still count it as the person's gesture; iPhones, which have no
// full screen for pages, get the frame over the whole window instead. Leaving full screen (Esc,
// back gesture) closes the screen.

/** Call from the click that opens the screen, before any await. */
export function openRemoteFullscreen() {
  const root = document.documentElement;
  if (!root.requestFullscreen || document.fullscreenElement) return;
  root
    .requestFullscreen({ navigationUI: 'hide' })
    .then(() => {
      // An HMI is wider than tall: turn the phone, where the browser allows it.
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (value: string) => Promise<void>;
      };
      return orientation.lock?.('landscape');
    })
    .catch(() => undefined);
}

interface Session {
  url: string;
  mode: 'view' | 'control';
}

export function RemoteScreen({
  deviceId,
  deviceName,
  onClose,
}: {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');

  // The page behind must not scroll under the screen (phones without full screen).
  useLayoutEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    mutate<Session>(`/devices/${deviceId}/remote-session`, 'POST')
      .then((value) => alive && setSession(value))
      .catch(
        (reason) =>
          alive &&
          setError(reason instanceof Error ? reason.message : 'Não foi possível abrir a tela.'),
      );
    return () => {
      alive = false;
    };
  }, [deviceId]);

  // Leave full screen first and take the frame away only after the browser is out of it:
  // removing the frame mid-transition left Chrome with a dead, unclickable patch in the
  // top-right corner of every page until it was restarted (2026-11-21).
  const close = useCallback(() => {
    if (!document.fullscreenElement) return onClose();
    document
      .exitFullscreen()
      .catch(() => undefined)
      .finally(onClose);
  }, [onClose]);

  useEffect(() => {
    let wasFull = Boolean(document.fullscreenElement);
    const change = () => {
      if (document.fullscreenElement) wasFull = true;
      else if (wasFull) onClose();
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('fullscreenchange', change);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('fullscreenchange', change);
      document.removeEventListener('keydown', key);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [onClose, close]);

  return createPortal(
    <div
      className="remote-screen"
      ref={shell}
      role="dialog"
      aria-label={`Tela da IHM · ${deviceName}`}
    >
      {session ? (
        <iframe
          src={session.url}
          title={`Tela da IHM · ${deviceName}`}
          // No full screen inside the frame: the platform already holds it, and noVNC's own
          // full-screen button (hidden when it may not) nested a second one over ours.
          allow="fullscreen 'none'; clipboard-read; clipboard-write"
        />
      ) : (
        <div className="remote-screen-state">
          {error ? (
            <>
              <strong>Não foi possível abrir a tela da IHM</strong>
              <span>{error}</span>
            </>
          ) : (
            <>
              <span className="button-spinner" />
              <strong>Conectando à IHM de {deviceName}…</strong>
            </>
          )}
        </div>
      )}
      <div className="remote-screen-bar">
        {session?.mode === 'view' && <span>Só visualização</span>}
        <button type="button" onClick={close} aria-label="Fechar a tela da IHM">
          × Fechar
        </button>
      </div>
    </div>,
    document.body,
  );
}
