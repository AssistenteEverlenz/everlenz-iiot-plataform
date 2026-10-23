/**
 * Which lot each bag came from.
 *
 * A lot is a run of batches of one recipe (the HMI's lot number). Between the mixer and the
 * spouts there is a buffer silo: the bags filled after a lot starts can still be the previous
 * batches, of this product or of the one before, and a lot's mass can still be bagging the next
 * morning. Cutting the bags by time ("from this lot's start to the next one's") gave a lot of one
 * 1,760 kg batch 220 bags of 20 kg, and lots of two products (Bella Massa, October 2026).
 *
 * So the bags go through the silo in order, product by product. Consecutive lots of one product
 * are a campaign (another product in between ends it: the silo empties on the change), and a bag
 * comes from the latest campaign of its product started before it -- a lot of an old campaign
 * that missed its bags (stamped late by an HMI that was offline) does not take them days later.
 * Inside the campaign, a bag belongs to the oldest lot that still has mass for it (its mixed kg over the
 * product's bag weight). The newest lot of the product so far takes whatever is beyond that, so
 * a difference between mixed and bagged shows on the lot where it happened instead of moving
 * bags into a lot that had not been mixed yet. Bags of a product no lot made in the window, or
 * of a recipe with no product, belong to no lot.
 */

export interface LotInput {
  lot: string;
  product: string | null;
  nominalKg: number | null;
  mixedKg: number;
  startedAt: number;
}
export interface BagInput {
  /** Start of the 5-minute bucket. */
  at: number;
  product: string | null;
  bags: number;
}
export interface LotAllocation {
  bags: number;
  /** The bags the lot's mass makes at the product's bag weight. */
  expectedBags: number | null;
  firstBagAt: number | null;
  lastBagAt: number | null;
}

const STEP_MS = 5 * 60_000;

export function allocateBags(lots: LotInput[], bags: BagInput[]) {
  const ordered = [...lots].sort((a, b) => a.startedAt - b.startedAt);
  const campaign = new Map<string, number>();
  ordered.forEach((lot, index) => {
    const previous = ordered[index - 1];
    campaign.set(
      lot.lot,
      previous && previous.product === lot.product ? campaign.get(previous.lot)! : index,
    );
  });
  const result = new Map<string, LotAllocation>(
    ordered.map((lot) => [
      lot.lot,
      {
        bags: 0,
        expectedBags: lot.nominalKg ? lot.mixedKg / lot.nominalKg : null,
        firstBagAt: null,
        lastBagAt: null,
      },
    ]),
  );
  let unassigned = 0;
  const take = (lot: LotInput, at: number, amount: number) => {
    const entry = result.get(lot.lot)!;
    entry.bags += amount;
    entry.firstBagAt ??= at;
    entry.lastBagAt = at + STEP_MS;
  };
  for (const row of [...bags].sort((a, b) => a.at - b.at)) {
    if (row.bags <= 0) continue;
    // The latest campaign of this product started when the bucket ends, its lots oldest first.
    const started = ordered.filter(
      (lot) => row.product != null && lot.product === row.product && lot.startedAt < row.at + STEP_MS,
    );
    const current = started.length ? campaign.get(started.at(-1)!.lot) : undefined;
    const eligible = started.filter((lot) => campaign.get(lot.lot) === current);
    if (!eligible.length) {
      unassigned += row.bags;
      continue;
    }
    let left = row.bags;
    for (const [index, lot] of eligible.entries()) {
      if (left <= 0) break;
      const entry = result.get(lot.lot)!;
      const last = index === eligible.length - 1;
      const room = entry.expectedBags == null ? Number.POSITIVE_INFINITY : entry.expectedBags - entry.bags;
      const amount = last ? left : Math.max(0, Math.min(left, room));
      if (amount > 0) take(lot, row.at, amount);
      left -= amount;
    }
  }
  return { lots: result, unassigned };
}
