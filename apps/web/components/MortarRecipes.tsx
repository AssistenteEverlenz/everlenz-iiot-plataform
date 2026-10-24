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
  celulose: {
    label: 'Éter de celulose',
    hint: 'retém a água e dá trabalhabilidade (MHEC, HPMC)',
    color: '#2f8f83',
  },
  polimero: {
    label: 'Polímero redispersível',
    hint: 'aderência e flexibilidade (EVA, VAE) — AC2 e AC3',
    color: '#5b6fc4',
  },
  incorporador: {
    label: 'Incorporador de ar',
    hint: 'microbolhas: leveza e trabalhabilidade',
    color: '#7a9cc0',
  },
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
function Composition({ recipe, legend }: { recipe: Recipe; legend: boolean }) {
  const total = Math.max(
    1,
    recipe.materials.reduce((sum, item) => sum + item.kg, 0) + recipe.additivesKg,
  );
  return (
    <div className="rc-comp">
      <div className="rc-comp-bar" role="img" aria-label="Composição de uma batelada">
        {recipe.materials.map((item, index) => (
          <i
            key={item.label}
            style={{
              width: `${(item.kg / total) * 100}%`,
              background: MATERIAL_COLORS[index % MATERIAL_COLORS.length],
            }}
            title={`${item.label}: ${kilos(item.kg)}`}
          />
        ))}
        {recipe.additives.map((item) => (
          <i
            key={item.id}
            className="manual"
            style={
              {
                width: `${Math.max(1.2, (item.kgPerBatch / total) * 100)}%`,
                '--kind': kindOf(item.kind).color,
              } as React.CSSProperties
            }
            title={`${item.name}: ${fineKg(item.kgPerBatch)} (à mão)`}
          />
        ))}
      </div>
      {legend && (
        <ul className="rc-comp-legend">
          {recipe.materials.map((item, index) => (
            <li key={item.label}>
              <u style={{ background: MATERIAL_COLORS[index % MATERIAL_COLORS.length] }} />
              {item.label} <b>{kilos(item.kg)}</b>
            </li>
          ))}
          {recipe.additives.map((item) => (
            <li
              key={item.id}
              className="manual"
              style={{ '--kind': kindOf(item.kind).color } as React.CSSProperties}
            >
              <u />
              {item.name} <b>{fineKg(item.kgPerBatch)}</b>
              <small>à mão</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type SortKey = 'batches' | 'batchKg' | 'costPerBatch' | 'costPerTon' | 'costPerBag';
const COLUMNS: Array<[SortKey, string]> = [
  ['batches', 'Bateladas'],
  ['batchKg', 'Batelada'],
  ['costPerBatch', 'R$/batelada'],
  ['costPerTon', 'R$/t'],
  ['costPerBag', 'R$/saco'],
];

/**
 * Every recipe in one table, so they compare at a glance: what one batch weighs and costs, by the
 * ton and by the bag, and what goes in by hand. A row opens to the batch drawn material by material.
 */
function RecipeTable({
  recipes,
  canEdit,
  onEdit,
}: {
  recipes: Recipe[];
  canEdit: boolean;
  onEdit: (recipe: Recipe) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'batches', desc: true });
  const [open, setOpen] = useState<string | null>(null);
  const rows = [...recipes].sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    // A recipe without a price goes last whichever way the column runs.
    if (left == null || right == null) return left == null ? (right == null ? 0 : 1) : -1;
    return sort.desc ? right - left : left - right;
  });
  const ran = recipes.filter((item) => item.batches > 0);
  const massKg = ran.reduce((sum, item) => sum + item.batchKg * item.batches, 0);
  const priced = ran.every((item) => item.costPerBatch != null);
  const costTotal = ran.reduce((sum, item) => sum + (item.costPerBatch ?? 0) * item.batches, 0);
  const maxPerTon = Math.max(1, ...recipes.map((item) => item.costPerTon ?? 0));
  const figure = (recipe: Recipe, key: SortKey) => {
    switch (key) {
      case 'batches':
        return <b>{integer(recipe.batches)}</b>;
      case 'batchKg':
        return (
          <>
            <b>{kilos(recipe.batchKg)}</b>
            {recipe.additivesKg > 0 && <small>+{fineKg(recipe.additivesKg)} à mão</small>}
          </>
        );
      case 'costPerBatch':
        return <b>{money(recipe.costPerBatch)}</b>;
      case 'costPerTon':
        return (
          <>
            <b>{money(recipe.costPerTon)}</b>
            {recipe.costPerTon != null && (
              <u className="rt-meter" aria-hidden="true">
                <i style={{ width: `${(recipe.costPerTon / maxPerTon) * 100}%` }} />
              </u>
            )}
          </>
        );
      case 'costPerBag':
        return (
          <>
            <b>{money(recipe.costPerBag, 2)}</b>
            {recipe.bagsPerBatch != null && (
              <small>{integer(recipe.bagsPerBatch)} sacos/bat.</small>
            )}
          </>
        );
    }
  };
  return (
    <div className="rt" role="table" aria-label="Receitas do misturador">
      <div className="rt-row rt-headrow" role="row">
        <span role="columnheader">Receita</span>
        <span role="columnheader">Composição</span>
        {COLUMNS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="columnheader"
            className={`rt-num ${sort.key === key ? 'sorted' : ''}`}
            aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
            onClick={() => setSort((was) => ({ key, desc: was.key === key ? !was.desc : true }))}
          >
            {label}
            <i aria-hidden="true">{sort.key === key ? (sort.desc ? '↓' : '↑') : ''}</i>
          </button>
        ))}
        <span role="columnheader">Aditivo à mão</span>
      </div>
      {rows.map((recipe) => {
        const expanded = open === recipe.recipe;
        return (
          <div
            key={recipe.recipe}
            className={`rt-item ${expanded ? 'open' : ''} ${recipe.batches ? '' : 'idle'}`}
          >
            <div
              className="rt-row"
              role="row"
              tabIndex={0}
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : recipe.recipe)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setOpen(expanded ? null : recipe.recipe);
                }
              }}
            >
              <span className="rt-name" role="cell">
                <b>
                  <i aria-hidden="true">›</i>
                  {recipe.recipe}
                </b>
                {recipe.product ? (
                  <small>{recipe.product.name}</small>
                ) : (
                  <small className="warn">sem produto ligado</small>
                )}
              </span>
              <span className="rt-comp" role="cell">
                <Composition recipe={recipe} legend={false} />
              </span>
              {COLUMNS.map(([key, label]) => (
                <span
                  key={key}
                  role="cell"
                  className={`rt-num rt-${key}`}
                  data-label={label}
                  title={
                    (key === 'costPerBatch' || key === 'costPerTon' || key === 'costPerBag') &&
                    recipe.costPerBatch == null
                      ? 'Falta o preço de algum material desta receita'
                      : undefined
                  }
                >
                  {figure(recipe, key)}
                </span>
              ))}
              <span className="rt-hand" role="cell">
                {recipe.additives.map((item) => (
                  <em
                    key={item.id}
                    style={{ '--kind': kindOf(item.kind).color } as React.CSSProperties}
                  >
                    <u aria-hidden="true" />
                    {item.name} <b>{fineKg(item.kgPerBatch)}</b>
                  </em>
                ))}
                {canEdit ? (
                  <button
                    type="button"
                    className={recipe.additives.length ? 'rt-edit' : 'rt-edit add'}
                    onClick={(event) => {
                      event.stopPropagation();
                      onEdit(recipe);
                    }}
                  >
                    {recipe.additives.length ? 'Configurar' : '+ Aditivo'}
                  </button>
                ) : (
                  !recipe.additives.length && <small>—</small>
                )}
              </span>
            </div>
            {expanded && (
              <div className="rt-detail">
                <Composition recipe={recipe} legend />
                <dl>
                  <div>
                    <dt>Pesado na balança</dt>
                    <dd>
                      {kilos(recipe.scaleKg ?? recipe.recipeKg)}
                      <small>
                        {recipe.scaleKg != null
                          ? `receita ${kilos(recipe.recipeKg)}`
                          : 'sem balança: peso da receita'}
                      </small>
                    </dd>
                  </div>
                  <div>
                    <dt>Materiais</dt>
                    <dd>
                      {money(recipe.materialsCost)}
                      <small>por batelada</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Aditivos à mão</dt>
                    <dd>
                      {recipe.additives.length ? money(recipe.additivesCost) : '—'}
                      <small>
                        {recipe.additives.length
                          ? `${fineKg(recipe.additivesKg)} · ${((recipe.additivesKg / recipe.batchKg) * 100).toFixed(1).replace('.', ',')}% da batelada`
                          : 'nenhum cadastrado'}
                      </small>
                    </dd>
                  </div>
                  <div>
                    <dt>Última batelada</dt>
                    <dd>
                      {day(recipe.lastAt)}
                      <small>{integer(recipe.batches)} no período</small>
                    </dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        );
      })}
      <div className="rt-row rt-total" role="row">
        <span className="rt-name" role="cell">
          <b>Total no período</b>
          <small>{ran.length} receitas rodaram</small>
        </span>
        <span className="rt-comp" role="cell" />
        <span className="rt-num rt-batches" role="cell" data-label="Bateladas">
          <b>{integer(ran.reduce((sum, item) => sum + item.batches, 0))}</b>
        </span>
        <span className="rt-num rt-batchKg" role="cell" data-label="Misturado">
          <b>{tons(massKg)} t</b>
        </span>
        <span className="rt-num rt-costPerBatch" role="cell" data-label="Custo">
          <b>{priced ? money(costTotal) : '—'}</b>
        </span>
        <span className="rt-num rt-costPerTon" role="cell" data-label="R$/t médio">
          <b>{priced && massKg ? money(costTotal / (massKg / 1000)) : '—'}</b>
        </span>
        <span className="rt-num rt-costPerBag" role="cell" />
        <span className="rt-hand" role="cell" />
      </div>
    </div>
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
    recipe.additives.map((item) => ({
      additiveId: item.id,
      kg: String(item.kgPerBatch).replace('.', ','),
    })),
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const weighed = recipe.scaleKg ?? recipe.recipeKg;
  const parsed = rows.map((row) => ({ ...row, value: number(row.kg) }));
  const totalKg = parsed.reduce(
    (sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0),
    0,
  );
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
          <button
            type="button"
            className="icon-button"
            aria-label="Fechar"
            onClick={() => onClose(false)}
          >
            ×
          </button>
        </header>
        <p className="rc-modal-lead">
          O que o operador coloca direto no misturador, em <b>uma batelada</b>. A balança pesa{' '}
          <b>{kilos(weighed)}</b>; somando os aditivos, a batelada fica com{' '}
          <b>{kilos(weighed + totalKg)}</b>.
        </p>
        {catalog.length === 0 ? (
          <div className="stops-empty">
            Cadastre primeiro os aditivos na aba Aditivos deste card.
          </div>
        ) : (
          <ul className="rc-rows">
            {rows.map((row, index) => {
              const additive = catalog.find((item) => item.id === row.additiveId);
              const value = number(row.kg);
              return (
                <li
                  key={index}
                  style={
                    { '--kind': kindOf(additive?.kind ?? 'outro').color } as React.CSSProperties
                  }
                >
                  <u aria-hidden="true" />
                  <select
                    aria-label="Aditivo"
                    value={row.additiveId}
                    onChange={(event) =>
                      setRows((was) =>
                        was.map((item, at) =>
                          at === index ? { ...item, additiveId: event.target.value } : item,
                        ),
                      )
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
                        setRows((was) =>
                          was.map((item, at) =>
                            at === index ? { ...item, kg: event.target.value } : item,
                          ),
                        )
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
                    {value > 0 && additive?.pricePerKg != null
                      ? ` · ${money(value * additive.pricePerKg, 2)}`
                      : ''}
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
              <button
                type="button"
                onClick={() => setRows((was) => [...was, { additiveId: '', kg: '' }])}
              >
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
          <button
            type="button"
            className="primary-button"
            disabled={saving || invalid}
            onClick={() => void save()}
          >
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
            <article
              key={item.id}
              className="rc-additive"
              style={{ '--kind': kind.color } as React.CSSProperties}
            >
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
                        price:
                          item.pricePerKg == null ? '' : String(item.pricePerKg).replace('.', ','),
                        pack:
                          item.packageKg == null ? '' : String(item.packageKg).replace('.', ','),
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
              <input
                value={form.name}
                maxLength={60}
                placeholder="ex.: Polímero VAE"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label>
              Tipo
              <select
                value={form.kind}
                onChange={(event) => setForm({ ...form, kind: event.target.value })}
              >
                {Object.entries(ADDITIVE_KINDS).map(([value, kind]) => (
                  <option key={value} value={value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Preço por kg (R$)
              <input
                inputMode="decimal"
                value={form.price}
                placeholder="ex.: 18,50"
                onChange={(event) => setForm({ ...form, price: event.target.value })}
              />
            </label>
            <label>
              Embalagem (kg)
              <input
                inputMode="decimal"
                value={form.pack}
                placeholder="ex.: 25"
                onChange={(event) => setForm({ ...form, pack: event.target.value })}
              />
            </label>
          </div>
          <small className="rc-form-hint">{kindOf(form.kind).hint}</small>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={() => setForm(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!form.name.trim()}
              onClick={() => void save()}
            >
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
  const board = usePoll<Board>(
    `/devices/${deviceId}/mortar/recipes-board?from=${from}&to=${to}`,
    300000,
  );
  const catalog = usePoll<{ available: boolean; additives: Additive[] }>(
    '/mortar/additives',
    600000,
  );
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
          <button
            type="button"
            className={tab === 'recipes' ? 'active' : ''}
            onClick={() => setTab('recipes')}
          >
            Receitas <small>{totals.recipes}</small>
          </button>
          <button
            type="button"
            className={tab === 'additives' ? 'active' : ''}
            onClick={() => setTab('additives')}
          >
            Aditivos <small>{catalog.data?.additives.length ?? 0}</small>
          </button>
        </div>
        {tab === 'recipes' && (
          <p>
            {totals.ran} receitas rodaram no período ·{' '}
            {totals.withAdditive ? (
              <>
                {totals.withAdditive} com aditivo à mão · <b>{tons(totals.additiveKg)} t</b> de
                aditivo nas bateladas
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
          <RecipeTable recipes={recipes} canEdit={canEdit && available} onEdit={setEditing} />
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
