'use client';

import { useState } from 'react';
import { BrandSpinner, usePlatform } from './PlatformShell';

// Wiping readings of one variable that were recorded wrong (bad format or address on the HMI,
// a PLC bug). A period keeps the rest of the history; "all" starts the variable over. The API
// rebuilds the hourly totals around the period so no average or counter jumps.

function localInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function ClearHistoryModal({
  variable,
  onConfirm,
  onClose,
}: {
  variable: string;
  onConfirm: (range: { from: string; to: string } | null) => Promise<void>;
  onClose: () => void;
}) {
  const { branding } = usePlatform();
  const [scope, setScope] = useState<'period' | 'all'>('period');
  const [from, setFrom] = useState(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return localInput(start);
  });
  const [to, setTo] = useState(() => localInput(new Date()));
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    setError('');
    let range: { from: string; to: string } | null = null;
    if (scope === 'period') {
      const start = new Date(from);
      const end = new Date(to);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end)
        return setError('O início do período precisa ser antes do fim.');
      range = { from: start.toISOString(), to: end.toISOString() };
    }
    setProcessing(true);
    try {
      await onConfirm(range);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível apagar as leituras.');
      setProcessing(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => !processing && onClose()}>
      <section
        className="modal-card compact-modal action-modal clear-history-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {processing ? (
          <BrandSpinner branding={branding} />
        ) : (
          <div className="modal-action-icon danger">!</div>
        )}
        <div className="eyebrow">ZERAR HISTÓRICO DA VARIÁVEL</div>
        <h2>{variable}</h2>
        <p>
          Apaga leituras gravadas desta variável e refaz os totais e médias calculados a partir
          delas. Use quando ela foi lida com formato ou endereço errado. Vale para todos os itens
          que usam esta variável. As outras variáveis do equipamento não são afetadas.
        </p>
        <div className="clear-history-options">
          <label>
            <input
              type="radio"
              name="clear-scope"
              checked={scope === 'period'}
              onChange={() => setScope('period')}
            />
            Somente um período
          </label>
          {scope === 'period' && (
            <div className="clear-history-range">
              <label className="field">
                De
                <input
                  type="datetime-local"
                  value={from}
                  max={to}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label className="field">
                Até
                <input
                  type="datetime-local"
                  value={to}
                  min={from}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
            </div>
          )}
          <label>
            <input
              type="radio"
              name="clear-scope"
              checked={scope === 'all'}
              onChange={() => setScope('all')}
            />
            Todo o histórico desta variável
          </label>
        </div>
        <p className="clear-history-warning">Esta ação não pode ser desfeita.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={processing} onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            disabled={processing}
            className="danger-button-solid"
            onClick={() => void confirm()}
          >
            {processing && <span className="button-spinner" />}
            {processing
              ? 'Apagando…'
              : scope === 'all'
                ? 'Apagar todo o histórico'
                : 'Apagar o período'}
          </button>
        </div>
      </section>
    </div>
  );
}
