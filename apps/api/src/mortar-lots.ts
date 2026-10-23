/**
 * Which lot each bag came from.
 *
 * A lot is a run of batches of one recipe (the HMI's lot number). Between the mixer and the
 * spouts there is a buffer silo: the bags filled after a lot starts can still be the previous
 * batches, of this product or of the one before, and a lot's mass can still be bagging the next
 * morning. Cutting the bags by time ("from this lot's start to the next one's") gave a lot of one
 * 1,760 kg batch 220 bags of 20 kg, and lots of two products (Bella Massa, October 2026).
 *
 * So the bags go through the silo in order, mix by mix, in kilos. A mix is what the mixer makes:
 * the same mass can leave in bags of 20 and of 5 kg ("AC3 Bella Massa 20kg" and "... 5kg"), so a
 * bag is matched to the mix of its product, and it takes its own weight out of the lot.
 * Consecutive lots of one mix are a campaign (another mix in between ends it: the silo empties on
 * the change). A bag comes from the latest campaign of its mix, and only while that campaign can
 * still be in the silo -- the latest campaign of all, or the one just before it (the tail of a
 * change): a bag named after a mix last made days ago did not come from it (a wrong name on the
 * spout, or data the HMI stamped late). Inside the campaign a bag belongs to the oldest lot that
 * still has mass for it; the newest lot takes whatever is beyond, so a difference shows on the
 * lot where it happened. Bags no campaign can explain belong to no lot.
 */

export interface LotInput {
  lot: string;
  product: string | null;
  /** The mix the lot is (mixOf of its product); its product when not given. */
  mix?: string | null;
  nominalKg: number | null;
  mixedKg: number;
  startedAt: number;
}
export interface BagInput {
  /** Start of the 5-minute bucket. */
  at: number;
  product: string | null;
  mix?: string | null;
  /** The bag's own weight; the lot's product weight when not given. */
  kgPerBag?: number | null;
  bags: number;
}
export interface LotAllocation {
  bags: number;
  /** The mass those bags carried, each at its own weight. */
  kg: number;
  /** The bags the lot's mass makes at the product's bag weight. */
  expectedBags: number | null;
  firstBagAt: number | null;
  lastBagAt: number | null;
}

const STEP_MS = 5 * 60_000;

/** The mix a product is: its name without the bag size ("AC3 Bella Massa 5kg" -> "AC3 Bella Massa"). */
export function mixOf(product: string | null | undefined) {
  if (!product) return null;
  return product.replace(/\s*\d+(?:[.,]\d+)?\s*kg\s*$/i, '').trim() || product;
}

export function allocateBags(lots: LotInput[], bags: BagInput[]) {
  const ordered = [...lots].sort((a, b) => a.startedAt - b.startedAt);
  const keyOf = (lot: LotInput) => lot.mix ?? lot.product;
  const campaign = new Map<string, number>();
  ordered.forEach((lot, index) => {
    const previous = ordered[index - 1];
    campaign.set(
      lot.lot,
      previous && keyOf(previous) === keyOf(lot) ? campaign.get(previous.lot)! : index,
    );
  });
  const result = new Map<string, LotAllocation>(
    ordered.map((lot) => [
      lot.lot,
      {
        bags: 0,
        kg: 0,
        expectedBags: lot.nominalKg ? lot.mixedKg / lot.nominalKg : null,
        firstBagAt: null,
        lastBagAt: null,
      },
    ]),
  );
  let unassigned = 0;
  /** Every share of a bucket, by lot (null: no lot), so a period can tell when each bag left. */
  const pieces: Array<{ lot: string | null; at: number; bags: number; kg: number; product: string | null }> = [];
  for (const row of [...bags].sort((a, b) => a.at - b.at)) {
    if (row.bags <= 0) continue;
    const key = row.mix ?? row.product;
    const before = ordered.filter((lot) => lot.startedAt < row.at + STEP_MS);
    // The campaigns that can still be in the silo: the latest one, and the one before it.
    const recent = [...new Set(before.map((lot) => campaign.get(lot.lot)!))].slice(-2);
    const mine = before.filter((lot) => key != null && keyOf(lot) === key);
    const current = mine.length ? campaign.get(mine.at(-1)!.lot)! : undefined;
    const eligible =
      current != null && recent.includes(current)
        ? mine.filter((lot) => campaign.get(lot.lot) === current)
        : [];
    const weight = (lot: LotInput) => row.kgPerBag ?? lot.nominalKg ?? 0;
    if (!eligible.length) {
      unassigned += row.bags;
      pieces.push({ lot: null, at: row.at, bags: row.bags, kg: row.bags * (row.kgPerBag ?? 0), product: row.product });
      continue;
    }
    let left = row.bags;
    for (const [index, lot] of eligible.entries()) {
      if (left <= 1e-9) break;
      const entry = result.get(lot.lot)!;
      const last = index === eligible.length - 1;
      const kgPerBag = weight(lot);
      const room = kgPerBag > 0 ? (lot.mixedKg - entry.kg) / kgPerBag : Number.POSITIVE_INFINITY;
      const amount = last ? left : Math.max(0, Math.min(left, room));
      if (amount > 0) {
        entry.bags += amount;
        entry.kg += amount * kgPerBag;
        entry.firstBagAt ??= row.at;
        entry.lastBagAt = row.at + STEP_MS;
        pieces.push({ lot: lot.lot, at: row.at, bags: amount, kg: amount * kgPerBag, product: row.product });
      }
      left -= amount;
    }
  }
  return { lots: result, unassigned, pieces, campaign };
}
