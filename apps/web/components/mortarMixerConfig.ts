/**
 * The mixer of a mortar plant as its PLC is programmed (migration 049): which variable plays
 * each role, the steps of its two processes and the codes of its alert word. Each device keeps
 * its own (mortar_settings.mixer_config), edited on the mixer card's pencil; the model of the
 * first plant (MT Metal, at Bella Massa) is one click away, and a device not configured yet is
 * read with that model and its variable names, so nothing changed for it.
 *
 * Shared by the ingestor (which variables to record as steps and alerts), the API (what the
 * board computes) and the web (labels, colours, the editor).
 */
export type StepKind = 'work' | 'prep' | 'wait' | 'off';
export type MixerTimer = 'mix' | 'discharge';
export interface MixerStep {
  /** The number the PLC publishes. */
  value: number;
  label: string;
  /** Working, preparing, waiting for something outside, or off: what the board adds up. */
  kind: StepKind;
  /** The material this step doses (a weighing step), by the material's name. */
  material?: string | null;
  /** The step the recipe times: its stopwatch and programmed time are the mixer's. */
  timer?: MixerTimer | null;
  /** A cycle starts here: the time from one to the next is the cycle. */
  cycle?: boolean;
}
export type AlarmKind = 'material' | 'equipment' | 'process' | 'info';
export interface MixerAlarm {
  value: number;
  label: string;
  kind: AlarmKind;
  /** The material that ran out, for a "falta de material" alert. */
  material?: string | null;
}
export type MixerRole =
  | 'asked'
  | 'total'
  | 'mixTimer'
  | 'dischargeTimer'
  | 'mixSetpoint'
  | 'dischargeSetpoint'
  | 'automatic';
export interface MixerConfig {
  /** Tag ids of each role; null when the PLC has no such variable. */
  tags: Partial<Record<MixerRole, string | null>>;
  weighing: { tagId: string | null; steps: MixerStep[] };
  mixing: { tagId: string | null; steps: MixerStep[] };
  alarms: { tagId: string | null; codes: MixerAlarm[] };
}

export const MIXER_ROLES: Array<{ role: MixerRole; label: string; hint: string; key: string }> = [
  {
    role: 'asked',
    label: 'Bateladas pedidas',
    hint: 'quantas o lote deve ter',
    key: 'BateladasDesejadas',
  },
  {
    role: 'total',
    label: 'Peso total da batelada',
    hint: 'o total previsto da receita, kg',
    key: 'PesoDesejadoTotal',
  },
  {
    role: 'mixTimer',
    label: 'Cronômetro da mistura',
    hint: 'conta enquanto mistura',
    key: 'TempoMistura',
  },
  {
    role: 'dischargeTimer',
    label: 'Cronômetro da descarga',
    hint: 'conta enquanto descarrega',
    key: 'TempoDescarga',
  },
  {
    role: 'mixSetpoint',
    label: 'Tempo de mistura programado',
    hint: 'opcional; sem ele, lido do cronômetro',
    key: 'TempoMisturaProgramado',
  },
  {
    role: 'dischargeSetpoint',
    label: 'Tempo de descarga programado',
    hint: 'opcional; sem ele, lido do cronômetro',
    key: 'TempoDescargaProgramado',
  },
  {
    role: 'automatic',
    label: 'Modo automático',
    hint: 'ligado = automático',
    key: 'ModoAutomatico',
  },
];
/** The names the first plant publishes, used while a device has no configuration. */
export const DEFAULT_PROCESS_KEYS = {
  weighing: 'ProcessoPesagem',
  mixing: 'ProcessoMisturador',
  alarms: 'StatusAlerta',
};

/** The model of MT Metal's mixer, as at Bella Massa (2026-10-16). */
export const MT_METAL_MIXER: Pick<MixerConfig, 'weighing' | 'mixing' | 'alarms'> = {
  weighing: {
    tagId: null,
    steps: [
      { value: 0, label: 'Desligado', kind: 'off' },
      { value: 1, label: 'Verificando a balança', kind: 'prep', cycle: false },
      { value: 5, label: 'Calculando a areia', kind: 'prep' },
      { value: 10, label: 'Dosando areia', kind: 'work', material: 'Areia', cycle: true },
      { value: 15, label: 'Calculando o porta bag 01', kind: 'prep' },
      { value: 20, label: 'Dosando porta bag 01', kind: 'work', material: 'Cimento' },
      { value: 25, label: 'Calculando o porta bag 02', kind: 'prep' },
      { value: 30, label: 'Dosando porta bag 02', kind: 'work', material: 'Porta bag 02' },
      { value: 35, label: 'Finalizando a pesagem', kind: 'prep' },
      { value: 40, label: 'Aguardando o misturador esvaziar', kind: 'wait' },
      { value: 45, label: 'Descarregando a balança', kind: 'work' },
    ],
  },
  mixing: {
    tagId: null,
    steps: [
      { value: 0, label: 'Desligado', kind: 'off' },
      { value: 1, label: 'Aguardando a balança', kind: 'wait' },
      { value: 5, label: 'Carregando o misturador', kind: 'work' },
      { value: 10, label: 'Aguardando o aditivo', kind: 'wait' },
      { value: 15, label: 'Misturando', kind: 'work', timer: 'mix', cycle: true },
      { value: 20, label: 'Aguardando a moega da ensacadeira', kind: 'wait' },
      { value: 21, label: 'Descarregando o misturador', kind: 'work', timer: 'discharge' },
      { value: 22, label: 'Verificando o nível da moega', kind: 'wait' },
      { value: 25, label: 'Liberando o misturador', kind: 'work' },
    ],
  },
  alarms: {
    tagId: null,
    codes: [
      { value: 1, label: 'Aguardando aditivo no misturador', kind: 'process' },
      { value: 2, label: 'Guilhotina da areia não abriu', kind: 'equipment' },
      { value: 3, label: 'Guilhotina da balança não abriu', kind: 'equipment' },
      { value: 4, label: 'Guilhotina do misturador não abriu', kind: 'equipment' },
      { value: 5, label: 'Falta material: areia', kind: 'material', material: 'Areia' },
      { value: 6, label: 'Falta material: cimento', kind: 'material', material: 'Cimento' },
      {
        value: 7,
        label: 'Falta material: porta bag 02',
        kind: 'material',
        material: 'Porta bag 02',
      },
      { value: 8, label: 'Balança não está vazia', kind: 'process' },
      { value: 9, label: 'Guilhotina da balança não fechou', kind: 'equipment' },
      { value: 10, label: 'Nível alto na moega das ensacadeiras', kind: 'process' },
      { value: 11, label: 'Quantidade de bateladas igual a 0', kind: 'info' },
    ],
  },
};

/**
 * The configuration a device is read with: its own, or -- not configured yet -- the MT Metal
 * model with the variables found by the first plant's names.
 */
export function resolveMixerConfig(
  stored: MixerConfig | null | undefined,
  tagOfKey: (key: string) => string | null,
): MixerConfig {
  if (stored && typeof stored === 'object' && stored.weighing && stored.mixing) {
    return {
      tags: stored.tags ?? {},
      weighing: { tagId: stored.weighing.tagId ?? null, steps: stored.weighing.steps ?? [] },
      mixing: { tagId: stored.mixing.tagId ?? null, steps: stored.mixing.steps ?? [] },
      alarms: { tagId: stored.alarms?.tagId ?? null, codes: stored.alarms?.codes ?? [] },
    };
  }
  return {
    tags: Object.fromEntries(MIXER_ROLES.map((item) => [item.role, tagOfKey(item.key)])),
    weighing: { ...MT_METAL_MIXER.weighing, tagId: tagOfKey(DEFAULT_PROCESS_KEYS.weighing) },
    mixing: { ...MT_METAL_MIXER.mixing, tagId: tagOfKey(DEFAULT_PROCESS_KEYS.mixing) },
    alarms: { ...MT_METAL_MIXER.alarms, tagId: tagOfKey(DEFAULT_PROCESS_KEYS.alarms) },
  };
}
