'use client';

import { useEffect, useState } from 'react';
import { usePoll } from './data';
import { ModalPortal } from './ModalPortal';
import { metricInfo, type ProductionMetric } from './ShiftBoard';

// The summary a panel opens with (apps/api/src/briefing.ts). The plants' people come back five to
// nine times a day, a minute each time, on the phone, to ask how production is going: this says
// it in one screen, then any touch opens the panel itself.

interface Briefing {
  configured: boolean;
  device: { id: string; name: string };
  now: string;
  shiftStatus: 'running' | 'finished';
  shifts: Array<{ name: string; start: string; end: string }>;
  metric: ProductionMetric;
  state: { state: string; since: string | null; product: string | null };
  made: number;
  totals: { pieces: number; milheiros: number; pallets: number; tons: number };
  target: {
    value: number;
    actual: number;
    plannedToNow: number;
    projected: number;
    requiredPerHour: number | null;
  } | null;
  pacePerHour: number;
  utilization: number | null;
  stopped: { count: number; seconds: number };
  yesterday: number;
  sinceVisit: { at: string; made: number; stops: number } | null;
}

/** A visit is over after ten quiet minutes (the same rule as the usage page). */
const SHOWN_AGAIN_AFTER_MS = 10 * 60_000;
const STATES: Record<string, { label: string; tone: string }> = {
  producing: { label: 'Produzindo', tone: 'good' },
  idle: { label: 'Parada · ociosa', tone: 'warn' },
  manual: { label: 'Parada · manual', tone: 'bad' },
  offline: { label: 'Sem comunicação', tone: 'muted' },
  unknown: { label: 'Sem leitura', tone: 'muted' },
};

const number = (value: number, decimals = 0) =>
  value.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
function ago(iso: string | null, now: string) {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((new Date(now).getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${String(rest).padStart(2, '0')}` : `${hours}h`;
}
/** '1h18', '45 min', '0 min'. */
function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${String(rest).padStart(2, '0')}` : `${hours}h`;
}
function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Opens once per visit of a panel, on top of it, until any touch. */
export function BriefingModal({ deviceId, dashboardId }: { deviceId: string; dashboardId: string }) {
  const key = `briefing:${dashboardId}`;
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    try {
      const last = Number(sessionStorage.getItem(key) ?? 0);
      if (Date.now() - last > SHOWN_AGAIN_AFTER_MS) setWanted(true);
    } catch {
      setWanted(true);
    }
  }, [key]);
  const briefing = usePoll<Briefing>(wanted ? `/devices/${deviceId}/briefing` : null, 600000);
  const close = () => {
    setWanted(false);
    try {
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // Without storage it simply opens again next time.
    }
  };
  // Leaving the panel while it is open also counts as having seen it.
  useEffect(() => {
    if (!wanted) return undefined;
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  });

  const data = briefing.data;
  if (!wanted || !data?.configured) return null;
  const info = metricInfo[data.metric] ?? metricInfo.pallets;
  const state = STATES[data.state.state] ?? STATES.unknown;
  const target = data.target;
  const share = target && target.value > 0 ? data.made / target.value : null;
  const expected = target && target.value > 0 ? Math.min(1, target.plannedToNow / target.value) : null;
  const projectedShare = target && target.value > 0 ? target.projected / target.value : null;
  const verdict = !target
    ? null
    : data.made >= target.value
      ? { tone: 'good', text: `Meta batida: ${number(data.made, info.decimals)} de ${number(target.value, info.decimals)} ${info.unit}.` }
      : data.shiftStatus === 'finished'
        ? { tone: 'bad', text: `Turno encerrado em ${Math.round((share ?? 0) * 100)}% da meta.` }
        : {
            tone: (projectedShare ?? 0) >= 1 ? 'good' : (projectedShare ?? 0) >= 0.9 ? 'warn' : 'bad',
            text: `No ritmo atual, fecha em ${number(target.projected, info.decimals)} ${info.unit} (${Math.round((projectedShare ?? 0) * 100)}% da meta).`,
          };
  const versus = data.yesterday > 0 ? data.made / data.yesterday - 1 : null;

  return (
    <ModalPortal>
      <div
        className="briefing-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="Resumo da operação"
        // Any touch, inside the card or out of it, opens the panel.
        onClick={close}
      >
        <div className="briefing-card">
          <header className="briefing-head">
            <div>
              <span className="briefing-eyebrow">Resumo da operação · hoje {clock(data.now)}</span>
              <h2>{data.device.name}</h2>
            </div>
            <button type="button" className="icon-button" aria-label="Fechar" onClick={close}>
              ×
            </button>
          </header>

          <div className={`briefing-state ${state.tone}`}>
            <i />
            <b>{state.label}</b>
            {data.state.since && <span>há {ago(data.state.since, data.now)}</span>}
            {data.state.product && <em>{data.state.product}</em>}
          </div>

          <section className="briefing-hero">
            <span>Produzido hoje</span>
            <strong>
              {number(data.made, info.decimals)} <small>{info.unit}</small>
            </strong>
            {target && (
              <>
                <div className="briefing-progress" aria-hidden="true">
                  <i style={{ width: `${Math.min(100, (share ?? 0) * 100)}%` }} />
                  {expected != null && <u style={{ left: `${expected * 100}%` }} />}
                </div>
                <small>
                  meta {number(target.value, info.decimals)} · esperado agora{' '}
                  {number(target.plannedToNow, info.decimals)}
                </small>
              </>
            )}
            {verdict && <p className={`briefing-verdict ${verdict.tone}`}>{verdict.text}</p>}
          </section>

          <section className="briefing-tiles">
            <div>
              <span>Ritmo</span>
              <b>
                {number(data.pacePerHour, info.decimals)} <small>{info.unit}/h</small>
              </b>
              {target?.requiredPerHour != null && data.shiftStatus === 'running' && (
                <em>precisa de {number(target.requiredPerHour, info.decimals)}/h</em>
              )}
            </div>
            <div>
              <span>Aproveitamento</span>
              <b>{data.utilization == null ? '—' : `${Math.round(data.utilization * 100)}%`}</b>
              <em>da máquina no turno</em>
            </div>
            <div>
              <span>Paradas hoje</span>
              <b>{data.stopped.count}</b>
              <em>{duration(data.stopped.seconds)} parada no turno</em>
            </div>
            <div>
              <span>Contra ontem</span>
              <b className={versus == null ? '' : versus >= 0 ? 'up' : 'down'}>
                {versus == null ? '—' : `${versus >= 0 ? '+' : ''}${Math.round(versus * 100)}%`}
              </b>
              <em>
                ontem até {clock(data.now)}: {number(data.yesterday, info.decimals)}
              </em>
            </div>
          </section>

          {data.sinceVisit && (
            <section className="briefing-since">
              <span>Desde a sua última visita, há {ago(data.sinceVisit.at, data.now)}</span>
              <b>
                {data.sinceVisit.made > 0 ? '+' : ''}
                {number(data.sinceVisit.made, info.decimals)} {info.unit} ·{' '}
                {data.sinceVisit.stops === 0
                  ? 'nenhuma parada'
                  : `${data.sinceVisit.stops} parada${data.sinceVisit.stops === 1 ? '' : 's'}`}
              </b>
            </section>
          )}

          <div className="briefing-foot">Toque em qualquer lugar para abrir o painel</div>
        </div>
      </div>
    </ModalPortal>
  );
}
