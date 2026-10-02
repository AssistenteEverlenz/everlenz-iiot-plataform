'use client';

import { useState } from 'react';
import { mutate } from './data';
import { formatNumber } from './ShiftBoard';

// How "Aproveitamento da máquina" is counted, chosen per equipment from the board's own card:
// the default producing ÷ (producing + idle), or a formula the plant writes by choosing which
// state times go above the line and which below.

export type UtilizationState = 'producing' | 'idle' | 'manual' | 'offline';
export interface UtilizationFormula {
  numerator: UtilizationState[];
  denominator: UtilizationState[];
}

const states: Array<[UtilizationState, string]> = [
  ['producing', 'Produzindo'],
  ['idle', 'Ociosa'],
  ['manual', 'Manual / parada'],
  ['offline', 'Sem comunicação'],
];
const words = (list: UtilizationState[]) =>
  states
    .filter(([state]) => list.includes(state))
    .map(([, label]) => label.toLowerCase())
    .join(' + ');

/** The formula in words, as the gauge caption and the modal preview show it. */
export function utilizationCaption(formula: UtilizationFormula | null | undefined) {
  if (!formula) return 'produzindo ÷ (produzindo + ociosa)';
  const above = words(formula.numerator);
  const below = words(formula.denominator);
  return `${formula.numerator.length > 1 ? `(${above})` : above} ÷ ${
    formula.denominator.length > 1 ? `(${below})` : below
  }`;
}

export function UtilizationModal({
  deviceId,
  formula,
  time,
  onClose,
}: {
  deviceId: string;
  formula: UtilizationFormula | null;
  /** The period's state times, so the preview shows what the formula would read now. */
  time: Partial<Record<UtilizationState, number>>;
  onClose: (saved: boolean) => void;
}) {
  const [custom, setCustom] = useState(Boolean(formula));
  const [numerator, setNumerator] = useState<UtilizationState[]>(
    formula?.numerator ?? ['producing'],
  );
  const [denominator, setDenominator] = useState<UtilizationState[]>(
    formula?.denominator ?? ['producing', 'idle', 'manual'],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toggle = (list: UtilizationState[], state: UtilizationState) =>
    list.includes(state) ? list.filter((item) => item !== state) : [...list, state];
  const chosen = custom ? { numerator, denominator } : null;
  const sum = (list: UtilizationState[]) =>
    list.reduce((total, state) => total + (time[state] ?? 0), 0);
  const below = sum(chosen?.denominator ?? ['producing', 'idle']);
  const preview = below > 0 ? (sum(chosen?.numerator ?? ['producing']) / below) * 100 : null;
  const invalid = custom && (!numerator.length || !denominator.length);

  async function save() {
    setSaving(true);
    setError('');
    try {
      await mutate(`/devices/${deviceId}/production-utilization`, 'PATCH', { formula: chosen });
      onClose(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => !saving && onClose(false)}>
      <div
        className="modal-card utilization-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-title">
          <div>
            <div className="eyebrow">APROVEITAMENTO DA MÁQUINA</div>
            <h2>Como calcular</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={saving}
            onClick={() => onClose(false)}
          >
            ×
          </button>
        </div>
        <div className="utilization-options">
          <label className={`utilization-option ${custom ? '' : 'active'}`}>
            <input type="radio" checked={!custom} onChange={() => setCustom(false)} />
            <span>
              <b>Padrão</b>
              <small>Produzindo ÷ (produzindo + ociosa). Parada manual não pesa contra a máquina.</small>
            </span>
          </label>
          <label className={`utilization-option ${custom ? 'active' : ''}`}>
            <input type="radio" checked={custom} onChange={() => setCustom(true)} />
            <span>
              <b>Personalizada</b>
              <small>Você escolhe quais tempos entram em cima e quais entram embaixo.</small>
            </span>
          </label>
        </div>
        {custom && (
          <div className="utilization-builder">
            {(
              [
                ['Em cima · conta como aproveitado', numerator, setNumerator],
                ['Embaixo · tempo considerado', denominator, setDenominator],
              ] as const
            ).map(([title, list, set]) => (
              <fieldset key={title}>
                <legend>{title}</legend>
                {states.map(([state, label]) => (
                  <label key={state} className="utilization-chip">
                    <input
                      type="checkbox"
                      checked={list.includes(state)}
                      onChange={() => set(toggle(list, state))}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        )}
        <div className="utilization-preview">
          <span>{invalid ? 'Escolha ao menos um tempo em cima e um embaixo.' : utilizationCaption(chosen)}</span>
          <b>{invalid || preview == null ? '—' : `${formatNumber(preview)}%`}</b>
          <small>no período aberto no quadro</small>
        </div>
        <div className="notice full-field">
          <b>Vale para este equipamento</b>
          Muda o número no quadro, na TV e no painel ao vivo. Fotos de dias já fechados guardam o
          número que tinham.
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={() => onClose(false)}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving || invalid}
            onClick={() => void save()}
          >
            {saving && <span className="button-spinner" />}
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}
