'use client';

import { useState } from 'react';
import type { VariableOption } from './FormulaInput';

// Every name a formula can use, with what it means and what it reads right now. Opened from the
// "i" beside the calculated fields, so nobody has to remember the names.

export function VariablesModal({
  options,
  onClose,
}: {
  options: VariableOption[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState('');
  // The platform's own numbers carry a prefix: turno.* on a dashboard, dia.* on the operations page.
  const isPlatform = (name: string) => name.startsWith('turno.') || name.startsWith('dia.');
  const plant = options.filter((option) => isPlatform(option.name));
  const hmi = options.filter((option) => !isPlatform(option.name));

  async function copy(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(name);
      window.setTimeout(() => setCopied(''), 1500);
    } catch {
      // Without permission for the clipboard the name is still on screen to be typed.
    }
  }

  const table = (title: string, rows: VariableOption[], empty: string) => (
    <div className="detail-section">
      <strong>{title}</strong>
      {rows.length ? (
        <div className="scroll">
          <table className="detail-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>O que traz</th>
                <th className="n">Agora</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((option) => (
                <tr key={option.name}>
                  <td>
                    <button type="button" className="variable-name" onClick={() => void copy(option.name)}>
                      <code>{option.name}</code>
                      <span>{copied === option.name ? 'copiado' : 'copiar'}</span>
                    </button>
                  </td>
                  <td>{option.description}</td>
                  <td className="n">{option.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="shifts-help">{empty}</p>
      )}
    </div>
  );

  return (
    <div className="modal-backdrop" style={{ zIndex: 2000 }} onMouseDown={onClose}>
      <div className="modal-card detail-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">FÓRMULAS</div>
            <h2>Variáveis disponíveis</h2>
            <p className="shifts-help">
              Use os nomes abaixo com + - * / ( ) e as funções min, max, round, abs, floor e ceil,
              separando os argumentos com ;. Exemplo: turno.pecas / turno.horas_produzindo.
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        {table(
          plant.some((option) => option.name.startsWith('dia.'))
            ? 'Do dia, calculadas pela plataforma'
            : 'Do turno, calculadas pela plataforma',
          plant,
          'Configure a produção do equipamento para ter os números do turno.',
        )}
        {table('Da IHM', hmi, 'Este equipamento ainda não tem variáveis numéricas lidas.')}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
