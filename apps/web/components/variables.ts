// The names a formula reads, the same on the dashboard, in the shift detail and on the operations
// page: ihm.<key> is the HMI's own latest reading, painel.<name> is what the production board
// works out for the shift (the running one, else the last or next).

import type { VariableOption } from './FormulaInput';

type Metric = 'milheiros' | 'tons' | 'blocks' | 'pallets';

/** The part of a production board a formula needs; the shift-board route returns more. */
export interface PanelSource {
  metric: Metric;
  totals: { pieces: number; milheiros: number; pallets: number; tons: number };
  time: { producing: number; idle: number; manual: number; elapsedProductive: number };
  utilization: number | null;
  pacePerHour: number;
  target: { value: number; actual: number; projected: number } | null;
  palletTiming?: { averageSeconds: number | null } | null;
}

export const METRIC_UNITS: Record<Metric, string> = {
  milheiros: 'milheiros',
  tons: 't',
  blocks: 'peças',
  pallets: 'paletes',
};

/** Each platform variable: what it is, a block title and the unit a new block starts with. */
export const PANEL_VARIABLES: Record<
  string,
  { label: string; description: string; unit: (metric: Metric) => string; decimals: number }
> = {
  'painel.produzido': { label: 'Produzido', description: 'produzido no turno, na unidade da meta', unit: (m) => METRIC_UNITS[m], decimals: 1 },
  'painel.meta': { label: 'Meta', description: 'meta do turno', unit: (m) => METRIC_UNITS[m], decimals: 0 },
  'painel.projecao': { label: 'Projeção', description: 'projeção de fechamento do turno', unit: (m) => METRIC_UNITS[m], decimals: 0 },
  'painel.ritmo': { label: 'Ritmo', description: 'ritmo atual, na unidade da meta por hora', unit: (m) => `${METRIC_UNITS[m]}/h`, decimals: 1 },
  'painel.aproveitamento': { label: 'Aproveitamento', description: 'tempo produzindo ÷ (produzindo + ocioso), em %', unit: () => '%', decimals: 1 },
  'painel.meta_feito': { label: 'Feito da meta', description: 'quanto já foi feito da meta', unit: (m) => METRIC_UNITS[m], decimals: 1 },
  'painel.pecas': { label: 'Peças', description: 'peças produzidas no turno', unit: () => 'peças', decimals: 0 },
  'painel.milheiros': { label: 'Milheiros', description: 'milheiros no turno', unit: () => 'milheiros', decimals: 1 },
  'painel.paletes': { label: 'Paletes', description: 'paletes no turno', unit: () => 'paletes', decimals: 0 },
  'painel.toneladas': { label: 'Toneladas', description: 'toneladas no turno', unit: () => 't', decimals: 1 },
  'painel.horas_produzindo': { label: 'Horas produzindo', description: 'horas com a máquina produzindo', unit: () => 'h', decimals: 1 },
  'painel.minutos_produzindo': { label: 'Minutos produzindo', description: 'minutos com a máquina produzindo', unit: () => 'min', decimals: 0 },
  'painel.horas_paradas': { label: 'Horas paradas', description: 'horas ociosa ou em manual', unit: () => 'h', decimals: 1 },
  'painel.horas_decorridas': { label: 'Horas decorridas', description: 'horas de turno já decorridas', unit: () => 'h', decimals: 1 },
  'painel.paletes_tempo_medio': { label: 'Tempo por palete', description: 'segundos por palete, em média', unit: () => 's', decimals: 0 },
};

function metricValue(board: PanelSource) {
  const { totals } = board;
  return board.metric === 'blocks' ? totals.pieces : totals[board.metric];
}

export function panelVariables(board: PanelSource | null | undefined): Record<string, number> {
  if (!board) return {};
  const { totals, time } = board;
  return {
    'painel.produzido': board.target?.actual ?? metricValue(board),
    'painel.meta': board.target?.value ?? 0,
    'painel.projecao': board.target?.projected ?? metricValue(board),
    'painel.ritmo': board.pacePerHour,
    'painel.aproveitamento': board.utilization == null ? 0 : board.utilization * 100,
    'painel.meta_feito': board.target?.actual ?? 0,
    'painel.pecas': totals.pieces,
    'painel.milheiros': totals.milheiros,
    'painel.paletes': totals.pallets,
    'painel.toneladas': totals.tons,
    'painel.horas_produzindo': time.producing / 3600,
    'painel.minutos_produzindo': time.producing / 60,
    'painel.horas_paradas': (time.idle + time.manual) / 3600,
    'painel.horas_decorridas': time.elapsedProductive / 3600,
    'painel.paletes_tempo_medio': board.palletTiming?.averageSeconds ?? 0,
  };
}

/** The HMI's latest numeric readings under their ihm.* names. */
export function hmiVariables(readings: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(readings).map(([key, value]) => [`ihm.${key}`, value]));
}

function format(value: number) {
  return new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
  }).format(value);
}

/** What the suggestion list and the variables modal offer: the board's first, then the HMI's. */
export function variableOptionsFor(values: Record<string, number>): VariableOption[] {
  const hmi = Object.keys(values).filter((name) => name.startsWith('ihm.')).sort();
  return [...Object.keys(PANEL_VARIABLES), ...hmi].map((name) => ({
    name,
    description: PANEL_VARIABLES[name]?.description ?? 'variável da IHM',
    value: values[name] == null ? '—' : format(values[name]),
  }));
}

/** Names a formula may use: painel.* always exists (a device without a board yet reads it as no
 * value, not as an unknown name), plus the HMI variables read so far. */
export function knownVariables(values: Record<string, number>) {
  return [...new Set([...Object.keys(PANEL_VARIABLES), ...Object.keys(values)])];
}
