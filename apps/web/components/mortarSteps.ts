import { createContext } from 'react';
import {
  MT_METAL_MIXER,
  type MixerAlarm,
  type MixerStep,
  type StepKind,
} from './mortarMixerConfig';

/**
 * The steps and alerts a mixer board names and colours its numbers with: the device's own
 * configuration (mortarMixerConfig.ts, migration 049), handed to the board by the API and shared
 * with everything inside it. A step the list does not know is shown as "Passo N" and counted as
 * work; an alert it does not know as "Alerta N".
 */
export type { StepKind } from './mortarMixerConfig';
export type Process = 'pesagem' | 'misturador';
export type Catalog = { pesagem: MixerStep[]; misturador: MixerStep[]; alarmes: MixerAlarm[] };

export const DEFAULT_CATALOG: Catalog = {
  pesagem: MT_METAL_MIXER.weighing.steps,
  misturador: MT_METAL_MIXER.mixing.steps,
  alarmes: MT_METAL_MIXER.alarms.codes,
};
export const StepsContext = createContext<Catalog>(DEFAULT_CATALOG);

export const STEP_KINDS: Record<StepKind, { label: string; color: string }> = {
  work: { label: 'Trabalhando', color: 'var(--brand-accent, #12b8a6)' },
  prep: { label: 'Preparando', color: 'color-mix(in srgb, var(--brand-accent, #12b8a6) 40%, #fff)' },
  wait: { label: 'Aguardando', color: '#f2a93b' },
  off: { label: 'Desligado', color: '#cfd8db' },
};

export const ALARM_KINDS: Record<MixerAlarm['kind'], { label: string; color: string }> = {
  material: { label: 'Falta de material', color: '#e4572e' },
  equipment: { label: 'Equipamento', color: '#9b6bd3' },
  process: { label: 'Processo', color: '#f2a93b' },
  info: { label: 'Aviso', color: '#8a9ca2' },
};

export function stepOf(catalog: Catalog, process: Process, value: number) {
  return (
    catalog[process].find((item) => item.value === value) ?? {
      value,
      label: `Passo ${value}`,
      kind: 'work' as StepKind,
      material: null,
      timer: null,
      cycle: false,
    }
  );
}

export function alarmOf(catalog: Catalog, value: number) {
  return (
    catalog.alarmes.find((item) => item.value === value) ?? {
      value,
      label: `Alerta ${value}`,
      kind: 'info' as MixerAlarm['kind'],
      material: null,
    }
  );
}

/** The material a weighing step doses, matched by name to the recipe's materials. */
export function materialIndex(materials: Array<{ label: string }>, name: string | null | undefined) {
  if (!name) return -1;
  const wanted = name.trim().toLowerCase();
  return materials.findIndex((item) => {
    const label = item.label.trim().toLowerCase();
    return label === wanted || label.startsWith(wanted) || wanted.startsWith(label);
  });
}
