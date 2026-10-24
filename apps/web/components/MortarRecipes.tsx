'use client';

import { useContext, useMemo, useState } from 'react';
import { mutate, usePoll } from './data';
import { confirmar } from './Dialogs';
import { ModalPortal } from './ModalPortal';
import { ProductsBoard, mixOf, type CatalogProduct, type CatalogRecipe } from './MortarProducts';
import { MortarColors, integer, kilos, money, tons } from './mortarShared';

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
type Board = {
  from: string;
  to: string;
  additivesAvailable: boolean;
  recipes: Recipe[];
  bagged: Array<{ recipe: string; bags: number }>;
};

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

type SortKey = 'batches' | 'batchKg' | 'costPerBatch' | 'costPerTon' | 'costPerBag';
const COLUMNS: Array<[SortKey, string]> = [
  ['batches', 'Bateladas'],
  ['batchKg', 'Batelada'],
  ['costPerBatch', 'R$/batelada'],
  ['costPerTon', 'R$/t'],
  ['costPerBag', 'R$/saco'],
];

const share = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '';

/** A swatch in the colour of a material, or striped in the colour of an additive's kind. */
function Swatch({ color, manual }: { color: string; manual?: boolean }) {
  return (
    <u
      className={manual ? 'rc-swatch manual' : 'rc-swatch'}
      style={{ '--kind': color, background: manual ? undefined : color } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}

/** One batch as a sum: each material and additive a line, the batch the total. */
function BatchLedger({ recipe, colorOf }: { recipe: Recipe; colorOf: (label: string) => string }) {
  const weighed = recipe.materials.reduce((sum, item) => sum + item.kg, 0);
  const total = weighed + recipe.additivesKg;
  const scaleGap = recipe.scaleKg == null ? null : recipe.scaleKg - recipe.recipeKg;
  return (
    <div className="rl">
      <div className="rl-title">Uma batelada</div>
      <ul>
        {recipe.materials.map((item) => (
          <li key={item.label}>
            <Swatch color={colorOf(item.label)} />
            <span>{item.label}</span>
            <b>{kilos(item.kg)}</b>
            <small>{share(item.kg, total)}</small>
            <em>{item.cost == null ? 'sem preço' : money(item.cost)}</em>
          </li>
        ))}
        {recipe.additives.map((item) => (
          <li key={item.id} className="manual">
            <Swatch color={kindOf(item.kind).color} manual />
            <span>
              {item.name} <i>à mão</i>
            </span>
            <b>{fineKg(item.kgPerBatch)}</b>
            <small>{share(item.kgPerBatch, total)}</small>
            <em>
              {item.pricePerKg == null ? 'sem preço' : money(item.kgPerBatch * item.pricePerKg)}
            </em>
          </li>
        ))}
        <li className="rl-total">
          <span>= Batelada</span>
          <b>{kilos(recipe.batchKg)}</b>
          <small />
          <em>{money(recipe.costPerBatch)}</em>
        </li>
      </ul>
      {scaleGap != null && (
        <p
          className={
            Math.abs(scaleGap) / Math.max(1, recipe.recipeKg) > 0.02 ? 'rl-note warn' : 'rl-note'
          }
        >
          A balança pesou <b>{kilos(recipe.scaleKg)}</b> por batelada, contra{' '}
          <b>{kilos(recipe.recipeKg)}</b> da receita ({scaleGap >= 0 ? '+' : ''}
          {share(scaleGap, recipe.recipeKg)}). O peso da batelada usa a balança.
        </p>
      )}
    </div>
  );
}

/** Where the batch goes: the product the mixer recipe makes, and every bag of that mix the HMI filled. */
function BatchBagging({
  recipe,
  products,
  bagRecipes,
  bagged,
  canEdit,
  onLink,
}: {
  recipe: Recipe;
  products: CatalogProduct[];
  bagRecipes: CatalogRecipe[];
  bagged: Map<string, number>;
  canEdit: boolean;
  onLink: (productId: string | null) => void;
}) {
  const mix = recipe.product ? mixOf(recipe.product.name) : null;
  const family = mix ? products.filter((item) => mixOf(item.name) === mix) : [];
  return (
    <div className="rb">
      <div className="rl-title">Vira no ensaque</div>
      <label className="rb-product">
        <span>Produto desta receita</span>
        {canEdit ? (
          <select
            value={recipe.product?.id ?? ''}
            onChange={(event) => onLink(event.target.value || null)}
          >
            <option value="">— sem produto —</option>
            {products.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        ) : (
          <b>{recipe.product?.name ?? 'sem produto'}</b>
        )}
      </label>
      {family.length ? (
        <ul>
          {family.map((product) => {
            const names = bagRecipes.filter(
              (item) => item.productId === product.id && item.bagger !== false,
            );
            const bags = names.reduce((sum, item) => sum + (bagged.get(item.recipe) ?? 0), 0);
            return (
              <li key={product.id}>
                <div>
                  <b>{product.name}</b>
                  <small>
                    saco de {product.nominal_kg.toLocaleString('pt-BR')} kg ·{' '}
                    {integer(recipe.batchKg / product.nominal_kg)} sacos por batelada
                  </small>
                </div>
                <strong>
                  {integer(bags)}{' '}
                  <small>sacos no período · {tons(bags * product.nominal_kg)} t</small>
                </strong>
                <p>
                  {names.length ? (
                    names.map((item) => (
                      <span
                        key={item.recipe}
                        className="rb-chip"
                        title="Nome da receita na IHM da ensacadeira"
                      >
                        {item.recipe}
                        {bagged.get(item.recipe) ? (
                          <i>{integer(bagged.get(item.recipe)!)}</i>
                        ) : null}
                      </span>
                    ))
                  ) : (
                    <small className="warn">
                      nenhuma receita da ensacadeira ligada a este produto
                    </small>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rb-empty">Ligue a receita a um produto para ver o que ela vira no ensaque.</p>
      )}
    </div>
  );
}

/**
 * Every mixer recipe in one table, so they compare at a glance: what goes in, what one batch weighs
 * and costs, by the ton and by the bag, and what goes in by hand. A row opens to the batch as a sum
 * and to what it becomes at the bagger.
 */
function RecipeTable({
  recipes,
  canEdit,
  additivesReady,
  onEdit,
  products,
  bagRecipes,
  bagged,
  onLink,
}: {
  recipes: Recipe[];
  canEdit: boolean;
  additivesReady: boolean;
  onEdit: (recipe: Recipe) => void;
  products: CatalogProduct[];
  bagRecipes: CatalogRecipe[];
  bagged: Map<string, number>;
  onLink: (recipe: string, productId: string | null) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'batches', desc: true });
  const [open, setOpen] = useState<string | null>(null);
  const palette = useContext(MortarColors);
  // One colour per material across every recipe: the order the plant set, then by first sight.
  const labels = [
    ...new Set(recipes.flatMap((item) => item.materials.map((material) => material.label))),
  ];
  const colorOf = (label: string) => palette.material(label, Math.max(0, labels.indexOf(label)));
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
        <span role="columnheader">O que vai na batelada</span>
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
        const toggle = () => setOpen(expanded ? null : recipe.recipe);
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
              onClick={toggle}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggle();
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
              <span className="rt-mats" role="cell">
                {recipe.materials.map((item) => (
                  <span key={item.label}>
                    <Swatch color={colorOf(item.label)} />
                    {item.label} <b>{kilos(item.kg)}</b>
                  </span>
                ))}
              </span>
              {COLUMNS.map(([key, label]) => (
                <span
                  key={key}
                  role="cell"
                  className={`rt-num rt-${key}`}
                  data-label={label}
                  title={
                    key !== 'batches' && key !== 'batchKg' && recipe.costPerBatch == null
                      ? 'Falta o preço de algum material desta receita (aba Insumos)'
                      : undefined
                  }
                >
                  {figure(recipe, key)}
                </span>
              ))}
              <span className="rt-hand" role="cell">
                {recipe.additives.map((item) => (
                  <em key={item.id}>
                    <Swatch color={kindOf(item.kind).color} manual />
                    {item.name} <b>{fineKg(item.kgPerBatch)}</b>
                  </em>
                ))}
                {canEdit && additivesReady ? (
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
                <BatchLedger recipe={recipe} colorOf={colorOf} />
                <BatchBagging
                  recipe={recipe}
                  products={products}
                  bagRecipes={bagRecipes}
                  bagged={bagged}
                  canEdit={canEdit}
                  onLink={(productId) => onLink(recipe.recipe, productId)}
                />
                <dl className="rt-facts">
                  <div>
                    <dt>No período</dt>
                    <dd>
                      {integer(recipe.batches)}{' '}
                      <small>{recipe.batches === 1 ? 'batelada' : 'bateladas'}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Misturado</dt>
                    <dd>
                      {tons(recipe.batchKg * recipe.batches)} <small>t</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Custo no período</dt>
                    <dd>
                      {recipe.costPerBatch == null
                        ? '—'
                        : money(recipe.costPerBatch * recipe.batches)}
                    </dd>
                  </div>
                  <div>
                    <dt>Última batelada</dt>
                    <dd>{day(recipe.lastAt)}</dd>
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
        <span className="rt-mats" role="cell" />
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

/** What a ton of each weighed material costs: one line per material the mixer doses. */
function MaterialPrices({
  labels,
  usedBy,
  canEdit,
}: {
  labels: string[];
  usedBy: (label: string) => number;
  canEdit: boolean;
}) {
  const saved = usePoll<{ prices: Array<{ label: string; pricePerTon: number }> }>(
    '/mortar/prices',
    600000,
  );
  const palette = useContext(MortarColors);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const stored = Object.fromEntries(
    (saved.data?.prices ?? []).map((item) => [
      item.label,
      String(item.pricePerTon).replace('.', ','),
    ]),
  );
  const values = form ?? stored;
  const all = [...new Set([...labels, ...Object.keys(stored)])];
  async function save() {
    if (!form) return;
    setSaving(true);
    setError('');
    try {
      await mutate('/mortar/prices', 'PUT', {
        prices: Object.entries(form)
          .filter(([, value]) => value.trim() !== '')
          .map(([label, value]) => ({ label, pricePerTon: number(value) })),
      });
      setForm(null);
      await saved.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="ri-section">
      <header>
        <b>Materiais pesados na balança</b>
        <small>
          Preço por tonelada. Com ele cada receita mostra o custo da batelada, da tonelada e do
          saco.
        </small>
      </header>
      <ul className="ri-prices">
        {all.map((label, index) => {
          const missing = !(values[label] ?? '').trim();
          return (
            <li key={label} className={missing ? 'missing' : ''}>
              <u
                style={{
                  background: palette.material(
                    label,
                    Math.max(0, labels.indexOf(label) >= 0 ? labels.indexOf(label) : index),
                  ),
                }}
                aria-hidden="true"
              />
              <div>
                <b>{label}</b>
                <small>
                  {usedBy(label)
                    ? `em ${usedBy(label)} ${usedBy(label) === 1 ? 'receita' : 'receitas'}`
                    : 'nenhuma receita no período'}
                  {missing && ' · sem preço'}
                </small>
              </div>
              <span className="ri-money">
                R$
                <input
                  inputMode="decimal"
                  aria-label={`Preço de ${label} por tonelada`}
                  value={values[label] ?? ''}
                  placeholder="—"
                  disabled={!canEdit}
                  onChange={(event) => setForm({ ...values, [label]: event.target.value })}
                />
                /t
              </span>
            </li>
          );
        })}
      </ul>
      {error && <div className="form-error">{error}</div>}
      {form && (
        <div className="ri-save">
          <button type="button" onClick={() => setForm(null)} disabled={saving}>
            Descartar
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? 'Salvando…' : 'Salvar preços'}
          </button>
        </div>
      )}
    </section>
  );
}

type Tab = 'batches' | 'bagging' | 'inputs';

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
  const [tab, setTab] = useState<Tab>('batches');
  const [editing, setEditing] = useState<Recipe | null>(null);
  const board = usePoll<Board>(
    `/devices/${deviceId}/mortar/recipes-board?from=${from}&to=${to}`,
    300000,
    { keepPrevious: true },
  );
  const catalog = usePoll<{ available: boolean; additives: Additive[] }>(
    '/mortar/additives',
    600000,
  );
  const products = usePoll<{ products: CatalogProduct[]; recipes: CatalogRecipe[] }>(
    '/mortar/products',
    600000,
  );
  const recipes = useMemo(() => board.data?.recipes ?? [], [board.data]);
  const bagged = useMemo(
    () => new Map((board.data?.bagged ?? []).map((row) => [row.recipe, row.bags])),
    [board.data],
  );
  const labels = useMemo(
    () => [...new Set(recipes.flatMap((item) => item.materials.map((material) => material.label)))],
    [recipes],
  );
  if (!board.data) return <div className="stops-empty">{board.error ?? 'Carregando…'}</div>;
  const available = board.data.additivesAvailable;
  const ran = recipes.filter((item) => item.batches > 0);
  const withAdditive = recipes.filter((item) => item.additives.length).length;
  const additiveKg = ran.reduce((sum, item) => sum + item.additivesKg * item.batches, 0);
  const bagNames = (products.data?.recipes ?? []).filter((item) => item.bagger || !item.mixer);
  const unlinked = bagNames.filter((item) => !item.productId).length;
  const tabs: Array<[Tab, string, string, number | null]> = [
    ['batches', 'Bateladas', 'receitas do misturador', recipes.length],
    ['bagging', 'Ensaque', 'produtos e receitas da IHM', products.data?.products.length ?? null],
    ['inputs', 'Insumos', 'preços e aditivos', null],
  ];
  const refreshAll = () => {
    void board.refresh();
    void catalog.refresh();
    return products.refresh();
  };
  return (
    <section className="rc">
      <nav className="rc-tabs" aria-label="Receitas">
        {tabs.map(([key, label, hint, count]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'active' : ''}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            <b>
              {label}
              {count != null && <i>{count}</i>}
              {key === 'bagging' && unlinked > 0 && (
                <em title={`${unlinked} receita(s) da IHM sem produto`}>{unlinked}</em>
              )}
            </b>
            <small>{hint}</small>
          </button>
        ))}
      </nav>
      {tab === 'batches' && (
        <>
          <p className="rc-lead">
            <b>{ran.length}</b> receitas rodaram no período ·{' '}
            {withAdditive ? (
              <>
                <b>{withAdditive}</b> com aditivo à mão · <b>{tons(additiveKg)} t</b> de aditivo nas
                bateladas
              </>
            ) : (
              'nenhuma com aditivo à mão cadastrado'
            )}
            <span> · toque numa receita para abrir a batelada</span>
          </p>
          {!available && (
            <div className="mortar-warning">
              <span>Os aditivos ficam disponíveis depois da migração 051 aplicada no banco.</span>
            </div>
          )}
          {recipes.length ? (
            <RecipeTable
              recipes={recipes}
              canEdit={canEdit}
              additivesReady={available}
              onEdit={setEditing}
              products={products.data?.products ?? []}
              bagRecipes={bagNames}
              bagged={bagged}
              onLink={(recipe, productId) =>
                void mutate('/mortar/recipes', 'PUT', { recipe, productId }).then(refreshAll)
              }
            />
          ) : (
            <div className="stops-empty">O misturador ainda não registrou nenhuma batelada.</div>
          )}
        </>
      )}
      {tab === 'bagging' &&
        (products.data ? (
          <ProductsBoard
            products={products.data.products}
            recipes={products.data.recipes}
            canEdit={canEdit}
            onChanged={refreshAll}
          />
        ) : (
          <div className="stops-empty">{products.error ?? 'Carregando…'}</div>
        ))}
      {tab === 'inputs' && (
        <div className="ri">
          <MaterialPrices
            labels={labels}
            usedBy={(label) =>
              recipes.filter(
                (item) => item.batches > 0 && item.materials.some((m) => m.label === label),
              ).length
            }
            canEdit={canEdit}
          />
          <section className="ri-section">
            <header>
              <b>Aditivos colocados à mão</b>
              <small>
                O que o operador põe direto no misturador e a balança não pesa. Cadastre aqui e diga
                em cada receita (aba Bateladas) quantos kg vão por batelada.
              </small>
            </header>
            {!available && (
              <div className="mortar-warning">
                <span>Os aditivos ficam disponíveis depois da migração 051 aplicada no banco.</span>
              </div>
            )}
            <AdditivesCatalog
              catalog={catalog.data?.additives ?? []}
              canEdit={canEdit && available}
              onChanged={() => void refreshAll()}
            />
          </section>
        </div>
      )}
      {editing && (
        <ModalPortal>
          <RecipeAdditivesModal
            recipe={editing}
            catalog={catalog.data?.additives ?? []}
            onClose={(saved) => {
              setEditing(null);
              if (saved) void refreshAll();
            }}
          />
        </ModalPortal>
      )}
    </section>
  );
}
