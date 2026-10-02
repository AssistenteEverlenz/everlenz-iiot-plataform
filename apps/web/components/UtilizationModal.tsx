'use client';

import { useState } from 'react';
import { mutate } from './data';

// How "Aproveitamento da máquina" is counted, chosen per equipment from the board's own card.
// A machine with automation stops itself and sits idle; one without automation is either
// producing or stopped by hand, so only counting idle time would read close to 100% all day.

export type UtilizationBasis = 'idle' | 'stopped';

const options: Array<{ basis: UtilizationBasis; title: string; text: string }> = [
  {
    basis: 'idle',
    title: 'Produzindo ÷ (produzindo + ociosa)',
    text: 'Para máquinas com automático: parada manual não pesa contra a máquina.',
  },
  {
    basis: 'stopped',
    title: 'Produzindo ÷ (produzindo + ociosa + manual/parada)',
    text: 'Para máquinas sem automático, que só ficam produzindo ou paradas.',
  },
];

export function utilizationCaption(basis: UtilizationBasis | undefined) {
  return basis === 'stopped'
    ? 'produzindo ÷ (produzindo + ociosa + parada)'
    : 'produzindo ÷ (produzindo + ociosa)';
}

export function UtilizationModal({
  deviceId,
  basis,
  onClose,
}: {
  deviceId: string;
  basis: UtilizationBasis;
  onClose: (saved: boolean) => void;
}) {
  const [choice, setChoice] = useState<UtilizationBasis>(basis);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setSaving(true);
    setError('');
    try {
      await mutate(`/devices/${deviceId}/production-utilization`, 'PATCH', { basis: choice });
      onClose(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => !saving && onClose(false)}>
      <div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>
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
        <div className="form-grid">
          {options.map((option) => (
            <label key={option.basis} className="check-field full-field">
              <input
                type="radio"
                name="utilization-basis"
                checked={choice === option.basis}
                onChange={() => setChoice(option.basis)}
              />
              <span>
                <b>{option.title}</b>
                <br />
                <small>{option.text}</small>
              </span>
            </label>
          ))}
          <div className="notice full-field">
            <b>Vale para este equipamento</b>
            Muda o número no quadro, na TV e na lista de produção ao vivo. Fotos de dias já
            fechados guardam o número que tinham.
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={() => onClose(false)}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving || choice === basis}
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
