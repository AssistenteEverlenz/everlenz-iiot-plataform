'use client';

import { useState } from 'react';
import { mutate, usePoll } from './data';
import { usePlatform } from './PlatformShell';

// Snapshots of a dashboard, from its Ações menu: take a "photo" of the page as it is (cards,
// their settings and the device's production parameters) or put a saved version back. A
// restore keeps the current state as a snapshot first, so it can be undone. The master can
// also make this dashboard the model new devices start from.

interface Snapshot {
  id: string;
  name: string;
  created_at: string;
  created_by_email: string | null;
  widgets: number;
}

function when(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SnapshotModal({
  dashboardId,
  onClose,
  onRestored,
}: {
  dashboardId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { user } = usePlatform();
  const list = usePoll<Snapshot[]>(`/dashboards/${dashboardId}/snapshots`, 600000);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'save' | 'restore' | 'template' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const selected = chosen || list.data?.[0]?.id || '';
  const selectedSnapshot = list.data?.find((snapshot) => snapshot.id === selected);

  async function run(kind: 'save' | 'restore' | 'template', action: () => Promise<unknown>, done: string) {
    setBusy(kind);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(done);
      await list.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível concluir.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal-card snapshot-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">SNAPSHOT DO PAINEL</div>
            <h2>Versões do painel</h2>
          </div>
          <button type="button" className="icon-button" disabled={Boolean(busy)} onClick={onClose}>
            ×
          </button>
        </div>

        <section className="snapshot-section">
          <strong>Tirar snapshot</strong>
          <p className="shifts-help">
            Guarda uma foto do painel como está agora: os cards, suas configurações e os
            parâmetros de produção do equipamento.
          </p>
          <div className="snapshot-row">
            <input
              value={name}
              maxLength={120}
              placeholder="Nome (opcional), ex.: Configuração inicial do cliente"
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="button"
              className="primary-button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  'save',
                  async () => {
                    await mutate(`/dashboards/${dashboardId}/snapshots`, 'POST', {
                      name: name.trim() || null,
                    });
                    setName('');
                  },
                  'Snapshot salvo.',
                )
              }
            >
              {busy === 'save' && <span className="button-spinner" />}
              Salvar snapshot
            </button>
          </div>
        </section>

        <section className="snapshot-section">
          <strong>Restaurar uma versão</strong>
          {list.data && !list.data.length ? (
            <p className="shifts-help">Nenhum snapshot salvo ainda.</p>
          ) : (
            <>
              <div className="snapshot-row">
                <select
                  value={selected}
                  onChange={(event) => {
                    setChosen(event.target.value);
                    setConfirming(false);
                  }}
                >
                  {(list.data ?? []).map((snapshot) => (
                    <option key={snapshot.id} value={snapshot.id}>
                      {snapshot.name} · {when(snapshot.created_at)} · {snapshot.widgets} card(s)
                      {snapshot.created_by_email ? ` · ${snapshot.created_by_email}` : ''}
                    </option>
                  ))}
                </select>
                {!confirming ? (
                  <button
                    type="button"
                    disabled={!selected || Boolean(busy)}
                    onClick={() => setConfirming(true)}
                  >
                    Restaurar
                  </button>
                ) : (
                  <button
                    type="button"
                    className="danger-button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run(
                        'restore',
                        async () => {
                          await mutate(
                            `/dashboards/${dashboardId}/snapshots/${selected}/restore`,
                            'POST',
                          );
                          setConfirming(false);
                          onRestored();
                        },
                        'Versão restaurada. O estado anterior foi guardado como snapshot.',
                      )
                    }
                  >
                    {busy === 'restore' && <span className="button-spinner" />}
                    Confirmar restauração
                  </button>
                )}
              </div>
              {confirming && selectedSnapshot && (
                <p className="shifts-help">
                  O painel volta a ficar como em “{selectedSnapshot.name}”. Antes disso, o estado
                  atual é guardado como snapshot, então dá para desfazer.
                </p>
              )}
            </>
          )}
        </section>

        {user.role === 'master' && (
          <section className="snapshot-section">
            <strong>Modelo para novos equipamentos</strong>
            <p className="shifts-help">
              Os próximos equipamentos cadastrados começam com os cards deste painel, sem
              variável: cada card recebe a variável pelo lápis.
            </p>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  'template',
                  () => mutate(`/dashboards/${dashboardId}/template`, 'POST'),
                  'Este painel agora é o modelo dos novos equipamentos.',
                )
              }
            >
              {busy === 'template' && <span className="button-spinner dark" />}
              Usar este painel como modelo
            </button>
          </section>
        )}

        {message && <div className="notice">{message}</div>}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={Boolean(busy)} onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
