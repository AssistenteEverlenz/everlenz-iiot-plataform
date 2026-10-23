'use client';

import { useState } from 'react';
import { mutate, usePoll } from './data';
import { ModalPortal } from './ModalPortal';
import { useReconcile } from './MortarBridge';
import { integer } from './mortarShared';

/**
 * The bags whose recipe reached the spouts without a product, and what to do with each. The
 * platform knows what the mixer was making when they came out, so it says so and offers it as the
 * product to link; a recipe linked here counts in the tons from then on, on every card. A bag the
 * HMI sent with no recipe at all ("SEM RECEITA") cannot be linked -- the name would stand for
 * every bag without a recipe -- so it is explained instead.
 */

const NO_RECIPE = /^\s*(sem receita)?\s*$/i;
const day = (iso: string) => {
  const local = new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString();
  return `${local.slice(8, 10)}/${local.slice(5, 7)}`;
};

function UnlinkedModal({
  deviceId,
  from,
  to,
  canLink,
  onClose,
}: {
  deviceId: string;
  from: string;
  to: string;
  canLink: boolean;
  onClose: (changed: boolean) => void;
}) {
  const reconcile = useReconcile(deviceId, from, to);
  const catalog = usePoll<{ products: Array<{ id: string; name: string }> }>('/mortar/products', 600000);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState('');
  const products = catalog.data?.products ?? [];
  const idOf = (name: string | undefined) => products.find((item) => item.name === name)?.id ?? '';
  const rows = (reconcile.data?.unlinked ?? []).filter((row) => !done.includes(row.recipe));
  async function link(recipe: string, productId: string) {
    setError('');
    try {
      await mutate('/mortar/recipes', 'PUT', { recipe, productId });
      setDone((list) => [...list, recipe]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao vincular.');
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => onClose(done.length > 0)}>
      <div className="modal-card mortar-modal unlinked-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-title">
          <div>
            <div className="eyebrow">RECEITAS SEM PRODUTO</div>
            <h2>De onde vieram estes sacos</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={() => onClose(done.length > 0)}>
            ×
          </button>
        </header>
        <p className="unlinked-lead">
          Estes sacos chegaram dos bicos com uma receita que não está ligada a nenhum produto: são
          contados, mas ficam fora das toneladas. A plataforma olhou o que o misturador fazia na
          hora em que saíram; ligue a receita ao produto e ela passa a contar em todos os cards.
        </p>
        {!reconcile.data ? (
          <div className="stops-empty">Carregando…</div>
        ) : rows.length === 0 ? (
          <div className="stops-empty">
            {done.length ? 'Pronto: as receitas foram vinculadas.' : 'Nenhuma receita sem produto no período.'}
          </div>
        ) : (
          <ul className="unlinked-list">
            {rows.map((row) => {
              const blank = NO_RECIPE.test(row.recipe);
              const inferred = [...row.inferred].sort((a, b) => b.bags - a.bags);
              const selected = choice[row.recipe] ?? idOf(inferred[0]?.product);
              return (
                <li key={row.recipe}>
                  <div className="unlinked-name">
                    <b>{row.recipe || '(vazio)'}</b>
                    <span>
                      {integer(row.bagsInPeriod)} sacos · {day(row.first)}
                      {day(row.last) !== day(row.first) ? ` a ${day(row.last)}` : ''}
                    </span>
                  </div>
                  {inferred.length > 0 && (
                    <div className="unlinked-mixer">
                      <span>Pelo misturador, eram</span>
                      {inferred.map((item) => (
                        <em key={item.product}>
                          {item.product} <b>{integer(item.bags)}</b>
                        </em>
                      ))}
                    </div>
                  )}
                  {blank ? (
                    <p className="unlinked-note">
                      A IHM mandou esses sacos sem receita no bico. Não dá para vincular esse nome: ele
                      valeria para todo saco sem receita. Na conta do rendimento eles aparecem em{' '}
                      <b>Receitas sem produto</b>, com o que o misturador fazia.
                    </p>
                  ) : canLink ? (
                    <div className="unlinked-action">
                      <select
                        aria-label={`Produto da receita ${row.recipe}`}
                        value={selected}
                        onChange={(event) => setChoice((was) => ({ ...was, [row.recipe]: event.target.value }))}
                      >
                        <option value="">Escolha o produto</option>
                        {products.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!selected}
                        onClick={() => void link(row.recipe, selected)}
                      >
                        Vincular
                      </button>
                    </div>
                  ) : (
                    <p className="unlinked-note">Peça a um administrador para vincular esta receita.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
    </div>
  );
}

/** The notice on the cards, and the window it opens. */
export function UnlinkedNotice({
  bags,
  deviceId,
  from,
  to,
  canLink,
  onChanged,
}: {
  bags: number;
  deviceId: string;
  from: string;
  to: string;
  canLink: boolean;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!bags) return null;
  return (
    <>
      <div className="mortar-warning">
        <span>
          <b>{integer(bags)} sacos</b> de receitas sem produto: contados, mas fora das toneladas.
        </span>
        <button type="button" onClick={() => setOpen(true)}>
          Ver de onde vieram
        </button>
      </div>
      {open && (
        <ModalPortal>
          <UnlinkedModal
            deviceId={deviceId}
            from={from}
            to={to}
            canLink={canLink}
            onClose={(changed) => {
              setOpen(false);
              if (changed) onChanged?.();
            }}
          />
        </ModalPortal>
      )}
    </>
  );
}
