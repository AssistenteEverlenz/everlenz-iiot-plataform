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
  'painel.produzido': {
    label: 'Produzido',
    description: 'produzido no turno, na unidade da meta',
    unit: (m) => METRIC_UNITS[m],
    decimals: 1,
  },
  'painel.meta': {
    label: 'Meta',
    description: 'meta do turno',
    unit: (m) => METRIC_UNITS[m],
    decimals: 0,
  },
  'painel.projecao': {
    label: 'Projeção',
    description: 'projeção de fechamento do turno',
    unit: (m) => METRIC_UNITS[m],
    decimals: 0,
  },
  'painel.ritmo': {
    label: 'Ritmo',
    description: 'ritmo atual, na unidade da meta por hora',
    unit: (m) => `${METRIC_UNITS[m]}/h`,
    decimals: 1,
  },
  'painel.aproveitamento': {
    label: 'Aproveitamento',
    description: 'tempo produzindo ÷ (produzindo + ocioso), em %',
    unit: () => '%',
    decimals: 1,
  },
  'painel.meta_feito': {
    label: 'Feito da meta',
    description: 'quanto já foi feito da meta',
    unit: (m) => METRIC_UNITS[m],
    decimals: 1,
  },
  'painel.pecas': {
    label: 'Peças',
    description: 'peças produzidas no turno',
    unit: () => 'peças',
    decimals: 0,
  },
  'painel.milheiros': {
    label: 'Milheiros',
    description: 'milheiros no turno',
    unit: () => 'milheiros',
    decimals: 1,
  },
  'painel.paletes': {
    label: 'Paletes',
    description: 'paletes no turno',
    unit: () => 'paletes',
    decimals: 0,
  },
  'painel.toneladas': {
    label: 'Toneladas',
    description: 'toneladas no turno',
    unit: () => 't',
    decimals: 1,
  },
  'painel.horas_produzindo': {
    label: 'Horas produzindo',
    description: 'horas com a máquina produzindo',
    unit: () => 'h',
    decimals: 1,
  },
  'painel.minutos_produzindo': {
    label: 'Minutos produzindo',
    description: 'minutos com a máquina produzindo',
    unit: () => 'min',
    decimals: 0,
  },
  'painel.horas_paradas': {
    label: 'Horas paradas',
    description: 'horas ociosa ou em manual',
    unit: () => 'h',
    decimals: 1,
  },
  'painel.horas_decorridas': {
    label: 'Horas decorridas',
    description: 'horas de turno já decorridas',
    unit: () => 'h',
    decimals: 1,
  },
  'painel.paletes_tempo_medio': {
    label: 'Tempo por palete',
    description: 'segundos por palete, em média',
    unit: () => 's',
    decimals: 0,
  },
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

/**
 * A mortar plant has no ceramic board: its formulas read argamassa.*, worked out by the bagging
 * board for the running shift (apps/api/src/mortar-board.ts).
 */
export interface MortarSource {
  metric: 'bags' | 'tons';
  target: { value: number; projected: number } | null;
  totals: {
    bags: number;
    kg: number;
    actual: number;
    runningS: number;
    idleS: number;
    elapsedProductive: number;
    pacePerHour: number;
    projected: number;
    availability: number | null;
    performance: number | null;
    effectiveness: number | null;
    stops: number;
    stopSeconds: number;
  };
}
export const MORTAR_VARIABLES: Record<
  string,
  { label: string; description: string; unit: string; decimals: number }
> = {
  'argamassa.sacos': {
    label: 'Sacos',
    description: 'sacos ensacados no turno, todos os bicos',
    unit: 'sacos',
    decimals: 0,
  },
  'argamassa.toneladas': {
    label: 'Toneladas',
    description: 'toneladas ensacadas no turno',
    unit: 't',
    decimals: 1,
  },
  'argamassa.meta': {
    label: 'Meta',
    description: 'meta do turno, na unidade da meta',
    unit: '',
    decimals: 0,
  },
  'argamassa.projecao': {
    label: 'Projeção',
    description: 'projeção de fechamento do turno',
    unit: '',
    decimals: 0,
  },
  'argamassa.ritmo': {
    label: 'Ritmo',
    description: 'ritmo do turno por hora produtiva, na unidade da meta',
    unit: '/h',
    decimals: 0,
  },
  'argamassa.horas_ensacando': {
    label: 'Horas ensacando',
    description: 'horas de bico ensacando, somando os bicos',
    unit: 'h',
    decimals: 1,
  },
  'argamassa.horas_ociosas': {
    label: 'Horas ociosas',
    description: 'horas de bico habilitado sem ensacar',
    unit: 'h',
    decimals: 1,
  },
  'argamassa.horas_decorridas': {
    label: 'Horas decorridas',
    description: 'horas produtivas do turno já decorridas',
    unit: 'h',
    decimals: 1,
  },
  'argamassa.disponibilidade': {
    label: 'Disponibilidade',
    description: 'tempo ensacando ÷ tempo habilitado, em %',
    unit: '%',
    decimals: 1,
  },
  'argamassa.desempenho': {
    label: 'Desempenho',
    description: 'sacos feitos ÷ sacos do ritmo padrão, em %',
    unit: '%',
    decimals: 1,
  },
  'argamassa.eficiencia': {
    label: 'Eficiência',
    description: 'disponibilidade × desempenho, em %',
    unit: '%',
    decimals: 1,
  },
  'argamassa.paradas': {
    label: 'Paradas',
    description: 'paradas dos bicos no turno',
    unit: 'paradas',
    decimals: 0,
  },
  'argamassa.minutos_parados': {
    label: 'Minutos parados',
    description: 'minutos de parada somando os bicos',
    unit: 'min',
    decimals: 0,
  },
};
export function mortarVariables(board: MortarSource | null | undefined): Record<string, number> {
  if (!board) return {};
  const { totals } = board;
  return {
    'argamassa.sacos': totals.bags,
    'argamassa.toneladas': totals.kg / 1000,
    'argamassa.meta': board.target?.value ?? 0,
    'argamassa.projecao': totals.projected,
    'argamassa.ritmo': totals.pacePerHour,
    'argamassa.horas_ensacando': totals.runningS / 3600,
    'argamassa.horas_ociosas': totals.idleS / 3600,
    'argamassa.horas_decorridas': totals.elapsedProductive / 3600,
    'argamassa.disponibilidade': (totals.availability ?? 0) * 100,
    'argamassa.desempenho': (totals.performance ?? 0) * 100,
    'argamassa.eficiencia': (totals.effectiveness ?? 0) * 100,
    'argamassa.paradas': totals.stops,
    'argamassa.minutos_parados': totals.stopSeconds / 60,
  };
}

/** The HMI's latest words (the recipe, a message) under their ihm.* names. */
export function hmiTexts(texts: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(texts)
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([key, value]) => [`ihm.${key}`, value]),
  );
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
export function variableOptionsFor(
  values: Record<string, number>,
  texts: Record<string, string> = {},
  /** Which platform names the equipment has: the ceramic board's or the mortar board's. */
  platform: 'painel' | 'argamassa' = 'painel',
): VariableOption[] {
  const hmi = Object.keys(values)
    .filter((name) => name.startsWith('ihm.'))
    .sort();
  const words = Object.keys(texts).sort();
  return [
    ...(platform === 'argamassa'
      ? Object.keys(MORTAR_VARIABLES).map((name) => ({
          name,
          description: MORTAR_VARIABLES[name].description,
          value: values[name] == null ? '—' : format(values[name]),
        }))
      : Object.keys(PANEL_VARIABLES).map((name) => ({
          name,
          description: PANEL_VARIABLES[name].description,
          value: values[name] == null ? '—' : format(values[name]),
        }))),
    ...hmi.map((name) => ({
      name,
      description: 'variável da IHM',
      value: values[name] == null ? '—' : format(values[name]),
    })),
    // Words cannot enter a calculation, but a block shows one on its own.
    ...words.map((name) => ({
      name,
      description: PANEL_TEXTS[name] ?? 'texto da IHM (só sozinho, não entra em conta)',
      value: texts[name] || '—',
    })),
  ];
}

/** Names a formula may use: painel.* always exists (a device without a board yet reads it as no
 * value, not as an unknown name), plus the HMI variables read so far. */
export function knownVariables(
  values: Record<string, number>,
  texts: Record<string, string> = {},
  platform: 'painel' | 'argamassa' = 'painel',
) {
  const names = platform === 'argamassa' ? MORTAR_VARIABLES : PANEL_VARIABLES;
  return [...new Set([...Object.keys(names), ...Object.keys(values), ...Object.keys(texts)])];
}

/** What the platform itself knows in words. */
export const PANEL_TEXTS: Record<string, string> = {
  'painel.produto': 'receita/produto que está rodando agora',
  'painel.turno': 'nome do turno em andamento',
};
