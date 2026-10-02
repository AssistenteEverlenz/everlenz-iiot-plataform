'use client';

import { useState } from 'react';
import { usePoll } from './data';
import { ModalPortal } from './ModalPortal';
import { clock, integer, kilos, percent, tons } from './mortarShared';

/**
 * Production lots (migration 040). A lot is one run of the mixer: a recipe and the batches the
 * operator asked for. It changes when the recipe changes or the batch counter is reset for a
 * new run, and its number is the date and time it started (261001-0715). The bags filled from
 * its first batch until the next lot began belong to it: that is what makes a bag traceable to
 * the mix it came from.
 */
export type Lot = {
  lot: string;
  recipe: string;
  batches: number;
  mixedKg: number;
  startedAt: string;
  lastBatchAt: string;
  baggedUntil: string;
  bags: number;
  baggedKg: number;
  products: Array<{ name: string; bags: number; kg: number | null }>;
};

const day = (iso: string) => {
  const local = new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString().slice(0, 10);
  return local.split('-').reverse().slice(0, 2).join('/');
};

export function useLots(deviceId: string, from: string, to: string) {
  return usePoll<{ lots: Lot[] }>(`/devices/${deviceId}/mortar/lots?from=${from}&to=${to}`, 120000);
}

/** The lots of the period, newest first; a row opens what the lot became. */
export function LotsTable({ lots, product }: { lots: Lot[]; product?: string }) {
  const [open, setOpen] = useState<Lot | null>(null);
  const shown = product
    ? lots.filter((lot) => lot.products.some((item) => item.name === product))
    : lots;
  if (!shown.length)
    return (
      <div className="stops-empty">
        Nenhum lote no período. O lote nasce quando a primeira batelada termina.
      </div>
    );
  return (
    <>
      <table className="stops-table mortar-table mortar-lots">
        <thead>
          <tr>
            <th>Lote</th>
            <th>Receita</th>
            <th className="n">Bateladas</th>
            <th className="n">Misturado</th>
            <th>Ensacado entre</th>
            <th className="n">{product ? `Sacos de ${product}` : 'Sacos'}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((lot) => (
            <tr key={lot.lot} onClick={() => setOpen(lot)}>
              <td>
                <b className="mortar-lot">{lot.lot}</b>
              </td>
              <td>{lot.recipe}</td>
              <td className="n">{integer(lot.batches)}</td>
              <td className="n">{tons(lot.mixedKg)} t</td>
              <td className="muted">
                {day(lot.startedAt)} {clock(lot.startedAt)} →{' '}
                {day(lot.baggedUntil) !== day(lot.startedAt) ? `${day(lot.baggedUntil)} ` : ''}
                {clock(lot.baggedUntil)}
              </td>
              <td className="n">
                {integer(
                  product
                    ? (lot.products.find((item) => item.name === product)?.bags ?? 0)
                    : lot.bags,
                )}
              </td>
            </tr>
          ))}
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
                    Receita {open.recipe} · começou {day(open.startedAt)} às {clock(open.startedAt)}
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
                  <em>{kilos(open.mixedKg / Math.max(1, open.batches))} por batelada</em>
                </div>
                <div className="mortar-figure">
                  <span>Ensacado</span>
                  <b>
                    {integer(open.bags)}
                    <small> sacos</small>
                  </b>
                  <em>{tons(open.baggedKg)} t</em>
                </div>
              </div>
              <p className="mortar-explain">
                Os sacos deste lote são os que saíram dos bicos de {day(open.startedAt)}{' '}
                {clock(open.startedAt)} até {clock(open.baggedUntil)}, quando o lote seguinte
                começou. O silo pulmão mistura um pouco o fim de um lote com o começo do outro; para
                uma reclamação, olhe também o lote vizinho.
              </p>
              <div className="stops-title">O que saiu deste lote</div>
              <table className="stops-table mortar-table">
                <tbody>
                  {open.products.map((item) => (
                    <tr key={item.name}>
                      <td>
                        <b>{item.name}</b>
                      </td>
                      <td className="n">{integer(item.bags)} sacos</td>
                      <td className="n">{tons(item.kg)} t</td>
                      <td className="n muted">
                        {percent(open.bags ? item.bags / open.bags : null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
