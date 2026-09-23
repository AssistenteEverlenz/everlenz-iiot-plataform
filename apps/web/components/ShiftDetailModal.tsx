'use client';

import { useMemo, useState } from 'react';
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
import { evaluateFormula, formulaVariables, parseFormula } from './formula';

/** A formula the master wrote on the card: the modal charts it hour by hour. */
export interface CalculatedSetting {
  id: string;
  label: string;
  formula: string;
  unit?: string;
  decimals?: number;
}

// What is behind each number of the production board: clicking a card opens this. It shows the
// shift hour by hour — how much was produced, how the machine spent the hour — and every pallet
// with the time it took, ranked, so the ceramist sees where the shift was won or lost. The
// production report shows the same charts for a closed shift, through ShiftDetailCharts.

export type DetailFocus = 'produced' | 'target' | 'projection' | 'pace' | 'pallets';

interface PalletEvent {
  at: string;
  seconds: number | null;
  pallets: number;
  product: string | null;
}
export const DETAIL_STEPS = [
  { minutes: 5, label: '5 min' },
  { minutes: 10, label: '10 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hora' },
] as const;

export interface DetailData {
  span: { start: string; end: string; until: string } | null;
  shiftName: string;
  metric: ProductionMetric;
  step?: number;
  /** One entry per period of the chosen step: the field is named after the first version. */
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
  /** Hourly average of each variable a calculated field reads. */
  variables?: Record<string, Array<{ hour: string; value: number }>>;
}

/** The variables every formula of a card needs, to ask the server for them in one go. */
export function formulaKeys(fields: CalculatedSetting[]) {
  const keys = new Set<string>();
  for (const field of fields) {
    try {
      for (const name of formulaVariables(parseFormula(field.formula)))
        if (!name.startsWith('turno.')) keys.add(name);
    } catch {
      // A formula still being written asks for nothing.
    }
  }
  return [...keys];
}

/** The shift variables as they were in one hour: the chart of a formula reads these. */
function hourVariables(hour: DetailData['hours'][number]): Record<string, number> {
  const stopped = hour.idle + hour.manual;
  const busy = hour.producing + stopped;
  return {
    'turno.pecas': hour.pieces,
    'turno.milheiros': hour.pieces / 1000,
    'turno.paletes': hour.pallets,
    'turno.toneladas': hour.tons,
    'turno.horas_produzindo': hour.producing / 3600,
    'turno.minutos_produzindo': hour.producing / 60,
    'turno.horas_paradas': stopped / 3600,
    'turno.horas_decorridas': busy / 3600,
    'turno.aproveitamento': busy > 0 ? (hour.producing / busy) * 100 : 0,
    'turno.ritmo': hour.producing > 0 ? hour.pallets / (hour.producing / 3600) : 0,
    'turno.paletes_tempo_medio': hour.pallets > 0 ? hour.producing / hour.pallets : 0,
  };
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

/** The shift's analysis: hour by hour, and every pallet with the time it took. */
export function ShiftDetailCharts({
  data,
  focus = 'produced',
  calculated = [],
}: {
  data: DetailData | null;
  focus?: DetailFocus;
  /** Calculated fields of the card: each one becomes a chart over the shift. */
  calculated?: CalculatedSetting[];
}) {
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

  // Pallets of the shift, fastest first: the operator sees which ones dragged.
  const ranking = useMemo(() => {
    const timed = (data?.pallets ?? []).filter((event) => event.seconds != null);
    const sorted = [...timed].sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0));
    const times = sorted.map((event) => event.seconds ?? 0);
    return {
      sorted,
      timed,
      best: sorted[0] ?? null,
      worst: sorted.at(-1) ?? null,
      median: times.length ? times[Math.floor(times.length / 2)] : null,
      count: data?.pallets.length ?? 0,
    };
  }, [data]);

  if (!data) return null;
  if (!data.span) return <p className="shifts-help">Nenhum turno para detalhar.</p>;
  const total = hours.at(-1)?.cumulative ?? 0;
  const bestHour = [...hours].sort((a, b) => b.value - a.value)[0] ?? null;
  const showHours = focus !== 'pallets';
  const showPallets = focus === 'pallets' || focus === 'produced';

  return (
    <>
      {showHours && (
        <>
          <div className="detail-summary">
            <div>
              <span>Total no período</span>
              <b>
                {number(total, info.decimals)} <small>{info.unit}</small>
              </b>
            </div>
            <div>
              <span>Melhor hora</span>
              <b>
                {bestHour ? bestHour.hour : '—'}{' '}
                <small>{bestHour ? number(bestHour.value, info.decimals) : ''}</small>
              </b>
            </div>
            <div>
              <span>Horas com produção</span>
              <b>{hours.filter((hour) => hour.value > 0).length}</b>
            </div>
            <div>
              <span>Paletes</span>
              <b>{number(ranking.count)}</b>
            </div>
          </div>

          <div className="detail-section">
            <strong>Acumulado ao longo do período</strong>
            <div className="detail-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={hours}>
                  <CartesianGrid
                    stroke="var(--detail-grid)"
                    strokeDasharray="3 6"
                    vertical={false}
                  />
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
                    stroke="var(--brand-accent, #12b8a6)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="detail-section">
            <strong>Produção por período</strong>
            <div className="detail-chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hours}>
                  <CartesianGrid
                    stroke="var(--detail-grid)"
                    strokeDasharray="3 6"
                    vertical={false}
                  />
                  <XAxis dataKey="hour" stroke="var(--detail-axis)" fontSize={12} />
                  <YAxis stroke="var(--detail-axis)" fontSize={12} width={48} />
                  <Tooltip
                    formatter={(value) => [
                      `${number(Number(value), info.decimals)} ${info.unit}`,
                      'produzido',
                    ]}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {hours.map((hour) => (
                      <Cell
                        key={hour.hour}
                        fill={
                          hour.value === bestHour?.value
                            ? 'var(--brand-accent, #12b8a6)'
                            : '#3d7f96'
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="detail-section">
            <strong>Como a máquina passou cada período</strong>
            <div className="scroll">
              <table className="detail-table">
                <thead>
                  <tr>
                    <th>{(data.step ?? 60) >= 60 ? 'Hora' : 'Período'}</th>
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
                  {!hours.length && (
                    <tr>
                      <td colSpan={6}>Sem produção registrada no período.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showHours &&
        calculated.map((field) => {
          const series = (data.hours ?? []).map((hour) => {
            // The HMI's variables come as the hour's average; the platform's own come from what
            // the machine did in that hour, so a formula reads the same names either way.
            const values: Record<string, number> = hourVariables(hour);
            const inHour = new Date(hour.hour);
            inHour.setMinutes(0, 0, 0);
            for (const [key, points] of Object.entries(data.variables ?? {})) {
              const point = points.find(
                (item) => item.hour === hour.hour || item.hour === inHour.toISOString(),
              );
              if (point) values[key] = point.value;
            }
            return { hour: clock(hour.hour), value: evaluateFormula(field.formula, values) };
          });
          const known = series.filter((point) => point.value != null);
          const average = known.length
            ? known.reduce((sum, point) => sum + (point.value ?? 0), 0) / known.length
            : null;
          return (
            <div className="detail-section" key={field.id}>
              <strong>
                {field.label || 'Calculado'} durante o período
                {average != null && (
                  <em className="detail-average">
                    {' '}
                    · média {number(average, field.decimals ?? 1)} {field.unit}
                  </em>
                )}
              </strong>
              <div className="detail-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series}>
                    <CartesianGrid
                      stroke="var(--detail-grid)"
                      strokeDasharray="3 6"
                      vertical={false}
                    />
                    <XAxis dataKey="hour" stroke="var(--detail-axis)" fontSize={12} />
                    <YAxis stroke="var(--detail-axis)" fontSize={12} width={48} />
                    <Tooltip
                      formatter={(value) => [
                        `${number(Number(value), field.decimals ?? 1)} ${field.unit ?? ''}`,
                        field.label || 'calculado',
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#b4592c"
                      strokeWidth={2}
                      dot={{ r: 2 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {!known.length && (
                <p className="shifts-help">
                  Esta conta não pôde ser calculada nas horas do período: confira se as variáveis
                  dela têm leitura.
                </p>
              )}
            </div>
          );
        })}

      {showPallets && ranking.count > 0 && (
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
                  data={ranking.timed.map((event) => ({
                    label: clock(event.at),
                    minutes: (event.seconds ?? 0) / 60,
                    slow: ranking.median != null && (event.seconds ?? 0) > ranking.median * 1.5,
                  }))}
                >
                  <CartesianGrid
                    stroke="var(--detail-grid)"
                    strokeDasharray="3 6"
                    vertical={false}
                  />
                  <XAxis dataKey="label" stroke="var(--detail-axis)" fontSize={11} />
                  <YAxis stroke="var(--detail-axis)" fontSize={12} width={48} unit=" min" />
                  <Tooltip
                    formatter={(value) => [minutesSeconds(Number(value) * 60), 'tempo do palete']}
                  />
                  <Bar dataKey="minutes" radius={[4, 4, 0, 0]}>
                    {ranking.timed.map((event) => (
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
              Em vermelho, os paletes que levaram mais de uma vez e meia a mediana do período: são
              onde a produção travou.
            </p>
          </div>

          <div className="detail-section">
            <strong>Ranking dos paletes</strong>
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
                      <td colSpan={4}>Nenhum palete fechado neste período.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export function ShiftDetailModal({
  deviceId,
  mode,
  focus,
  calculated = [],
  onClose,
}: {
  deviceId: string;
  mode: 'shift' | 'day';
  focus: DetailFocus;
  calculated?: CalculatedSetting[];
  onClose: () => void;
}) {
  const keys = formulaKeys(calculated);
  const [step, setStep] = useState(60);
  const detail = usePoll<DetailData>(
    `/devices/${deviceId}/shift-detail?mode=${mode}&step=${step}${keys.length ? `&keys=${encodeURIComponent(keys.join(','))}` : ''}`,
    60000,
  );
  const data = detail.data;
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
          <div className="detail-step">
            <label htmlFor="detail-step">Dividir por</label>
            <select
              id="detail-step"
              value={step}
              onChange={(event) => setStep(Number(event.target.value))}
            >
              {DETAIL_STEPS.map((option) => (
                <option key={option.minutes} value={option.minutes}>
                  {option.label}
                </option>
              ))}
            </select>
            <button type="button" className="icon-button" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        {detail.loading && <p>Carregando…</p>}
        {detail.error && <div className="form-error">{detail.error}</div>}
        <ShiftDetailCharts data={data} focus={focus} calculated={calculated} />

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
