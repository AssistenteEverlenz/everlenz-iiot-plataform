'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { sinceText, TvGrid, useTvData } from './TvBlocks';
import { defaultScreens, type TvScreen } from './tvConfig';
import { clock, duration, stateInfo } from './ShiftBoard';

// Modo TV ("Gestão à Vista"): the screens the master configured for this dashboard (or the
// default ones), shown in turn, each for its own time. A TV remote's arrow keys (or a click on
// the header) pick a screen, which then holds for two minutes. Light or dark theme, screen kept
// awake. With ?preview=1 the TV is the live preview inside the TV editor: it shows the config
// the editor sends and reports where its grid is, so the editor can draw handles over it.

type Theme = 'dark' | 'light';
const THEME_KEY = 'everlenz-tv-theme';
const HOLD_MS = 2 * 60 * 1000;

export function ShiftTv({ id }: { id: string }) {
  const data = useTvData(id);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Preview inside the editor: config comes from the parent window, the screen is fixed.
  const [preview, setPreview] = useState(false);
  const [previewConfig, setPreviewConfig] = useState<{ screens: TvScreen[]; screen: number } | null>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('preview') !== '1') return;
    setPreview(true);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'tv-config') return;
      setPreviewConfig({ screens: event.data.screens, screen: event.data.screen });
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'tv-ready' }, window.location.origin);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const widgets = data.dashboard.data?.widgets;
  const savedScreens = data.saved.data?.screens;
  const screens = useMemo<TvScreen[]>(
    () =>
      previewConfig?.screens ?? (savedScreens?.length ? savedScreens : defaultScreens(widgets ?? [])),
    [previewConfig, savedScreens, widgets],
  );
  const [page, setPage] = useState(0);
  const [holdUntil, setHoldUntil] = useState(0);
  const count = Math.max(1, screens.length);
  const shown = previewConfig ? Math.min(previewConfig.screen, count - 1) : page % count;
  const shownDuration = screens[shown]?.duration_seconds ?? 20;
  // Each screen stays its own time; a picked screen first waits out its hold.
  useEffect(() => {
    if (preview || count < 2) return;
    const wait = Math.max(0, holdUntil - Date.now()) + shownDuration * 1000;
    const timer = setTimeout(() => setPage((currentPage) => (currentPage + 1) % count), wait);
    return () => clearTimeout(timer);
  }, [preview, count, shown, shownDuration, holdUntil]);
  // A TV remote sends arrow keys: they turn the screen, which then holds for two minutes.
  useEffect(() => {
    if (preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (count < 2) return;
      const forward = ['ArrowRight', 'ArrowDown', 'PageDown'].includes(event.key);
      const back = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key);
      if (!forward && !back) return;
      event.preventDefault();
      setPage((currentPage) => (currentPage + (forward ? 1 : count - 1)) % count);
      setHoldUntil(Date.now() + HOLD_MS);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, count]);

  // Theme: dark by default, remembered on this screen; the platform theme comes back on exit.
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock
      ?.request('screen')
      .then((granted) => {
        lock = granted;
      })
      .catch(() => undefined);
    try {
      if (localStorage.getItem(THEME_KEY) === 'light') setTheme('light');
    } catch {
      // No storage: the dark default stays.
    }
    return () => {
      if (previous) root.dataset.theme = previous;
      else delete root.dataset.theme;
      void lock?.release().catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The choice lasts for this visit.
    }
  }, [theme]);

  // Preview: tell the editor where the grid is (it moves as data and config arrive).
  useEffect(() => {
    if (!preview) return;
    const post = () => {
      const grid = document.querySelector('.tv-grid');
      if (!(grid instanceof HTMLElement)) return;
      const rect = grid.getBoundingClientRect();
      const style = getComputedStyle(grid);
      window.parent.postMessage(
        {
          type: 'tv-layout',
          layout: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            gapX: parseFloat(style.columnGap) || 0,
            gapY: parseFloat(style.rowGap) || 0,
          },
        },
        window.location.origin,
      );
    };
    const frame = requestAnimationFrame(post);
    const timer = setInterval(post, 800);
    window.addEventListener('resize', post);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      window.removeEventListener('resize', post);
    };
  }, [preview, screens, shown]);

  const board = data.board.data;
  const current = data.current;
  const shift = board?.shifts[0];
  const state = data.state;
  const screen = screens[shown];

  return (
    <div className={`tv3 ${theme}`}>
      <header className="tv3-head">
        <div className="tv3-title">
          <span className="tv3-eyebrow">GESTÃO À VISTA · PRODUÇÃO</span>
          <h1>
            {data.device.data?.name ?? data.dashboard.data?.name ?? 'Carregando…'}
            {data.device.data?.site_name && data.device.data.site_name !== data.device.data.name && (
              <small> · {data.device.data.site_name}</small>
            )}
          </h1>
        </div>
        <div className="tv3-shift">
          <strong>
            {shift ? `${shift.name} · ${clock(shift.start)}–${clock(shift.end)}` : 'Sem turno agora'}
          </strong>
          <span>
            {board?.status === 'running' && current
              ? `termina em ${duration((new Date(current.span.end).getTime() - now.getTime()) / 1000)}`
              : board?.next
                ? `próximo turno ${clock(board.next.start)}`
                : ''}
            {board?.product ? ` · ${board.product}` : ''}
          </span>
        </div>
        <div className="tv3-right">
          {count > 1 && (
            <span
              className="tv3-pages"
              role="group"
              aria-label="Tela da TV"
              title="As telas trocam sozinhas; as setas do controle remoto também trocam"
            >
              {/* The current screen by name and one dot per screen: stays small with many screens. */}
              <b className="tv3-pages-name">{screens[shown]?.name}</b>
              {screens.map((item, index) => (
                <button
                  key={`${item.name}-${index}`}
                  type="button"
                  className={`tv3-dot ${shown === index ? 'active' : ''}`}
                  title={item.name}
                  aria-label={item.name}
                  onClick={() => {
                    setPage(index);
                    setHoldUntil(Date.now() + HOLD_MS);
                  }}
                />
              ))}
            </span>
          )}
          <span
            className="tv3-state"
            style={{ '--state': stateInfo[state]?.color ?? '#98a6ab' } as React.CSSProperties}
          >
            <i />
            {stateInfo[state]?.label ?? 'Sem dados'}
            {data.stateMinutes >= 1 && <small>há {sinceText(data.stateMinutes)}</small>}
          </span>
          <strong className="tv3-clock">
            {now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            <small>
              {now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}
            </small>
          </strong>
          <button
            type="button"
            className="tv3-icon"
            title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
            aria-label={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
            onClick={() => setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button
            type="button"
            className="tv3-icon"
            title="Tela cheia"
            aria-label="Tela cheia"
            onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}
          >
            ⛶
          </button>
          {!preview && (
            <Link className="tv3-icon" href={`/dashboards/${id}`} aria-label="Sair da TV">
              ✕
            </Link>
          )}
        </div>
      </header>

      {data.dashboard.data && screen ? (
        <TvGrid screen={screen} data={data} dashboardId={id} />
      ) : (
        <div className="tv3-loading">
          {data.dashboard.error ?? <span className="detail-spinner" aria-label="Carregando" />}
        </div>
      )}
    </div>
  );
}
