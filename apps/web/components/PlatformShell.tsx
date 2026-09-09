'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

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
  { href: '/', label: 'Centro de comando', short: 'Início', icon: '◫' },
  { href: '/dashboards', label: 'Painéis', short: 'Painéis', icon: '◈' },
  { href: '/devices', label: 'Dispositivos', short: 'Ativos', icon: '▰' },
  { href: '/integrations', label: 'Integrações', short: 'Dados', icon: '⇄' },
];

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<{
    user: PlatformUser;
    deviceIds: string[] | null;
  } | null>();
  const [branding, setBranding] = useState(defaultBranding);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);

  async function refreshSession() {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    setSession(response.ok ? await response.json() : null);
  }

  useEffect(() => {
    void fetch('/api/branding/public', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : defaultBranding))
      .then(setBranding)
      .catch(() => setBranding(defaultBranding));
    void refreshSession();
    setCollapsed(window.localStorage.getItem('iiot-sidebar-collapsed') === 'true');
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

  const masterNavigation =
    session.user.role === 'master'
      ? [
          ...navigation,
          { href: '/users', label: 'Usuários e acessos', short: 'Usuários', icon: '♙' },
          { href: '/settings', label: 'White label', short: 'Marca', icon: '◆' },
          { href: '/mqtt-inspector', label: 'MQTT Inspector', short: 'MQTT', icon: '⌁' },
        ]
      : navigation;

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.replace('/login');
  }

  function toggleSidebar() {
    setCollapsed((current) => {
      window.localStorage.setItem('iiot-sidebar-collapsed', String(!current));
      return !current;
    });
  }

  return (
    <PlatformContext.Provider value={{ ...session, branding, refreshSession }}>
      <div className={`platform-shell ${collapsed ? 'sidebar-collapsed' : ''}`} style={style}>
        <aside className="platform-sidebar">
          <div className="sidebar-brand-row">
            <Link className="brand" href="/">
              {branding.logo_url ? <img src={branding.logo_url} alt="" /> : <b>e</b>}
              <span className="brand-copy">
                {branding.product_name}
                <small>{branding.subtitle}</small>
              </span>
            </Link>
            <button className="collapse-button" onClick={toggleSidebar} aria-label="Recolher menu">
              {collapsed ? '›' : '‹'}
            </button>
          </div>
          <div className="workspace nav-label">
            POC INDUSTRIAL <small>Operação conectada</small>
          </div>
          <nav className="side-navigation">
            {masterNavigation.map((item) => (
              <Link
                key={item.href}
                className={active(pathname, item.href) ? 'active' : ''}
                href={item.href}
                title={collapsed ? item.label : undefined}
              >
                <span className="nav-icon">{item.icon}</span>
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
            <span>PLATAFORMA IIoT</span>
            <div className="topbar-user">
              <span className="live-dot" /> Dados em tempo real <b>{session.user.fullName}</b>
            </div>
          </header>
          {children}
        </main>
        <nav className="bottom-navigation">
          {navigation.map((item) => (
            <Link
              key={item.href}
              className={active(pathname, item.href) ? 'active' : ''}
              href={item.href}
            >
              <span>{item.icon}</span>
              {item.short}
            </Link>
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
              {masterNavigation.slice(4).map((item) => (
                <Link key={item.href} href={item.href} onClick={() => setMobileMenu(false)}>
                  {item.icon} {item.label}
                </Link>
              ))}
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

function LoadingScreen({ branding }: { branding: Branding }) {
  return (
    <main className="platform-loading">
      <div className="industrial-spinner">
        <i />
        <i />
        <i />
      </div>
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
