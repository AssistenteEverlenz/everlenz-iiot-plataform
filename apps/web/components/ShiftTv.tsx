'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { usePoll, type Dashboard, type DashboardWidget, type Device, type Sample } from './data';
import { TvProductsPage } from './TvProductsPage';
import {
  clock,
  duration,
  formatNumber,
  Gauge,
  metricInfo,
  minutesSeconds,
  ShiftCurve,
  stateInfo,
  type ProductionMetric,
  type ShiftBoardResponse,
} from './ShiftBoard';

// Modo TV ("Gestão à Vista"): the production board for a wall screen, on its own 16:9 grid so
// nothing overlaps and nothing scrolls. Page "Turno": the machine state and for how long, an
// alert line, the shift numbers next to the dashboard gauges, the S-curve with today's
// production per product, and the week's targets with each day's availability. Page
// "Produtos": the dashboard's product charts. The pages turn every 20 s by themselves; a TV
// remote's arrow keys (or a click on the header) pick one. Light or dark theme, screen awake.

interface ReportRow {
  kind: 'shift' | 'off_shift';
  open?: boolean;
  source?: 'auto' | 'manual';
  production_date: string;
  pieces: number;
  pallets: number;
  tons: number;
  producing_s?: number;
  idle_s?: number;
  target_metric: ProductionMetric | null;
  target_value: number | null;
  products?: Array<{ product_code: string; pieces: number; pallets: number; tons: number }>;
}
type Tone = 'good' | 'warn' | 'bad';
type Theme = 'dark' | 'light';

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const PALETTE = ['#12b8a6', '#3b82f6', '#f2a93b', '#e4572e', '#a78bfa', '#2bb3e6', '#8aa29e', '#d65db1'];
const THEME_KEY = 'everlenz-tv-theme';
const HOLD_MS = 2 * 60 * 1000;

function plantToday() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
function weekdayOf(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}
function amountOf(row: { pieces: number; pallets: number; tons: number }, metric: ProductionMetric) {
  if (metric === 'milheiros') return Number(row.pieces) / 1000;
  if (metric === 'tons') return Number(row.tons);
  if (metric === 'blocks') return Number(row.pieces);
  return Number(row.pallets);
}
function share(part: number, total: number) {
  return total > 0 ? `${formatNumber((part / total) * 100, 1)}%` : '—';
}

export function ShiftTv({ id }: { id: string }) {
  const dashboard = usePoll<Dashboard>(`/dashboards/${id}`, 300000);
  const deviceId = dashboard.data?.device_id ?? null;
  const device = usePoll<Device>(deviceId ? `/devices/${deviceId}` : null, 300000);
  const board = usePoll<ShiftBoardResponse>(
    deviceId ? `/devices/${deviceId}/shift-board?mode=shift` : null,
    20000,
  );
  const latest = usePoll<Sample[]>(deviceId ? `/devices/${deviceId}/latest` : null, 5000);
  const today = plantToday();
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  const reports = usePoll<{ reports: ReportRow[] }>(
    deviceId ? `/devices/${deviceId}/shift-reports?from=${monday}&to=${today}` : null,
    60000,
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Two pages in turn every 20 s: the shift, then the dashboard's product charts.
  const quickWidgets = (dashboard.data?.widgets ?? [])
    .filter(
      (widget) =>
        ['donut', 'bar_vertical', 'bar_horizontal'].includes(widget.widget_type) && widget.tag_id,
    )
    .slice(0, 4);
  const pages = quickWidgets.length ? 2 : 1;
  const [page, setPage] = useState(0);
  const [holdUntil, setHoldUntil] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() < holdUntil) return;
      setPage((currentPage) => (currentPage + 1) % pages);
    }, 20000);
    return () => clearInterval(timer);
  }, [pages, holdUntil]);
  // A TV remote sends arrow keys: they turn the page, which then holds for two minutes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (pages < 2) return;
      const forward = ['ArrowRight', 'ArrowDown', 'PageDown'].includes(event.key);
      const back = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key);
      if (!forward && !back) return;
      event.preventDefault();
      setPage((currentPage) => (currentPage + (forward ? 1 : pages - 1)) % pages);
      setHoldUntil(Date.now() + HOLD_MS);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pages]);
  const shown = page % pages;

  // Theme: dark by default, remembered on this screen. The platform theme is restored on exit;
  // the screen stays awake where the browser allows it.
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

  const data = board.data;
  const current = data?.board ?? null;
  const metric: ProductionMetric = current?.metric ?? 'pallets';
  const info = metricInfo[metric];
  const state = data?.state ?? 'unknown';
  const target = current?.target ?? null;
  const number = (value: number) => formatNumber(value, info.decimals);
  // How long the machine has been in its current state, from the 5-minute timeline.
  const stateMinutes = useMemo(() => {
    const timeline = current?.timeline ?? [];
    const same = (value: string) =>
      value === state || (state === 'idle' && (value === 'waiting' || value === 'closing'));
    let count = 0;
    for (let index = timeline.length - 1; index >= 0 && same(timeline[index].state); index -= 1)
      count += 1;
    return count * 5;
  }, [current, state]);

  const alert: { tone: Tone; text: string } | null = (() => {
    if (!data || !current) return null;
    if (data.status === 'running' && ['manual', 'idle', 'offline'].includes(state) && stateMinutes >= 10)
      return {
        tone: 'bad',
        text: `Máquina ${stateInfo[state]?.label.toLowerCase() ?? 'parada'} há ${duration(stateMinutes * 60)}`,
      };
    if (!target?.health) return null;
    if (target.health === 'achieved')
      return { tone: 'good', text: `Meta atingida: ${number(target.actual)} de ${number(target.value)} ${info.unit}` };
    if (target.health === 'on_track')
      return {
        tone: 'good',
        text: `No ritmo: fecha em ${number(target.projected)} ${info.unit} (${formatNumber((target.projected / target.value) * 100)}% da meta)`,
      };
    if (target.health === 'missed')
      return { tone: 'bad', text: `Turno fechou em ${number(target.actual)} de ${number(target.value)} ${info.unit}` };
    return {
      tone: target.health === 'at_risk' ? 'warn' : 'bad',
      text: `Para bater ${number(target.value)} ${info.unit} precisa de ${number(target.requiredPerHour ?? 0)} ${info.unit}/h — ritmo atual ${number(target.ratePerHour)} ${info.unit}/h`,
    };
  })();

  // The week, Monday to Sunday: target reached and each day's machine availability.
  const week = useMemo(() => {
    const byDate = new Map<
      string,
      {
        target: number;
        achieved: number;
        metric: ProductionMetric | null;
        open: boolean;
        producing: number;
        idle: number;
      }
    >();
    for (const row of reports.data?.reports ?? []) {
      if (row.kind !== 'shift' || row.source === 'manual') continue;
      const day = byDate.get(row.production_date) ?? {
        target: 0,
        achieved: 0,
        metric: null,
        open: false,
        producing: 0,
        idle: 0,
      };
      if (row.target_value && row.target_metric) {
        day.target += Number(row.target_value);
        day.achieved += amountOf(row, row.target_metric);
        day.metric = row.target_metric;
      }
      day.producing += Number(row.producing_s ?? 0);
      day.idle += Number(row.idle_s ?? 0);
      day.open = day.open || Boolean(row.open);
      byDate.set(row.production_date, day);
    }
    return Array.from({ length: 7 }, (_, index) => {
      const date = addDays(monday, index);
      const day = byDate.get(date);
      const ratio = day && day.target > 0 ? day.achieved / day.target : null;
      const availability =
        day && day.producing + day.idle > 0 ? day.producing / (day.producing + day.idle) : null;
      const future = date > today;
      const status = future || !day
        ? 'none'
        : ratio == null
          ? 'no-target'
          : ratio >= 1
            ? 'met'
            : day.open
              ? 'running'
              : ratio >= 0.9
                ? 'near'
                : 'missed';
      return { date, day, ratio, availability, status, future, isToday: date === today };
    });
  }, [reports.data, monday, today]);

  // Today's production per product: pallets (or pieces) and tons, each with its share.
  const dayMix = useMemo(() => {
    const totals = new Map<string, { pallets: number; tons: number; pieces: number }>();
    for (const row of reports.data?.reports ?? []) {
      if (row.production_date !== today || row.source === 'manual') continue;
      for (const product of row.products ?? []) {
        const total = totals.get(product.product_code) ?? { pallets: 0, tons: 0, pieces: 0 };
        total.pallets += Number(product.pallets);
        total.tons += Number(product.tons);
        total.pieces += Number(product.pieces);
        totals.set(product.product_code, total);
      }
    }
    const list = [...totals]
      .map(([code, total]) => ({ code, ...total }))
      .filter((row) => row.pallets > 0 || row.tons > 0 || row.pieces > 0);
    const pallets = list.reduce((sum, row) => sum + row.pallets, 0);
    const tons = list.reduce((sum, row) => sum + row.tons, 0);
    const pieces = list.reduce((sum, row) => sum + row.pieces, 0);
    const byPallets = pallets > 0;
    list.sort((a, b) => (byPallets ? b.pallets - a.pallets : b.pieces - a.pieces));
    return { list, pallets, tons, pieces, byPallets };
  }, [reports.data, today]);

  const gauges = (dashboard.data?.widgets ?? [])
    .filter((widget) => widget.widget_type === 'gauge' && widget.tag_id)
    .slice(0, 2);
  const sampleOf = (widget: DashboardWidget) =>
    latest.data?.find((sample) => sample.tag_id === widget.tag_id);
  const shift = data?.shifts[0];
  const pace = current?.palletTiming;
  const pct = target && target.value > 0 ? target.actual / target.value : null;
  const targetTone =
    target?.health === 'achieved' || target?.health === 'on_track'
      ? 'good'
      : target?.health === 'at_risk'
        ? 'warn'
        : target?.health
          ? 'bad'
          : '';

  return (
    <div className={`tv3 ${theme}`}>
      <header className="tv3-head">
        <div className="tv3-title">
          <span className="tv3-eyebrow">GESTÃO À VISTA · PRODUÇÃO</span>
          <h1>
            {device.data?.name ?? dashboard.data?.name ?? 'Carregando…'}
            {device.data?.site_name && device.data.site_name !== device.data.name && (
              <small> · {device.data.site_name}</small>
            )}
          </h1>
        </div>
        <div className="tv3-shift">
          <strong>
            {shift ? `${shift.name} · ${clock(shift.start)}–${clock(shift.end)}` : 'Sem turno agora'}
          </strong>
          <span>
            {data?.status === 'running' && current
              ? `termina em ${duration((new Date(current.span.end).getTime() - now.getTime()) / 1000)}`
              : data?.next
                ? `próximo turno ${clock(data.next.start)}`
                : ''}
            {data?.product ? ` · ${data.product}` : ''}
          </span>
        </div>
        <div className="tv3-right">
          {pages > 1 && (
            <span
              className="tv3-pages"
              role="group"
              aria-label="Página da TV"
              title="As páginas trocam sozinhas a cada 20 s; as setas do controle remoto também trocam"
            >
              {['Turno', 'Produtos'].map((label, index) => (
                <button
                  key={label}
                  type="button"
                  className={shown === index ? 'active' : ''}
                  onClick={() => {
                    setPage(index);
                    setHoldUntil(Date.now() + HOLD_MS);
                  }}
                >
                  {label}
                </button>
              ))}
            </span>
          )}
          <span
            className="tv3-state"
            style={{ '--state': stateInfo[state]?.color ?? '#98a6ab' } as React.CSSProperties}
          >
            <i />
            {stateInfo[state]?.label ?? 'Sem dados'}
            {stateMinutes >= 5 && <small>há {duration(stateMinutes * 60)}</small>}
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
          <Link className="tv3-icon" href={`/dashboards/${id}`} aria-label="Sair da TV">
            ✕
          </Link>
        </div>
      </header>

      {alert && <div className={`tv3-alert ${alert.tone}`}>{alert.text}</div>}

      {shown === 1 ? (
        <TvProductsPage dashboardId={id} widgets={quickWidgets} />
      ) : !data ? (
        <div className="tv3-loading">
          {board.error ?? dashboard.error ?? <span className="detail-spinner" aria-label="Carregando" />}
        </div>
      ) : (
        // A div, not <main>: the platform shell offsets every <main> by the sidebar width.
        <div className="tv3-main">
          <section className="tv3-kpis">
            <div className="tv3-kpi">
              <span>Produzido</span>
              <b>
                {formatNumber(current?.totals.milheiros ?? 0, 1)} <small>milheiros</small>
              </b>
              <em>
                {formatNumber(current?.totals.pieces ?? 0)} peças ·{' '}
                {formatNumber(current?.totals.pallets ?? 0)} paletes ·{' '}
                {formatNumber(current?.totals.tons ?? 0, 1)} t
              </em>
            </div>
            <div className={`tv3-kpi ${targetTone}`}>
              <span>Meta</span>
              {target ? (
                <>
                  <b>
                    {pct == null ? '—' : `${formatNumber(pct * 100)}%`}{' '}
                    <small>
                      {number(target.actual)} de {number(target.value)} {info.unit}
                    </small>
                  </b>
                  <em>esperado agora {number(target.plannedToNow)}</em>
                </>
              ) : (
                <>
                  <b className="muted">Sem meta</b>
                  <em>defina no quadro de produção</em>
                </>
              )}
            </div>
            <div className="tv3-kpi">
              <span>Projeção</span>
              <b>
                {number(target ? target.projected : (current?.pacePerHour ?? 0) * ((current?.plannedSeconds ?? 0) / 3600))}{' '}
                <small>{info.unit}</small>
              </b>
              <em>{target ? `${formatNumber((target.projected / target.value) * 100)}% da meta` : 'no ritmo da última hora'}</em>
            </div>
            <div className="tv3-kpi">
              <span>Ritmo</span>
              <b>
                {number(current?.pacePerHour ?? 0)} <small>{info.unit}/h</small>
              </b>
              <em>
                {target?.requiredPerHour != null && (current?.remainingSeconds ?? 0) > 0
                  ? `necessário ${number(target.requiredPerHour)} ${info.unit}/h`
                  : `aproveitamento ${current?.utilization == null ? '—' : `${formatNumber(current.utilization * 100)}%`}`}
              </em>
            </div>
            <div className="tv3-kpi">
              <span>Tempo por palete</span>
              <b>
                {minutesSeconds(pace?.averageSeconds)} <small>média</small>
              </b>
              <em>
                último {minutesSeconds(pace?.lastSeconds)}
                {pace?.lastAt ? ` · às ${clock(pace.lastAt)}` : ''}
              </em>
            </div>
            {gauges.map((widget) => (
              <TvGauge key={widget.id} widget={widget} sample={sampleOf(widget)} />
            ))}
          </section>

          {current ? (
            <section className="tv3-card tv3-curve">
              <div className="tv3-card-title">
                <strong>Curva S · {info.name} acumulados</strong>
                <span className="tv3-curve-legend">
                  <i className="planned" /> planejado <i className="actual" /> realizado{' '}
                  <i className="projected" /> projeção
                </span>
              </div>
              {/* The colours under "realizado" are the machine states. */}
              <div className="tv3-legend tv3-curve-states">
                {[...new Set(current.timeline.map((segment) => segment.state))].map((item) => (
                  <span key={item}>
                    <i style={{ background: stateInfo[item]?.color }} />
                    {stateInfo[item]?.label ?? item}
                  </span>
                ))}
              </div>
              <div className="tv3-chart">
                <ShiftCurve board={current} fontSize={13} />
              </div>
            </section>
          ) : (
            <section className="tv3-card tv3-curve tv3-empty-shift">
              <strong>Sem turno em andamento</strong>
              <span>
                {data.next
                  ? `Próximo turno às ${clock(data.next.start)}`
                  : 'Cadastre os turnos da fábrica na tela Produção.'}
              </span>
            </section>
          )}

          <section className="tv3-card tv3-daymix">
            <div className="tv3-card-title">
              <strong>Produção por produto · hoje</strong>
              <span>
                {formatNumber(dayMix.byPallets ? dayMix.pallets : dayMix.pieces)}{' '}
                {dayMix.byPallets ? 'paletes' : 'peças'} · {formatNumber(dayMix.tons, 1)} t
              </span>
            </div>
            {dayMix.list.length ? (
              <div className="tv3-daymix-body">
                <div className="tv3-donut">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={dayMix.list}
                        dataKey={dayMix.byPallets ? 'pallets' : 'pieces'}
                        nameKey="code"
                        innerRadius="58%"
                        outerRadius="96%"
                        stroke="none"
                        isAnimationActive={false}
                      >
                        {dayMix.list.map((row, index) => (
                          <Cell key={row.code} fill={PALETTE[index % PALETTE.length]} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="tv3-mixlist">
                  {dayMix.list.slice(0, 4).map((row, index) => (
                    <li key={row.code}>
                      <span className="tv3-mixlist-name">
                        <i style={{ background: PALETTE[index % PALETTE.length] }} />
                        {row.code}
                      </span>
                      <span className="tv3-mixlist-values">
                        <b>{formatNumber(dayMix.byPallets ? row.pallets : row.pieces)} un</b>{' '}
                        <small>
                          {share(
                            dayMix.byPallets ? row.pallets : row.pieces,
                            dayMix.byPallets ? dayMix.pallets : dayMix.pieces,
                          )}
                        </small>
                        <span className="tv3-mixlist-sep">|</span>
                        <b>{formatNumber(row.tons, 1)} t</b> <small>{share(row.tons, dayMix.tons)}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="tv3-empty">Sem produção hoje.</p>
            )}
          </section>

          <section className="tv3-card tv3-week">
            <div className="tv3-card-title">
              <strong>Meta da semana</strong>
              <span>% da meta · produzido de previsto · aproveitamento da máquina</span>
            </div>
            <div className="tv3-week-days">
              {week.map((item) => {
                const unit = item.day?.metric ? metricInfo[item.day.metric] : null;
                return (
                  <div
                    key={item.date}
                    className={`tv3-day ${item.isToday ? 'today' : ''}`}
                    data-goal={item.status}
                  >
                    <div className="tv3-day-head">
                      <span>
                        {WEEKDAYS[weekdayOf(item.date)]} {item.date.slice(8)}/{item.date.slice(5, 7)}
                      </span>
                      {item.isToday && <em>hoje</em>}
                    </div>
                    <div className="tv3-day-body">
                      <div className="tv3-day-goal">
                        <b>{item.ratio == null ? '—' : `${formatNumber(item.ratio * 100)}%`}</b>
                        <small>
                          {item.day && item.ratio != null && unit
                            ? `${formatNumber(item.day.achieved, unit.decimals)} de ${formatNumber(item.day.target, unit.decimals)} ${unit.unit}`
                            : item.future
                              ? ''
                              : item.day
                                ? 'sem meta'
                                : 'sem turno'}
                        </small>
                      </div>
                      {item.availability != null && (
                        <div className="tv3-day-util" title="Aproveitamento: produzindo ÷ (produzindo + ociosa)">
                          <Gauge value={item.availability} />
                          <small>aproveitamento</small>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/** A gauge card of the dashboard (PeçasHora, ToneladaHora…) at wall size. */
function TvGauge({ widget, sample }: { widget: DashboardWidget; sample?: Sample }) {
  const min = widget.config.min ?? 0;
  const max = widget.config.max ?? 100;
  const decimals = widget.config.decimals ?? 1;
  const value = sample?.value_number ?? null;
  const ratio =
    value == null || max <= min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angle = Math.PI * (1 - ratio);
  const x = 60 + 48 * Math.cos(angle);
  const y = 60 - 48 * Math.sin(angle);
  return (
    <div className="tv3-kpi tv3-gauge">
      <span>{widget.title}</span>
      <svg viewBox="0 0 120 74" role="img" aria-label={widget.title}>
        <path d="M12 60 A48 48 0 0 1 108 60" className="tv3-gauge-track" />
        {ratio > 0 && (
          <path d={`M12 60 A48 48 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`} className="tv3-gauge-value" />
        )}
        <text x="60" y="55" textAnchor="middle" className="tv3-gauge-number">
          {value == null ? '—' : formatNumber(value, decimals)}
        </text>
        <text x="12" y="72" textAnchor="middle" className="tv3-gauge-limit">
          {formatNumber(min, decimals)}
        </text>
        <text x="108" y="72" textAnchor="middle" className="tv3-gauge-limit">
          {formatNumber(max, decimals)}
        </text>
      </svg>
    </div>
  );
}
