'use client';

import { useState } from 'react';
import { usePoll } from './data';
import { ModalPortal } from './ModalPortal';
import { CampaignBridge, type CampaignData } from './MortarBridge';
import { clock, integer, kilos, tons } from './mortarShared';

/**
 * Production lots (migration 040). A lot is one run of the mixer: a recipe and the batches the
 * operator asked for, numbered by the date and time it started (261001-0715). Its bags are the
 * ones that went through the buffer silo from it, product by product (apps/api/src/mortar-lots.ts):
 * a lot holds one product, as many bags as its mass makes, and the difference shows on the lot
 * where it happened.
 */
export type Lot = {
  lot: string;
  recipe: string;
  /** The product the recipe makes; null while the recipe is not linked to one. */
  product?: string | null;
  batches: number;
  mixedKg: number;
  /** What the recipe asked for, against the scale's mixedKg. */
  recipeKg?: number;
  startedAt: string;
  lastBatchAt: string;
  /** First and last bag of the lot; null while none came out yet. */
  baggedFrom?: string | null;
  baggedUntil: string;
  bags: number;
  /** The bags the mixed mass makes at the product's bag weight. */
  expectedBags?: number | null;
  baggedKg: number;
  products: Array<{ name: string; bags: number; kg: number | null }>;
  /** The run of lots of the mix this lot belongs to, and why its mixed and bagged differ. */
  campaign?: CampaignData | null;
};

const day = (iso: string) => {
  const local = new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString().slice(0, 10);
  return local.split('-').reverse().slice(0, 2).join('/');
};
/** "22/10 15:50 → 23/10 06:30", the day said again only when it changes. */
const between = (from: string, to: string) =>
  `${day(from)} ${clock(from)} → ${day(to) !== day(from) ? `${day(to)} ` : ''}${clock(to)}`;
/** Bags over (+) or under (−) what the mass makes; small differences are the bag weight. */
function differenceOf(lot: Lot) {
  if (lot.expectedBags == null || lot.bags <= 0) return null;
  const bags = Math.round(lot.bags - lot.expectedBags);
  const share = lot.expectedBags > 0 ? Math.abs(bags) / lot.expectedBags : 0;
  return { bags, tone: share <= 0.05 ? 'even' : bags > 0 ? 'over' : 'under' };
}
const signed = (value: number) => (value > 0 ? `+${integer(value)}` : value < 0 ? `−${integer(-value)}` : '0');

export function useLots(deviceId: string, from: string, to: string) {
  return usePoll<{ lots: Lot[] }>(`/devices/${deviceId}/mortar/lots?from=${from}&to=${to}`, 120000);
}

/** The lots of the period, newest first; a row opens what the lot became. */
export function LotsTable({ lots, product }: { lots: Lot[]; product?: string }) {
  const [open, setOpen] = useState<Lot | null>(null);
  const shown = product
    ? lots.filter((lot) => (lot.product ?? lot.products[0]?.name) === product)
    : lots;
  if (!shown.length)
    return (
      <div className="stops-empty">
        Nenhum lote no período. O lote nasce quando a primeira batelada termina.
      </div>
    );
  const openDifference = open ? differenceOf(open) : null;
  const openNominal =
    open && open.expectedBags ? open.mixedKg / open.expectedBags : null;
  return (
    <>
      <table className="stops-table mortar-table mortar-lots">
        <thead>
          <tr>
            <th>Lote</th>
            <th>Produto</th>
            <th className="n">Bateladas</th>
            <th className="n">Misturado</th>
            <th>Ensacado entre</th>
            <th className="n">Sacos</th>
            <th className="n">Esperado</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((lot) => {
            const difference = differenceOf(lot);
            return (
              <tr key={lot.lot} onClick={() => setOpen(lot)}>
                <td>
                  <b className="mortar-lot">{lot.lot}</b>
                </td>
                <td>{lot.product ?? lot.recipe}</td>
                <td className="n">{integer(lot.batches)}</td>
                <td className="n">{tons(lot.mixedKg)} t</td>
                <td className="muted">
                  {lot.baggedFrom
                    ? between(lot.baggedFrom, lot.baggedUntil)
                    : lot.product
                      ? 'no silo'
                      : 'receita sem produto'}
                </td>
                <td className="n">
                  {integer(lot.bags)}
                  {difference && difference.tone !== 'even' && (
                    <em className={`mortar-lot-diff ${difference.tone}`}> {signed(difference.bags)}</em>
                  )}
                </td>
                <td className="n muted">
                  {lot.expectedBags == null ? '—' : integer(lot.expectedBags)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {open && (
        <ModalPortal>
          <div className="modal-backdrop" onClick={() => setOpen(null)}>
            <div className="modal-card mortar-modal" onClick={(event) => event.stopPropagation()}>
              <header className="modal-title">
                <div>
                  <h2>Lote {open.lot}</h2>
                  <small>
                    {open.product ?? open.recipe} · receita {open.recipe} · começou{' '}
                    {day(open.startedAt)} às {clock(open.startedAt)}
                  </small>
                </div>
                <button onClick={() => setOpen(null)} aria-label="Fechar">
                  Fechar
                </button>
              </header>
              <div className="mortar-figures">
                <div className="mortar-figure">
                  <span>Bateladas</span>
                  <b>{integer(open.batches)}</b>
                  <em>última às {clock(open.lastBatchAt)}</em>
                </div>
                <div className="mortar-figure">
                  <span>Misturado</span>
                  <b>
                    {tons(open.mixedKg)}
                    <small> t</small>
                  </b>
                  <em>
                    {open.expectedBags == null
                      ? `${kilos(open.mixedKg / Math.max(1, open.batches))} por batelada`
                      : `dá ${integer(open.expectedBags)} sacos de ${kilos(openNominal)}`}
                  </em>
                </div>
                <div className="mortar-figure">
                  <span>Ensacado</span>
                  <b>
                    {integer(open.bags)}
                    <small> sacos</small>
                  </b>
                  <em>{tons(open.baggedKg)} t</em>
                </div>
                <div className="mortar-figure">
                  <span>Diferença</span>
                  <b className={openDifference ? `mortar-lot-diff ${openDifference.tone}` : ''}>
                    {openDifference ? signed(openDifference.bags) : '—'}
                    <small> sacos</small>
                  </b>
                  <em>
                    {openDifference && openNominal
                      ? `${openDifference.bags > 0 ? '+' : openDifference.bags < 0 ? '−' : ''}${kilos(Math.abs(openDifference.bags) * openNominal)}`
                      : 'ensacado − esperado'}
                  </em>
                </div>
              </div>
              <p className="mortar-explain">
                {open.baggedFrom
                  ? `Ensacado de ${between(open.baggedFrom, open.baggedUntil)}, na ordem em que saiu do silo.`
                  : open.product
                    ? 'Nenhum saco deste lote saiu ainda: a massa está no silo.'
                    : `A receita ${open.recipe} não está ligada a um produto, então não dá para saber quais sacos saíram dela: ligue-a em Produtos e receitas.`}
              </p>
              {open.campaign && <CampaignBridge campaign={open.campaign} />}
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
