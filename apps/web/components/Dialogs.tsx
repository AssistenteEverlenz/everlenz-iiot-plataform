'use client';

import { useEffect, useState } from 'react';
import { ModalPortal } from './ModalPortal';

// The platform's own notices and confirmations, in place of the browser's alert() and confirm(),
// which look like the device's and not like the platform. Called from anywhere:
//
//   avisar({ titulo: 'Teste na fila', texto: '...' })
//   if (!(await confirmar({ titulo: 'Excluir produto?', texto: '...', perigo: true }))) return;
//
// <DialogHost /> (in the shell) draws them, one at a time, with the look of ActionModal.

type Tone = 'success' | 'error' | 'info';
interface Notice {
  kind: 'notice';
  titulo: string;
  texto: string;
  tom?: Tone;
  resolve: () => void;
}
interface Question {
  kind: 'question';
  titulo: string;
  texto: string;
  confirmar?: string;
  cancelar?: string;
  perigo?: boolean;
  resolve: (answer: boolean) => void;
}
type Dialog = Notice | Question;

const queue: Dialog[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** A message with an OK button; resolves when it is closed. */
export function avisar(options: { titulo: string; texto: string; tom?: Tone }) {
  return new Promise<void>((resolve) => {
    queue.push({ kind: 'notice', ...options, resolve });
    changed();
  });
}

/** A question; resolves true when confirmed, false when cancelled or closed. */
export function confirmar(options: {
  titulo: string;
  texto: string;
  confirmar?: string;
  cancelar?: string;
  perigo?: boolean;
}) {
  return new Promise<boolean>((resolve) => {
    queue.push({ kind: 'question', ...options, resolve });
    changed();
  });
}

export function DialogHost() {
  const [, redraw] = useState(0);
  useEffect(() => {
    const listener = () => redraw((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const current = queue[0];
  useEffect(() => {
    if (!current) return undefined;
    const escape = (event: KeyboardEvent) => {
      // Enter presses the focused button by itself; only Escape needs a key of its own.
      if (event.key === 'Escape') close(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  });
  if (!current) return null;

  function close(answer: boolean) {
    const dialog = queue.shift();
    if (dialog?.kind === 'question') dialog.resolve(answer);
    else dialog?.resolve();
    changed();
  }
  const danger = current.kind === 'question' ? Boolean(current.perigo) : current.tom === 'error';
  const icon = danger ? '!' : current.kind === 'notice' && current.tom === 'info' ? 'i' : '✓';
  return (
    <ModalPortal>
      <div className="modal-backdrop" onMouseDown={() => close(false)}>
        <section
          className="modal-card compact-modal action-modal"
          role={current.kind === 'question' ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          aria-labelledby="platform-dialog-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className={`modal-action-icon ${danger ? 'danger' : ''}`}>{icon}</div>
          <div className="eyebrow">{current.kind === 'question' ? 'CONFIRMAR OPERAÇÃO' : 'AVISO'}</div>
          <h2 id="platform-dialog-title">{current.titulo}</h2>
          <p>{current.texto}</p>
          <div className="modal-actions">
            {current.kind === 'question' && (
              <button type="button" onClick={() => close(false)}>
                {current.cancelar ?? 'Cancelar'}
              </button>
            )}
            <button
              type="button"
              autoFocus
              className={danger && current.kind === 'question' ? 'danger-button-solid' : 'primary-button'}
              onClick={() => close(true)}
            >
              {current.kind === 'question' ? (current.confirmar ?? 'Confirmar') : 'Entendi'}
            </button>
          </div>
        </section>
      </div>
    </ModalPortal>
  );
}
