'use client';

import { useState } from 'react';
import { BrandSpinner, usePlatform } from './PlatformShell';

export function ActionModal({
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { branding } = usePlatform();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    setProcessing(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível concluir a operação.');
      setProcessing(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => !processing && onClose()}>
      <section
        className="modal-card compact-modal action-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {processing ? (
          <BrandSpinner branding={branding} />
        ) : (
          <div className={`modal-action-icon ${danger ? 'danger' : ''}`}>{danger ? '!' : '✓'}</div>
        )}
        <div className="eyebrow">CONFIRMAR OPERAÇÃO</div>
        <h2>{processing ? 'Processando…' : title}</h2>
        <p>
          {processing
            ? 'Aguarde a confirmação do servidor. Esta janela fechará ao concluir.'
            : description}
        </p>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={processing} onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            disabled={processing}
            className={danger ? 'danger-button-solid' : 'primary-button'}
            onClick={() => void confirm()}
          >
            {processing && <span className="button-spinner" />}
            {processing ? 'Processando…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
