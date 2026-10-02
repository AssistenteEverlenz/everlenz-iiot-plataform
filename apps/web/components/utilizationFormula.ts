// "Aproveitamento da máquina" written by the plant, the same way as the other cards' formulas:
// a formula over the period's state times whose result is the percentage itself. The API reads
// this file too (its bundle takes it in), so the board, the TV and the panel compute the same
// number from the same names. No React here: it is plain arithmetic both sides can import.

import { evaluateFormula, formulaError } from './formula.ts';

export interface UtilizationTime {
  producing: number;
  idle: number;
  manual: number;
  offline?: number;
  elapsedProductive?: number;
}

/** The names a utilization formula reads, with what each one is. */
export const UTILIZATION_VARIABLES: Record<string, string> = {
  'painel.horas_produzindo': 'horas com a máquina produzindo',
  'painel.horas_ociosa': 'horas em automático sem produzir',
  'painel.horas_manual': 'horas em manual / parada',
  'painel.horas_sem_comunicacao': 'horas sem comunicação',
  'painel.horas_paradas': 'horas ociosa ou em manual',
  'painel.horas_decorridas': 'horas de turno já decorridas',
  'painel.minutos_produzindo': 'minutos com a máquina produzindo',
  'painel.minutos_ociosa': 'minutos em automático sem produzir',
  'painel.minutos_manual': 'minutos em manual / parada',
  'painel.minutos_sem_comunicacao': 'minutos sem comunicação',
  'painel.minutos_paradas': 'minutos ociosa ou em manual',
  'painel.minutos_decorridos': 'minutos de turno já decorridos',
};

/** What the default reads, written as a formula: the starting point of a custom one. */
export const DEFAULT_UTILIZATION_FORMULA =
  'painel.horas_produzindo / (painel.horas_produzindo + painel.horas_ociosa) * 100';

export function utilizationValues(time: UtilizationTime): Record<string, number> {
  const offline = time.offline ?? 0;
  const elapsed = time.elapsedProductive ?? time.producing + time.idle + time.manual + offline;
  const seconds: Record<string, number> = {
    produzindo: time.producing,
    ociosa: time.idle,
    manual: time.manual,
    sem_comunicacao: offline,
    paradas: time.idle + time.manual,
  };
  const values: Record<string, number> = {
    'painel.horas_decorridas': elapsed / 3600,
    'painel.minutos_decorridos': elapsed / 60,
  };
  for (const [name, value] of Object.entries(seconds)) {
    values[`painel.horas_${name}`] = value / 3600;
    values[`painel.minutos_${name}`] = value / 60;
  }
  return values;
}

/** The utilization as a fraction (0.62 for 62 %), or null when there is nothing to divide. */
export function utilizationFrom(formula: string | null | undefined, time: UtilizationTime) {
  if (!formula?.trim()) {
    const total = time.producing + time.idle;
    return total > 0 ? time.producing / total : null;
  }
  const percent = evaluateFormula(formula, utilizationValues(time));
  return percent == null ? null : percent / 100;
}

export function utilizationFormulaError(formula: string) {
  if (!formula.trim()) return 'Escreva a fórmula.';
  return formulaError(formula, Object.keys(UTILIZATION_VARIABLES));
}

/**
 * The first custom formulas were chosen as boxes (state times above and below the line); they
 * read as the same formula written out, so a plant that chose one keeps its number.
 */
export function utilizationFormulaText(stored: unknown): string | null {
  if (!stored || typeof stored !== 'object') return null;
  const value = stored as { formula?: unknown; numerator?: unknown; denominator?: unknown };
  if (typeof value.formula === 'string') return value.formula.trim() || null;
  const names: Record<string, string> = {
    producing: 'painel.horas_produzindo',
    idle: 'painel.horas_ociosa',
    manual: 'painel.horas_manual',
    offline: 'painel.horas_sem_comunicacao',
  };
  const part = (list: unknown) =>
    Array.isArray(list) ? list.filter((item) => item in names).map((item) => names[item]) : [];
  const above = part(value.numerator);
  const below = part(value.denominator);
  if (!above.length || !below.length) return null;
  const group = (list: string[]) => (list.length > 1 ? `(${list.join(' + ')})` : list[0]);
  return `${group(above)} / ${group(below)} * 100`;
}
