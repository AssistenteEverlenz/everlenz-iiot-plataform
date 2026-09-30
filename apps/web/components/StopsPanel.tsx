'use client';

import { useMemo, useState } from 'react';
import { usePoll } from './data';

/**
 * How often the line stopped, and for how long (migration 032).
 *
 * The five-minute buckets always knew how many seconds a machine spent stopped, but never how
 * many times it stopped, and seconds cannot be turned back into a count. Twelve stops of two
 * minutes and one stop of twenty-four are the same number of seconds and completely different
 * problems: the first is a line that keeps tripping, the second is a breakdown.
 */
type Stops = {
  from: string;
  to: string;
  days: Array<{
    date: string;
    stops: number;
    seconds: number;
    pauses: number;
    pauseSeconds: number;
    longestSeconds: number;
  }>;
  reasons: Array<{ state: string; stops: number; seconds: number }>;
  longest: Array<{ startedAt: string; seconds: number; state: string; product: string | null }>;
};

const REASONS: Record<string, { label: string; color: string }> = {
  idle: { label: 'Ociosa', color: '#f2a93b' },
  manual: { label: 'Manual / parada', color: '#e4572e' },
  offline: { label: 'Sem comunicação', color: '#98a6ab' },
};

/** A duration as a plant says it: "2 min", "1h05". */
function duration(seconds: number) {
  if (!seconds || seconds < 60) return `${Math.round(seconds || 0)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
    : `${minutes} min`;
}
const day = (date: string) => date.split('-').reverse().slice(0, 2).join('/');
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function StopsPanel({ deviceId, days = 14 }: { deviceId: string; days?: number }) {
  const [window, setWindow] = useState(days);
  const stops = usePoll<Stops>(`/devices/${deviceId}/stops?days=${window}`, 120000);

  const totals = useMemo(() => {
    const rows = stops.data?.days ?? [];
    const count = rows.reduce((sum, row) => sum + row.stops, 0);
    const seconds = rows.reduce((sum, row) => sum + row.seconds, 0);
    const worked = rows.filter((row) => row.stops > 0).length;
    return {
      count,
      seconds,
      // Days with no stop at all are not averaged in: they would flatter the number.
      perDay: worked ? count / worked : 0,
      average: count ? seconds / count : 0,
      longest: rows.reduce((most, row) => Math.max(most, row.longestSeconds), 0),
      short: (stops.data?.longest ?? []).length,
    };
  }, [stops.data]);

  const peak = Math.max(1, ...(stops.data?.days ?? []).map((row) => row.stops));

  if (!stops.data)
    return <div className="stops-empty">{stops.error ?? 'Carregando paradas…'}</div>;

  return (
    <div className="stops-panel">
      <div className="stops-window">
        {[7, 14, 30, 90].map((option) => (
          <button
            key={option}
            type="button"
            className={window === option ? 'active' : ''}
            onClick={() => setWindow(option)}
          >
            {option} dias
          </button>
        ))}
      </div>

      <div className="stops-totals">
        <div>
          <span>Paradas</span>
          <b>{totals.count}</b>
          <small>{totals.perDay ? `${totals.perDay.toFixed(1)} por dia produzido` : 'nenhuma ainda'}</small>
        </div>
        <div>
          <span>Tempo parado</span>
          <b>{duration(totals.seconds)}</b>
          <small>somado no período</small>
        </div>
        <div>
          <span>Parada média</span>
          <b>{duration(totals.average)}</b>
          <small>cada vez que parou</small>
        </div>
        <div>
          <span>Maior parada</span>
          <b>{duration(totals.longest)}</b>
          <small>a mais longa do período</small>
        </div>
      </div>

      {Boolean(stops.data.reasons.length) && (
        <>
          <div className="stops-title">Por motivo</div>
          <div className="stops-reasons">
            {stops.data.reasons.map((reason) => {
              const info = REASONS[reason.state] ?? { label: reason.state, color: '#98a6ab' };
              const share = totals.count ? (reason.stops / totals.count) * 100 : 0;
              return (
                <div key={reason.state}>
                  <div className="stops-reason-head">
                    <i style={{ background: info.color }} />
                    <strong>{info.label}</strong>
                    <span>
                      {reason.stops}× · {duration(reason.seconds)}
                    </span>
                  </div>
                  <div className="stops-bar">
                    <i style={{ width: `${share}%`, background: info.color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="stops-title">Dia a dia</div>
      <div className="stops-days">
        {stops.data.days.map((row) => (
          <div className="stops-day" key={row.date} title={`${row.stops} parada(s) · ${duration(row.seconds)}`}>
            <div className="stops-day-bar">
              <i style={{ height: `${(row.stops / peak) * 100}%` }} />
            </div>
            <b>{row.stops}</b>
            <small>{day(row.date)}</small>
          </div>
        ))}
        {!stops.data.days.length && (
          <div className="stops-empty">
            Nenhuma parada registrada ainda. A contagem começa a partir do dia em que a
            plataforma passou a gravá-las.
          </div>
        )}
      </div>

      {Boolean(stops.data.longest.length) && (
        <>
          <div className="stops-title">As mais longas</div>
          <table className="stops-table">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Motivo</th>
                <th>Produto</th>
                <th className="n">Durou</th>
              </tr>
            </thead>
            <tbody>
              {stops.data.longest.slice(0, 6).map((item) => (
                <tr key={item.startedAt}>
                  <td>
                    {day(item.startedAt.slice(0, 10))} às {clock(item.startedAt)}
                  </td>
                  <td>{REASONS[item.state]?.label ?? item.state}</td>
                  <td>{item.product ?? '—'}</td>
                  <td className="n">{duration(item.seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
