'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PageSlots } from './PlatformShell';
import { ThemeToggle } from './ThemeToggle';

// What a dashboard puts in the platform shell: the equipment and its heartbeat in the top bar,
// and one "Ações" button gathering what used to crowd the header (add, exports, TV, refresh
// rate, theme). On desktop the button sits in the top bar; on phones it is the highlighted
// button in the middle of the bottom bar.

interface DashboardChromeProps {
  slots: PageSlots;
  deviceName: string;
  deviceCode: string;
  online: boolean;
  /** Changes on every new message: the heart beats once per change. */
  beat: string | null | undefined;
  refreshMs: number;
  savingRefresh: boolean;
  onRefresh: (refreshMs: number) => void;
  onAdd: () => void;
  onPdf: () => void;
  csvHref: string;
  tvHref: string;
}

export function DashboardChrome(props: DashboardChromeProps) {
  const { slots } = props;
  return (
    <>
      {slots.header && createPortal(<EquipmentHead {...props} />, slots.header)}
      {slots.actions && createPortal(<ActionsButton {...props} variant="menu" />, slots.actions)}
      {slots.fab && createPortal(<ActionsButton {...props} variant="fab" />, slots.fab)}
    </>
  );
}

function EquipmentHead({ deviceName, deviceCode, online, beat }: DashboardChromeProps) {
  return (
    <div className="equipment-head">
      <Heartbeat online={online} beat={beat} />
      <div>
        <strong title={deviceName}>{deviceName}</strong>
        <span className="code-chip">{deviceCode}</span>
      </div>
    </div>
  );
}

/** Green and beating while the equipment publishes; grey and still when it goes quiet. */
function Heartbeat({ online, beat }: { online: boolean; beat: string | null | undefined }) {
  const label = online ? 'Online' : 'Offline';
  return (
    <span className={`heartbeat ${online ? 'online' : 'offline'}`} title={label} aria-label={label}>
      {/* A new key restarts the animation, so each message gives exactly one beat. */}
      <svg key={online ? (beat ?? 'on') : 'off'} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20.5s-7.4-4.5-9.4-9C1.2 8.3 3.3 4.8 6.8 4.8c2 0 3.5 1.1 5.2 3 1.7-1.9 3.2-3 5.2-3 3.5 0 5.6 3.5 4.2 6.7-2 4.5-9.4 9-9.4 9Z" />
      </svg>
    </span>
  );
}

function ActionsButton({
  variant,
  refreshMs,
  savingRefresh,
  onRefresh,
  onAdd,
  onPdf,
  csvHref,
  tvHref,
}: DashboardChromeProps & { variant: 'menu' | 'fab' }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open || variant !== 'menu') return;
    const close = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, variant]);
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const items = (
    <>
      <button className="primary-button" onClick={run(onAdd)}>
        + Adicionar indicador
      </button>
      <button onClick={run(onPdf)}>Exportar PDF</button>
      <a className="secondary-button" href={csvHref} onClick={() => setOpen(false)}>
        Exportar CSV
      </a>
      {/* Opens the managerial wall board; the widget grid stays the operator's view. */}
      <button onClick={run(() => window.location.assign(tvHref))}>Modo TV</button>
      <label className="actions-refresh">
        <span>Atualização {savingRefresh && <span className="button-spinner dark" />}</span>
        <select value={refreshMs} onChange={(event) => onRefresh(Number(event.target.value))}>
          <option value={1000}>1 segundo</option>
          <option value={2000}>2 segundos</option>
          <option value={5000}>5 segundos</option>
          <option value={10000}>10 segundos</option>
        </select>
      </label>
      <ThemeToggle withLabel />
    </>
  );

  if (variant === 'fab')
    return (
      <>
        <button
          className={`bottom-fab ${open ? 'active' : ''}`}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span>
            <ActionsIcon />
          </span>
          Ações
        </button>
        {/* On the body: the bottom bar's blur would trap a fixed backdrop inside the bar. */}
        {open &&
          createPortal(
            <div className="mobile-menu-backdrop" onClick={() => setOpen(false)}>
              <section
                className="mobile-menu-sheet actions-sheet"
                onClick={(event) => event.stopPropagation()}
              >
                {items}
              </section>
            </div>,
            document.body,
          )}
      </>
    );

  return (
    <span className="actions-menu" ref={wrapper}>
      <button
        className={`actions-trigger ${open ? 'active' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ActionsIcon /> Ações
      </button>
      {open && <div className="actions-popover">{items}</div>}
    </span>
  );
}

function ActionsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </svg>
  );
}
