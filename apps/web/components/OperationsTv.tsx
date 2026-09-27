'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { usePoll } from './data';
import {
  healthOf,
  HEALTH_LABELS,
  normalizeCard,
  OperationCardBody,
  type CardConfig,
  type OperationMachine,
} from './OperationCard';
import { defaultScreens, TV_COLUMNS, type OperationTvScreen } from './operationsTvConfig';
import {
  FleetAlert,
  FleetKpis,
  FleetMap,
  FleetRanking,
  FleetStates,
  FleetTotals,
} from './OperationsTvBlocks';

// Modo TV da operação ("Gestão à Vista · multicerâmicas"): every plant of the group on the wall
// at once, each a card of the operations page filling its cell, with no scrolling. The screens
// the master arranged (or the default ones) follow one another; a remote's arrow keys pick one,
// which then holds. With ?preview=1 it is the live preview inside the TV editor.

type Theme = 'dark' | 'light';
const THEME_KEY = 'everlenz-tv-theme';
const HOLD_MS = 2 * 60 * 1000;

type Machine = OperationMachine & {
  siteName: string;
  deviceId: string;
  updatedAt: string | null;
};
interface Overview {
  generatedAt: string;
  sites: Array<{ id: string; name: string; machines: Machine[] }>;
}
interface Settings {
  cards: Record<string, unknown>;
}

export function useOperationsTvData() {
  const overview = usePoll<Overview>('/operations/overview', 10000);
  const settings = usePoll<Settings>('/operations/settings', 60000);
  const saved = usePoll<{ screens: OperationTvScreen[] }>('/operations/tv', 60000);
  const machines = useMemo(
    () => (overview.data?.sites ?? []).flatMap((site) => site.machines),
    [overview.data],
  );
  const configFor = useMemo(
    () => (machine: Machine): CardConfig =>
      normalizeCard(settings.data?.cards[machine.deviceId], machine.metric),
    [settings.data],
  );
  return { overview, settings, saved, machines, configFor };
}
export type OperationsTvData = ReturnType<typeof useOperationsTvData>;

/** One plant in a TV cell: its name, how it is doing, and its blocks filling the rest. */
export function TvPlantCard({
  machine,
  config,
}: {
  machine: Machine;
  config: CardConfig;
}) {
  const health = healthOf(machine, config);
  return (
    <article className={`tv-plant health-${health}`}>
      <header>
        <strong>{machine.deviceName}</strong>
        <em className="machine-health">
          <i />
          {HEALTH_LABELS[health]}
        </em>
      </header>
      <OperationCardBody machine={machine} config={config} />
    </article>
  );
}

export function OperationsTvGrid({
  screen,
  data,
}: {
  screen: OperationTvScreen;
  data: OperationsTvData;
}) {
  const byId = new Map(data.machines.map((machine) => [machine.deviceId, machine]));
  // A block of the group reads the plants of this screen, so four ceramics total those four.
  const onScreen = screen.cards
    .filter((card) => card.kind === 'plant' && card.device_id)
    .map((card) => byId.get(card.device_id!))
    .filter((machine): machine is Machine => Boolean(machine));
  const fleet = onScreen.length ? onScreen : data.machines;
  return (
    <div
      className="tv-grid operations-tv-grid"
      style={{ gridTemplateRows: `repeat(${screen.rows}, minmax(0, 1fr))` }}
    >
      {screen.cards.map((card, index) => {
        const machine = card.device_id ? byId.get(card.device_id) : undefined;
        return (
          <div
            key={`${card.kind}-${card.device_id ?? index}-${index}`}
            className="tv-cell"
            data-card={index}
            style={{
              gridColumn: `${card.x} / span ${Math.min(card.w, TV_COLUMNS - card.x + 1)}`,
              gridRow: `${card.y} / span ${card.h}`,
            }}
          >
            {card.kind === 'fleet_kpis' ? (
              <FleetKpis machines={fleet} />
            ) : card.kind === 'fleet_totals' ? (
              <FleetTotals machines={fleet} />
            ) : card.kind === 'fleet_ranking' ? (
              <FleetRanking machines={fleet} />
            ) : card.kind === 'fleet_states' ? (
              <FleetStates machines={fleet} />
            ) : card.kind === 'fleet_map' ? (
              <FleetMap machines={fleet} />
            ) : card.kind === 'fleet_alert' ? (
              <FleetAlert machines={fleet} configFor={data.configFor} />
            ) : machine ? (
              <TvPlantCard machine={machine} config={data.configFor(machine)} />
            ) : (
              <div className="tv-plant tv-plant-missing">Cerâmica sem acesso ou removida</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function OperationsTv() {
  const data = useOperationsTvData();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Preview inside the editor: the config comes from the parent window and the screen is fixed.
  const [preview, setPreview] = useState(false);
  const [previewConfig, setPreviewConfig] = useState<{
    screens: OperationTvScreen[];
    screen: number;
  } | null>(null);
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

  const savedScreens = data.saved.data?.screens;
  const screens = useMemo<OperationTvScreen[]>(
    () =>
      previewConfig?.screens ??
      (savedScreens?.length
        ? savedScreens
        : defaultScreens(data.machines.map((machine) => machine.deviceId))),
    [previewConfig, savedScreens, data.machines],
  );
  const [page, setPage] = useState(0);
  const [holdUntil, setHoldUntil] = useState(0);
  const count = Math.max(1, screens.length);
  const shown = previewConfig ? Math.min(previewConfig.screen, count - 1) : page % count;
  const shownDuration = screens[shown]?.duration_seconds ?? 20;
  useEffect(() => {
    if (preview || count < 2) return;
    const wait = Math.max(0, holdUntil - Date.now()) + shownDuration * 1000;
    const timer = setTimeout(() => setPage((current) => (current + 1) % count), wait);
    return () => clearTimeout(timer);
  }, [preview, count, shown, shownDuration, holdUntil]);
  useEffect(() => {
    if (preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (count < 2) return;
      const forward = ['ArrowRight', 'ArrowDown', 'PageDown'].includes(event.key);
      const back = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key);
      if (!forward && !back) return;
      event.preventDefault();
      setPage((current) => (current + (forward ? 1 : count - 1)) % count);
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
      const grid = document.querySelector('.operations-tv-grid');
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

  const screen = screens[shown];
  const producing = data.machines.filter((machine) => machine.state === 'producing').length;
  const offline = data.machines.filter((machine) => machine.state === 'offline').length;

  return (
    <div className={`tv3 operations-tv ${theme}`}>
      <header className="tv3-head">
        <div className="tv3-title">
          <span className="tv3-eyebrow">GESTÃO À VISTA · MULTICERÂMICAS</span>
          <h1>Operação em tempo real</h1>
        </div>
        <div className="tv3-shift">
          <strong>
            {data.machines.length} cerâmica{data.machines.length === 1 ? '' : 's'}
          </strong>
          <span>
            {producing} produzindo
            {offline ? ` · ${offline} sem comunicação` : ''}
          </span>
        </div>
        <div className="tv3-right">
          {count > 1 && (
            <span className="tv3-pages" role="group" aria-label="Tela da TV">
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
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button
            type="button"
            className="tv3-icon"
            title="Tela cheia"
            aria-label="Tela cheia"
            onClick={() =>
              void document.documentElement.requestFullscreen?.().catch(() => undefined)
            }
          >
            ⛶
          </button>
          {!preview && (
            <Link className="tv3-icon" href="/operations" aria-label="Sair da TV">
              ✕
            </Link>
          )}
        </div>
      </header>

      {data.overview.data && screen ? (
        <OperationsTvGrid screen={screen} data={data} />
      ) : (
        <div className="tv3-loading">
          {data.overview.error ??
            (data.overview.data ? (
              'Nenhuma cerâmica para exibir.'
            ) : (
              <span className="detail-spinner" aria-label="Carregando" />
            ))}
        </div>
      )}
    </div>
  );
}
