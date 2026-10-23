import { allocateBags, mixOf } from './mortar-lots.js';

/**
 * Why mixed and bagged differ, and where.
 *
 * Every number of a mortar plant comes from two counters that never meet: the scale weighs what
 * the mixer makes, the spouts count the bags. Between them the buffer silo holds mass for hours,
 * the spouts carry a recipe name the operator sets by hand, and the HMI can go offline and send a
 * morning at once. A bare "difference: 2.1 t" leaves the plant to dig. This follows every bag back
 * to the batches it came from (mortar-lots.ts) and says why each kilo of difference exists, with
 * its date. A campaign -- consecutive lots of one mix -- is where mixed and bagged must meet; its
 * difference is, in this order:
 *
 *  - offline: batches seconds apart, which no mixer makes -- the HMI sent them late, together,
 *    and the difference is the timing, not the plant;
 *  - silo: the campaign still bagging has its shortfall in the silo;
 *  - notBagged: no bag at all came out with the campaign's name -- the spouts carried another;
 *  - changeover: a campaign short followed by one over (or the reverse) -- the spouts took the
 *    new name while the silo still gave the old mix, or kept the old name too long;
 *  - wrongName: far more bags than the mass makes (under 75 % of the bag weight each): the bags
 *    were not this mix;
 *  - bagWeight: the rest, said as the real mean weight of a bag (16.8 kg for a 20 kg bag), with
 *    up to 4 % heavier as normal filling;
 *  - loss: mass beyond that which never became a bag.
 *
 * For a period, the bridge from mixed to bagged closes exactly: the silo carried in from before
 * and out after, the causes of the campaigns mixed in the period, the bags no batch explains, and
 * the bags whose recipe has no product (outside the tons).
 */

export interface BatchRow {
  lot: string;
  at: number;
  recipe: string;
  product: string | null;
  nominalKg: number | null;
  /** The scale's mass when weighed, else the recipe's. */
  kg: number;
  recipeKg: number;
  batches: number;
}
export interface BagRow {
  at: number;
  recipe: string;
  /** The product the recipe is linked to; null when it is not. */
  product: string | null;
  nominalKg: number | null;
  bags: number;
}
export type CauseKind =
  | 'offline'
  | 'silo'
  | 'notBagged'
  | 'changeover'
  | 'wrongName'
  | 'bagWeight'
  | 'loss'
  | 'noProduct';
export interface Cause {
  kind: CauseKind;
  kg: number;
  /** changeover: the mix on the other side of the change. */
  partner?: string;
  /** bagWeight: the mean real weight of a bag, and the weight it should have. */
  realBagKg?: number;
  nominalKg?: number;
}
export interface Campaign {
  id: string;
  /** The mix ("AC3 Bella Massa"), and the products its bags were. */
  mix: string | null;
  products: string[];
  nominalKg: number | null;
  lots: string[];
  batches: number;
  mixedKg: number;
  recipeKg: number;
  bags: number;
  baggedKg: number;
  startedAt: number;
  lastBatchAt: number;
  firstBagAt: number | null;
  lastBagAt: number | null;
  offline: boolean;
  open: boolean;
  causes: Cause[];
}
export type BridgeKind = 'carryIn' | 'carryOut' | CauseKind | 'unassigned' | 'unlinked';
export interface BridgeSource {
  campaign?: string;
  label: string | null;
  at: number;
  kg: number;
  note?: string;
}
export interface BridgeItem {
  kind: BridgeKind;
  kg: number;
  /** Where it came from: the campaigns (or recipes) that make it up, largest first. */
  sources: BridgeSource[];
}

const STEP_MS = 5 * 60_000;
/** Two batches closer than this cannot both be real: the HMI sent them late, together. */
const BURST_MS = 90_000;
/** A bag may come out this much heavier than its nominal weight before the rest is loss. */
const FILL_SHARE = 0.04;
/** Lighter than this share of their weight, the bags were not this mix. */
const WRONG_SHARE = 0.75;
/** Under this share of the mass, a campaign closed: it pairs with no change of product. */
const CLOSED_SHARE = 0.005;

export function reconcile(input: {
  batches: BatchRow[];
  bags: BagRow[];
  period: { start: number; end: number };
}) {
  const { start, end } = input.period;
  const inPeriod = (at: number) => at >= start && at < end;

  // ---- Lots, from the batches ----
  type Lot = {
    lot: string;
    product: string | null;
    mix: string | null;
    nominalKg: number | null;
    mixedKg: number;
    recipeKg: number;
    batches: number;
    startedAt: number;
    lastAt: number;
    /** The mass of its batches weighed in the period. */
    inPeriodKg: number;
  };
  const lotMap = new Map<string, Lot>();
  const batches = [...input.batches].sort((a, b) => a.at - b.at);
  const burst = new Set<string>();
  batches.forEach((batch, index) => {
    const lot = lotMap.get(batch.lot) ?? {
      lot: batch.lot,
      product: batch.product,
      mix: mixOf(batch.product),
      nominalKg: batch.nominalKg,
      mixedKg: 0,
      recipeKg: 0,
      batches: 0,
      startedAt: batch.at,
      lastAt: batch.at,
      inPeriodKg: 0,
    };
    lot.mixedKg += batch.kg;
    lot.recipeKg += batch.recipeKg;
    lot.batches += batch.batches;
    lot.lastAt = batch.at;
    if (inPeriod(batch.at)) lot.inPeriodKg += batch.kg;
    lotMap.set(batch.lot, lot);
    const previous = batches[index - 1];
    if (previous && batch.at - previous.at < BURST_MS) {
      burst.add(batch.lot);
      burst.add(previous.lot);
    }
  });
  const lots = [...lotMap.values()].sort((a, b) => a.startedAt - b.startedAt);

  // ---- Bags with no product: the mixer says what they were ----
  const mixerAt = (at: number) =>
    [...lots].reverse().find((lot) => lot.startedAt < at + STEP_MS && lot.product != null);
  const unlinked = new Map<
    string,
    { recipe: string; bags: number; bagsInPeriod: number; kgInPeriod: number; inferred: Map<string, number>; first: number; last: number }
  >();
  const bagRows = input.bags.map((row) => {
    if (row.product) return { ...row, mix: mixOf(row.product), linked: true };
    const lot = mixerAt(row.at);
    const entry = unlinked.get(row.recipe) ?? {
      recipe: row.recipe,
      bags: 0,
      bagsInPeriod: 0,
      kgInPeriod: 0,
      inferred: new Map<string, number>(),
      first: row.at,
      last: row.at,
    };
    entry.bags += row.bags;
    if (inPeriod(row.at)) {
      entry.bagsInPeriod += row.bags;
      entry.kgInPeriod += row.bags * (lot?.nominalKg ?? 0);
    }
    entry.first = Math.min(entry.first, row.at);
    entry.last = Math.max(entry.last, row.at);
    if (lot?.product) entry.inferred.set(lot.product, (entry.inferred.get(lot.product) ?? 0) + row.bags);
    unlinked.set(row.recipe, entry);
    return {
      ...row,
      product: lot?.product ?? null,
      mix: lot?.mix ?? null,
      nominalKg: lot?.nominalKg ?? null,
      linked: false,
    };
  });

  // ---- Through the silo ----
  const { lots: allocated, pieces, campaign: campaignOf } = allocateBags(
    lots.map((lot) => ({
      lot: lot.lot,
      product: lot.product,
      mix: lot.mix,
      nominalKg: lot.nominalKg,
      mixedKg: lot.mixedKg,
      startedAt: lot.startedAt,
    })),
    bagRows.map((row) => ({
      at: row.at,
      product: row.product,
      mix: row.mix,
      kgPerBag: row.nominalKg,
      bags: row.bags,
    })),
  );

  // ---- Campaigns ----
  const campaigns: Campaign[] = [];
  const lotCampaign = new Map<string, Campaign>();
  for (const lot of lots) {
    const key = String(campaignOf.get(lot.lot));
    let current = campaigns.at(-1);
    if (!current || current.id !== key) {
      current = {
        id: key,
        mix: lot.mix,
        products: [],
        nominalKg: lot.nominalKg,
        lots: [],
        batches: 0,
        mixedKg: 0,
        recipeKg: 0,
        bags: 0,
        baggedKg: 0,
        startedAt: lot.startedAt,
        lastBatchAt: lot.lastAt,
        firstBagAt: null,
        lastBagAt: null,
        offline: false,
        open: false,
        causes: [],
      };
      campaigns.push(current);
    }
    const share = allocated.get(lot.lot)!;
    current.lots.push(lot.lot);
    current.batches += lot.batches;
    current.mixedKg += lot.mixedKg;
    current.recipeKg += lot.recipeKg;
    current.bags += share.bags;
    current.baggedKg += share.kg;
    current.lastBatchAt = lot.lastAt;
    if (share.firstBagAt) current.firstBagAt = Math.min(current.firstBagAt ?? share.firstBagAt, share.firstBagAt);
    if (share.lastBagAt) current.lastBagAt = Math.max(current.lastBagAt ?? 0, share.lastBagAt);
    if (burst.has(lot.lot)) current.offline = true;
    lotCampaign.set(lot.lot, current);
  }
  for (const piece of pieces)
    if (piece.lot && piece.product) {
      const owner = lotCampaign.get(piece.lot)!;
      if (!owner.products.includes(piece.product)) owner.products.push(piece.product);
    }
  if (campaigns.length) campaigns[campaigns.length - 1].open = true;
  // A campaign started within three hours after a burst had its bags stamped with the burst.
  const bursts = batches.filter((batch) => burst.has(batch.lot)).map((batch) => batch.at);
  for (const item of campaigns)
    if (bursts.some((at) => item.startedAt >= at && item.startedAt - at < 3 * 3600_000)) item.offline = true;

  // ---- Causes, campaign by campaign ----
  const left = new Map<string, number>();
  for (const item of campaigns) {
    left.set(item.id, 0);
    // A mixer recipe with no product: its mass cannot be followed into bags.
    if (!item.nominalKg) {
      item.causes.push({ kind: 'noProduct', kg: -item.mixedKg });
      continue;
    }
    const residual = item.baggedKg - item.mixedKg;
    if (!residual) continue;
    if (item.offline) item.causes.push({ kind: 'offline', kg: residual });
    else if (item.open && residual < 0) item.causes.push({ kind: 'silo', kg: residual });
    else if (item.bags === 0) item.causes.push({ kind: 'notBagged', kg: residual });
    else left.set(item.id, residual);
  }
  // A change of mix: one side short, the next over.
  const small = (value: number, owner: Campaign) => Math.abs(value) <= owner.mixedKg * CLOSED_SHARE;
  for (let index = 0; index + 1 < campaigns.length; index += 1) {
    const a = campaigns[index];
    const b = campaigns[index + 1];
    const ra = left.get(a.id) ?? 0;
    const rb = left.get(b.id) ?? 0;
    if (small(ra, a) || small(rb, b) || Math.sign(ra) === Math.sign(rb)) continue;
    const moved = Math.min(Math.abs(ra), Math.abs(rb));
    a.causes.push({ kind: 'changeover', kg: Math.sign(ra) * moved, partner: b.mix ?? undefined });
    b.causes.push({ kind: 'changeover', kg: Math.sign(rb) * moved, partner: a.mix ?? undefined });
    left.set(a.id, ra - Math.sign(ra) * moved);
    left.set(b.id, rb - Math.sign(rb) * moved);
  }
  for (const item of campaigns) {
    const rest = left.get(item.id) ?? 0;
    if (!rest || !item.nominalKg) continue;
    // The bag as it really came out: the mass over the bags, against the weight it should have.
    const nominalKg = item.nominalKg;
    // (after a change of mix took its share: the mass left over its own bags).
    const realBagKg = item.mixedKg + rest > 0 ? (nominalKg * item.mixedKg) / (item.mixedKg + rest) : undefined;
    if (rest > 0) {
      const tooLight = realBagKg != null && realBagKg < nominalKg * WRONG_SHARE;
      item.causes.push({ kind: tooLight ? 'wrongName' : 'bagWeight', kg: rest, realBagKg, nominalKg });
    } else {
      // Bags filled heavy explain up to 4 % of their weight; the rest never became a bag.
      const fill = Math.max(rest, -item.baggedKg * FILL_SHARE);
      if (fill < 0) item.causes.push({ kind: 'bagWeight', kg: fill, realBagKg, nominalKg });
      if (rest - fill < 0) item.causes.push({ kind: 'loss', kg: rest - fill });
    }
  }

  // ---- The period's bridge ----
  const items = new Map<BridgeKind, BridgeItem>();
  const add = (kind: BridgeKind, kg: number, source: BridgeSource) => {
    if (!kg) return;
    const item = items.get(kind) ?? { kind, kg: 0, sources: [] };
    item.kg += kg;
    const same = item.sources.find(
      (entry) => entry.campaign === source.campaign && entry.label === source.label && entry.note === source.note,
    );
    if (same) same.kg += kg;
    else item.sources.push({ ...source });
    items.set(kind, item);
  };
  const sourceOf = (owner: Campaign | undefined, kg: number, note?: string): BridgeSource => ({
    campaign: owner?.id,
    label: owner?.mix ?? null,
    at: owner?.startedAt ?? start,
    kg,
    note,
  });
  // The mass of each campaign in the period, against the mass whose bags are in the period.
  // Bags no batch explains: near a burst they are the HMI's late data; before the first batch
  // ever recorded they are the silo from before the monitoring; else a name on the spout that
  // the mixer did not make then (or a batch its counter missed).
  const burstTimes = bursts;
  const firstBatch = batches[0]?.at ?? Number.POSITIVE_INFINITY;
  const dayOf = (at: number) => new Date(at - 3 * 3600_000).toISOString().slice(0, 10);
  for (const piece of pieces) {
    if (piece.lot == null) {
      if (!inPeriod(piece.at) || !piece.product) continue;
      const source = { label: piece.product, at: piece.at, kg: piece.kg, note: dayOf(piece.at) };
      if (burstTimes.some((at) => Math.abs(at - piece.at) < 3 * 3600_000)) add('offline', piece.kg, source);
      else if (piece.at < firstBatch) add('carryIn', piece.kg, { ...source, note: 'before' });
      else add('unassigned', piece.kg, source);
      continue;
    }
    const lot = lotMap.get(piece.lot)!;
    const owner = lotCampaign.get(piece.lot);
    // The share of the lot's mass weighed in the period: the bag counts against it.
    const share = lot.mixedKg ? lot.inPeriodKg / lot.mixedKg : 0;
    if (inPeriod(piece.at)) add('carryIn', piece.kg * (1 - share), sourceOf(owner, piece.kg * (1 - share)));
    else if (piece.at >= end) add('carryOut', -piece.kg * share, sourceOf(owner, -piece.kg * share));
  }
  // The causes of the campaigns weighed in the period, in the share of their mass in it.
  for (const item of campaigns) {
    const inside = item.lots.reduce((sum, lot) => sum + lotMap.get(lot)!.inPeriodKg, 0);
    if (!inside || !item.mixedKg) continue;
    const share = inside / item.mixedKg;
    for (const cause of item.causes)
      add(
        cause.kind,
        cause.kg * share,
        sourceOf(
          item,
          cause.kg * share,
          cause.partner ?? (cause.realBagKg ? `${cause.realBagKg.toFixed(1)}|${cause.nominalKg}` : undefined),
        ),
      );
  }
  for (const entry of unlinked.values())
    if (entry.kgInPeriod)
      add('unlinked', -entry.kgInPeriod, { label: entry.recipe, at: entry.first, kg: -entry.kgInPeriod });

  const mixedKg = batches.filter((batch) => inPeriod(batch.at)).reduce((sum, batch) => sum + batch.kg, 0);
  const baggedKg = bagRows
    .filter((row) => row.linked && inPeriod(row.at))
    .reduce((sum, row) => sum + row.bags * (row.nominalKg ?? 0), 0);
  for (const item of items.values()) item.sources.sort((a, b) => Math.abs(b.kg) - Math.abs(a.kg));

  return {
    mixedKg,
    baggedKg,
    // A change of mix that evens out in the period still explains its campaigns: it stays.
    bridge: [...items.values()].filter(
      (item) => Math.abs(item.kg) >= 0.5 || (item.kind === 'changeover' && item.sources.length > 0),
    ),
    /** What the bridge leaves unexplained: zero but for rounding. */
    gapKg: baggedKg - mixedKg - [...items.values()].reduce((sum, item) => sum + item.kg, 0),
    campaigns,
    lotCampaign: new Map([...lotCampaign.entries()].map(([lot, item]) => [lot, item.id])),
    allocated,
    unlinked: [...unlinked.values()].map((entry) => ({
      recipe: entry.recipe,
      bags: entry.bags,
      bagsInPeriod: entry.bagsInPeriod,
      inferred: [...entry.inferred.entries()].map(([product, bags]) => ({ product, bags })),
      first: entry.first,
      last: entry.last,
    })),
  };
}
