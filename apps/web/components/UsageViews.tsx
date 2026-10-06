'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePoll } from './data';

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
  activeDays: number;
  visits: number;
  logins: number;
  topPage: string | null;
}
export interface UsageOverview {
  days: number;
  users: UsageRow[];
  daily: Array<{ day: string; users: number; openMinutes: number; activeMinutes: number }>;
}
interface UserUsage {
  days: number;
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
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
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
    ticks.at(-1)! <= 120 ? (minutes % 60 ? `${minutes}min` : `${minutes / 60}h`) : `${hoursTick(minutes)}h`;
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

function MinutesBars({
  data,
  dataKey,
  label,
  every = 0,
}: {
  data: Array<Record<string, string | number>>;
  dataKey: string;
  label: string;
  /** Labels to skip between two shown, so 24 hours do not pile up. */
  every?: number;
}) {
  const ticks = hourTicks(data.map((item) => Number(item.minutes)));
  return (
    <div className="detail-chart usage-chart-small">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid stroke="var(--detail-grid)" strokeDasharray="3 6" vertical={false} />
          <XAxis dataKey={dataKey} stroke="var(--detail-axis)" fontSize={11} interval={every} />
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
            formatter={(value) => [duration(Number(value)), label]}
          />
          <Bar dataKey="minutes" fill="var(--brand-accent, #12b8a6)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function UserUsageModal({
  userId,
  days,
  onDays,
  onClose,
}: {
  userId: string;
  days: number;
  onDays: (days: number) => void;
  onClose: () => void;
}) {
  const usage = usePoll<UserUsage>(`/usage/users/${userId}?days=${days}`, 120000);
  const data = usage.data;
  const total = (key: 'openMinutes' | 'activeMinutes' | 'tvMinutes') =>
    (data?.daily ?? []).reduce((sum, item) => sum + item[key], 0);
  const open = total('openMinutes');
  const active = total('activeMinutes');
  const tv = total('tvMinutes');
  const activeDays = (data?.daily ?? []).filter((item) => item.openMinutes > 0).length;
  const visits = data?.visits ?? [];
  const averageVisit = visits.length
    ? visits.reduce((sum, visit) => sum + visit.minutes, 0) / visits.length
    : 0;
  const pagesTotal = (data?.pages ?? [])
    .filter((page) => !page.tv)
    .reduce((sum, page) => sum + page.minutes, 0);
  const busiest = [...(data?.hours ?? [])].sort((a, b) => b.minutes - a.minutes)[0];

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card detail-modal usage-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">USO DA PLATAFORMA</div>
            <h2>{data?.user.name ?? 'Carregando…'}</h2>
            {data && (
              <p className="shifts-help">
                {data.user.email} · último login {when(data.user.lastLoginAt)}
              </p>
            )}
          </div>
          <div className="detail-step">
            <PeriodPills days={days} onDays={onDays} />
            <button type="button" className="icon-button" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        {usage.error && <div className="form-error">{usage.error}</div>}
        {data && (
          <>
            <div className="detail-summary">
              <div>
                <span>Tempo em uso</span>
                <b>{duration(active)}</b>
                <small>com interação na tela</small>
              </div>
              <div>
                <span>Tempo com a plataforma aberta</span>
                <b>{duration(open)}</b>
                <small>{open ? `${Math.round((active / open) * 100)}% em uso` : 'sem registro'}</small>
              </div>
              <div>
                <span>Visitas</span>
                <b>{visits.length}</b>
                <small>média de {duration(averageVisit)} cada</small>
              </div>
              <div>
                <span>Dias com acesso</span>
                <b>{activeDays}</b>
                <small>de {days} dias</small>
              </div>
            </div>
            <div className="detail-summary">
              <div>
                <span>Logins no período</span>
                <b>{data.loginCount}</b>
                <small>os últimos 30 estão listados abaixo</small>
              </div>
              <div>
                <span>Horário de mais uso</span>
                <b>{busiest?.minutes ? `${String(busiest.hour).padStart(2, '0')}h` : '—'}</b>
                <small>hora do dia com mais tempo aberto</small>
              </div>
              <div>
                <span>Aparelho</span>
                <b>{data.devices[0] ? DEVICES[data.devices[0].device] ?? data.devices[0].device : '—'}</b>
                <small>
                  {data.devices.map((item) => `${DEVICES[item.device] ?? item.device} ${duration(item.minutes)}`).join(' · ') || 'sem registro'}
                </small>
              </div>
              <div>
                <span>Em modo TV</span>
                <b>{duration(tv)}</b>
                <small>fora do tempo de uso</small>
              </div>
            </div>

            {!open && !tv ? (
              <p className="shifts-help">
                Nenhum uso registrado neste período. O registro começou a ser feito na implantação
                desta tela; acessos anteriores não aparecem aqui.
              </p>
            ) : (
              <>
                <div className="detail-section">
                  <strong>Tempo em uso por dia</strong>
                  <DailyUsageChart data={data.daily} days={days} label="em uso" />
                </div>
                <div className="usage-two">
                  <div className="detail-section">
                    <strong>Horas do dia</strong>
                    <MinutesBars
                      data={data.hours.map((item) => ({ hora: `${item.hour}h`, minutes: item.minutes }))}
                      dataKey="hora"
                      label="aberta"
                      every={2}
                    />
                  </div>
                  <div className="detail-section">
                    <strong>Dias da semana</strong>
                    <MinutesBars
                      data={data.weekdays.map((item) => ({ dia: WEEKDAYS[item.weekday], minutes: item.minutes }))}
                      dataKey="dia"
                      label="aberta"
                    />
                  </div>
                </div>

                <div className="detail-section">
                  <strong>O que mais vê</strong>
                  <div className="scroll">
                    <table className="detail-table">
                      <thead>
                        <tr>
                          <th>Página</th>
                          <th className="n">Tempo aberta</th>
                          <th className="n">Em uso</th>
                          <th className="n">% do tempo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.pages.map((page) => (
                          <tr key={`${page.label}-${page.tv}`}>
                            <td>{page.label}</td>
                            <td className="n">{duration(page.minutes)}</td>
                            <td className="n">{page.tv ? '—' : duration(page.activeMinutes)}</td>
                            <td className="n">
                              {page.tv || !pagesTotal ? '—' : `${Math.round((page.minutes / pagesTotal) * 100)}%`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="detail-section">
                  <strong>Visitas</strong>
                  <div className="scroll">
                    <table className="detail-table">
                      <thead>
                        <tr>
                          <th>Início</th>
                          <th className="n">Duração</th>
                          <th className="n">Em uso</th>
                          <th>Aparelho</th>
                          <th>Páginas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visits.map((visit) => (
                          <tr key={visit.startedAt}>
                            <td>{when(visit.startedAt)}</td>
                            <td className="n">{duration(visit.minutes)}</td>
                            <td className="n">{duration(visit.activeMinutes)}</td>
                            <td>{DEVICES[visit.device] ?? visit.device}</td>
                            <td className="usage-pages">{visit.pages.join(' · ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            <div className="detail-section">
              <strong>Logins</strong>
              <div className="scroll">
                <table className="detail-table">
                  <thead>
                    <tr>
                      <th>Quando</th>
                      <th>Navegador</th>
                      <th>IP</th>
                      <th>Manter conectado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.logins.map((login) => (
                      <tr key={login.at}>
                        <td>{when(login.at)}</td>
                        <td>{browserOf(login.userAgent)}</td>
                        <td>{login.ip ?? '—'}</td>
                        <td>{login.persistent ? 'sim' : 'não'}</td>
                      </tr>
                    ))}
                    {!data.logins.length && (
                      <tr>
                        <td colSpan={4}>Nenhum login registrado desde a implantação desta tela.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
