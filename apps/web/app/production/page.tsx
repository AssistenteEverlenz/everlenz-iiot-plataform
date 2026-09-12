'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ActionModal } from '../../components/ActionModal';
import { ProductionConfigModal } from '../../components/ProductionConfigModal';
import { ShiftBoardView, type ShiftBoardResponse } from '../../components/ShiftBoard';
import { usePlatform } from '../../components/PlatformShell';
import { mutate, usePoll, type Device } from '../../components/data';
import {
  duration,
  formatNumber,
  metricInfo,
  type ProductionMetric,
} from '../../components/ShiftBoard';

// Produção: the history page. One row per closed shift (or per day), with the columns the user
// picks, a comparison chart, CSV export and printing. Shift calendars and the production
// configuration of each device are edited here too, away from the operator's panel.

interface Report {
  id: string;
  kind: 'shift' | 'off_shift';
  open?: boolean;
  /** 'auto': written by the shift close; 'manual': a partial someone generated. */
  source?: 'auto' | 'manual';
  shift_name: string;
  production_date: string;
  planned_start: string;
  planned_end: string;
  planned_seconds: number;
  pieces: number;
  pallets: number;
  tons: number;
  producing_s: number;
  idle_s: number;
  manual_s: number;
  offline_s: number;
  target_metric: ProductionMetric | null;
  target_value: number | null;
  products: Array<{ product_code: string; pieces: number; pallets: number; tons: number }>;
}
interface ReportsResponse {
  reports: Report[];
  defaultShifts: boolean;
  shiftNames: string[];
  targetMetric: ProductionMetric | null;
}
interface Row {
  key: string;
  /** Stored report id; null for the running shift and for day totals. */
  id: string | null;
  source: 'auto' | 'manual' | null;
  date: string;
  shift: string;
  start: string | null;
  end: string | null;
  open: boolean;
  offShift: boolean;
  pieces: number;
  milheiros: number;
  pallets: number;
  tons: number;
  producing: number;
  idle: number;
  manual: number;
  offline: number;
  planned: number;
  target: number | null;
  targetMetric: ProductionMetric | null;
  products: Array<{ product_code: string; pieces: number; pallets: number; tons: number }>;
}
interface ShiftForm {
  name: string;
  weekdays: number[];
  start: string;
  end: string;
  breaks: Array<{ start: string; end: string }>;
}

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const COLUMNS_KEY = 'everlenz-production-columns';

function plantToday() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function shiftDay(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
function brDate(date: string) {
  return date.split('-').reverse().join('/');
}
function clockOf(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      })
    : '—';
}
function metricOf(row: Row, metric: ProductionMetric) {
  if (metric === 'milheiros') return row.milheiros;
  if (metric === 'tons') return row.tons;
  if (metric === 'blocks') return row.pieces;
  return row.pallets;
}
function utilization(row: Row) {
  return row.producing + row.idle > 0 ? row.producing / (row.producing + row.idle) : null;
}
function attainment(row: Row) {
  return row.target && row.targetMetric ? metricOf(row, row.targetMetric) / row.target : null;
}

function toRow(report: Report): Row {
  return {
    key: report.id,
    id: report.open ? null : report.id,
    source: report.open ? null : (report.source ?? 'auto'),
    date: report.production_date,
    shift: report.shift_name,
    start: report.kind === 'shift' ? report.planned_start : null,
    end: report.kind === 'shift' ? report.planned_end : null,
    open: Boolean(report.open),
    offShift: report.kind === 'off_shift',
    pieces: Number(report.pieces),
    milheiros: Number(report.pieces) / 1000,
    pallets: Number(report.pallets),
    tons: Number(report.tons),
    producing: Number(report.producing_s),
    idle: Number(report.idle_s),
    manual: Number(report.manual_s),
    offline: Number(report.offline_s),
    planned: Number(report.planned_seconds),
    target: report.target_value == null ? null : Number(report.target_value),
    targetMetric: report.target_metric,
    products: Array.isArray(report.products) ? report.products : [],
  };
}

function groupByDay(rows: Row[]): Row[] {
  const days = new Map<string, Row>();
  for (const row of rows) {
    const day = days.get(row.date) ?? {
      ...row,
      key: row.date,
      id: null,
      source: null,
      shift: '',
      start: null,
      end: null,
      open: false,
      offShift: false,
      pieces: 0,
      milheiros: 0,
      pallets: 0,
      tons: 0,
      producing: 0,
      idle: 0,
      manual: 0,
      offline: 0,
      planned: 0,
      target: null,
      products: [],
    };
    day.pieces += row.pieces;
    day.milheiros += row.milheiros;
    day.pallets += row.pallets;
    day.tons += row.tons;
    day.producing += row.producing;
    day.idle += row.idle;
    day.manual += row.manual;
    day.offline += row.offline;
    day.planned += row.planned;
    day.open ||= row.open;
    if (row.target != null) {
      day.target = (day.target ?? 0) + row.target;
      day.targetMetric = row.targetMetric;
    }
    const shifts = new Set(day.shift ? day.shift.split(', ') : []);
    shifts.add(row.shift);
    day.shift = [...shifts].join(', ');
    for (const product of row.products) {
      const existing = day.products.find((item) => item.product_code === product.product_code);
      if (existing) {
        existing.pieces += product.pieces;
        existing.pallets += product.pallets;
        existing.tons += product.tons;
      } else day.products.push({ ...product });
    }
    days.set(row.date, day);
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
}

const COLUMNS: Array<{
  id: string;
  label: string;
  initial: boolean;
  numeric?: boolean;
  value: (row: Row) => string;
  csv?: (row: Row) => string;
}> = [
  { id: 'date', label: 'Data', initial: true, value: (row) => brDate(row.date) },
  {
    id: 'shift',
    label: 'Turno',
    initial: true,
    value: (row) => row.shift + (row.open ? ' (em andamento)' : ''),
  },
  {
    id: 'window',
    label: 'Horário',
    initial: true,
    value: (row) => (row.start ? `${clockOf(row.start)}–${clockOf(row.end)}` : '—'),
  },
  {
    id: 'milheiros',
    label: 'Milheiros',
    initial: true,
    numeric: true,
    value: (row) => formatNumber(row.milheiros, 2),
  },
  {
    id: 'pieces',
    label: 'Peças',
    initial: true,
    numeric: true,
    value: (row) => formatNumber(row.pieces),
  },
  {
    id: 'pallets',
    label: 'Paletes',
    initial: false,
    numeric: true,
    value: (row) => formatNumber(row.pallets),
  },
  {
    id: 'tons',
    label: 'Toneladas',
    initial: false,
    numeric: true,
    value: (row) => formatNumber(row.tons, 2),
  },
  {
    id: 'target',
    label: 'Meta',
    initial: true,
    numeric: true,
    value: (row) =>
      row.target != null && row.targetMetric
        ? `${formatNumber(row.target, metricInfo[row.targetMetric].decimals)} ${metricInfo[row.targetMetric].unit}`
        : '—',
  },
  {
    id: 'attainment',
    label: '% da meta',
    initial: true,
    numeric: true,
    value: (row) => {
      const value = attainment(row);
      return value == null ? '—' : `${formatNumber(value * 100)}%`;
    },
  },
  {
    id: 'utilization',
    label: 'Aproveitamento',
    initial: true,
    numeric: true,
    value: (row) => {
      const value = utilization(row);
      return value == null ? '—' : `${formatNumber(value * 100)}%`;
    },
  },
  {
    id: 'producing',
    label: 'Produzindo',
    initial: true,
    numeric: true,
    value: (row) => duration(row.producing),
    csv: (row) => formatNumber(row.producing / 60),
  },
  {
    id: 'idle',
    label: 'Ociosa',
    initial: true,
    numeric: true,
    value: (row) => duration(row.idle),
    csv: (row) => formatNumber(row.idle / 60),
  },
  {
    id: 'manual',
    label: 'Manual / parada',
    initial: false,
    numeric: true,
    value: (row) => duration(row.manual),
    csv: (row) => formatNumber(row.manual / 60),
  },
  {
    id: 'offline',
    label: 'Sem comunicação',
    initial: false,
    numeric: true,
    value: (row) => duration(row.offline),
    csv: (row) => formatNumber(row.offline / 60),
  },
  {
    id: 'planned',
    label: 'Tempo planejado',
    initial: false,
    numeric: true,
    value: (row) => duration(row.planned),
    csv: (row) => formatNumber(row.planned / 60),
  },
  {
    id: 'product',
    label: 'Produto principal',
    initial: false,
    value: (row) =>
      [...row.products].sort((a, b) => b.pieces - a.pieces || b.pallets - a.pallets)[0]
        ?.product_code ?? '—',
  },
];

function download(name: string, content: string) {
  // Excel in Portuguese opens ";"-separated files with decimal commas directly; the BOM keeps accents.
  const blob = new Blob(['﻿', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function ProductionPage() {
  const { user } = usePlatform();
  const search = useSearchParams();
  const devices = usePoll<Device[]>('/devices?limit=200&offset=0', 60000);
  const [deviceId, setDeviceId] = useState(search.get('device') ?? '');
  const [from, setFrom] = useState(() => shiftDay(plantToday(), -6));
  const [to, setTo] = useState(plantToday);
  const [view, setView] = useState<'shift' | 'day'>('shift');
  const [shiftFilter, setShiftFilter] = useState('');
  const [includeOffShift, setIncludeOffShift] = useState(true);
  // The row whose details are open (board of that shift or day, products).
  const [detail, setDetail] = useState<Row | null>(null);
  const [columns, setColumns] = useState<string[]>(() =>
    COLUMNS.filter((column) => column.initial).map((column) => column.id),
  );
  const [choosingColumns, setChoosingColumns] = useState(false);
  const [editingShifts, setEditingShifts] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  // Row maintenance (master): partial snapshot, rebuild of automatic rows, removal.
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<'delete' | 'recalculate' | null>(null);
  const [actionError, setActionError] = useState('');
  const [generating, setGenerating] = useState(false);
  const canMaintain = user.role === 'master';

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? 'null');
      if (Array.isArray(saved) && saved.length) setColumns(saved);
    } catch {
      // Keeps the defaults.
    }
  }, []);
  useEffect(() => {
    if (!deviceId && devices.data?.[0]) setDeviceId(devices.data[0].id);
  }, [devices.data, deviceId]);
  async function generateSnapshot() {
    setGenerating(true);
    setActionError('');
    try {
      await mutate(`/devices/${deviceId}/shift-reports/snapshot`, 'POST');
      await reports.refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Falha ao gerar a parcial.');
    } finally {
      setGenerating(false);
    }
  }
  async function recalculate() {
    await mutate(`/devices/${deviceId}/shift-reports/recalculate`, 'POST', { from, to });
    setSelected([]);
    await reports.refresh();
  }
  async function deleteSelected() {
    await mutate(`/devices/${deviceId}/shift-reports`, 'DELETE', { ids: selected });
    setSelected([]);
    await reports.refresh();
  }
  function toggleColumn(id: string) {
    const next = columns.includes(id) ? columns.filter((item) => item !== id) : [...columns, id];
    setColumns(next);
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(next));
    } catch {
      // Private mode: the choice lasts for this visit.
    }
  }

  const device = devices.data?.find((item) => item.id === deviceId) ?? null;
  const reports = usePoll<ReportsResponse>(
    deviceId ? `/devices/${deviceId}/shift-reports?from=${from}&to=${to}` : null,
    60000,
  );
  const shiftRows = useMemo(
    () =>
      (reports.data?.reports ?? [])
        .map(toRow)
        .filter((row) => includeOffShift || !row.offShift)
        .filter((row) => !shiftFilter || row.shift === shiftFilter),
    [reports.data, includeOffShift, shiftFilter],
  );
  const rows = view === 'day' ? groupByDay(shiftRows) : shiftRows;
  const metric: ProductionMetric = reports.data?.targetMetric ?? 'milheiros';
  const info = metricInfo[metric];
  const totals = rows.reduce(
    (sum, row) => ({
      milheiros: sum.milheiros + row.milheiros,
      pieces: sum.pieces + row.pieces,
      pallets: sum.pallets + row.pallets,
      tons: sum.tons + row.tons,
      producing: sum.producing + row.producing,
      idle: sum.idle + row.idle,
      target: sum.target + (row.target ?? 0),
      achieved:
        sum.achieved + (row.target && row.targetMetric ? metricOf(row, row.targetMetric) : 0),
    }),
    { milheiros: 0, pieces: 0, pallets: 0, tons: 0, producing: 0, idle: 0, target: 0, achieved: 0 },
  );
  const visible = COLUMNS.filter((column) => columns.includes(column.id));
  const selectable = view === 'shift' ? rows.flatMap((row) => (row.id ? [row.id] : [])) : [];
  const chartRows = [...rows]
    .filter((row) => !row.offShift)
    .reverse()
    .map((row) => ({
      label:
        view === 'day'
          ? brDate(row.date).slice(0, 5)
          : `${brDate(row.date).slice(0, 5)} ${row.shift}`,
      value: metricOf(row, metric),
      target: row.target,
    }));

  function exportCsv() {
    // One line per product: the quantities of that product, the rest of the shift (or day)
    // repeated, so a spreadsheet can filter and sum by product.
    const quantities = new Set(['milheiros', 'pieces', 'pallets', 'tons']);
    const columns = visible.filter((column) => column.id !== 'product');
    const productAt = columns.findIndex((column) => column.id === 'shift') + 1;
    const clean = (text: string) => text.replace(/;/g, ',');
    const headerCells = columns.map((column) => column.label);
    headerCells.splice(productAt, 0, 'Produto');
    const header = headerCells.join(';');
    const lines = rows.flatMap((row) =>
      (row.products.length ? row.products : [null]).map((product) => {
        const own = product
          ? {
              ...row,
              pieces: Number(product.pieces),
              milheiros: Number(product.pieces) / 1000,
              pallets: Number(product.pallets),
              tons: Number(product.tons),
            }
          : row;
        const cells = columns.map((column) =>
          clean((column.csv ?? column.value)(quantities.has(column.id) ? own : row)),
        );
        cells.splice(productAt, 0, clean(product?.product_code ?? '—'));
        return cells.join(';');
      }),
    );
    download(
      `producao-${device?.device_code ?? 'equipamento'}-${from}-a-${to}.csv`,
      [header, ...lines].join('\r\n'),
    );
  }

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">PRODUÇÃO</div>
          <h1>Histórico de produção</h1>
          <p>O que, quanto e quando cada turno produziu, com meta e aproveitamento da máquina.</p>
        </div>
        {user.role === 'master' && device && (
          <div className="toolbar-actions">
            <button onClick={() => setEditingShifts(true)}>Turnos da fábrica</button>
            <button onClick={() => setEditingConfig(true)}>Configurar equipamento</button>
          </div>
        )}
      </div>

      <section className="card production-filters">
        <label className="field">
          Equipamento
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            {devices.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.site_name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          De
          <input
            type="date"
            value={from}
            max={to}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="field">
          Até
          <input
            type="date"
            value={to}
            min={from}
            max={plantToday()}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <label className="field">
          Turno
          <select value={shiftFilter} onChange={(event) => setShiftFilter(event.target.value)}>
            <option value="">Todos</option>
            {reports.data?.shiftNames.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <div className="production-view" role="group" aria-label="Agrupar por">
          <button className={view === 'shift' ? 'active' : ''} onClick={() => setView('shift')}>
            Por turno
          </button>
          <button className={view === 'day' ? 'active' : ''} onClick={() => setView('day')}>
            Por dia
          </button>
        </div>
        <label className="production-check">
          <input
            type="checkbox"
            checked={includeOffShift}
            onChange={(event) => setIncludeOffShift(event.target.checked)}
          />
          Incluir fora de turno
        </label>
      </section>

      {reports.data?.defaultShifts && (
        <div className="notice">
          <b>Turno padrão em uso</b>
          Esta fábrica ainda não tem turnos cadastrados: a produção está sendo contada como um
          turno, de segunda a sexta, das 07:00 às 17:00.
          {user.role === 'master' && ' Cadastre os turnos reais em "Turnos da fábrica".'}
        </div>
      )}
      {reports.error && <div className="error-banner">{reports.error}</div>}

      <section className="production-totals">
        <div>
          <span>Milheiros</span>
          <b>{formatNumber(totals.milheiros, 1)}</b>
        </div>
        <div>
          <span>Peças</span>
          <b>{formatNumber(totals.pieces)}</b>
        </div>
        <div>
          <span>Paletes</span>
          <b>{formatNumber(totals.pallets)}</b>
        </div>
        <div>
          <span>Toneladas</span>
          <b>{formatNumber(totals.tons, 1)}</b>
        </div>
        <div>
          <span>Aproveitamento</span>
          <b>
            {totals.producing + totals.idle > 0
              ? `${formatNumber((totals.producing / (totals.producing + totals.idle)) * 100)}%`
              : '—'}
          </b>
        </div>
        <div>
          <span>% da meta</span>
          <b>
            {totals.target > 0 ? `${formatNumber((totals.achieved / totals.target) * 100)}%` : '—'}
          </b>
        </div>
      </section>

      {chartRows.length > 0 && (
        <section className="card production-chart">
          <div className="shift-section-title">
            {info.name} por {view === 'day' ? 'dia' : 'turno'}
            {totals.target > 0 && ' · linha = meta'}
          </div>
          <div className="production-chart-area">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e6eef0" strokeDasharray="3 5" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: '#71868d' }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  width={48}
                  tick={{ fontSize: 10, fill: '#71868d' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  formatter={(value) =>
                    `${formatNumber(Number(value), info.decimals)} ${info.unit}`
                  }
                />
                <Bar
                  dataKey="value"
                  name="Produzido"
                  fill="var(--brand-accent, #12b8a6)"
                  radius={[5, 5, 0, 0]}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="target"
                  name="Meta"
                  stroke="#e4572e"
                  strokeWidth={2}
                  dot={false}
                  strokeDasharray="5 4"
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className="card">
        <div className="production-table-bar">
          <strong>
            {rows.length} {view === 'day' ? 'dia(s)' : 'registro(s)'}
          </strong>
          <div className="production-table-actions">
            <div className="production-columns">
              <button onClick={() => setChoosingColumns(!choosingColumns)}>Colunas</button>
              {choosingColumns && (
                <div className="production-columns-menu">
                  {COLUMNS.map((column) => (
                    <label key={column.id}>
                      <input
                        type="checkbox"
                        checked={columns.includes(column.id)}
                        onChange={() => toggleColumn(column.id)}
                      />
                      {column.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <button onClick={exportCsv} disabled={!rows.length}>
              Exportar CSV
            </button>
            <button onClick={() => window.print()} disabled={!rows.length}>
              Imprimir / PDF
            </button>
            {canMaintain && deviceId && (
              <>
                <button disabled={generating} onClick={() => void generateSnapshot()}>
                  {generating ? 'Gerando…' : 'Gerar parcial agora'}
                </button>
                <button onClick={() => setConfirming('recalculate')}>Recalcular período</button>
                {view === 'shift' && (
                  <button
                    className="danger-text"
                    disabled={!selected.length}
                    onClick={() => setConfirming('delete')}
                  >
                    Excluir selecionadas{selected.length ? ` (${selected.length})` : ''}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {actionError && <div className="form-error">{actionError}</div>}
        <div className="production-source-legend">
          <span>
            <i className="source-dot auto" /> gerada pelo sistema
          </span>
          <span>
            <i className="source-dot manual" /> gerada manualmente
          </span>
          <span>
            <i className="source-dot live" /> turno em andamento
          </span>
        </div>
        <div className="table-scroll">
          <table className="production-table">
            <thead>
              <tr>
                {view === 'shift' && <th className="source-column" aria-label="Origem" />}
                {view === 'shift' && canMaintain && (
                  <th className="select-column">
                    <input
                      type="checkbox"
                      aria-label="Selecionar todas"
                      checked={
                        selectable.length > 0 && selectable.every((id) => selected.includes(id))
                      }
                      onChange={(event) => setSelected(event.target.checked ? selectable : [])}
                    />
                  </th>
                )}
                {visible.map((column) => (
                  <th key={column.id} className={column.numeric ? 'numeric' : ''}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <>
                  <tr
                    key={row.key}
                    className={`${row.open ? 'open' : ''} ${row.offShift ? 'off-shift' : ''}`}
                    onClick={() => setDetail(row)}
                    title="Ver tudo sobre este período: quadro, estados e produtos"
                  >
                    {view === 'shift' && (
                      <td className="source-column">
                        <i
                          className={`source-dot ${row.source ?? 'live'}`}
                          title={
                            row.source === 'manual'
                              ? 'Gerada manualmente'
                              : row.source === 'auto'
                                ? 'Gerada pelo sistema'
                                : 'Turno em andamento'
                          }
                        />
                      </td>
                    )}
                    {view === 'shift' && canMaintain && (
                      <td className="select-column" onClick={(event) => event.stopPropagation()}>
                        {row.id && (
                          <input
                            type="checkbox"
                            aria-label="Selecionar linha"
                            checked={selected.includes(row.id)}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked
                                  ? [...current, row.id as string]
                                  : current.filter((item) => item !== row.id),
                              )
                            }
                          />
                        )}
                      </td>
                    )}
                    {visible.map((column) => (
                      <td key={column.id} className={column.numeric ? 'numeric' : ''}>
                        {column.value(row)}
                      </td>
                    ))}
                  </tr>
                  {row.products.length > 1 && (
                    <tr key={`${row.key}-products`} className="production-products-row">
                      <td
                        colSpan={
                          visible.length + (view === 'shift' ? 1 : 0) + (view === 'shift' && canMaintain ? 1 : 0)
                        }
                      >
                        <div className="production-products">
                          {row.products.map((product) => (
                            <span key={product.product_code}>
                              <b>{product.product_code}</b>
                              {formatNumber(product.pieces / 1000, 2)} mil ·{' '}
                              {formatNumber(product.pieces)} peças ·{' '}
                              {formatNumber(product.pallets)} paletes
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <div className="empty">
              {reports.data
                ? 'Nenhum turno registrado no período. Os turnos entram aqui ao terminar.'
                : 'Carregando…'}
            </div>
          )}
        </div>
      </section>

      {editingShifts && device && (
        <ShiftsModal
          siteId={device.site_id}
          siteName={device.site_name ?? ''}
          onClose={() => {
            setEditingShifts(false);
            void reports.refresh();
          }}
        />
      )}
      {confirming === 'delete' && (
        <ActionModal
          title="Excluir linhas do histórico"
          description={`${selected.length} linha(s) selecionada(s) sairão do histórico. Linhas automáticas excluídas não são geradas de novo pelo fechamento; para trazê-las de volta use "Recalcular período".`}
          confirmLabel="Excluir"
          danger
          onConfirm={deleteSelected}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming === 'recalculate' && (
        <ActionModal
          title="Recalcular período"
          description={`As linhas automáticas de ${brDate(from)} a ${brDate(to)} serão geradas de novo, recontando a produção a partir do histórico de variáveis gravado (inclusive as linhas que foram excluídas). As parciais manuais não mudam.`}
          confirmLabel="Recalcular"
          onConfirm={recalculate}
          onClose={() => setConfirming(null)}
        />
      )}
      {detail && deviceId && (
        <DetailModal
          deviceId={deviceId}
          row={detail}
          view={view}
          onClose={() => setDetail(null)}
        />
      )}
      {editingConfig && device && (
        <ProductionConfigModal
          deviceId={device.id}
          deviceName={device.name}
          onClose={() => {
            setEditingConfig(false);
            void reports.refresh();
          }}
        />
      )}
    </>
  );
}

function ShiftsModal({
  siteId,
  siteName,
  onClose,
}: {
  siteId: string;
  siteName: string;
  onClose: () => void;
}) {
  const loaded = usePoll<{
    shifts: Array<{
      id: string | null;
      name: string;
      weekdays: number[];
      start: string;
      end: string;
      breaks: Array<{ start: string; end: string }>;
    }>;
    isDefault: boolean;
  }>(`/sites/${siteId}/shifts`, 600000);
  const [shifts, setShifts] = useState<ShiftForm[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (loaded.data && !shifts)
      setShifts(
        loaded.data.shifts.map((shift) => ({
          name: shift.name,
          weekdays: shift.weekdays,
          start: shift.start,
          end: shift.end,
          breaks: shift.breaks,
        })),
      );
  }, [loaded.data, shifts]);
  function update(index: number, patch: Partial<ShiftForm>) {
    setShifts(
      (current) =>
        current?.map((shift, position) => (position === index ? { ...shift, ...patch } : shift)) ??
        null,
    );
  }
  async function save() {
    if (!shifts) return;
    setSaving(true);
    setError('');
    try {
      await mutate(`/sites/${siteId}/shifts`, 'PUT', { shifts });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar os turnos.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => !saving && onClose()}>
      <div className="modal-card shifts-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">TURNOS DA FÁBRICA</div>
            <h2>{siteName}</h2>
          </div>
          <button type="button" className="icon-button" disabled={saving} onClick={onClose}>
            ×
          </button>
        </div>
        <p className="shifts-help">
          Só o tempo dentro dos turnos, sem as pausas, conta para meta e aproveitamento. Produção
          fora deles aparece separada como &quot;fora de turno&quot;. Alterar os turnos vale para os
          próximos turnos: o histórico já fechado não muda.
          {loaded.data?.isDefault && ' Hoje está em uso o turno padrão (seg–sex 07:00–17:00).'}
        </p>
        {shifts?.map((shift, index) => (
          <div key={index} className="shift-form">
            <div className="shift-form-row">
              <label className="field">
                Nome
                <input
                  value={shift.name}
                  maxLength={60}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
              </label>
              <label className="field">
                Início
                <input
                  type="time"
                  step={300}
                  value={shift.start}
                  onChange={(event) => update(index, { start: event.target.value })}
                />
              </label>
              <label className="field">
                Fim
                <input
                  type="time"
                  step={300}
                  value={shift.end}
                  onChange={(event) => update(index, { end: event.target.value })}
                />
              </label>
              <button
                type="button"
                className="danger-text"
                onClick={() => setShifts(shifts.filter((_, position) => position !== index))}
              >
                Remover turno
              </button>
            </div>
            <div className="weekday-picker">
              {WEEKDAYS.map((label, day) => (
                <button
                  type="button"
                  key={label}
                  className={shift.weekdays.includes(day) ? 'selected' : ''}
                  onClick={() =>
                    update(index, {
                      weekdays: shift.weekdays.includes(day)
                        ? shift.weekdays.filter((item) => item !== day)
                        : [...shift.weekdays, day].sort(),
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="shift-breaks">
              <small>Pausas (almoço, café, troca de turno…)</small>
              {shift.breaks.map((pause, breakIndex) => (
                <div key={breakIndex} className="shift-break">
                  <input
                    type="time"
                    step={300}
                    value={pause.start}
                    aria-label="Início da pausa"
                    onChange={(event) =>
                      update(index, {
                        breaks: shift.breaks.map((item, position) =>
                          position === breakIndex ? { ...item, start: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <span>até</span>
                  <input
                    type="time"
                    step={300}
                    value={pause.end}
                    aria-label="Fim da pausa"
                    onChange={(event) =>
                      update(index, {
                        breaks: shift.breaks.map((item, position) =>
                          position === breakIndex ? { ...item, end: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Remover pausa"
                    onClick={() =>
                      update(index, {
                        breaks: shift.breaks.filter((_, position) => position !== breakIndex),
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  update(index, { breaks: [...shift.breaks, { start: '12:00', end: '13:00' }] })
                }
              >
                + Pausa
              </button>
            </div>
          </div>
        ))}
        {shifts && shifts.length < 6 && (
          <button
            type="button"
            onClick={() =>
              setShifts([
                ...shifts,
                {
                  name: `Turno ${shifts.length + 1}`,
                  weekdays: [1, 2, 3, 4, 5],
                  start: '07:00',
                  end: '17:00',
                  breaks: [],
                },
              ])
            }
          >
            + Turno
          </button>
        )}
        {shifts && !shifts.length && (
          <p className="shifts-help">
            Sem turnos cadastrados, a fábrica volta a usar o turno padrão.
          </p>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={onClose}>
            Cancelar
          </button>
          <button
            className="primary-button"
            disabled={saving || !shifts}
            onClick={() => void save()}
          >
            {saving && <span className="button-spinner" />}
            {saving ? 'Salvando…' : 'Salvar turnos'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Everything about one row of the history: the board of that shift or day, and its products. */
function DetailModal({
  deviceId,
  row,
  view,
  onClose,
}: {
  deviceId: string;
  row: Row;
  view: 'shift' | 'day';
  onClose: () => void;
}) {
  const params = new URLSearchParams({
    date: row.date,
    kind: view === 'day' ? 'day' : row.offShift ? 'off_shift' : 'shift',
  });
  if (view !== 'day' && row.start) params.set('start', row.start);
  if (view !== 'day' && row.end) params.set('end', row.end);
  const detail = usePoll<ShiftBoardResponse>(
    `/devices/${deviceId}/production-detail?${params.toString()}`,
    row.open ? 30000 : 600000,
  );
  const reached = attainment(row);
  const machine = utilization(row);
  const products = [...row.products].sort((a, b) => b.pieces - a.pieces || b.pallets - a.pallets);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-card production-detail-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-title">
          <div>
            <div className="eyebrow">{view === 'day' ? 'DIA DE PRODUÇÃO' : 'TURNO DE PRODUÇÃO'}</div>
            <h2>
              {brDate(row.date)}
              {view === 'day' ? '' : ` · ${row.shift}`}
              {row.start && view !== 'day' ? ` · ${clockOf(row.start)}–${clockOf(row.end)}` : ''}
            </h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="production-detail-summary">
          <div>
            <span>Milheiros</span>
            <b>{formatNumber(row.milheiros, 2)}</b>
          </div>
          <div>
            <span>Peças</span>
            <b>{formatNumber(row.pieces)}</b>
          </div>
          <div>
            <span>Paletes</span>
            <b>{formatNumber(row.pallets)}</b>
          </div>
          <div>
            <span>Toneladas</span>
            <b>{formatNumber(row.tons, 1)}</b>
          </div>
          <div>
            <span>Meta</span>
            <b>
              {row.target && row.targetMetric
                ? `${formatNumber(row.target, metricInfo[row.targetMetric].decimals)} ${metricInfo[row.targetMetric].unit}`
                : '—'}
            </b>
          </div>
          <div>
            <span>% da meta</span>
            <b>{reached == null ? '—' : `${formatNumber(reached * 100)}%`}</b>
          </div>
          <div>
            <span>Aproveitamento</span>
            <b>{machine == null ? '—' : `${formatNumber(machine * 100)}%`}</b>
          </div>
          <div>
            <span>Tempo planejado</span>
            <b>{row.planned ? duration(row.planned) : '—'}</b>
          </div>
        </div>
        <div className="production-detail-products">
          <div className="shift-section-title">Produtos</div>
          {products.length ? (
            <table className="production-table">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th className="numeric">Milheiros</th>
                  <th className="numeric">Peças</th>
                  <th className="numeric">Paletes</th>
                  <th className="numeric">Toneladas</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.product_code}>
                    <td>{product.product_code}</td>
                    <td className="numeric">{formatNumber(product.pieces / 1000, 2)}</td>
                    <td className="numeric">{formatNumber(product.pieces)}</td>
                    <td className="numeric">{formatNumber(product.pallets)}</td>
                    <td className="numeric">{formatNumber(Number(product.tons), 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="shifts-help">Sem produção registrada.</p>
          )}
        </div>
        {row.offShift && (
          <p className="shifts-help">
            Fora de turno: o quadro abaixo mostra o dia inteiro, e os totais acima só o que foi
            produzido fora dos turnos.
          </p>
        )}
        {detail.data ? (
          <ShiftBoardView data={detail.data} deviceId={deviceId} historical />
        ) : (
          <p>{detail.error ?? 'Carregando o quadro…'}</p>
        )}
      </div>
    </div>
  );
}

export default function Production() {
  return (
    <Suspense>
      <ProductionPage />
    </Suspense>
  );
}
