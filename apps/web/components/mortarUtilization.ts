// "Disponibilidade dos bicos" written by the plant, the mortar twin of utilizationFormula.ts:
// a formula over the period's state times whose result is the percentage itself. The API reads
// this file too, so the board and its detail compute the same number from the same names. No
// React here: plain arithmetic both sides can import.

import { evaluateFormula, formulaError } from './formula.ts';

export interface MortarTime {
  producing: number;
  idle: number;
  disabled: number;
  offline?: number;
  elapsedProductive?: number;
}

/** The names a availability formula reads, with what each one is. */
export const MORTAR_UTILIZATION_VARIABLES: Record<string, string> = {
  'argamassa.horas_ensacando': 'horas com bico ensacando',
  'argamassa.horas_ociosa': 'horas de bico habilitado sem ensacar',
  'argamassa.horas_desabilitada': 'horas de bico desligado na IHM',
  'argamassa.horas_sem_comunicacao': 'horas sem comunicação',
  'argamassa.horas_paradas': 'horas ociosa ou desabilitada',
  'argamassa.horas_decorridas': 'horas de turno já decorridas',
  'argamassa.minutos_ensacando': 'minutos com bico ensacando',
  'argamassa.minutos_ociosa': 'minutos de bico habilitado sem ensacar',
  'argamassa.minutos_desabilitada': 'minutos de bico desligado na IHM',
  'argamassa.minutos_sem_comunicacao': 'minutos sem comunicação',
  'argamassa.minutos_paradas': 'minutos ociosa ou desabilitada',
  'argamassa.minutos_decorridos': 'minutos de turno já decorridos',
};

/** What the default reads, written as a formula: the starting point of a custom one. */
export const DEFAULT_MORTAR_UTILIZATION =
  'argamassa.horas_ensacando / (argamassa.horas_ensacando + argamassa.horas_ociosa) * 100';

export function mortarUtilizationValues(time: MortarTime): Record<string, number> {
  const offline = time.offline ?? 0;
  const elapsed = time.elapsedProductive ?? time.producing + time.idle + time.disabled + offline;
  const seconds: Record<string, number> = {
    ensacando: time.producing,
    ociosa: time.idle,
    desabilitada: time.disabled,
    sem_comunicacao: offline,
    paradas: time.idle + time.disabled,
  };
  const values: Record<string, number> = {
    'argamassa.horas_decorridas': elapsed / 3600,
    'argamassa.minutos_decorridos': elapsed / 60,
  };
  for (const [name, value] of Object.entries(seconds)) {
    values[`argamassa.horas_${name}`] = value / 3600;
    values[`argamassa.minutos_${name}`] = value / 60;
  }
  return values;
}

/** The availability as a fraction (0.89 for 89 %), or null when there is nothing to divide. */
export function mortarUtilizationFrom(formula: string | null | undefined, time: MortarTime) {
  if (!formula?.trim()) {
    const total = time.producing + time.idle;
    return total > 0 ? time.producing / total : null;
  }
  const percent = evaluateFormula(formula, mortarUtilizationValues(time));
  return percent == null ? null : percent / 100;
}

export function mortarUtilizationError(formula: string) {
  if (!formula.trim()) return 'Escreva a fórmula.';
  return formulaError(formula, Object.keys(MORTAR_UTILIZATION_VARIABLES));
}

/** The gauge caption: the default in words, or the plant's own formula as written. */
export function mortarUtilizationCaption(formula: string | null | undefined) {
  return formula?.trim()
    ? formula.replace(/argamassa\./g, '')
    : 'ensacando ÷ (ensacando + ociosa)';
}
