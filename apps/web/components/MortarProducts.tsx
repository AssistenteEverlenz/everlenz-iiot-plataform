'use client';

import { useMemo, useState } from 'react';
import { mutate } from './data';
import { confirmar } from './Dialogs';
import { integer } from './mortarShared';

/**
 * The bagger side of the recipes card: the products a plant sells, grouped by the mix they carry,
 * and the recipe names the bagger HMI uses, each hanging under the product it fills. A name moves
 * to another product by dragging it there (or, on a phone, by tapping it and then the product);
 * the names no product claims yet wait in a tray on top, because their bags count for nothing
 * until they are linked.
 */

export type CatalogProduct = {
  id: string;
  name: string;
  nominal_kg: number;
  standard_rate: number | null;
};
export type CatalogRecipe = {
  recipe: string;
  productId: string | null;
  bags: number;
  lastAt: string | null;
  mixer?: boolean;
  bagger?: boolean;
};

export const mixOf = (name: string) =>
  name.replace(/\s*\d+(?:[.,]\d+)?\s*kg\s*$/i, '').trim() || name;
const number = (text: string) => Number(text.replace(',', '.'));
const day = (iso: string | null) => {
  if (!iso) return '';
  const local = new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString();
  return `${local.slice(8, 10)}/${local.slice(5, 7)}`;
};

type Draft = { id: string; name: string; kg: string; rate: string };

function ProductForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="rp-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label>
        Produto
        <input
          autoFocus
          value={draft.name}
          maxLength={80}
          placeholder="ex.: AC3 Bella Fix 20kg"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <label>
        Saco (kg)
        <input
          inputMode="decimal"
          value={draft.kg}
          placeholder="20"
          onChange={(event) => onChange({ ...draft, kg: event.target.value })}
        />
      </label>
      <label title="Quantos sacos por hora um bico bem regulado faz deste produto. Com ele o quadro mostra o desempenho.">
        Ritmo padrão (sacos/h)
        <input
          inputMode="decimal"
          value={draft.rate}
          placeholder="opcional"
          onChange={(event) => onChange({ ...draft, rate: event.target.value })}
        />
      </label>
      <div className="rp-form-actions">
        <button type="button" onClick={onCancel}>
          Cancelar
        </button>
        <button
          type="submit"
          className="primary-button"
          disabled={!draft.name.trim() || !(number(draft.kg) > 0)}
        >
          Salvar
        </button>
      </div>
    </form>
  );
}

export function ProductsBoard({
  products,
  recipes,
  canEdit,
  onChanged,
}: {
  products: CatalogProduct[];
  recipes: CatalogRecipe[];
  canEdit: boolean;
  onChanged: () => Promise<unknown> | void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  // Names the mixer runs never reach the bagger HMI: they are linked on the batches tab.
  const names = recipes.filter((item) => item.bagger || !item.mixer);
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    }
  };
  const link = (recipe: string, productId: string | null) => {
    setPicked(null);
    setOver(null);
    const current = names.find((item) => item.recipe === recipe);
    if (!current || current.productId === productId) return;
    void run(() => mutate('/mortar/recipes', 'PUT', { recipe, productId }));
  };
  const saveDraft = () => {
    if (!draft) return;
    const body = {
      name: draft.name.trim(),
      nominalKg: number(draft.kg),
      standardRate: draft.rate.trim() ? number(draft.rate) : null,
    };
    void run(async () => {
      if (draft.id) await mutate(`/mortar/products/${draft.id}`, 'PATCH', body);
      else await mutate('/mortar/products', 'POST', body);
      setDraft(null);
    });
  };
  const remove = async (product: CatalogProduct, linked: number) => {
    const ok = await confirmar({
      titulo: `Excluir ${product.name}?`,
      texto: linked
        ? `As ${linked} receita(s) ligadas a ele voltam para "Sem produto", e os sacos delas deixam de contar.`
        : 'Nenhuma receita está ligada a este produto.',
      confirmar: 'Excluir',
      perigo: true,
    });
    if (ok) void run(() => mutate(`/mortar/products/${product.id}`, 'DELETE'));
  };

  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const unlinked = names
    .filter((item) => !item.productId)
    .filter((item) => matches(item.recipe))
    .sort((a, b) => b.bags - a.bags);
  const families = useMemo(() => {
    const groups = new Map<string, CatalogProduct[]>();
    for (const product of products) {
      const key = mixOf(product.name);
      groups.set(key, [...(groups.get(key) ?? []), product]);
    }
    return [...groups.entries()]
      .map(([mix, items]) => ({
        mix,
        items: items.sort((a, b) => b.nominal_kg - a.nominal_kg),
      }))
      .sort((a, b) => a.mix.localeCompare(b.mix, 'pt-BR'));
  }, [products]);

  // A chip: one recipe name of the bagger HMI, dragged or tapped to move.
  const chip = (item: CatalogRecipe) => (
    <span
      key={item.recipe}
      className={`rp-chip ${picked === item.recipe ? 'picked' : ''} ${item.bags ? '' : 'quiet'}`}
      draggable={canEdit}
      role={canEdit ? 'button' : undefined}
      tabIndex={canEdit ? 0 : undefined}
      title={
        item.bags
          ? `${integer(item.bags)} sacos registrados · último em ${day(item.lastAt)}`
          : 'Nenhum saco registrado com este nome'
      }
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', item.recipe);
        event.dataTransfer.effectAllowed = 'move';
        setPicked(item.recipe);
      }}
      onDragEnd={() => {
        setPicked(null);
        setOver(null);
      }}
      onClick={(event) => {
        if (!canEdit) return;
        event.stopPropagation();
        setPicked(picked === item.recipe ? null : item.recipe);
      }}
      onKeyDown={(event) => {
        if (canEdit && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          setPicked(picked === item.recipe ? null : item.recipe);
        }
      }}
    >
      {canEdit && <i className="rp-grip" aria-hidden="true" />}
      {item.recipe}
      {item.bags > 0 && <small>{integer(item.bags)}</small>}
      {canEdit && item.productId && (
        <button
          type="button"
          aria-label={`Desligar ${item.recipe}`}
          title={item.bags ? 'Desligar do produto' : 'Remover este nome (nunca ensacou)'}
          onClick={async (event) => {
            event.stopPropagation();
            // A name that never bagged exists only through its link: unlinking removes it.
            if (
              !item.bags &&
              !(await confirmar({
                titulo: `Remover ${item.recipe}?`,
                texto:
                  'Nenhum saco foi registrado com este nome, então ele sai da lista. Se a IHM voltar a usá-lo, ele reaparece em "Sem produto".',
                confirmar: 'Remover',
                perigo: true,
              }))
            )
              return;
            link(item.recipe, null);
          }}
        >
          ×
        </button>
      )}
    </span>
  );
  // What a product row or the tray does when a name is dropped or tapped onto it.
  const target = (key: string, productId: string | null) =>
    canEdit
      ? {
          onDragOver: (event: React.DragEvent) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (over !== key) setOver(key);
          },
          onDragLeave: (event: React.DragEvent) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
          },
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            const recipe = event.dataTransfer.getData('text/plain');
            if (recipe) link(recipe, productId);
          },
          onClick: () => {
            if (picked) link(picked, productId);
          },
        }
      : {};

  const linkedCount = names.filter((item) => item.productId).length;
  return (
    <div className={`rp ${picked ? 'moving' : ''}`}>
      <div className="rp-toolbar">
        <label className="rp-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            placeholder="Buscar produto ou receita da IHM"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p>
          Cada produto e os nomes que a IHM da ensacadeira usa para ele. Os sacos de um nome contam
          no produto da linha onde ele está
          {canEdit ? '; para trocar, arraste o nome para outra linha' : ''}.
          <br />
          <b>{products.length}</b> produtos · <b>{linkedCount}</b> receitas da IHM ligadas
          {names.length - linkedCount > 0 && (
            <>
              {' '}
              · <b className="warn">{names.length - linkedCount}</b> sem produto
            </>
          )}
        </p>
        {canEdit && !draft && (
          <button
            type="button"
            className="primary-button"
            onClick={() => setDraft({ id: '', name: '', kg: '', rate: '' })}
          >
            + Produto
          </button>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      {draft && !draft.id && (
        <ProductForm
          draft={draft}
          onChange={setDraft}
          onSave={saveDraft}
          onCancel={() => setDraft(null)}
        />
      )}
      {(unlinked.length > 0 || picked) && (
        <section
          className={`rp-tray ${over === 'tray' ? 'over' : ''} ${unlinked.length ? '' : 'clear'}`}
          {...target('tray', null)}
        >
          <header>
            <b>{unlinked.length ? 'Sem produto' : 'Solte aqui para desligar'}</b>
            {unlinked.length > 0 && (
              <small>
                Os sacos destas receitas não contam em nenhum produto.{' '}
                {canEdit &&
                  (picked
                    ? 'Agora toque no produto que ela enche.'
                    : 'Arraste cada uma até o produto que ela enche — ou toque nela e depois no produto.')}
              </small>
            )}
          </header>
          <div className="rp-chips">{unlinked.map(chip)}</div>
        </section>
      )}
      {picked && unlinked.every((item) => item.recipe !== picked) && (
        <div className="rp-hint">
          Movendo <b>{picked}</b> — toque no produto de destino.{' '}
          <button type="button" onClick={() => setPicked(null)}>
            Cancelar
          </button>
        </div>
      )}
      <div className="pt" role="table" aria-label="Produtos e nomes da IHM">
        <div className="pt-row pt-headrow" role="row">
          <span role="columnheader">Produto</span>
          <span role="columnheader">Nomes na IHM da ensacadeira</span>
          <span role="columnheader" className="pt-num">
            Sacos
          </span>
          <span role="columnheader" className="pt-num">
            Último saco
          </span>
          <span role="columnheader" className="pt-num">
            Ritmo padrão
          </span>
          <span role="columnheader" />
        </div>
        {families.map(({ mix, items }) => {
          const shown = items.filter(
            (product) =>
              matches(product.name) ||
              matches(mix) ||
              names.some((item) => item.productId === product.id && matches(item.recipe)),
          );
          if (!shown.length) return null;
          return (
            // The sizes of one mix sit together, set apart from the next mix by a firmer line.
            <div key={mix} className="pt-family" role="rowgroup" aria-label={mix}>
              {shown.map((product) => {
                const own = names.filter((item) => item.productId === product.id);
                const bags = own.reduce((sum, item) => sum + item.bags, 0);
                const last = own.reduce<string | null>(
                  (latest, item) =>
                    item.lastAt && (!latest || item.lastAt > latest) ? item.lastAt : latest,
                  null,
                );
                if (draft?.id === product.id)
                  return (
                    <div key={product.id} className="pt-edit" role="row">
                      <ProductForm
                        draft={draft}
                        onChange={setDraft}
                        onSave={saveDraft}
                        onCancel={() => setDraft(null)}
                      />
                    </div>
                  );
                return (
                  <div
                    key={product.id}
                    role="row"
                    className={`pt-row ${over === product.id ? 'over' : ''} ${picked ? 'target' : ''}`}
                    {...target(product.id, product.id)}
                  >
                    <span className="pt-name" role="cell">
                      <b>{product.name}</b>
                    </span>
                    <span className="rp-chips" role="cell">
                      {own.length ? (
                        own.map(chip)
                      ) : (
                        <span className="rp-drop">
                          {canEdit ? 'solte aqui um nome da IHM' : 'nenhum nome da IHM'}
                        </span>
                      )}
                    </span>
                    <span className="pt-num" role="cell" data-label="Sacos">
                      <b>{bags ? integer(bags) : '—'}</b>
                    </span>
                    <span className="pt-num" role="cell" data-label="Último saco">
                      {last ? day(last) : '—'}
                    </span>
                    <span className="pt-num" role="cell" data-label="Ritmo padrão">
                      {product.standard_rate ? `${integer(product.standard_rate)} sacos/h` : '—'}
                    </span>
                    <span className="rp-actions" role="cell">
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Editar ${product.name}`}
                            title="Editar"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDraft({
                                id: product.id,
                                name: product.name,
                                kg: String(product.nominal_kg).replace('.', ','),
                                rate:
                                  product.standard_rate == null
                                    ? ''
                                    : String(product.standard_rate).replace('.', ','),
                              });
                            }}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="icon-button danger"
                            aria-label={`Excluir ${product.name}`}
                            title="Excluir"
                            onClick={(event) => {
                              event.stopPropagation();
                              void remove(product, own.length);
                            }}
                          >
                            ×
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {!products.length && (
        <div className="stops-empty">Nenhum produto cadastrado. Comece pelo botão + Produto.</div>
      )}
    </div>
  );
}
