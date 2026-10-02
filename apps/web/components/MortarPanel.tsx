'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import { mutate, usePoll } from './data';
import { ModalPortal } from './ModalPortal';
import { usePlatform } from './PlatformShell';
import { Bagging, Materials, MortarColors, Output, Yield } from './MortarBoards';
import {
  PERIODS,
  integer,
  paletteOf,
  windowOf,
  type MortarCardConfig,
  type MortarView,
  type Period,
  type Summary,
} from './mortarShared';

export type { MortarView } from './mortarShared';

export function MortarPanel({
  deviceId,
  view,
  config,
}: {
  deviceId: string;
  view: MortarView;
  /** The card's own settings: its colour, and those of its spouts and materials. */
  config?: MortarCardConfig;
}) {
  const { user } = usePlatform();
  const master = user.role === 'master';
  const [period, setPeriod] = useState<Period>(view === 'bagging' ? 'today' : 'month');
  const [custom, setCustom] = useState(() => windowOf('7d'));
  const [modal, setModal] = useState<null | 'products'>(null);
  const range = period === 'custom' ? custom : windowOf(period);
  const summary = usePoll<Summary>(
    `/devices/${deviceId}/mortar?from=${range.from}&to=${range.to}`,
    view === 'bagging' ? 30000 : 120000,
  );

  const tools = (
    <div className="stops-tools">
      <div className="widget-period" role="group" aria-label="Período">
        {PERIODS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={period === value ? 'active' : ''}
            onClick={() => setPeriod(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <span className="widget-period-custom">
          <input
            type="date"
            aria-label="De"
            value={custom.from}
            max={custom.to}
            onChange={(event) => setCustom((was) => ({ ...was, from: event.target.value }))}
          />
          <span>até</span>
          <input
            type="date"
            aria-label="Até"
            value={custom.to}
            min={custom.from}
            onChange={(event) => setCustom((was) => ({ ...was, to: event.target.value }))}
          />
        </span>
      )}
    </div>
  );

  const data = summary.data;
  return (
    <MortarColors.Provider value={paletteOf(config)}>
      <div className="stops-panel mortar-panel">
        <div className="stops-head">{tools}</div>
        {!data ? (
          <div className="stops-empty">{summary.error ?? 'Carregando…'}</div>
        ) : view === 'bagging' ? (
          <Bagging
            data={data}
            live={range.to >= windowOf('today').to}
            onLink={master ? () => setModal('products') : undefined}
          />
        ) : view === 'mortar_output' ? (
          <Output
            data={data}
            displayKey={'mortar-output-display:' + deviceId}
            onLink={master ? () => setModal('products') : undefined}
          />
        ) : view === 'mortar_materials' ? (
          <Materials data={data} />
        ) : (
          <Yield data={data} onLink={master ? () => setModal('products') : undefined} />
        )}
        {modal === 'products' && (
          <ModalPortal>
            <ProductsModal
              onClose={() => {
                setModal(null);
                void summary.refresh();
              }}
            />
          </ModalPortal>
        )}
      </div>
    </MortarColors.Provider>
  );
}

type Catalog = {
  products: Array<{ id: string; name: string; nominal_kg: number }>;
  recipes: Array<{ recipe: string; productId: string | null; bags: number; lastAt: string | null }>;
};

/** Ações → Produtos e receitas: the products a plant sells and the recipes that fill them. */
export function ProductsModal({ onClose }: { onClose: () => void }) {
  const catalog = usePoll<Catalog>('/mortar/products', 600000);
  const [name, setName] = useState('');
  const [kg, setKg] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; kg: string } | null>(null);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      await catalog.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar');
    }
  };
  const number = (text: string) => Number(text.replace(',', '.'));
  const products = catalog.data?.products ?? [];
  const recipes = catalog.data?.recipes ?? [];
  const pending = recipes.filter((row) => !row.productId).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card mortar-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-title">
          <div>
            <h2>Produtos e receitas</h2>
            <small>
              Cada receita das ensacadeiras aponta para um produto. Receitas iguais em bicos
              diferentes somam no mesmo produto.
            </small>
          </div>
          <button onClick={onClose} aria-label="Fechar">
            Fechar
          </button>
        </header>
        {error && <div className="form-error">{error}</div>}

        <div className="stops-title">Produtos</div>
        <form
          className="mortar-form-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !(number(kg) > 0)) return;
            void run(async () => {
              await mutate('/mortar/products', 'POST', {
                name: name.trim(),
                nominalKg: number(kg),
              });
              setName('');
              setKg('');
            });
          }}
        >
          <input
            placeholder="Nome do produto (ex.: AC-II 20kg)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Peso do saco (kg)"
            inputMode="decimal"
            value={kg}
            onChange={(e) => setKg(e.target.value)}
          />
          <button type="submit" className="primary">
            Adicionar
          </button>
        </form>
        <table className="stops-table">
          <tbody>
            {products.map((product) =>
              editing?.id === product.id ? (
                <tr key={product.id}>
                  <td>
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      inputMode="decimal"
                      value={editing.kg}
                      onChange={(e) => setEditing({ ...editing, kg: e.target.value })}
                    />
                  </td>
                  <td className="n">
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          await mutate(`/mortar/products/${product.id}`, 'PATCH', {
                            name: editing.name.trim(),
                            nominalKg: number(editing.kg),
                          });
                          setEditing(null);
                        })
                      }
                    >
                      Salvar
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={product.id}>
                  <td>
                    <b>{product.name}</b>
                  </td>
                  <td>{product.nominal_kg.toLocaleString('pt-BR')} kg</td>
                  <td className="n">
                    <button
                      type="button"
                      onClick={() =>
                        setEditing({
                          id: product.id,
                          name: product.name,
                          kg: String(product.nominal_kg).replace('.', ','),
                        })
                      }
                    >
                      Editar
                    </button>{' '}
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Excluir ${product.name}? As receitas voltam a contar sem produto.`,
                          )
                        )
                          void run(() => mutate(`/mortar/products/${product.id}`, 'DELETE'));
                      }}
                    >
                      Excluir
                    </button>
                  </td>
                </tr>
              ),
            )}
            {!products.length && (
              <tr>
                <td className="stops-empty">Nenhum produto cadastrado.</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="stops-title">
          Receitas das ensacadeiras
          <small> · {pending ? `${pending} sem produto` : 'todas vinculadas'}</small>
        </div>
        <table className="stops-table">
          <thead>
            <tr>
              <th>Receita na IHM</th>
              <th className="n">Sacos</th>
              <th>Produto</th>
            </tr>
          </thead>
          <tbody>
            {recipes.map((row) => (
              <tr key={row.recipe} className={row.productId ? '' : 'mortar-unlinked'}>
                <td>{row.recipe}</td>
                <td className="n">{integer(row.bags)}</td>
                <td>
                  <select
                    value={row.productId ?? ''}
                    onChange={(event) =>
                      void run(() =>
                        mutate('/mortar/recipes', 'PUT', {
                          recipe: row.recipe,
                          productId: event.target.value || null,
                        }),
                      )
                    }
                  >
                    <option value="">— sem produto —</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
            {!recipes.length && (
              <tr>
                <td colSpan={3} className="stops-empty">
                  As receitas aparecem aqui assim que as ensacadeiras mandarem o primeiro saco.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Which variables feed the mixing and the bagging ----

type Tag = { id: string; key: string; name: string; data_type: string };
type SpoutForm = {
  id?: string;
  name: string;
  countTagId: string | null;
  recipeTagId: string | null;
  runningTagId: string | null;
  enabledTagId: string | null;
};
type Form = {
  mixEnabled: boolean;
  recipeTagId: string | null;
  batchCountTagId: string | null;
  scaleTagId: string | null;
  materials: Array<{ label: string; tagId: string | null }>;
  baggingEnabled: boolean;
  idleSeconds: number;
  spouts: SpoutForm[];
};
const EMPTY_FORM: Form = {
  mixEnabled: true,
  recipeTagId: null,
  batchCountTagId: null,
  scaleTagId: null,
  materials: [
    { label: 'Areia', tagId: null },
    { label: 'Cimento', tagId: null },
    { label: 'Cal / complemento', tagId: null },
  ],
  baggingEnabled: true,
  idleSeconds: 120,
  spouts: [
    { name: 'LE', countTagId: null, recipeTagId: null, runningTagId: null, enabledTagId: null },
    { name: 'CT', countTagId: null, recipeTagId: null, runningTagId: null, enabledTagId: null },
    { name: 'LD', countTagId: null, recipeTagId: null, runningTagId: null, enabledTagId: null },
  ],
};

function TagSelect({
  tags,
  value,
  onChange,
  types,
}: {
  tags: Tag[];
  value: string | null;
  onChange: (value: string | null) => void;
  types: string[];
}) {
  return (
    <select value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">— nenhuma —</option>
      {tags
        .filter((tag) => types.includes(tag.data_type) || tag.id === value)
        .map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.key}
            {tag.name && tag.name !== tag.key ? ` · ${tag.name}` : ''}
          </option>
        ))}
    </select>
  );
}

/** What the card settings (the pencil) hand back to the dashboard when it saves. */
export type MortarSettingsHandle = {
  save: () => Promise<void>;
  config: () => Pick<MortarCardConfig, 'spoutColors' | 'materialColors'>;
};

/**
 * The settings of one mortar card, shown inside the card's pencil. Each card shows only what it
 * reads: the bagging card its spouts, the raw-material card the mixer. Both are kept in the
 * device's mortar settings, so the card that is not being edited keeps its half untouched.
 */
export function MortarCardSettings({
  deviceId,
  view,
  config,
  handle,
}: {
  deviceId: string;
  view: MortarView;
  config: MortarCardConfig;
  handle: MutableRefObject<MortarSettingsHandle | null>;
}) {
  const palette = paletteOf(config);
  const [spoutColors, setSpoutColors] = useState<string[]>(config.spoutColors ?? []);
  const [materialColors, setMaterialColors] = useState<Record<string, string>>(
    config.materialColors ?? {},
  );
  const tags = usePoll<Tag[]>(`/devices/${deviceId}/tags`, 600000);
  const saved = usePoll<{
    settings: null | {
      mix_enabled: boolean;
      recipe_tag_id: string | null;
      batch_count_tag_id: string | null;
      scale_tag_id: string | null;
      materials: Array<{ label: string; tagId: string | null }>;
      bagging_enabled: boolean;
      idle_seconds: number;
    };
    spouts: Array<{
      id: string;
      name: string;
      count_tag_id: string | null;
      recipe_tag_id: string | null;
      running_tag_id: string | null;
      enabled_tag_id: string | null;
    }>;
  }>(`/devices/${deviceId}/mortar/settings`, 600000);
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (form || !saved.data) return;
    const { settings, spouts } = saved.data;
    setForm(
      settings
        ? {
            mixEnabled: settings.mix_enabled,
            recipeTagId: settings.recipe_tag_id,
            batchCountTagId: settings.batch_count_tag_id,
            scaleTagId: settings.scale_tag_id,
            materials: settings.materials ?? [],
            baggingEnabled: settings.bagging_enabled,
            idleSeconds: settings.idle_seconds,
            spouts: spouts.map((spout) => ({
              id: spout.id,
              name: spout.name,
              countTagId: spout.count_tag_id,
              recipeTagId: spout.recipe_tag_id,
              runningTagId: spout.running_tag_id,
              enabledTagId: spout.enabled_tag_id,
            })),
          }
        : EMPTY_FORM,
    );
  }, [saved.data, form]);

  const list = tags.data ?? [];
  const set = (patch: Partial<Form>) => setForm((was) => (was ? { ...was, ...patch } : was));
  const setSpout = (index: number, patch: Partial<SpoutForm>) =>
    setForm((was) =>
      was
        ? {
            ...was,
            spouts: was.spouts.map((spout, at) => (at === index ? { ...spout, ...patch } : spout)),
          }
        : was,
    );
  const setMaterial = (index: number, patch: Partial<Form['materials'][number]>) =>
    setForm((was) =>
      was
        ? {
            ...was,
            materials: was.materials.map((item, at) =>
              at === index ? { ...item, ...patch } : item,
            ),
          }
        : was,
    );
  const edits = view === 'bagging' || view === 'mortar_materials';
  handle.current = {
    save: async () => {
      if (form && edits) await mutate(`/devices/${deviceId}/mortar/settings`, 'PUT', form);
    },
    config: () => ({ spoutColors, materialColors }),
  };
  const colorInput = (value: string, onChange: (value: string) => void, label: string) => (
    <input
      type="color"
      className="mortar-color"
      value={value}
      aria-label={label}
      title={label}
      onChange={(event) => onChange(event.target.value)}
    />
  );

  if (!edits)
    return (
      <div className="notice full-field">
        Este card lê o que os cards de Ensaque e Matéria-prima registram. A cor dele é a do campo{' '}
        <b>Cor</b>; os produtos e o peso de cada saco ficam em <b>Ações → Produtos e receitas</b>.
      </div>
    );
  return (
    <div className="full-field">
      {!form ? (
        <div className="stops-empty">Carregando…</div>
      ) : (
        <div className="mortar-config">
          {view === 'mortar_materials' && (
            <>
              <label className="mortar-switch">
                <input
                  type="checkbox"
                  checked={form.mixEnabled}
                  onChange={(event) => set({ mixEnabled: event.target.checked })}
                />
                <b>Mistura</b> <small>bateladas e consumo de matéria-prima</small>
              </label>
              {form.mixEnabled && (
                <div className="mortar-grid">
                  <label>
                    Contador de bateladas
                    <TagSelect
                      tags={list}
                      types={['number']}
                      value={form.batchCountTagId}
                      onChange={(v) => set({ batchCountTagId: v })}
                    />
                  </label>
                  <label>
                    Receita atual
                    <TagSelect
                      tags={list}
                      types={['string']}
                      value={form.recipeTagId}
                      onChange={(v) => set({ recipeTagId: v })}
                    />
                  </label>
                  <label>
                    Balança (opcional)
                    <TagSelect
                      tags={list}
                      types={['number']}
                      value={form.scaleTagId}
                      onChange={(v) => set({ scaleTagId: v })}
                    />
                  </label>
                  <div className="mortar-sub">
                    Peso de cada material numa batelada (peso desejado da receita)
                  </div>
                  {form.materials.map((item, index) => (
                    <div className="mortar-row" key={index}>
                      {colorInput(
                        materialColors[item.label] ?? palette.material(item.label, index),
                        (value) => setMaterialColors((was) => ({ ...was, [item.label]: value })),
                        `Cor de ${item.label}`,
                      )}
                      <input
                        value={item.label}
                        aria-label="Material"
                        onChange={(e) => setMaterial(index, { label: e.target.value })}
                      />
                      <TagSelect
                        tags={list}
                        types={['number']}
                        value={item.tagId}
                        onChange={(v) => setMaterial(index, { tagId: v })}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          set({ materials: form.materials.filter((_, at) => at !== index) })
                        }
                      >
                        Remover
                      </button>
                    </div>
                  ))}
                  {form.materials.length < 8 && (
                    <button
                      type="button"
                      className="mortar-add"
                      onClick={() =>
                        set({ materials: [...form.materials, { label: 'Material', tagId: null }] })
                      }
                    >
                      + Material
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {view === 'bagging' && (
            <>
              <label className="mortar-switch">
                <input
                  type="checkbox"
                  checked={form.baggingEnabled}
                  onChange={(event) => set({ baggingEnabled: event.target.checked })}
                />
                <b>Ensaque</b> <small>sacos por bico e por receita</small>
              </label>
              {form.baggingEnabled && (
                <div className="mortar-grid">
                  <label>
                    Bico ocioso depois de (segundos sem saco)
                    <input
                      type="number"
                      min={10}
                      max={3600}
                      value={form.idleSeconds}
                      onChange={(e) => set({ idleSeconds: Number(e.target.value) || 120 })}
                    />
                  </label>
                  {form.spouts.map((spout, index) => (
                    <fieldset className="mortar-spout-form" key={spout.id ?? `new-${index}`}>
                      <legend>
                        {colorInput(
                          spoutColors[index] || palette.spout(index),
                          (value) =>
                            setSpoutColors((was) => {
                              const next = [...was];
                              next[index] = value;
                              return next;
                            }),
                          `Cor do bico ${spout.name}`,
                        )}
                        Bico {index + 1}
                        <input
                          value={spout.name}
                          aria-label="Nome do bico"
                          onChange={(e) => setSpout(index, { name: e.target.value })}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (
                              !spout.id ||
                              window.confirm(
                                `Remover o bico ${spout.name}? A contagem dele é apagada junto.`,
                              )
                            )
                              set({ spouts: form.spouts.filter((_, at) => at !== index) });
                          }}
                        >
                          Remover
                        </button>
                      </legend>
                      <label>
                        Pacotes (contador)
                        <TagSelect
                          tags={list}
                          types={['number']}
                          value={spout.countTagId}
                          onChange={(v) => setSpout(index, { countTagId: v })}
                        />
                      </label>
                      <label>
                        Produto / receita
                        <TagSelect
                          tags={list}
                          types={['string']}
                          value={spout.recipeTagId}
                          onChange={(v) => setSpout(index, { recipeTagId: v })}
                        />
                      </label>
                      <label>
                        Habilitado
                        <TagSelect
                          tags={list}
                          types={['boolean', 'number']}
                          value={spout.enabledTagId}
                          onChange={(v) => setSpout(index, { enabledTagId: v })}
                        />
                      </label>
                      <label>
                        Ligado (opcional)
                        <TagSelect
                          tags={list}
                          types={['boolean', 'number']}
                          value={spout.runningTagId}
                          onChange={(v) => setSpout(index, { runningTagId: v })}
                        />
                      </label>
                    </fieldset>
                  ))}
                  {form.spouts.length < 24 && (
                    <button
                      type="button"
                      className="mortar-add"
                      onClick={() =>
                        set({
                          spouts: [
                            ...form.spouts,
                            {
                              name: `B${form.spouts.length + 1}`,
                              countTagId: null,
                              recipeTagId: null,
                              runningTagId: null,
                              enabledTagId: null,
                            },
                          ],
                        })
                      }
                    >
                      + Bico
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          <p className="stops-note">
            Só aparecem variáveis já configuradas no equipamento. Se faltar alguma, adicione-a em
            Variáveis antes. Tudo é salvo junto com o card.
          </p>
        </div>
      )}
    </div>
  );
}

/** For the picker: the four mortar cards, their help line and a sensible start size. */
export const MORTAR_CARDS: Array<[MortarView, string, string, string]> = [
  [
    'bagging',
    '▤',
    'Ensaque',
    'Sacos e toneladas da linha e de cada bico, ritmo, estado agora e a produção hora a hora.',
  ],
  [
    'mortar_output',
    '▦',
    'Produzido por produto',
    'Sacos e toneladas por produto no período, somando as receitas de todos os bicos.',
  ],
  [
    'mortar_materials',
    '◫',
    'Matéria-prima',
    'Bateladas e o consumo de cada material (areia, cimento, cal…) por receita.',
  ],
  [
    'mortar_yield',
    '⇄',
    'Rendimento',
    'O que foi misturado contra o que saiu ensacado, e a diferença.',
  ],
];
export const isMortarView = (type: string): type is MortarView =>
  MORTAR_CARDS.some(([view]) => view === type);
