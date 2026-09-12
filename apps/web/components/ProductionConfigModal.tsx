'use client';

import { useEffect, useState } from 'react';
import { mutate, usePoll } from './data';
import { metricInfo, type ProductionMetric } from './ShiftBoard';

// Production parameters of one device: counters, automatic signal, idle and end-of-shift
// rules, weight per piece and target. Opened from the Produção page and from the production
// board's settings, so the board can be set up where it is placed.

interface Signal {
  id: string;
  key: string;
  data_type: 'number' | 'boolean' | 'string';
  tag_id: string | null;
  name: string | null;
  unit: string | null;
  present: boolean;
}
interface ProductionConfig {
  site_id: string;
  blocks_tag_id: string | null;
  pallets_tag_id: string | null;
  auto_tag_id: string | null;
  idle_seconds: number | null;
  weight_per_unit_kg: number | null;
  weight_tag_id: string | null;
  closing_minutes: number | null;
  target_metric: ProductionMetric | null;
  target_per_shift: number | null;
}

export function ProductionConfigModal({
  deviceId,
  deviceName,
  onClose,
  stacked = false,
}: {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
  /** Opened over another modal (the board's settings): drawn above it. */
  stacked?: boolean;
}) {
  const config = usePoll<ProductionConfig>(`/devices/${deviceId}/production-config`, 600000);
  const signals = usePoll<Signal[]>(`/devices/${deviceId}/signals`, 600000);
  const [form, setForm] = useState<{
    pieces: string;
    pallets: string;
    auto: string;
    idleSeconds: number;
    closingMinutes: number;
    weight: string;
    weightKey: string;
    metric: ProductionMetric | '';
    target: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!config.data || !signals.data || form) return;
    const signalFor = (tagId: string | null) =>
      signals.data?.find((signal) => signal.tag_id && signal.tag_id === tagId)?.key ?? '';
    setForm({
      pieces: signalFor(config.data.blocks_tag_id),
      pallets: signalFor(config.data.pallets_tag_id),
      auto: signalFor(config.data.auto_tag_id),
      idleSeconds: config.data.idle_seconds ?? 60,
      closingMinutes: config.data.closing_minutes ?? 30,
      weight: config.data.weight_per_unit_kg ? String(config.data.weight_per_unit_kg) : '',
      weightKey: signalFor(config.data.weight_tag_id),
      metric: config.data.target_metric ?? '',
      target: config.data.target_per_shift ? String(config.data.target_per_shift) : '',
    });
  }, [config.data, signals.data, form]);
  const numeric =
    signals.data?.filter(
      (signal) => signal.data_type === 'number' && (signal.present || signal.tag_id),
    ) ?? [];
  const autoOptions =
    signals.data?.filter(
      (signal) =>
        (signal.data_type === 'boolean' || signal.data_type === 'number') &&
        (signal.present || signal.tag_id),
    ) ?? [];

  async function tagIdFor(key: string) {
    if (!key) return null;
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
  async function save() {
    if (!form) return;
    setSaving(true);
    setError('');
    try {
      const [piecesTagId, palletsTagId, autoTagId, weightTagId] = await Promise.all([
        tagIdFor(form.pieces),
        tagIdFor(form.pallets),
        tagIdFor(form.auto),
        tagIdFor(form.weightKey),
      ]);
      await mutate(`/devices/${deviceId}/production-config`, 'PATCH', {
        piecesTagId,
        palletsTagId,
        autoTagId,
        idleSeconds: Number(form.idleSeconds) || 60,
        closingMinutes: Number.isFinite(Number(form.closingMinutes))
          ? Math.min(240, Math.max(0, Math.round(Number(form.closingMinutes))))
          : 30,
        weightPerUnitKg: form.weight ? Number(form.weight.replace(',', '.')) : null,
        weightTagId,
        targetMetric: form.metric || null,
        targetPerShift: form.metric && form.target ? Number(form.target.replace(',', '.')) : null,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar a configuração.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      style={stacked ? { zIndex: 2000 } : undefined}
      onMouseDown={() => !saving && onClose()}
    >
      <div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">PRODUÇÃO DO EQUIPAMENTO</div>
            <h2>{deviceName}</h2>
          </div>
          <button type="button" className="icon-button" disabled={saving} onClick={onClose}>
            ×
          </button>
        </div>
        {!form ? (
          <p>Carregando…</p>
        ) : (
          <div className="form-grid">
            <label className="field">
              Contador de peças (blocos)
              <select
                value={form.pieces}
                onChange={(event) => setForm({ ...form, pieces: event.target.value })}
              >
                <option value="">Não usar</option>
                {numeric.map((signal) => (
                  <option key={signal.id} value={signal.key}>
                    {signal.key}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Contador de paletes
              <select
                value={form.pallets}
                onChange={(event) => setForm({ ...form, pallets: event.target.value })}
              >
                <option value="">Não usar</option>
                {numeric.map((signal) => (
                  <option key={signal.id} value={signal.key}>
                    {signal.key}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Máquina em automático
              <select
                value={form.auto}
                onChange={(event) => setForm({ ...form, auto: event.target.value })}
              >
                <option value="">Não usar (parada manual conta como ociosa)</option>
                {autoOptions.map((signal) => (
                  <option key={signal.id} value={signal.key}>
                    {signal.key} · {signal.data_type}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Ociosa depois de (segundos sem contar)
              <input
                type="number"
                min={5}
                max={3600}
                value={form.idleSeconds}
                onChange={(event) => setForm({ ...form, idleSeconds: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              Encerrado se parar nos últimos (minutos do turno)
              <input
                type="number"
                min={0}
                max={240}
                value={form.closingMinutes}
                title="Se a máquina para de contar nesses minutos finais e não volta até o fim do turno, o tempo depois da última produção conta como Encerrado, não como ociosa. 0 desliga."
                onChange={(event) =>
                  setForm({ ...form, closingMinutes: Number(event.target.value) })
                }
              />
            </label>
            <label className="field">
              Peso por peça (kg) — variável da IHM
              <select
                value={form.weightKey}
                onChange={(event) => setForm({ ...form, weightKey: event.target.value })}
              >
                <option value="">Não usar (usa o valor fixo)</option>
                {numeric.map((signal) => (
                  <option key={signal.id} value={signal.key}>
                    {signal.key}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {form.weightKey ? 'Peso fixo (kg) — se a variável não vier' : 'Peso por peça (kg) — valor fixo'}
              <input
                inputMode="decimal"
                value={form.weight}
                placeholder="Ex.: 2,6"
                onChange={(event) => setForm({ ...form, weight: event.target.value })}
              />
            </label>
            <label className="field">
              Meta por turno
              <select
                value={form.metric}
                onChange={(event) =>
                  setForm({ ...form, metric: event.target.value as ProductionMetric | '' })
                }
              >
                <option value="">Sem meta</option>
                <option value="milheiros">Milheiros</option>
                <option value="tons">Toneladas</option>
                <option value="blocks">Blocos (peças)</option>
                <option value="pallets">Paletes</option>
              </select>
            </label>
            {form.metric && (
              <label className="field">
                Valor da meta por turno ({metricInfo[form.metric].unit})
                <input
                  inputMode="decimal"
                  value={form.target}
                  onChange={(event) => setForm({ ...form, target: event.target.value })}
                />
              </label>
            )}
            <div className="notice full-field">
              <b>Como a máquina é classificada</b>
              Em automático e contando: produzindo. Em automático sem contar há mais que o tempo
              acima: ociosa. Fora do automático: manual/parada. Sem mensagens: sem comunicação. 1
              milheiro = 1.000 peças.
            </div>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving || !form}
            onClick={() => void save()}
          >
            {saving && <span className="button-spinner" />}
            {saving ? 'Salvando…' : 'Salvar configuração'}
          </button>
        </div>
      </div>
    </div>
  );
}
