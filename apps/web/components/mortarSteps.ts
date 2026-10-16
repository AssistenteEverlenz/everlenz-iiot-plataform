/**
 * The steps the mixer's PLC runs its two processes with (Bella Massa, 2026-10-15), in the words
 * the board uses. Each step has a kind, the one thing the board needs to colour and add it:
 *   work  -- the machine doing its job (dosing, loading, mixing, discharging);
 *   prep  -- the PLC checking or calculating between jobs, seconds at a time;
 *   wait  -- waiting for something outside the process (the mixer, the additive, the bagger);
 *   off   -- the process switched off.
 * A step the list does not know is shown as "Passo N" and counted as work.
 */
export type StepKind = 'work' | 'prep' | 'wait' | 'off';
export type Process = 'pesagem' | 'misturador';

export const PROCESS_STEPS: Record<
  Process,
  Array<{ step: number; label: string; short: string; kind: StepKind; material?: number }>
> = {
  pesagem: [
    { step: 0, label: 'Desligado', short: 'Desligado', kind: 'off' },
    { step: 1, label: 'Verificando a balança', short: 'Verifica', kind: 'prep' },
    { step: 5, label: 'Calculando a areia', short: 'Calcula', kind: 'prep' },
    { step: 10, label: 'Dosando areia', short: 'Areia', kind: 'work', material: 0 },
    { step: 15, label: 'Calculando o porta bag 01', short: 'Calcula', kind: 'prep' },
    { step: 20, label: 'Dosando porta bag 01', short: 'Bag 01', kind: 'work', material: 1 },
    { step: 25, label: 'Calculando o porta bag 02', short: 'Calcula', kind: 'prep' },
    { step: 30, label: 'Dosando porta bag 02', short: 'Bag 02', kind: 'work', material: 2 },
    { step: 35, label: 'Finalizando a pesagem', short: 'Finaliza', kind: 'prep' },
    { step: 40, label: 'Aguardando o misturador esvaziar', short: 'Aguarda', kind: 'wait' },
    { step: 45, label: 'Descarregando a balança', short: 'Descarga', kind: 'work' },
  ],
  misturador: [
    { step: 0, label: 'Desligado', short: 'Desligado', kind: 'off' },
    { step: 1, label: 'Aguardando a balança', short: 'Aguarda', kind: 'wait' },
    { step: 5, label: 'Carregando o misturador', short: 'Carga', kind: 'work' },
    { step: 10, label: 'Aguardando o aditivo', short: 'Aditivo', kind: 'wait' },
    { step: 15, label: 'Misturando', short: 'Mistura', kind: 'work' },
    { step: 20, label: 'Aguardando a moega da ensacadeira', short: 'Moega', kind: 'wait' },
    { step: 21, label: 'Descarregando o misturador', short: 'Descarga', kind: 'work' },
    { step: 22, label: 'Verificando o nível da moega', short: 'Nível', kind: 'wait' },
    { step: 25, label: 'Liberando o misturador', short: 'Libera', kind: 'work' },
  ],
};

export const STEP_KINDS: Record<StepKind, { label: string; color: string }> = {
  work: { label: 'Trabalhando', color: 'var(--brand-accent, #12b8a6)' },
  prep: { label: 'Preparando', color: 'color-mix(in srgb, var(--brand-accent, #12b8a6) 40%, #fff)' },
  wait: { label: 'Aguardando', color: '#f2a93b' },
  off: { label: 'Desligado', color: '#cfd8db' },
};

export function stepOf(process: Process, step: number) {
  return (
    PROCESS_STEPS[process].find((item) => item.step === step) ?? {
      step,
      label: `Passo ${step}`,
      short: `P${step}`,
      kind: 'work' as StepKind,
    }
  );
}
