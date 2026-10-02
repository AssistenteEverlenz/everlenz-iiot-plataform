'use client';

import { useState } from 'react';
import { mutate } from './data';
import { FormulaInput } from './FormulaInput';
import { formatNumber } from './ShiftBoard';
import {
  DEFAULT_UTILIZATION_FORMULA,
  UTILIZATION_VARIABLES,
  utilizationFormulaError,
  utilizationFrom,
  utilizationValues,
  type UtilizationTime,
} from './utilizationFormula';

// How "Aproveitamento da máquina" is counted, chosen per equipment from the board's own card:
// the default producing ÷ (producing + idle), or a formula the plant writes over the period's
// state times, typed like the other cards' formulas. Its result is the percentage itself.

/** The gauge caption: the default in words, or the plant's own formula as written. */
export function utilizationCaption(formula: string | null | undefined) {
  return formula?.trim() ? formula.replace(/painel\./g, '') : 'produzindo ÷ (produzindo + ociosa)';
}

export function UtilizationModal({
  deviceId,
  formula,
  time,
  onClose,
}: {
  deviceId: string;
  formula: string | null;
  /** The period's state times, so the preview shows what the formula reads now. */
  time: UtilizationTime;
  onClose: (saved: boolean) => void;
}) {
  const [custom, setCustom] = useState(Boolean(formula));
  const [text, setText] = useState(formula ?? DEFAULT_UTILIZATION_FORMULA);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const values = utilizationValues(time);
  const options = Object.entries(UTILIZATION_VARIABLES).map(([name, description]) => ({
    name,
    description,
    value: formatNumber(values[name] ?? 0, 1),
  }));
  const problem = custom ? utilizationFormulaError(text) : null;
  const preview = problem ? null : utilizationFrom(custom ? text : null, time);

  async function save() {
    setSaving(true);
    setError('');
    try {
      await mutate(`/devices/${deviceId}/production-utilization`, 'PATCH', {
        formula: custom ? text : null,
      });
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
              <b>Fórmula própria</b>
              <small>Uma conta sua sobre os tempos do período. O resultado é o próprio %.</small>
            </span>
          </label>
        </div>
        {custom && (
          <div className="utilization-builder">
            <FormulaInput
              value={text}
              options={options}
              placeholder={DEFAULT_UTILIZATION_FORMULA}
              onChange={setText}
            />
            <small>
              Digite o nome de um tempo e escolha na lista. Ex.: painel.horas_produzindo /
              (painel.horas_produzindo + painel.horas_paradas) * 100
            </small>
          </div>
        )}
        <div className="utilization-preview">
          <span>{problem ?? (custom ? 'resultado da sua fórmula' : 'produzindo ÷ (produzindo + ociosa)')}</span>
          <b>{preview == null ? '—' : `${formatNumber(preview * 100)}%`}</b>
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
            disabled={saving || Boolean(problem)}
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
