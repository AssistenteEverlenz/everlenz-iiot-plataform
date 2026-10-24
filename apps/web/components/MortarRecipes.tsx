'use client';

import { useMemo, useState } from 'react';
import { mutate, usePoll } from './data';
import { confirmar } from './Dialogs';
import { ModalPortal } from './ModalPortal';
import { MATERIAL_COLORS, integer, kilos, money, tons } from './mortarShared';

/**
 * The recipes card (migration 051): what goes into one batch of each mixer recipe, drawn, and
 * what it costs -- with the additives the operator pours by hand into the mixer while it waits
 * for them. Those never cross the scale, so the plant says here how many kilos of each go into a
 * batch, and the platform adds them to the mixed mass (yield, lots, reconciliation) and to the
 * cost. A second tab keeps the catalog of additives: kind, price per kg, the package they come in.
 */

type Additive = {
  id: string;
  name: string;
  kind: string;
  pricePerKg: number | null;
  packageKg: number | null;
  recipes?: number;
};
type Recipe = {
  recipe: string;
  product: { id: string; name: string; nominalKg: number } | null;
  batches: number;
  lastAt: string;
  recipeKg: number;
  scaleKg: number | null;
  batchKg: number;
  materials: Array<{ label: string; kg: number; cost: number | null }>;
  additives: Array<Additive & { kgPerBatch: number }>;
  additivesKg: number;
  materialsCost: number | null;
  additivesCost: number | null;
  costPerBatch: number | null;
  costPerTon: number | null;
  costPerBag: number | null;
  bagsPerBatch: number | null;
};
type Board = { from: string; to: string; additivesAvailable: boolean; recipes: Recipe[] };

/** The kinds of additive a dry-mortar plant pours, with what each one is for. */
export const ADDITIVE_KINDS: Record<string, { label: string; hint: string; color: string }> = {
  celulose: { label: 'Éter de celulose', hint: 'retém a água e dá trabalhabilidade (MHEC, HPMC)', color: '#2f8f83' },
  polimero: { label: 'Polímero redispersível', hint: 'aderência e flexibilidade (EVA, VAE) — AC2 e AC3', color: '#5b6fc4' },
  incorporador: { label: 'Incorporador de ar', hint: 'microbolhas: leveza e trabalhabilidade', color: '#7a9cc0' },
  retardador: { label: 'Retardador', hint: 'aumenta o tempo em aberto', color: '#b88a3a' },
  hidrofugante: { label: 'Hidrofugante', hint: 'repele a água', color: '#3f87a8' },
  pigmento: { label: 'Pigmento', hint: 'cor (ex.: branca)', color: '#b36a8a' },
  fibra: { label: 'Fibra', hint: 'reduz fissuras', color: '#7d8a4a' },
  outro: { label: 'Outro', hint: 'qualquer outro produto colocado à mão', color: '#8a9ca2' },
};
const kindOf = (kind: string) => ADDITIVE_KINDS[kind] ?? ADDITIVE_KINDS.outro;
const number = (text: string) => Number(text.replace(',', '.'));
/** Additives are a few kilos: they keep up to two places, where the batch mass rounds to the kilo. */
const fineKg = (kg: number) => `${kg.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} kg`;
const day = (iso: string) => {
  const local = new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString();
  return `${local.slice(8, 10)}/${local.slice(5, 7)}`;
};

/** One batch, drawn: the weighed materials in their colours, the additives striped. */
function Composition({ recipe }: { recipe: Recipe }) {
  const total = Math.max(1, recipe.materials.reduce((sum, item) => sum + item.kg, 0) + recipe.additivesKg);
  return (
    <div className="rc-comp">
      <div className="rc-comp-bar" role="img" aria-label="Composição de uma batelada">
        {recipe.materials.map((item, index) => (
          <i
            key={item.label}
            style={{ width: `${(item.kg / total) * 100}%`, background: MATERIAL_COLORS[index % MATERIAL_COLORS.length] }}
            title={`${item.label}: ${kilos(item.kg)}`}
          />
        ))}
        {recipe.additives.map((item) => (
          <i
            key={item.id}
            className="manual"
            style={{ width: `${Math.max(1.2, (item.kgPerBatch / total) * 100)}%`, '--kind': kindOf(item.kind).color } as React.CSSProperties}
            title={`${item.name}: ${fineKg(item.kgPerBatch)} (à mão)`}
          />
        ))}
      </div>
      <ul className="rc-comp-legend">
        {recipe.materials.map((item, index) => (
          <li key={item.label}>
            <u style={{ background: MATERIAL_COLORS[index % MATERIAL_COLORS.length] }} />
            {item.label} <b>{kilos(item.kg)}</b>
          </li>
        ))}
        {recipe.additives.map((item) => (
          <li key={item.id} className="manual" style={{ '--kind': kindOf(item.kind).color } as React.CSSProperties}>
            <u />
            {item.name} <b>{fineKg(item.kgPerBatch)}</b>
            <small>à mão</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecipeCard({
  recipe,
  canEdit,
  onEdit,
}: {
  recipe: Recipe;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const share = recipe.batchKg ? recipe.additivesKg / recipe.batchKg : 0;
  return (
    <article className="rc-card">
      <header>
        <div>
          <b>{recipe.recipe}</b>
          {recipe.product ? (
            <small>
              enche <span>{recipe.product.name}</span>
            </small>
          ) : (
            <small className="warn">receita sem produto ligado</small>
          )}
        </div>
        <em title={`Última batelada em ${day(recipe.lastAt)}`}>
          {integer(recipe.batches)} <small>{recipe.batches === 1 ? 'batelada' : 'bateladas'}</small>
        </em>
      </header>
      <Composition recipe={recipe} />
      <div className="rc-figures">
        <div>
          <span>Batelada</span>
          <b>{kilos(recipe.batchKg)}</b>
          <small>
            {recipe.scaleKg != null ? 'balança' : 'receita'} {kilos(recipe.scaleKg ?? recipe.recipeKg)}
            {recipe.additivesKg > 0 && ` + ${fineKg(recipe.additivesKg)} à mão`}
          </small>
        </div>
        <div>
          <span>Custo da batelada</span>
          <b>{recipe.costPerBatch == null ? '—' : money(recipe.costPerBatch)}</b>
          <small>
            {recipe.costPerTon == null ? 'falta preço de material' : `${money(recipe.costPerTon)}/t`}
          </small>
        </div>
        <div>
          <span>Por saco</span>
          <b>{recipe.costPerBag == null ? '—' : money(recipe.costPerBag, 2)}</b>
          <small>
            {recipe.bagsPerBatch == null ? 'sem produto' : `${integer(recipe.bagsPerBatch)} sacos/batelada`}
          </small>
        </div>
      </div>
      {recipe.additives.length ? (
        <div className="rc-additives">
          <span className="rc-hand" aria-hidden="true">✋</span>
          <div>
            <b>
              Aditivos à mão · {fineKg(recipe.additivesKg)} <small>({(share * 100).toFixed(1).replace('.', ',')}% da batelada)</small>
            </b>
            <small>
              {recipe.additives
                .map((item) =>
                  item.packageKg
                    ? `${item.name} ${fineKg(item.kgPerBatch)} (${(item.kgPerBatch / item.packageKg).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} emb.)`
                    : `${item.name} ${fineKg(item.kgPerBatch)}`,
                )
                .join(' · ')}
            </small>
          </div>
          {canEdit && (
            <button type="button" onClick={onEdit}>
              Configurar
            </button>
          )}
        </div>
      ) : (
        <div className="rc-additives empty">
          <span className="rc-hand" aria-hidden="true">✋</span>
          <div>
            <b>Sem aditivo à mão</b>
          </div>
          {canEdit && (
            <button type="button" onClick={onEdit}>
              Adicionar
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/** The additives of one recipe, edited together: which, and how many kilos per batch. */
function RecipeAdditivesModal({
  recipe,
  catalog,
  onClose,
}: {
  recipe: Recipe;
  catalog: Additive[];
  onClose: (saved: boolean) => void;
}) {
  const [rows, setRows] = useState(
    recipe.additives.map((item) => ({ additiveId: item.id, kg: String(item.kgPerBatch).replace('.', ',') })),
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const weighed = recipe.scaleKg ?? recipe.recipeKg;
  const parsed = rows.map((row) => ({ ...row, value: number(row.kg) }));
  const totalKg = parsed.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0);
  const invalid = parsed.some((row) => !row.additiveId || !(row.value > 0));
  async function save() {
    setSaving(true);
    setError('');
    try {
      await mutate('/mortar/recipe-additives', 'PUT', {
        recipe: recipe.recipe,
        items: parsed.map((row) => ({ additiveId: row.additiveId, kgPerBatch: row.value })),
      });
      onClose(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => !saving && onClose(false)}>
      <div className="modal-card rc-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-title">
          <div>
            <div className="eyebrow">ADITIVOS À MÃO</div>
            <h2>{recipe.recipe}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={() => onClose(false)}>
            ×
          </button>
        </header>
        <p className="rc-modal-lead">
          O que o operador coloca direto no misturador, em <b>uma batelada</b>. A balança pesa{' '}
          <b>{kilos(weighed)}</b>; somando os aditivos, a batelada fica com <b>{kilos(weighed + totalKg)}</b>.
        </p>
        {catalog.length === 0 ? (
          <div className="stops-empty">Cadastre primeiro os aditivos na aba Aditivos deste card.</div>
        ) : (
          <ul className="rc-rows">
            {rows.map((row, index) => {
              const additive = catalog.find((item) => item.id === row.additiveId);
              const value = number(row.kg);
              return (
                <li key={index} style={{ '--kind': kindOf(additive?.kind ?? 'outro').color } as React.CSSProperties}>
                  <u aria-hidden="true" />
                  <select
                    aria-label="Aditivo"
                    value={row.additiveId}
                    onChange={(event) =>
                      setRows((was) => was.map((item, at) => (at === index ? { ...item, additiveId: event.target.value } : item)))
                    }
                  >
                    <option value="">Escolha o aditivo</option>
                    {catalog.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <span className="rc-kg">
                    <input
                      inputMode="decimal"
                      aria-label="Quilos por batelada"
                      value={row.kg}
                      onChange={(event) =>
                        setRows((was) => was.map((item, at) => (at === index ? { ...item, kg: event.target.value } : item)))
                      }
                    />
                    kg
                  </span>
                  <small>
                    {value > 0 && weighed
                      ? `${((value / (weighed + totalKg)) * 100).toFixed(2).replace('.', ',')}%`
                      : ''}
                    {value > 0 && additive?.packageKg
                      ? ` · ${(value / additive.packageKg).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} emb.`
                      : ''}
                    {value > 0 && additive?.pricePerKg != null ? ` · ${money(value * additive.pricePerKg, 2)}` : ''}
                  </small>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Remover"
                    onClick={() => setRows((was) => was.filter((_, at) => at !== index))}
                  >
                    ×
                  </button>
                </li>
              );
            })}
            <li className="rc-add">
              <button type="button" onClick={() => setRows((was) => [...was, { additiveId: '', kg: '' }])}>
                + Aditivo
              </button>
            </li>
          </ul>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={() => onClose(false)}>
            Cancelar
          </button>
          <button type="button" className="primary-button" disabled={saving || invalid} onClick={() => void save()}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The catalog of additives: each a card with its kind, price and package; added and edited inline. */
function AdditivesCatalog({
  catalog,
  canEdit,
  onChanged,
}: {
  catalog: Additive[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const blank = { id: '', name: '', kind: 'polimero', price: '', pack: '' };
  const [form, setForm] = useState<typeof blank | null>(null);
  const [error, setError] = useState('');
  async function save() {
    if (!form) return;
    setError('');
    const body = {
      name: form.name,
      kind: form.kind,
      pricePerKg: form.price.trim() ? number(form.price) : null,
      packageKg: form.pack.trim() ? number(form.pack) : null,
    };
    try {
      if (form.id) await mutate(`/mortar/additives/${form.id}`, 'PATCH', body);
      else await mutate('/mortar/additives', 'POST', body);
      setForm(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    }
  }
  async function remove(item: Additive) {
    const ok = await confirmar({
      titulo: `Remover ${item.name}?`,
      texto: item.recipes
        ? `Ele sai das ${item.recipes} receita(s) que o usam, e as bateladas deixam de contar o peso e o custo dele.`
        : 'Nenhuma receita usa este aditivo.',
      confirmar: 'Remover',
      perigo: true,
    });
    if (!ok) return;
    await mutate(`/mortar/additives/${item.id}`, 'DELETE');
    onChanged();
  }
  return (
    <div className="rc-catalog">
      <div className="rc-catalog-grid">
        {catalog.map((item) => {
          const kind = kindOf(item.kind);
          return (
            <article key={item.id} className="rc-additive" style={{ '--kind': kind.color } as React.CSSProperties}>
              <header>
                <u aria-hidden="true" />
                <div>
                  <b>{item.name}</b>
                  <small>{kind.label}</small>
                </div>
              </header>
              <p>{kind.hint}</p>
              <dl>
                <div>
                  <dt>Preço</dt>
                  <dd>{item.pricePerKg == null ? '—' : `${money(item.pricePerKg, 2)}/kg`}</dd>
                </div>
                <div>
                  <dt>Embalagem</dt>
                  <dd>{item.packageKg == null ? '—' : kilos(item.packageKg)}</dd>
                </div>
                <div>
                  <dt>Receitas</dt>
                  <dd>{integer(item.recipes ?? 0)}</dd>
                </div>
              </dl>
              {canEdit && (
                <footer>
                  <button
                    type="button"
                    onClick={() =>
                      setForm({
                        id: item.id,
                        name: item.name,
                        kind: item.kind,
                        price: item.pricePerKg == null ? '' : String(item.pricePerKg).replace('.', ','),
                        pack: item.packageKg == null ? '' : String(item.packageKg).replace('.', ','),
                      })
                    }
                  >
                    Editar
                  </button>
                  <button type="button" className="danger-text" onClick={() => void remove(item)}>
                    Remover
                  </button>
                </footer>
              )}
            </article>
          );
        })}
        {canEdit && !form && (
          <button type="button" className="rc-additive rc-new" onClick={() => setForm(blank)}>
            <span aria-hidden="true">+</span>
            Novo aditivo
          </button>
        )}
      </div>
      {form && (
        <div className="rc-form">
          <b>{form.id ? 'Editar aditivo' : 'Novo aditivo'}</b>
          <div className="rc-form-grid">
            <label>
              Nome
              <input value={form.name} maxLength={60} placeholder="ex.: Polímero VAE" onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            <label>
              Tipo
              <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
                {Object.entries(ADDITIVE_KINDS).map(([value, kind]) => (
                  <option key={value} value={value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Preço por kg (R$)
              <input inputMode="decimal" value={form.price} placeholder="ex.: 18,50" onChange={(event) => setForm({ ...form, price: event.target.value })} />
            </label>
            <label>
              Embalagem (kg)
              <input inputMode="decimal" value={form.pack} placeholder="ex.: 25" onChange={(event) => setForm({ ...form, pack: event.target.value })} />
            </label>
          </div>
          <small className="rc-form-hint">{kindOf(form.kind).hint}</small>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={() => setForm(null)}>
              Cancelar
            </button>
            <button type="button" className="primary-button" disabled={!form.name.trim()} onClick={() => void save()}>
              Salvar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RecipesBoard({
  deviceId,
  from,
  to,
  canEdit,
}: {
  deviceId: string;
  from: string;
  to: string;
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<'recipes' | 'additives'>('recipes');
  const [editing, setEditing] = useState<Recipe | null>(null);
  const board = usePoll<Board>(`/devices/${deviceId}/mortar/recipes-board?from=${from}&to=${to}`, 300000);
  const catalog = usePoll<{ available: boolean; additives: Additive[] }>('/mortar/additives', 600000);
  const recipes = board.data?.recipes ?? [];
  const totals = useMemo(() => {
    const ran = recipes.filter((item) => item.batches > 0);
    return {
      recipes: recipes.length,
      ran: ran.length,
      withAdditive: recipes.filter((item) => item.additives.length).length,
      additiveKg: ran.reduce((sum, item) => sum + item.additivesKg * item.batches, 0),
    };
  }, [recipes]);
  if (!board.data) return <div className="stops-empty">{board.error ?? 'Carregando…'}</div>;
  const available = board.data.additivesAvailable;
  return (
    <section className="rc">
      <div className="rc-head">
        <div className="widget-period" role="group" aria-label="Ver">
          <button type="button" className={tab === 'recipes' ? 'active' : ''} onClick={() => setTab('recipes')}>
            Receitas <small>{totals.recipes}</small>
          </button>
          <button type="button" className={tab === 'additives' ? 'active' : ''} onClick={() => setTab('additives')}>
            Aditivos <small>{catalog.data?.additives.length ?? 0}</small>
          </button>
        </div>
        {tab === 'recipes' && (
          <p>
            {totals.ran} receitas rodaram no período ·{' '}
            {totals.withAdditive ? (
              <>
                {totals.withAdditive} com aditivo à mão · <b>{tons(totals.additiveKg)} t</b> de aditivo nas bateladas
              </>
            ) : (
              'nenhuma com aditivo à mão cadastrado'
            )}
          </p>
        )}
      </div>
      {!available && (
        <div className="mortar-warning">
          <span>Os aditivos ficam disponíveis depois da migração 051 aplicada no banco.</span>
        </div>
      )}
      {tab === 'recipes' ? (
        recipes.length ? (
          <div className="rc-grid">
            {recipes.map((recipe) => (
              <RecipeCard
                key={recipe.recipe}
                recipe={recipe}
                canEdit={canEdit && available}
                onEdit={() => setEditing(recipe)}
              />
            ))}
          </div>
        ) : (
          <div className="stops-empty">O misturador ainda não registrou nenhuma batelada.</div>
        )
      ) : (
        <AdditivesCatalog
          catalog={catalog.data?.additives ?? []}
          canEdit={canEdit && available}
          onChanged={() => {
            void catalog.refresh();
            void board.refresh();
          }}
        />
      )}
      {editing && (
        <ModalPortal>
          <RecipeAdditivesModal
            recipe={editing}
            catalog={catalog.data?.additives ?? []}
            onClose={(saved) => {
              setEditing(null);
              if (saved) {
                void board.refresh();
                void catalog.refresh();
              }
            }}
          />
        </ModalPortal>
      )}
    </section>
  );
}
