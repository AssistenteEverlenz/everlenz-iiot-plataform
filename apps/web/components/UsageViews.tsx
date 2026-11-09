'use client';

import type React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { usePoll } from './data';
import { UsageBehaviour, type Behaviour } from './UsageBehaviour';

// The master's view of how each person uses the platform (migration 042): the ranking of
// everyone, and one person's days, visits, pages, hours and logins. Read from the minutes the
// browser reports while the platform is on screen; TV boards are counted apart.

export interface UsageRow {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
  openMinutes: number;
  activeMinutes: number;
  tvMinutes: number;
  mobileMinutes: number;
  desktopMinutes: number;
  activeDays: number;
  visits: number;
  logins: number;
  topPage: string | null;
}
export interface UsageOverview {
  days: number;
  behaviour?: Behaviour | null;
  users: UsageRow[];
  daily: Array<{ day: string; users: number; openMinutes: number; activeMinutes: number }>;
}
interface UserUsage {
  days: number;
  behaviour?: Behaviour | null;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    createdAt: string;
    lastLoginAt: string | null;
  };
  daily: Array<{ day: string; openMinutes: number; activeMinutes: number; tvMinutes: number }>;
  visits: Array<{
    startedAt: string;
    endedAt: string;
    minutes: number;
    activeMinutes: number;
    device: string;
    pages: string[];
  }>;
  pages: Array<{ label: string; tv: boolean; minutes: number; activeMinutes: number }>;
  hours: Array<{ hour: number; minutes: number }>;
  weekdays: Array<{ weekday: number; minutes: number }>;
  devices: Array<{ device: string; minutes: number }>;
  loginCount: number;
  logins: Array<{ at: string; ip: string | null; userAgent: string | null; persistent: boolean }>;
}

export const USAGE_PERIODS: Array<[number, string]> = [
  [7, '7 dias'],
  [30, '30 dias'],
  [90, '90 dias'],
  [365, '1 ano'],
];
const DEVICES: Record<string, string> = { desktop: 'Computador', mobile: 'Celular', tv: 'TV' };

/** "2h 15min", "45min", "—". */
export function duration(minutes: number | null | undefined) {
  if (!minutes) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (!hours) return `${rest}min`;
  return rest ? `${hours}h ${rest}min` : `${hours}h`;
}
export function when(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}
const dayShort = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** The browser and system of a login, in two words instead of a user-agent string. */
function browserOf(agent: string | null) {
  if (!agent) return '—';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /OPR\//.test(agent)
      ? 'Opera'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Firefox\//.test(agent)
          ? 'Firefox'
          : /Safari\//.test(agent)
            ? 'Safari'
            : 'Navegador';
  const system = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad/.test(agent)
      ? 'iOS'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Mac OS/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return system ? `${browser} · ${system}` : browser;
}

export function PeriodPills({ days, onDays }: { days: number; onDays: (days: number) => void }) {
  return (
    <span className="widget-period" role="group" aria-label="Período">
      {USAGE_PERIODS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          className={days === value ? 'active' : ''}
          onClick={() => onDays(value)}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/** Minutes as whole hours on an axis, so a day of use reads "3h" instead of "180" or "2,7h". */
function hoursTick(minutes: number) {
  return String(Math.round(minutes / 60));
}

/** Axis marks on whole hours (or half hours when the busiest bar is under two hours). */
function hourTicks(values: number[]) {
  const top = Math.max(0, ...values);
  if (top <= 0) return [0, 60];
  if (top <= 120) return [0, 30, 60, 90, 120].filter((tick) => tick <= Math.ceil(top / 30) * 30);
  const hours = Math.ceil(top / 60);
  const step = Math.max(1, Math.ceil(hours / 5));
  const ticks: number[] = [];
  for (let hour = 0; hour <= Math.ceil(hours / step) * step; hour += step) ticks.push(hour * 60);
  return ticks;
}
function minutesTick(ticks: number[]) {
  // Half hours read as minutes, whole hours as hours.
  return (minutes: number) =>
    ticks.at(-1)! <= 120
      ? minutes % 60
        ? `${minutes}min`
        : `${minutes / 60}h`
      : `${hoursTick(minutes)}h`;
}

/**
 * Every day of the period, with the days nobody used it at zero: leaving them out drew a week
 * of daily use where there were gaps, which is exactly what the page is there to show.
 */
function everyDay<T extends { day: string }>(rows: T[], days: number, empty: Omit<T, 'day'>) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const today = new Date(Date.now() - 3 * 3600_000);
  const list: T[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(today.getTime() - back * 86_400_000).toISOString().slice(0, 10);
    list.push(byDay.get(day) ?? ({ day, ...empty } as T));
  }
  return list;
}

export function DailyUsageChart({
  data,
  days,
  label,
}: {
  data: Array<{ day: string; activeMinutes: number; users?: number }>;
  days: number;
  label: string;
}) {
  const filled = everyDay(data, days, { activeMinutes: 0, users: 0 });
  const ticks = hourTicks(filled.map((item) => item.activeMinutes));
  return (
    <div className="detail-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={filled.map((item) => ({ ...item, label: dayShort(item.day) }))}>
          <CartesianGrid stroke="var(--detail-grid)" strokeDasharray="3 6" vertical={false} />
          <XAxis dataKey="label" stroke="var(--detail-axis)" fontSize={11} minTickGap={12} />
          <YAxis
            stroke="var(--detail-axis)"
            fontSize={12}
            width={48}
            ticks={ticks}
            domain={[0, ticks.at(-1)!]}
            tickFormatter={minutesTick(ticks)}
          />
          <Tooltip
            cursor={{ fill: 'var(--detail-grid)' }}
            formatter={(value, _name, item) => {
              const users = (item.payload as { users?: number }).users;
              return [
                `${duration(Number(value))}${users != null ? ` · ${users} pessoa(s)` : ''}`,
                label,
              ];
            }}
          />
          <Bar
            dataKey="activeMinutes"
            fill="var(--brand-accent, #12b8a6)"
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** "11h48", "45min", "—": compact, the way the person's window reads its figures. */
function short(minutes: number | null | undefined) {
  if (!minutes) return '—';
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  return hours ? `${hours}h${String(total % 60).padStart(2, '0')}` : `${total}min`;
}
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

/** Small line icons for devices and pages (the stroke follows the text color). */
const GLYPHS: Record<string, React.ReactNode> = {
  desktop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  mobile: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  tv: (
    <>
      <rect x="2" y="5" width="20" height="13" rx="2" />
      <path d="M8 22h8M7 2l5 3 5-3" />
    </>
  ),
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  factory: (
    <>
      <path d="M3 21V10l6 4V10l6 4V6h6v15z" />
      <path d="M7 18h2M12 18h2M17 18h2" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),
  chip: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3" />
    </>
  ),
  brush: <path d="M9 15l-5 5M14 4l6 6-8 8-6-6z" />,
  radio: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M8 8a6 6 0 0 0 0 8M16 8a6 6 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
    </>
  ),
};
function Glyph({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name] ?? GLYPHS.grid}
    </svg>
  );
}
const PAGE_GLYPHS: Record<string, string> = {
  'Centro de comando': 'home',
  Operação: 'activity',
  Produção: 'factory',
  Dispositivos: 'chip',
  'Usuários e acessos': 'users',
  'White label': 'brush',
  'Inspetor MQTT': 'radio',
};
function pageGlyph(label: string) {
  if (label.startsWith('TV')) return 'tv';
  if (label.startsWith('Painel') || label === 'Lista de painéis') return 'grid';
  return PAGE_GLYPHS[label] ?? 'grid';
}
const ROLES: Record<string, string> = { master: 'Master', admin: 'Admin', user: 'Usuário' };
const onPhone = (agent: string | null) => /Android|iPhone|iPad|Mobile/.test(agent ?? '');

export function UserUsageModal({
  userId,
  days,
  onDays,
  onClose,
  actions,
}: {
  userId: string;
  days: number;
  onDays: (days: number) => void;
  onClose: () => void;
  /** What can be done to the account (edit, deactivate, new password, delete), on top. */
  actions?: React.ReactNode;
}) {
  const usage = usePoll<UserUsage>(`/usage/users/${userId}?days=${days}`, 120000);
  const data = usage.data;
  const daily = everyDay(data?.daily ?? [], days, {
    openMinutes: 0,
    activeMinutes: 0,
    tvMinutes: 0,
  });
  const open = daily.reduce((sum, item) => sum + item.openMinutes, 0);
  const active = daily.reduce((sum, item) => sum + item.activeMinutes, 0);
  const tv = daily.reduce((sum, item) => sum + item.tvMinutes, 0);
  const activeDays = daily.filter((item) => item.openMinutes > 0).length;
  const visits = data?.visits ?? [];
  const busiestDay = Math.max(1, ...daily.map((item) => item.openMinutes));
  const hours = Array.from(
    { length: 24 },
    (_, hour) => data?.hours.find((item) => item.hour === hour)?.minutes ?? 0,
  );
  const busiestHour = Math.max(1, ...hours);
  const devices = data?.devices ?? [];
  const devicesTotal = devices.reduce((sum, item) => sum + item.minutes, 0);
  const pages = data?.pages ?? [];
  const pagesTotal = pages.reduce((sum, page) => sum + page.minutes, 0);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card usage-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="uu-head">
          <div>
            <div className="eyebrow">
              {actions ? 'USUÁRIO · USO DA PLATAFORMA' : 'USO DA PLATAFORMA'}
            </div>
            <h2>{data?.user.name ?? 'Carregando…'}</h2>
          </div>
          <button type="button" className="uu-close" aria-label="Fechar" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="uu-sub">
          <p>
            {data
              ? `${data.user.email} · ${ROLES[data.user.role] ?? data.user.role} · último login ${when(data.user.lastLoginAt)}`
              : ''}
          </p>
          <PeriodPills days={days} onDays={onDays} />
        </div>
        {actions && <div className="row-actions usage-actions">{actions}</div>}
        {usage.error && <div className="form-error">{usage.error}</div>}
        {data && (
          <>
            <div className="uu-stats">
              <div>
                <span>Tempo em uso</span>
                <b>{short(active)}</b>
                <small>mexendo na tela</small>
              </div>
              <div>
                <span>Plataforma aberta</span>
                <b>{short(open)}</b>
                <small>{open ? `${pct(active, open)} em uso` : 'sem registro'}</small>
              </div>
              <div>
                <span>Visitas</span>
                <b>{visits.length}</b>
                <small>{visits.length ? `média de ${short(open / visits.length)}` : '—'}</small>
              </div>
              <div>
                <span>Dias com acesso</span>
                <b>{activeDays}</b>
                <small>de {days} dias</small>
              </div>
            </div>

            {!open && !tv ? (
              <p className="uu-empty">
                Nenhum uso registrado nestes {days} dias. O registro começou com esta versão da
                plataforma.
              </p>
            ) : (
              <>
                <p className="uu-label">Aparelhos</p>
                <div className="uu-devices">
                  {devices.map((item) => (
                    <div key={item.device}>
                      <span>
                        <Glyph name={item.device} />
                        {DEVICES[item.device] ?? item.device}
                      </span>
                      <span className="uu-prog">
                        <i style={{ width: pct(item.minutes, devicesTotal) }} />
                      </span>
                      <b>
                        {short(item.minutes)} · {pct(item.minutes, devicesTotal)}
                      </b>
                    </div>
                  ))}
                </div>

                <p className="uu-label">Tempo com a plataforma aberta por dia</p>
                <div className="uu-bars" style={{ '--n': days } as React.CSSProperties}>
                  {daily.map((item) => (
                    <i
                      key={item.day}
                      title={`${dayShort(item.day)}: ${short(item.openMinutes)} aberta, ${short(item.activeMinutes)} em uso`}
                      style={{ height: `${(item.openMinutes / busiestDay) * 100}%` }}
                    >
                      <b
                        style={{
                          height: item.openMinutes
                            ? `${(item.activeMinutes / item.openMinutes) * 100}%`
                            : 0,
                        }}
                      />
                    </i>
                  ))}
                </div>
                <div className="uu-axis">
                  <span>{dayShort(daily[0].day)}</span>
                  <span className="uu-key">
                    <i className="open" /> aberta <i /> em uso
                  </span>
                  <span>hoje</span>
                </div>

                <p className="uu-label">Horário do dia</p>
                <div className="uu-bars hours" style={{ '--n': 24 } as React.CSSProperties}>
                  {hours.map((minutes, hour) => (
                    <i
                      key={hour}
                      title={`${String(hour).padStart(2, '0')}h: ${short(minutes)}`}
                      style={{ height: `${(minutes / busiestHour) * 100}%` }}
                    />
                  ))}
                </div>
                <div className="uu-axis">
                  <span>0h</span>
                  <span>6h</span>
                  <span>12h</span>
                  <span>18h</span>
                  <span>23h</span>
                </div>

                <p className="uu-label">O que mais vê</p>
                <div className="uu-list">
                  {pages.map((page) => (
                    <div key={`${page.label}-${page.tv}`} className="uu-item">
                      <span className="uu-ico">
                        <Glyph name={pageGlyph(page.label)} />
                      </span>
                      <span>
                        {page.label}
                        <span className="uu-prog">
                          <i style={{ width: pct(page.minutes, pagesTotal) }} />
                        </span>
                      </span>
                      <span className="uu-right">
                        {short(page.minutes)}
                        <small>{pct(page.minutes, pagesTotal)}</small>
                      </span>
                    </div>
                  ))}
                </div>

                <UsageBehaviour data={data.behaviour} everyone={false} />

                <p className="uu-label">Visitas recentes</p>
                <div className="uu-list">
                  {visits.slice(0, 8).map((visit) => (
                    <div key={visit.startedAt} className="uu-item">
                      <span className="uu-ico blue">
                        <Glyph name={visit.device} />
                      </span>
                      <span>
                        {when(visit.startedAt)}
                        <small>{visit.pages.join(' · ')}</small>
                      </span>
                      <span className="uu-right">
                        {short(visit.minutes)}
                        <small>
                          {visit.activeMinutes ? `${short(visit.activeMinutes)} em uso` : 'sem uso'}
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <p className="uu-label">Logins</p>
            <div className="uu-list">
              {data.logins.length ? (
                data.logins.map((login) => (
                  <div key={login.at} className="uu-item">
                    <span className="uu-ico mute">
                      <Glyph name={onPhone(login.userAgent) ? 'mobile' : 'desktop'} />
                    </span>
                    <span>
                      {when(login.at)}
                      <small>
                        {browserOf(login.userAgent)}
                        {login.ip ? ` · ${login.ip}` : ''}
                      </small>
                    </span>
                    <span className="uu-right">
                      <small>{login.persistent ? 'manteve conectado' : ''}</small>
                    </span>
                  </div>
                ))
              ) : (
                <p className="uu-empty">Nenhum login registrado desde esta versão da plataforma.</p>
              )}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
