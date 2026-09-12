'use client';

import { useState } from 'react';
import { mutate, usePoll } from './data';
import { formatNumber } from './ShiftBoard';
import { usePlatform } from './PlatformShell';

// "Conferir com a IHM": the HMI counter is the reference. Shows what the HMI counted since it
// last started from zero, what the platform added up in the same hours and where they differ;
// "Ajustar com a IHM" rewrites the differing hours from the stored readings. Opened from a
// card's settings (that card's variable) and from the Produção page (the production counters).

interface HmiCheck {
  key: string;
  name: string | null;
  empty?: boolean;
  since?: string;
  windowStart?: string;
  reset?: boolean;
  hmiValue?: number;
  hmiCount?: number;
  platformCount?: number;
  correctCount?: number;
  difference?: number;
  hours?: Array<{ hour: string; platform: number; correct: number }>;
  production?: { label: string; value: number } | null;
}

function when(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
}
function hourLabel(iso: string) {
  const start = new Date(iso);
  const end = new Date(start.getTime() + 3600 * 1000);
  const time = (date: Date) =>
    date.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
  return `${start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })} ${time(start)}–${time(end)}`;
}

export function HmiCheckModal({
  deviceId,
  tagId,
  onClose,
  stacked = false,
}: {
  deviceId: string;
  /** The card's variable; without it the production counters of the device are offered. */
  tagId?: string;
  onClose: () => void;
  stacked?: boolean;
}) {
  const { user } = usePlatform();
  const config = usePoll<{ blocks_tag_id: string | null; pallets_tag_id: string | null }>(
    tagId ? null : `/devices/${deviceId}/production-config`,
    600000,
  );
  const options = tagId
    ? []
    : [
        config.data?.blocks_tag_id
          ? { id: config.data.blocks_tag_id, label: 'Contador de peças' }
          : null,
        config.data?.pallets_tag_id
          ? { id: config.data.pallets_tag_id, label: 'Contador de paletes' }
          : null,
      ].filter((option): option is { id: string; label: string } => Boolean(option));
  const [chosen, setChosen] = useState('');
  const selected = tagId ?? (chosen || options[0]?.id || '');
  const checked = usePoll<HmiCheck>(
    selected ? `/devices/${deviceId}/tags/${selected}/hmi-check` : null,
    600000,
  );
  const [adjusted, setAdjusted] = useState<HmiCheck | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [error, setError] = useState('');
  const data = adjusted ?? checked.data;
  const matches = data && !data.empty && Math.abs(data.difference ?? 0) < 0.5;

  async function adjust() {
    setAdjusting(true);
    setError('');
    try {
      setAdjusted(await mutate<HmiCheck>(`/devices/${deviceId}/tags/${selected}/hmi-check`, 'POST'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível ajustar.');
    } finally {
      setAdjusting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      style={stacked ? { zIndex: 2000 } : undefined}
      onMouseDown={() => !adjusting && onClose()}
    >
      <div className="modal-card hmi-check-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">CONFERIR COM A IHM</div>
            <h2>{data?.name || data?.key || 'Contador'}</h2>
          </div>
          <button type="button" className="icon-button" disabled={adjusting} onClick={onClose}>
            ×
          </button>
        </div>
        <p className="shifts-help">
          O contador da IHM é a referência. A plataforma acha o último zeramento dele e compara, hora
          a hora, o que a IHM contou com o que os gráficos e cards somaram.
        </p>
        {!tagId && (
          <label className="field">
            Contador
            <select
              value={selected}
              onChange={(event) => {
                setChosen(event.target.value);
                setAdjusted(null);
              }}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {config.data && !options.length && (
              <small>Configure o contador de peças ou de paletes em Configurar equipamento.</small>
            )}
          </label>
        )}
        {!data ? (
          <p>{checked.error ?? (selected ? 'Analisando as leituras…' : '')}</p>
        ) : data.empty ? (
          <p>Sem leituras dessa variável nos últimos 7 dias.</p>
        ) : (
          <>
            <div className="production-detail-summary">
              <div>
                <span>Valor atual na IHM</span>
                <b>{formatNumber(data.hmiValue ?? 0)}</b>
              </div>
              <div>
                <span>
                  IHM desde {data.reset ? 'o zeramento' : 'a 1ª leitura'} ({when(data.since ?? '')})
                </span>
                <b>{formatNumber(data.hmiCount ?? 0)}</b>
              </div>
              <div>
                <span>Plataforma desde {when(data.windowStart ?? '')}</span>
                <b>{formatNumber(data.platformCount ?? 0)}</b>
              </div>
              <div>
                <span>Recontagem pelas leituras</span>
                <b>{formatNumber(data.correctCount ?? 0)}</b>
              </div>
              {data.production && (
                <div>
                  <span>{data.production.label}</span>
                  <b>{formatNumber(data.production.value)}</b>
                </div>
              )}
            </div>
            {matches ? (
              <div className="shift-health good">
                Confere: a plataforma está igual à contagem da IHM.
                {adjusted ? ' Ajuste aplicado.' : ''}
              </div>
            ) : (
              <>
                <div className="shift-health bad">
                  A plataforma está {formatNumber(Math.abs(data.difference ?? 0))}{' '}
                  {(data.difference ?? 0) > 0 ? 'acima' : 'abaixo'} da contagem da IHM.
                </div>
                <table className="production-table">
                  <thead>
                    <tr>
                      <th>Hora</th>
                      <th className="numeric">Plataforma</th>
                      <th className="numeric">IHM (recontado)</th>
                      <th className="numeric">Diferença</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.hours ?? []).map((row) => (
                      <tr key={row.hour}>
                        <td>{hourLabel(row.hour)}</td>
                        <td className="numeric">{formatNumber(row.platform)}</td>
                        <td className="numeric">{formatNumber(row.correct)}</td>
                        <td className="numeric">{formatNumber(row.platform - row.correct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <p className="shifts-help">
              A comparação cobre as leituras dos últimos 7 dias, hora a hora, recontando o contador
              como a IHM conta (zeramento a zeramento). O ajuste refaz as horas diferentes a partir
              das leituras gravadas: um recuo pequeno do contador (leitura instável) deixa de ser
              contado como zeramento.
            </p>
          </>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={adjusting} onClick={onClose}>
            Fechar
          </button>
          {user.role === 'master' && data && !data.empty && !matches && (
            <button
              type="button"
              className="primary-button"
              disabled={adjusting}
              onClick={() => void adjust()}
            >
              {adjusting && <span className="button-spinner" />}
              {adjusting ? 'Ajustando…' : 'Ajustar com a IHM'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
