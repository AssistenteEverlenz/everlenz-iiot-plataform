'use client';

import { useEffect, useState } from 'react';
import { mutate, usePoll } from './data';
import { metricInfo, type ProductionMetric } from './ShiftBoard';

// Target of the shift, edited from the production board's "Meta" card: a fixed value, or an
// HMI variable (the target changes with the product the machine is making) with the fixed
// value as fallback. Closed shifts keep the target they had.

interface Signal {
  id: string;
  key: string;
  data_type: 'number' | 'boolean' | 'string';
  tag_id: string | null;
  name: string | null;
  unit: string | null;
  present: boolean;
}
interface TargetConfig {
  blocks_tag_id: string | null;
  pallets_tag_id: string | null;
  target_metric: ProductionMetric | null;
  target_per_shift: number | null;
  target_tag_id: string | null;
}

export function TargetModal({
  deviceId,
  onClose,
}: {
  deviceId: string;
  onClose: (saved: boolean) => void;
}) {
  const config = usePoll<TargetConfig>(`/devices/${deviceId}/production-config`, 600000);
  const signals = usePoll<Signal[]>(`/devices/${deviceId}/signals`, 600000);
  const [form, setForm] = useState<{
    metric: ProductionMetric | '';
    value: string;
    fromHmi: boolean;
    key: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!config.data || !signals.data || form) return;
    const key =
      signals.data.find((signal) => signal.tag_id && signal.tag_id === config.data?.target_tag_id)
        ?.key ?? '';
    setForm({
      metric:
        config.data.target_metric ?? (config.data.pallets_tag_id ? 'pallets' : 'milheiros'),
      value: config.data.target_per_shift ? String(config.data.target_per_shift) : '',
      fromHmi: Boolean(key),
      key,
    });
  }, [config.data, signals.data, form]);
  const numeric =
    signals.data?.filter(
      (signal) => signal.data_type === 'number' && (signal.present || signal.tag_id),
    ) ?? [];

  async function tagIdFor(key: string) {
    const signal = signals.data?.find((item) => item.key === key);
    if (!signal) return null;
    if (signal.tag_id) return signal.tag_id;
    const tag = await mutate<{ id: string }>(`/devices/${deviceId}/tags`, 'POST', {
      key: signal.key,
      name: signal.name || signal.key,
      dataType: signal.data_type,
      unit: signal.unit,
      scaleMultiplier: 1,
      scaleOffset: 0,
    });
    return tag.id;
  }
  async function save(clear = false) {
    if (!form) return;
    if (!clear && form.fromHmi && !form.key) {
      setError('Escolha a variável da meta na IHM.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const value = form.value ? Number(form.value.replace(',', '.')) : null;
      await mutate(`/devices/${deviceId}/production-target`, 'PATCH', {
        targetMetric: clear ? null : form.metric || null,
        targetPerShift: clear ? null : value,
        targetTagId: clear || !form.fromHmi ? null : await tagIdFor(form.key),
      });
      onClose(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar a meta.');
    } finally {
      setSaving(false);
    }
  }
  const unit = form?.metric ? metricInfo[form.metric].unit : '';
  return (
    <div className="modal-backdrop" onMouseDown={() => !saving && onClose(false)}>
      <div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">META DO TURNO</div>
            <h2>Editar meta</h2>
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
        {!form ? (
          <p>Carregando…</p>
        ) : (
          <div className="form-grid">
            <label className="field">
              Meta em
              <select
                value={form.metric}
                onChange={(event) =>
                  setForm({ ...form, metric: event.target.value as ProductionMetric })
                }
              >
                <option value="milheiros">Milheiros</option>
                <option value="tons">Toneladas</option>
                <option value="blocks">Blocos (peças)</option>
                <option value="pallets">Paletes</option>
              </select>
            </label>
            <label className="check-field full-field">
              <input
                type="checkbox"
                checked={form.fromHmi}
                onChange={(event) => setForm({ ...form, fromHmi: event.target.checked })}
              />
              A meta vem de uma variável da IHM (muda com o produto)
            </label>
            {form.fromHmi && (
              <label className="field">
                Variável da meta na IHM
                <select
                  value={form.key}
                  onChange={(event) => setForm({ ...form, key: event.target.value })}
                >
                  <option value="">Escolha a variável</option>
                  {numeric.map((signal) => (
                    <option key={signal.id} value={signal.key}>
                      {signal.key}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              {form.fromHmi
                ? `Meta fixa por turno (${unit}) — se a IHM não enviar`
                : `Meta por turno (${unit})`}
              <input
                inputMode="decimal"
                value={form.value}
                placeholder={form.fromHmi ? 'Opcional' : 'Ex.: 100'}
                onChange={(event) => setForm({ ...form, value: event.target.value })}
              />
            </label>
            <div className="notice full-field">
              <b>Como a meta é usada</b>
              Vale para o turno em andamento e os próximos. Cada turno fechado guarda a meta que
              tinha, então mudar a meta hoje não altera o histórico.
            </div>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="danger-text" disabled={saving} onClick={() => void save(true)}>
            Sem meta
          </button>
          <button type="button" disabled={saving} onClick={() => onClose(false)}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving || !form}
            onClick={() => void save()}
          >
            {saving && <span className="button-spinner" />}
            {saving ? 'Salvando…' : 'Salvar meta'}
          </button>
        </div>
      </div>
    </div>
  );
}
