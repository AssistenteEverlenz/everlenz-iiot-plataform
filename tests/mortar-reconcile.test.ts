import { describe, expect, it } from 'vitest';
import { reconcile, type BagRow, type BatchRow } from '../apps/api/src/mortar-reconcile.js';
import { mixOf } from '../apps/api/src/mortar-lots.js';

const MIN = 60_000;
const t0 = Date.UTC(2026, 9, 21, 10, 0); // 07:00 at the plant
const at = (minutes: number) => t0 + minutes * MIN;
const period = { start: t0 - 4 * 60 * MIN, end: t0 + 20 * 60 * MIN };
const P = { fix: 'AC3 Bella Fix 20kg', branca: 'AC3 Bella Massa Branca 20kg', bm20: 'AC3 Bella Massa 20kg', bm5: 'AC3 Bella Massa 5kg', reboco: 'Reboco 20kg' };

function batch(lot: string, minute: number, product: string | null, kg = 2200, nominalKg = 20): BatchRow {
  return { lot, at: at(minute), recipe: product ?? 'X', product, nominalKg: product ? nominalKg : null, kg, recipeKg: kg, batches: 1 };
}
/** Bags of one product, a 5-minute bucket at a time. */
function bags(product: string | null, from: number, to: number, perBucket: number, nominalKg = 20, recipe?: string): BagRow[] {
  return Array.from({ length: (to - from) / 5 }, (_, index) => ({
    at: at(from + index * 5),
    recipe: recipe ?? product ?? 'SEM RECEITA',
    product,
    nominalKg: product ? nominalKg : null,
    bags: perBucket,
  }));
}
const kinds = (result: ReturnType<typeof reconcile>) =>
  Object.fromEntries(result.bridge.map((item) => [item.kind, Math.round(item.kg)]));

describe('why mixed and bagged differ', () => {
  it('closes the bridge exactly, whatever happened', () => {
    const result = reconcile({
      batches: [batch('a', 0, P.fix), batch('a', 15, P.fix), batch('b', 60, P.branca, 1800), batch('c', 120, P.reboco)],
      bags: [...bags(P.fix, 5, 60, 20), ...bags(P.branca, 65, 110, 12), ...bags(P.reboco, 125, 160, 15), ...bags(null, 160, 170, 5)],
      period,
    });
    expect(Math.abs(result.gapKg)).toBeLessThan(0.01);
    const sum = result.bridge.reduce((total, item) => total + item.kg, 0);
    expect(sum).toBeCloseTo(result.baggedKg - result.mixedKg, 1);
  });

  it('says a product bagged light, with the real weight of the bag', () => {
    // 1,800 kg made 108 bags "of 20 kg": 16.7 kg each.
    const result = reconcile({
      batches: [batch('a', 0, P.fix), batch('b', 30, P.branca, 1800), batch('c', 90, P.reboco)],
      bags: [...bags(P.fix, 5, 30, 22), ...bags(P.branca, 35, 80, 12), ...bags(P.reboco, 95, 130, 16)],
      period,
    });
    const branca = result.campaigns.find((item) => item.mix === mixOf(P.branca))!;
    const weight = branca.causes.find((cause) => cause.kind === 'bagWeight')!;
    expect(weight.kg).toBeGreaterThan(0);
    expect(weight.realBagKg).toBeCloseTo(16.7, 1);
  });

  it('pairs a product short with the next one over: the spouts changed name early', () => {
    // 2,200 kg of Fix made 100 bags; Branca's 1,800 kg made 100: ten Fix bags were named Branca.
    const result = reconcile({
      batches: [batch('a', 0, P.fix), batch('b', 60, P.branca, 1800), batch('c', 140, P.reboco)],
      bags: [...bags(P.fix, 5, 55, 10), ...bags(P.branca, 60, 110, 10), ...bags(P.reboco, 145, 200, 10)],
      period,
    });
    const fix = result.campaigns.find((item) => item.mix === mixOf(P.fix))!;
    const branca = result.campaigns.find((item) => item.mix === mixOf(P.branca))!;
    expect(fix.causes.find((cause) => cause.kind === 'changeover')?.kg).toBeCloseTo(-200, 0);
    expect(branca.causes.find((cause) => cause.kind === 'changeover')?.kg).toBeCloseTo(200, 0);
  });

  it('takes the bags of 5 kg out of the same mix as the bags of 20', () => {
    const result = reconcile({
      batches: [batch('a', 0, P.bm20), batch('b', 120, P.reboco)],
      // 100 bags of 20 kg and 40 of 5 kg: the 2,200 kg exactly.
      bags: [...bags(P.bm20, 5, 55, 10), ...bags(P.bm5, 55, 75, 10, 5), ...bags(P.reboco, 125, 180, 10)],
      period,
    });
    const bm = result.campaigns.find((item) => item.mix === 'AC3 Bella Massa')!;
    expect(bm.baggedKg).toBeCloseTo(2200, 0);
    expect(bm.products.sort()).toEqual([P.bm20, P.bm5].sort());
    expect(kinds(result).unassigned ?? 0).toBe(0);
  });

  it('reads batches seconds apart as the HMI sending late, not as the plant', () => {
    const result = reconcile({
      batches: [batch('a', 0, P.fix), { ...batch('a', 0, P.fix), at: at(0) + 20_000 }, batch('b', 300, P.reboco)],
      bags: [...bags(P.fix, 5, 20, 30), ...bags(P.reboco, 305, 360, 10)],
      period,
    });
    expect(result.campaigns[0].offline).toBe(true);
    expect(result.campaigns[0].causes.map((cause) => cause.kind)).toEqual(['offline']);
  });

  it('keeps the shortfall of the campaign still bagging in the silo', () => {
    const result = reconcile({
      batches: [batch('a', 0, P.fix), batch('a', 15, P.fix)],
      bags: bags(P.fix, 5, 60, 10),
      period,
    });
    expect(result.campaigns.at(-1)!.causes).toEqual([{ kind: 'silo', kg: -(4400 - 2200) }]);
  });

  it('says when no bag came out with the name of what was mixed', () => {
    const result = reconcile({
      batches: [batch('a', 0, P.fix), batch('b', 30, P.branca, 1800), batch('c', 60, P.reboco)],
      bags: [...bags(P.fix, 5, 30, 22), ...bags(P.reboco, 65, 120, 10)],
      period,
    });
    const branca = result.campaigns.find((item) => item.mix === mixOf(P.branca))!;
    expect(branca.causes).toEqual([{ kind: 'notBagged', kg: -1800 }]);
  });

  it('carries the silo in and out of a period', () => {
    // A lot mixed the evening before, bagged in the morning; one mixed late, bagged next day.
    const result = reconcile({
      batches: [batch('eve', -120, P.fix), batch('day', 600, P.reboco), batch('next', 1500, P.branca, 1800)],
      bags: [...bags(P.fix, 0, 55, 10), ...bags(P.reboco, 605, 660, 10), ...bags(P.branca, 1505, 1550, 10)],
      period: { start: at(-60), end: at(1440) },
    });
    expect(kinds(result).carryIn).toBe(2200);
  });

  it('keeps a bag named after a mix last made days ago out of it', () => {
    const result = reconcile({
      batches: [batch('old', 0, P.reboco), batch('fix', 120, P.fix), batch('bm', 240, P.bm20)],
      bags: [...bags(P.reboco, 5, 60, 10), ...bags(P.fix, 125, 180, 10), ...bags(P.reboco, 2 * 1440, 2 * 1440 + 30, 10)],
      period: { start: at(0), end: at(3 * 1440) },
    });
    expect(kinds(result).unassigned).toBe(60 * 20);
    expect(result.campaigns[0].baggedKg).toBe(2200);
  });

  it('names the product of a bag sent without a recipe after what the mixer was making', () => {
    const result = reconcile({
      batches: [batch('a', 0, P.fix)],
      bags: [...bags(null, 5, 30, 10)],
      period,
    });
    expect(result.unlinked[0].inferred).toEqual([{ product: P.fix, bags: 50 }]);
    expect(kinds(result).unlinked).toBe(-1000);
  });
});

