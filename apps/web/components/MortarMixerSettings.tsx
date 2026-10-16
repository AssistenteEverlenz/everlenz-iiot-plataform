'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import { mutate, usePoll } from './data';
import {
  MIXER_ROLES,
  MT_METAL_MIXER,
  type MixerAlarm,
  type MixerConfig,
  type MixerStep,
} from './mortarMixerConfig';

/**
 * The mixer card's pencil (migration 049): the mixer as this device's PLC is programmed. Which
 * variable plays each role, the steps of the weighing and of the mixer -- the number the PLC
 * publishes, its name, what kind of time it is, the material it doses, whether it is the timed
 * mixing or discharge -- and the codes of the alert word. Nothing here is assumed: a PLC from
 * another maker is described in its own numbers. The model of the first plant (MT Metal) fills it
 * in one click, matching its variables by name.
 */
type Tag = { id: string; key: string; name: string; data_type: string };
export type MixerSettingsHandle = { save: () => Promise<void> };

const KINDS: Array<[MixerStep['kind'], string]> = [
  ['work', 'Trabalhando'],
  ['prep', 'Preparando'],
  ['wait', 'Aguardando'],
  ['off', 'Desligado'],
];
const ALARM_KINDS: Array<[MixerAlarm['kind'], string]> = [
  ['material', 'Falta de material'],
  ['equipment', 'Equipamento'],
  ['process', 'Processo'],
  ['info', 'Aviso'],
];

function TagPick({
  tags,
  value,
  onChange,
}: {
  tags: Tag[];
  value: string | null | undefined;
  onChange: (value: string | null) => void;
}) {
  return (
    <select value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">— nenhuma —</option>
      {tags.map((tag) => (
        <option key={tag.id} value={tag.id}>
          {tag.key}
          {tag.name && tag.name !== tag.key ? ` · ${tag.name}` : ''}
        </option>
      ))}
    </select>
  );
}

function StepsEditor({
  steps,
  onChange,
  materials,
  timers,
}: {
  steps: MixerStep[];
  onChange: (steps: MixerStep[]) => void;
  materials: boolean;
  timers: boolean;
}) {
  const set = (index: number, patch: Partial<MixerStep>) =>
    onChange(steps.map((step, at) => (at === index ? { ...step, ...patch } : step)));
  // The weighing names the material each step doses; the mixer, its timed steps.
  const variant = materials ? 'with-material' : 'with-timer';
  return (
    <div className="mixer-config-table">
      <div className={`mixer-config-row head ${variant}`}>
        <span>Valor</span>
        <span>Nome da etapa</span>
        <span>Tipo</span>
        {materials && <span>Material dosado</span>}
        {timers && <span>Cronometrada</span>}
        <span>Ciclo</span>
        <span />
      </div>
      {steps.map((step, index) => (
        <div className={`mixer-config-row ${variant}`} key={index}>
          <input
            type="number"
            aria-label="Valor"
            value={step.value}
            onChange={(event) => set(index, { value: Number(event.target.value) || 0 })}
          />
          <input
            aria-label="Nome da etapa"
            value={step.label}
            maxLength={80}
            onChange={(event) => set(index, { label: event.target.value })}
          />
          <select
            aria-label="Tipo"
            value={step.kind}
            onChange={(event) => set(index, { kind: event.target.value as MixerStep['kind'] })}
          >
            {KINDS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {materials ? (
            <input
              aria-label="Material dosado"
              placeholder="ex.: Areia"
              value={step.material ?? ''}
              maxLength={40}
              onChange={(event) => set(index, { material: event.target.value || null })}
            />
          ) : null}
          {timers ? (
            <select
              aria-label="Etapa cronometrada"
              value={step.timer ?? ''}
              onChange={(event) =>
                set(index, { timer: (event.target.value || null) as MixerStep['timer'] })
              }
            >
              <option value="">—</option>
              <option value="mix">Mistura</option>
              <option value="discharge">Descarga</option>
            </select>
          ) : null}
          <label title="O ciclo começa nesta etapa: o tempo de uma até a próxima é o ciclo">
            <input
              type="checkbox"
              checked={Boolean(step.cycle)}
              onChange={(event) =>
                onChange(
                  steps.map((item, at) => ({
                    ...item,
                    cycle:
                      at === index
                        ? event.target.checked
                        : event.target.checked
                          ? false
                          : item.cycle,
                  })),
                )
              }
            />
            início
          </label>
          <button
            type="button"
            title="Remover etapa"
            aria-label="Remover etapa"
            onClick={() => onChange(steps.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="mixer-config-actions">
        <button
          type="button"
          onClick={() =>
            onChange([
              ...steps,
              { value: (steps.at(-1)?.value ?? 0) + 5, label: 'Nova etapa', kind: 'work' },
            ])
          }
        >
          + Etapa
        </button>
      </div>
    </div>
  );
}

function AlarmsEditor({
  codes,
  onChange,
}: {
  codes: MixerAlarm[];
  onChange: (codes: MixerAlarm[]) => void;
}) {
  const set = (index: number, patch: Partial<MixerAlarm>) =>
    onChange(codes.map((code, at) => (at === index ? { ...code, ...patch } : code)));
  return (
    <div className="mixer-config-table">
      <div className="mixer-config-row alarm head">
        <span>Valor</span>
        <span>Texto do alerta</span>
        <span>Tipo</span>
        <span>Material</span>
        <span />
      </div>
      {codes.map((code, index) => (
        <div className="mixer-config-row alarm" key={index}>
          <input
            type="number"
            aria-label="Valor"
            value={code.value}
            onChange={(event) => set(index, { value: Number(event.target.value) || 0 })}
          />
          <input
            aria-label="Texto do alerta"
            value={code.label}
            maxLength={80}
            onChange={(event) => set(index, { label: event.target.value })}
          />
          <select
            aria-label="Tipo"
            value={code.kind}
            onChange={(event) => set(index, { kind: event.target.value as MixerAlarm['kind'] })}
          >
            {ALARM_KINDS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            aria-label="Material"
            placeholder={code.kind === 'material' ? 'ex.: Cimento' : ''}
            value={code.material ?? ''}
            maxLength={40}
            disabled={code.kind !== 'material'}
            onChange={(event) => set(index, { material: event.target.value || null })}
          />
          <button
            type="button"
            title="Remover alerta"
            aria-label="Remover alerta"
            onClick={() => onChange(codes.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="mixer-config-actions">
        <button
          type="button"
          onClick={() =>
            onChange([
              ...codes,
              { value: (codes.at(-1)?.value ?? 0) + 1, label: 'Novo alerta', kind: 'process' },
            ])
          }
        >
          + Alerta
        </button>
      </div>
    </div>
  );
}

export function MixerSettings({
  deviceId,
  handle,
}: {
  deviceId: string;
  handle: MutableRefObject<MixerSettingsHandle | null>;
}) {
  const tags = usePoll<Tag[]>(`/devices/${deviceId}/tags`, 600000);
  const saved = usePoll<{ saved: boolean; config: MixerConfig }>(
    `/devices/${deviceId}/mortar/mixer-config`,
    600000,
  );
  const [config, setConfig] = useState<MixerConfig | null>(null);
  useEffect(() => {
    if (!config && saved.data) setConfig(saved.data.config);
  }, [saved.data, config]);
  handle.current = {
    save: async () => {
      if (config) await mutate(`/devices/${deviceId}/mortar/mixer-config`, 'PUT', config);
    },
  };
  const list = tags.data ?? [];
  if (!config) return <div className="stops-empty">Carregando…</div>;
  const byKey = (key: string) => list.find((tag) => tag.key === key)?.id ?? null;
  const loadModel = () =>
    setConfig({
      tags: Object.fromEntries(
        MIXER_ROLES.map((item) => [item.role, config.tags[item.role] ?? byKey(item.key)]),
      ),
      weighing: {
        tagId: config.weighing.tagId ?? byKey('ProcessoPesagem'),
        steps: MT_METAL_MIXER.weighing.steps,
      },
      mixing: {
        tagId: config.mixing.tagId ?? byKey('ProcessoMisturador'),
        steps: MT_METAL_MIXER.mixing.steps,
      },
      alarms: {
        tagId: config.alarms.tagId ?? byKey('StatusAlerta'),
        codes: MT_METAL_MIXER.alarms.codes,
      },
    });
  return (
    <div className="full-field mixer-config">
      <p className="mixer-config-help">
        Descreva o misturador como o CLP dele está programado: as variáveis de cada papel, as etapas
        da pesagem e do misturador (o número que o CLP publica em cada etapa) e os códigos dos
        alertas.{' '}
        {!saved.data?.saved &&
          'Este equipamento ainda usa o modelo MT Metal com os nomes padrão; salve para fixar a configuração dele.'}
      </p>
      <div className="mixer-config-actions">
        <button type="button" onClick={loadModel}>
          Carregar modelo MT Metal (Bella Massa)
        </button>
      </div>

      <section>
        <h4>Variáveis do misturador</h4>
        <p className="mixer-config-help">
          A receita, o contador de bateladas, a balança e os materiais ficam no card de
          Matéria-prima.
        </p>
        <div className="mixer-config-roles">
          {MIXER_ROLES.map((item) => (
            <label key={item.role}>
              {item.label}
              <TagPick
                tags={list}
                value={config.tags[item.role]}
                onChange={(value) =>
                  setConfig({ ...config, tags: { ...config.tags, [item.role]: value } })
                }
              />
              <small>{item.hint}</small>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h4>Etapas da pesagem</h4>
        <div className="mixer-config-roles">
          <label>
            Variável do passo da pesagem
            <TagPick
              tags={list}
              value={config.weighing.tagId}
              onChange={(value) =>
                setConfig({ ...config, weighing: { ...config.weighing, tagId: value } })
              }
            />
            <small>o número da etapa em que a balança está</small>
          </label>
        </div>
        <StepsEditor
          steps={config.weighing.steps}
          materials
          timers={false}
          onChange={(steps) => setConfig({ ...config, weighing: { ...config.weighing, steps } })}
        />
      </section>

      <section>
        <h4>Etapas do misturador</h4>
        <div className="mixer-config-roles">
          <label>
            Variável do passo do misturador
            <TagPick
              tags={list}
              value={config.mixing.tagId}
              onChange={(value) =>
                setConfig({ ...config, mixing: { ...config.mixing, tagId: value } })
              }
            />
            <small>o número da etapa em que o misturador está</small>
          </label>
        </div>
        <StepsEditor
          steps={config.mixing.steps}
          materials={false}
          timers
          onChange={(steps) => setConfig({ ...config, mixing: { ...config.mixing, steps } })}
        />
      </section>

      <section>
        <h4>Alertas</h4>
        <div className="mixer-config-roles">
          <label>
            Variável de alerta
            <TagPick
              tags={list}
              value={config.alarms.tagId}
              onChange={(value) =>
                setConfig({ ...config, alarms: { ...config.alarms, tagId: value } })
              }
            />
            <small>o código do alerta ativo (0 = nenhum)</small>
          </label>
        </div>
        <AlarmsEditor
          codes={config.alarms.codes}
          onChange={(codes) => setConfig({ ...config, alarms: { ...config.alarms, codes } })}
        />
      </section>
    </div>
  );
}
