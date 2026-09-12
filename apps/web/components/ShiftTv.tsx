'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { usePoll, type Dashboard, type Device } from './data';
import {
  clock,
  duration,
  formatNumber,
  metricInfo,
  ShiftBoardView,
  stateInfo,
  type ProductionMetric,
  type ShiftBoardResponse,
} from './ShiftBoard';

// Modo TV ("Gestão à Vista"): the production board for a wall screen. One 16:9 page without
// scrolling, readable from a distance: the machine's state and for how long, an alert line,
// the shift board (numbers, S-curve, availability, timeline) and, below, this week's targets
// and the products of the shift. It refreshes by itself, in the dark theme, and keeps the
// screen awake where the browser allows it.

interface ReportRow {
  kind: 'shift' | 'off_shift';
  open?: boolean;
  source?: 'auto' | 'manual';
  production_date: string;
  pieces: number;
  pallets: number;
  tons: number;
  target_metric: ProductionMetric | null;
  target_value: number | null;
}
type Tone = 'good' | 'warn' | 'bad';

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

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
function amountOf(
  row: { pieces: number; pallets: number; tons: number; milheiros?: number },
  metric: ProductionMetric,
) {
  if (metric === 'milheiros') return Number(row.pieces) / 1000;
  if (metric === 'tons') return Number(row.tons);
  if (metric === 'blocks') return Number(row.pieces);
  return Number(row.pallets);
}

export function ShiftTv({ id }: { id: string }) {
  const dashboard = usePoll<Dashboard>(`/dashboards/${id}`, 300000);
  const deviceId = dashboard.data?.device_id ?? null;
  const device = usePoll<Device>(deviceId ? `/devices/${deviceId}` : null, 300000);
  const board = usePoll<ShiftBoardResponse>(
    deviceId ? `/devices/${deviceId}/shift-board?mode=shift` : null,
    20000,
  );
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
  // Dark theme while the TV is open; the screen stays awake where the browser allows it.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = 'dark';
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
    return () => {
      if (previous) root.dataset.theme = previous;
      else delete root.dataset.theme;
      void lock?.release().catch(() => undefined);
    };
  }, []);

  const data = board.data;
  const current = data?.board ?? null;
  const metric: ProductionMetric = current?.metric ?? 'pallets';
  const info = metricInfo[metric];
  const state = data?.state ?? 'unknown';
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
  const shift = data?.shifts[0];
  const target = current?.target ?? null;
  const unit = info.unit;
  const number = (value: number) => formatNumber(value, info.decimals);

  const alert: { tone: Tone; text: string } | null = (() => {
    if (!data || !current) return null;
    const stoppedStates = ['manual', 'idle', 'offline'];
    if (data.status === 'running' && stoppedStates.includes(state) && stateMinutes >= 10)
      return {
        tone: 'bad',
        text: `Máquina ${stateInfo[state]?.label.toLowerCase() ?? 'parada'} há ${duration(stateMinutes * 60)}`,
      };
    if (!target || !target.health) return null;
    if (target.health === 'achieved')
      return {
        tone: 'good',
        text: `Meta atingida: ${number(target.actual)} de ${number(target.value)} ${unit}`,
      };
    if (target.health === 'on_track')
      return {
        tone: 'good',
        text: `No ritmo: fecha em ${number(target.projected)} ${unit} (${formatNumber((target.projected / target.value) * 100)}% da meta)`,
      };
    if (target.health === 'missed')
      return {
        tone: 'bad',
        text: `Turno fechou em ${number(target.actual)} de ${number(target.value)} ${unit}`,
      };
    return {
      tone: target.health === 'at_risk' ? 'warn' : 'bad',
      text: `Para bater ${number(target.value)} ${unit} precisa de ${number(target.requiredPerHour ?? 0)} ${unit}/h — ritmo atual ${number(target.ratePerHour)} ${unit}/h`,
    };
  })();

  // This week's targets, Monday to Sunday, from the shift history.
  const week = useMemo(() => {
    const byDate = new Map<
      string,
      { target: number; achieved: number; metric: ProductionMetric | null; open: boolean }
    >();
    for (const row of reports.data?.reports ?? []) {
      if (row.kind !== 'shift' || row.source === 'manual') continue;
      const day = byDate.get(row.production_date) ?? {
        target: 0,
        achieved: 0,
        metric: null,
        open: false,
      };
      if (row.target_value && row.target_metric) {
        day.target += Number(row.target_value);
        day.achieved += amountOf(row, row.target_metric);
        day.metric = row.target_metric;
      }
      day.open = day.open || Boolean(row.open);
      byDate.set(row.production_date, day);
    }
    return Array.from({ length: 7 }, (_, index) => {
      const date = addDays(monday, index);
      const day = byDate.get(date);
      const ratio = day && day.target > 0 ? day.achieved / day.target : null;
      const status =
        date > today
          ? 'none'
          : !day
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
      return { date, day, ratio, status, future: date > today };
    });
  }, [reports.data, monday, today]);

  const products = useMemo(() => {
    const rows = (current?.products ?? []).map((product) => ({
      code: product.product_code,
      amount: amountOf(product, metric),
    }));
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    return rows
      .filter((row) => row.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .map((row) => ({ ...row, share: total > 0 ? row.amount / total : 0 }));
  }, [current, metric]);

  return (
    <div className="tv2">
      <header className="tv2-head">
        <div className="tv2-title">
          <span className="tv2-eyebrow">GESTÃO À VISTA · PRODUÇÃO</span>
          <h1>{device.data?.name ?? dashboard.data?.name ?? 'Carregando…'}</h1>
          <small>{device.data?.site_name ?? ''}</small>
        </div>
        <div className="tv2-shift">
          <strong>
            {shift ? `${shift.name} · ${clock(shift.start)}–${clock(shift.end)}` : 'Sem turno agora'}
          </strong>
          <span>
            {data?.status === 'running' && current
              ? `termina em ${duration((new Date(current.span.end).getTime() - now.getTime()) / 1000)}`
              : data?.next
                ? `próximo turno ${clock(data.next.start)}`
                : ''}
            {data?.product ? ` · produto ${data.product}` : ''}
          </span>
        </div>
        <div className="tv2-right">
          <span
            className="tv2-state"
            style={{ '--state': stateInfo[state]?.color ?? '#98a6ab' } as React.CSSProperties}
          >
            <i />
            {stateInfo[state]?.label ?? 'Sem dados'}
            {stateMinutes >= 5 && <small>há {duration(stateMinutes * 60)}</small>}
          </span>
          <strong className="tv2-clock">
            {now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            <small>
              {now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}
            </small>
          </strong>
          <button
            type="button"
            className="tv2-icon"
            title="Tela cheia"
            aria-label="Tela cheia"
            onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}
          >
            ⛶
          </button>
          <Link className="tv2-icon" href={`/dashboards/${id}`} aria-label="Sair da TV">
            ✕
          </Link>
        </div>
      </header>

      {alert && <div className={`tv2-alert ${alert.tone}`}>{alert.text}</div>}

      <main className="tv2-board">
        {data && deviceId ? (
          <ShiftBoardView data={data} deviceId={deviceId} hideHead />
        ) : (
          <div className="tv2-loading">
            {board.error ?? dashboard.error ?? <span className="detail-spinner" aria-label="Carregando" />}
          </div>
        )}
      </main>

      <footer className="tv2-bottom">
        <section className="tv2-card">
          <div className="tv2-card-title">Meta da semana</div>
          <div className="tv2-week">
            {week.map((item) => (
              <div key={item.date} className="tv2-day" data-goal={item.status}>
                <span>
                  {WEEKDAYS[weekdayOf(item.date)]} {item.date.slice(8)}/{item.date.slice(5, 7)}
                </span>
                <b>{item.ratio == null ? '—' : `${formatNumber(item.ratio * 100)}%`}</b>
                <small>
                  {item.day && item.ratio != null && item.day.metric
                    ? `${formatNumber(item.day.achieved, metricInfo[item.day.metric].decimals)} de ${formatNumber(item.day.target, metricInfo[item.day.metric].decimals)}`
                    : item.future
                      ? ''
                      : item.day
                        ? 'sem meta'
                        : 'sem turno'}
                </small>
              </div>
            ))}
          </div>
        </section>
        <section className="tv2-card">
          <div className="tv2-card-title">Produtos do turno · {info.name}</div>
          {products.length ? (
            <ul className="tv2-products">
              {products.slice(0, 4).map((product) => (
                <li key={product.code}>
                  <span title={product.code}>{product.code}</span>
                  <i>
                    <em style={{ width: `${Math.max(3, product.share * 100)}%` }} />
                  </i>
                  <b>{formatNumber(product.amount, info.decimals)}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="tv2-empty">Sem produção no turno.</p>
          )}
        </section>
      </footer>
    </div>
  );
}
