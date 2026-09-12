'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { NavIcon, type NavIconName } from './NavIcon';
import { ThemeToggle } from './ThemeToggle';

export interface PlatformUser {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: 'master' | 'user';
  status: 'active' | 'inactive';
  mustChangePassword: boolean;
}

export interface Branding {
  product_name: string;
  subtitle: string;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
}

interface PlatformContextValue {
  user: PlatformUser;
  deviceIds: string[] | null;
  branding: Branding;
  refreshSession: () => Promise<void>;
  refreshBranding: () => Promise<void>;
  /** Places in the shell a page can fill through a portal (see PageSlots). */
  slots: PageSlots;
}

/**
 * The dashboard puts its equipment in the top bar and its actions in a button there (desktop)
 * or a highlighted button in the bottom bar (phones). Other pages leave them empty and the
 * shell shows its default top bar.
 */
export interface PageSlots {
  header: HTMLElement | null;
  actions: HTMLElement | null;
  fab: HTMLElement | null;
}

const defaultBranding: Branding = {
  product_name: 'Everlenz IIoT',
  subtitle: 'Industrial Intelligence',
  logo_url: null,
  primary_color: '#0b2028',
  accent_color: '#12b8a6',
};

const PlatformContext = createContext<PlatformContextValue | null>(null);
const navigation = [
  { href: '/', label: 'Centro de comando', short: 'Início', icon: 'home' },
  { href: '/dashboards', label: 'Painéis', short: 'Painéis', icon: 'panels' },
  { href: '/devices', label: 'Dispositivos', short: 'Ativos', icon: 'device' },
] satisfies { href: string; label: string; short: string; icon: NavIconName }[];
// Every user reads production history; on phones it lives in the "Mais" sheet so the bottom
// bar keeps its four slots.
const productionNavigation = {
  href: '/production',
  label: 'Produção',
  short: 'Produção',
  icon: 'production' as const,
};

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<{
    user: PlatformUser;
    deviceIds: string[] | null;
  } | null>();
  const [branding, setBranding] = useState(defaultBranding);
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarHovered, setSidebarHovered] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [fabSlot, setFabSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo(
    () => ({ header: headerSlot, actions: actionsSlot, fab: fabSlot }),
    [headerSlot, actionsSlot, fabSlot],
  );

  async function refreshSession() {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    setSession(response.ok ? await response.json() : null);
  }
  async function refreshBranding() {
    try {
      const response = await fetch('/api/branding/public', { cache: 'no-store' });
      setBranding(response.ok ? await response.json() : defaultBranding);
    } catch {
      setBranding(defaultBranding);
    }
  }

  useEffect(() => {
    void refreshBranding();
    void refreshSession();
    const timer = window.setTimeout(() => setCollapsed(true), 400);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (session === null && pathname !== '/login')
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (session && pathname === '/login') router.replace('/');
  }, [pathname, router, session]);

  useEffect(() => {
    if (
      session?.user.role === 'user' &&
      ['/users', '/settings', '/mqtt-inspector'].some((path) => pathname.startsWith(path))
    )
      router.replace('/');
  }, [pathname, router, session]);

  // A plant user comes for their equipment's dashboard: land there directly instead of the
  // command centre. With several equipments, the list of dashboards comes first. The other
  // screens stay reachable from the navigation.
  useEffect(() => {
    if (session?.user.role !== 'user' || pathname !== '/') return;
    let cancelled = false;
    void fetch('/api/dashboards', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : []))
      .then((dashboards: Array<{ id: string }>) => {
        if (cancelled || !Array.isArray(dashboards)) return;
        router.replace(dashboards.length === 1 ? `/dashboards/${dashboards[0].id}` : '/dashboards');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pathname, router, session]);

  const style = useMemo(
    () =>
      ({
        '--brand-primary': branding.primary_color,
        '--brand-accent': branding.accent_color,
      }) as React.CSSProperties,
    [branding],
  );

  if (pathname === '/login') return <div style={style}>{children}</div>;
  if (!session) return <LoadingScreen branding={branding} />;
  // The TV board fills the screen with no navigation: it runs unattended on a wall display.
  // It still sits after the session check, so it is never reachable without a login.
  if (pathname.endsWith('/tv')) return <div style={style}>{children}</div>;

  const masterNavigation =
    session.user.role === 'master'
      ? [
          ...navigation,
          productionNavigation,
          {
            href: '/users',
            label: 'Usuários e acessos',
            short: 'Usuários',
            icon: 'users' as const,
          },
          { href: '/settings', label: 'White label', short: 'Marca', icon: 'brand' as const },
          {
            href: '/mqtt-inspector',
            label: 'MQTT Inspector',
            short: 'MQTT',
            icon: 'mqtt' as const,
          },
        ]
      : [...navigation, productionNavigation];

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.replace('/login');
  }

  const sidebarIsCollapsed = collapsed && !sidebarHovered;
  return (
    <PlatformContext.Provider
      value={{ ...session, branding, refreshSession, refreshBranding, slots }}
    >
      <div
        className={`platform-shell ${sidebarIsCollapsed ? 'sidebar-collapsed' : ''}`}
        style={style}
      >
        <aside
          className="platform-sidebar"
          onMouseEnter={() => setSidebarHovered(true)}
          onMouseLeave={() => setSidebarHovered(false)}
        >
          <div className="sidebar-brand-row">
            <Link className="brand" href="/">
              {branding.logo_url ? <img src={branding.logo_url} alt="" /> : <b>e</b>}
              <span className="brand-copy">
                {branding.product_name}
                <small>{branding.subtitle}</small>
              </span>
            </Link>
          </div>
          <nav className="side-navigation">
            {masterNavigation.map((item) => (
              <Link
                key={item.href}
                className={active(pathname, item.href) ? 'active' : ''}
                href={item.href}
                title={sidebarIsCollapsed ? item.label : undefined}
              >
                <span className="nav-icon">
                  <NavIcon name={item.icon} />
                </span>
                <span className="nav-label">{item.label}</span>
              </Link>
            ))}
          </nav>
          <div className="aside-foot">
            <button className="sidebar-user" onClick={() => void logout()} title="Sair">
              <span className="user-avatar">{initials(session.user.fullName)}</span>
              <span className="nav-label">
                <strong>{session.user.fullName}</strong>
                <small>{session.user.role === 'master' ? 'Administrador master' : 'Cliente'}</small>
              </span>
              <span className="nav-label">↗</span>
            </button>
          </div>
        </aside>
        <main className="platform-main">
          <header className="platform-topbar">
            <div className="topbar-page" ref={setHeaderSlot} />
            <span className="topbar-default">PLATAFORMA IIoT</span>
            <div className="topbar-user">
              <span className="topbar-default">
                <span className="live-dot" /> Dados em tempo real
              </span>
              <b>{session.user.fullName}</b>
              <span className="topbar-actions" ref={setActionsSlot} />
              <span className="topbar-default">
                <ThemeToggle />
              </span>
            </div>
          </header>
          {children}
        </main>
        <nav className="bottom-navigation">
          {navigation.map((item, index) => (
            <Fragment key={item.href}>
              {/* Between Painéis and Ativos: the page's highlighted action button, if any. */}
              {index === 2 && <span className="bottom-fab-slot" ref={setFabSlot} />}
              <Link className={active(pathname, item.href) ? 'active' : ''} href={item.href}>
                <span>
                  <NavIcon name={item.icon} />
                </span>
                {item.short}
              </Link>
            </Fragment>
          ))}
          <button className={mobileMenu ? 'active' : ''} onClick={() => setMobileMenu(!mobileMenu)}>
            <span>•••</span>Mais
          </button>
        </nav>
        {mobileMenu && (
          <div className="mobile-menu-backdrop" onClick={() => setMobileMenu(false)}>
            <section className="mobile-menu-sheet" onClick={(event) => event.stopPropagation()}>
              <div className="mobile-user-card">
                <span className="user-avatar">{initials(session.user.fullName)}</span>
                <div>
                  <strong>{session.user.fullName}</strong>
                  <small>{session.user.email}</small>
                </div>
              </div>
              {masterNavigation.slice(navigation.length).map((item) => (
                <Link key={item.href} href={item.href} onClick={() => setMobileMenu(false)}>
                  <NavIcon name={item.icon} /> {item.label}
                </Link>
              ))}
              <ThemeToggle withLabel />
              <button className="danger-text" onClick={() => void logout()}>
                Sair da plataforma
              </button>
            </section>
          </div>
        )}
        {session.user.mustChangePassword && <FirstAccessModal onComplete={refreshSession} />}
      </div>
    </PlatformContext.Provider>
  );
}

function FirstAccessModal({ onComplete }: { onComplete: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmation) return setError('As senhas não coincidem.');
    setSaving(true);
    setError('');
    const response = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password, confirmation }),
    });
    const result = (await response.json()) as { error?: string };
    setSaving(false);
    if (!response.ok) return setError(result.error ?? 'Não foi possível alterar a senha.');
    await onComplete();
  }
  return (
    <div className="modal-backdrop force-password-backdrop">
      <form className="modal-card compact-modal" onSubmit={submit}>
        <div className="modal-security-icon">✓</div>
        <div className="eyebrow">PRIMEIRO ACESSO</div>
        <h2>Crie sua nova senha</h2>
        <p>Substitua a senha provisória antes de acessar os dados da plataforma.</p>
        <label className="field">
          Nova senha
          <input
            type="password"
            minLength={12}
            required
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="field">
          Confirmar senha
          <input
            type="password"
            minLength={12}
            required
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        <small className="password-hint">
          Mínimo de 12 caracteres, com maiúscula, minúscula e número.
        </small>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" disabled={saving}>
          {saving && <span className="button-spinner" />}
          {saving ? 'Salvando...' : 'Salvar e continuar'}
        </button>
      </form>
    </div>
  );
}

// The logo stays still and only a ring turns around it, as in the DR Fin loader: a spinning
// logo reads as a broken image, while a spinning ring reads as progress.
export function BrandSpinner({ branding }: { branding: Branding }) {
  return (
    <span className="brand-spinner" role="status" aria-label="Carregando">
      <span className="brand-spinner-ring" />
      {branding.logo_url ? (
        <img src={branding.logo_url} alt="" aria-hidden="true" />
      ) : (
        <span className="brand-spinner-letter">e</span>
      )}
    </span>
  );
}

export function LoadingScreen({ branding }: { branding: Branding }) {
  return (
    <main className="platform-loading">
      <BrandSpinner branding={branding} />
      <strong>{branding.product_name}</strong>
      <span>Sincronizando seu ambiente industrial...</span>
    </main>
  );
}

function active(pathname: string, href: string) {
  return pathname === href || (href !== '/' && pathname.startsWith(href));
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function usePlatform() {
  const context = useContext(PlatformContext);
  if (!context) throw new Error('usePlatform must be used inside PlatformShell');
  return context;
}
