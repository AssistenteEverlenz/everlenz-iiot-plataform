'use client';

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePoll } from './data';
import { metricInfo, type ProductionMetric } from './ShiftBoard';

// What is behind each number of the production board: clicking a card opens this. It shows the
// shift hour by hour — how much was produced, how the machine spent the hour — and every pallet
// with the time it took, ranked, so the ceramist sees where the shift was won or lost.

export type DetailFocus = 'produced' | 'target' | 'projection' | 'pace' | 'pallets';

interface PalletEvent {
  at: string;
  seconds: number | null;
  pallets: number;
  product: string | null;
}
interface DetailData {
  span: { start: string; end: string; until: string } | null;
  shiftName: string;
  metric: ProductionMetric;
  hours: {
    hour: string;
    pieces: number;
    pallets: number;
    tons: number;
    producing: number;
    idle: number;
    manual: number;
  }[];
  pallets: PalletEvent[];
}

const TITLES: Record<DetailFocus, string> = {
  produced: 'Produção durante o turno',
  target: 'Meta durante o turno',
  projection: 'Projeção de fechamento',
  pace: 'Ritmo durante o turno',
  pallets: 'Tempo por palete',
};

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function number(value: number | null | undefined, decimals = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
function minutesSeconds(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function ShiftDetailModal({
  deviceId,
  mode,
  focus,
  onClose,
}: {
  deviceId: string;
  mode: 'shift' | 'day';
  focus: DetailFocus;
  onClose: () => void;
}) {
  const detail = usePoll<DetailData>(`/devices/${deviceId}/shift-detail?mode=${mode}`, 60000);
  const data = detail.data;
  const info = metricInfo[data?.metric ?? 'pallets'];

  const hours = useMemo(() => {
    if (!data) return [];
    const valueOf = (hour: DetailData['hours'][number]) =>
      data.metric === 'tons'
        ? hour.tons
        : data.metric === 'pallets'
          ? hour.pallets
          : data.metric === 'blocks'
            ? hour.pieces
            : hour.pieces / 1000;
    let running = 0;
    return data.hours.map((hour) => {
      const value = valueOf(hour);
      running += value;
      return {
        hour: clock(hour.hour),
        value,
        cumulative: running,
        producing: hour.producing / 60,
        stopped: (hour.idle + hour.manual) / 60,
        pallets: hour.pallets,
      };
    });
  }, [data]);

  // Pallets of the shift, best time first: the operator sees which ones dragged.
  const ranking = useMemo(() => {
    const timed = (data?.pallets ?? []).filter((event) => event.seconds != null);
    const sorted = [...timed].sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0));
    const times = sorted.map((event) => event.seconds ?? 0);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    return {
      sorted,
      best: sorted[0] ?? null,
      worst: sorted.at(-1) ?? null,
      median,
      average: times.length ? times.reduce((sum, item) => sum + item, 0) / times.length : null,
      count: data?.pallets.length ?? 0,
    };
  }, [data]);

  const total = hours.at(-1)?.cumulative ?? 0;
  const bestHour = [...hours].sort((a, b) => b.value - a.value)[0] ?? null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card detail-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">DETALHE DO TURNO</div>
            <h2>{TITLES[focus]}</h2>
            {data?.span && (
              <p className="shifts-help">
                {data.shiftName} · {clock(data.span.start)} às {clock(data.span.end)} · atualizado
                até {clock(data.span.until)}
              </p>
            )}
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>

        {detail.loading && <p>Carregando…</p>}
        {detail.error && <div className="form-error">{detail.error}</div>}
        {data && !data.span && <p className="shifts-help">Nenhum turno para detalhar agora.</p>}

        {data?.span && focus !== 'pallets' && (
          <>
            <div className="detail-summary">
              <div>
                <span>Total no turno</span>
                <b>
                  {number(total, info.decimals)} <small>{info.unit}</small>
                </b>
              </div>
              <div>
                <span>Melhor hora</span>
                <b>
                  {bestHour ? `${bestHour.hour}` : '—'}{' '}
                  <small>{bestHour ? number(bestHour.value, info.decimals) : ''}</small>
                </b>
              </div>
              <div>
                <span>Horas com produção</span>
                <b>{hours.filter((hour) => hour.value > 0).length}</b>
              </div>
              <div>
                <span>Paletes no turno</span>
                <b>{number(ranking.count)}</b>
              </div>
            </div>

            <div className="detail-section">
              <strong>Acumulado ao longo do turno</strong>
              <div className="detail-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={hours}>
                    <CartesianGrid stroke="var(--detail-grid)" strokeDasharray="3 6" vertical={false} />
                    <XAxis dataKey="hour" stroke="var(--detail-axis)" fontSize={12} />
                    <YAxis stroke="var(--detail-axis)" fontSize={12} width={48} />
                    <Tooltip
                      formatter={(value) => [
                        `${number(Number(value), info.decimals)} ${info.unit}`,
                        'acumulado',
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="cumulative"
                      stroke="#12b8a6"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="detail-section">
              <strong>Produção por hora</strong>
              <div className="detail-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hours}>
                    <CartesianGrid stroke="var(--detail-grid)" strokeDasharray="3 6" vertical={false} />
                    <XAxis dataKey="hour" stroke="var(--detail-axis)" fontSize={12} />
                    <YAxis stroke="var(--detail-axis)" fontSize={12} width={48} />
                    <Tooltip
                      formatter={(value, name) => [
                        name === 'value'
                          ? `${number(Number(value), info.decimals)} ${info.unit}`
                          : `${number(Number(value))} min`,
                        name === 'value' ? 'produzido' : name === 'producing' ? 'produzindo' : 'parada',
                      ]}
                    />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {hours.map((hour) => (
                        <Cell
                          key={hour.hour}
                          fill={hour.value === bestHour?.value ? '#12b8a6' : '#3d7f96'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="detail-section">
              <strong>Como a máquina passou cada hora</strong>
              <div className="scroll">
                <table className="detail-table">
                  <thead>
                    <tr>
                      <th>Hora</th>
                      <th className="n">Produzido</th>
                      <th className="n">Acumulado</th>
                      <th className="n">Produzindo</th>
                      <th className="n">Parada</th>
                      <th className="n">Paletes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hours.map((hour) => (
                      <tr key={hour.hour}>
                        <td>{hour.hour}</td>
                        <td className="n">{number(hour.value, info.decimals)}</td>
                        <td className="n">{number(hour.cumulative, info.decimals)}</td>
                        <td className="n">{number(hour.producing)} min</td>
                        <td className="n">{number(hour.stopped)} min</td>
                        <td className="n">{number(hour.pallets)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {data?.span && focus === 'pallets' && (
          <>
            <div className="detail-summary">
              <div>
                <span>Paletes</span>
                <b>{number(ranking.count)}</b>
              </div>
              <div>
                <span>Mais rápido</span>
                <b className="good">
                  {minutesSeconds(ranking.best?.seconds)}{' '}
                  <small>{ranking.best ? `às ${clock(ranking.best.at)}` : ''}</small>
                </b>
              </div>
              <div>
                <span>Mediana</span>
                <b>{minutesSeconds(ranking.median)}</b>
              </div>
              <div>
                <span>Mais demorado</span>
                <b className="bad">
                  {minutesSeconds(ranking.worst?.seconds)}{' '}
                  <small>{ranking.worst ? `às ${clock(ranking.worst.at)}` : ''}</small>
                </b>
              </div>
            </div>

            <div className="detail-section">
              <strong>Tempo de cada palete, na ordem do turno</strong>
              <div className="detail-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={(data.pallets ?? [])
                      .filter((event) => event.seconds != null)
                      .map((event, index) => ({
                        label: clock(event.at),
                        minutes: (event.seconds ?? 0) / 60,
                        index,
                      }))}
                  >
                    <CartesianGrid stroke="var(--detail-grid)" strokeDasharray="3 6" vertical={false} />
                    <XAxis dataKey="label" stroke="var(--detail-axis)" fontSize={11} />
                    <YAxis stroke="var(--detail-axis)" fontSize={12} width={48} unit=" min" />
                    <Tooltip
                      formatter={(value) => [minutesSeconds(Number(value) * 60), 'tempo do palete']}
                    />
                    <Bar dataKey="minutes" radius={[4, 4, 0, 0]}>
                      {(data.pallets ?? [])
                        .filter((event) => event.seconds != null)
                        .map((event) => (
                          <Cell
                            key={event.at}
                            fill={
                              ranking.median != null && (event.seconds ?? 0) > ranking.median * 1.5
                                ? '#e4572e'
                                : '#3d7f96'
                            }
                          />
                        ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="shifts-help">
                Em vermelho, os paletes que levaram mais de uma vez e meia a mediana do turno: são
                onde a produção travou.
              </p>
            </div>

            <div className="detail-section">
              <strong>Ranking do turno</strong>
              <div className="scroll">
                <table className="detail-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Fechado às</th>
                      <th className="n">Tempo</th>
                      <th>Produto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.sorted.map((event, index) => (
                      <tr key={event.at}>
                        <td>{index + 1}º</td>
                        <td>{clock(event.at)}</td>
                        <td className="n">{minutesSeconds(event.seconds)}</td>
                        <td>{event.product ?? '—'}</td>
                      </tr>
                    ))}
                    {!ranking.sorted.length && (
                      <tr>
                        <td colSpan={4}>Nenhum palete fechado neste turno ainda.</td>
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
