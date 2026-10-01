import { describe, expect, it } from 'vitest';
import {
  overchargePaise,
  threeWayMatch,
  type MatchLine,
} from '../../src/lib/banking/three-way-match';
import { QTY_SCALE } from '../../src/lib/accounting/units';

const line = (key: string, qty: bigint, pricePaise: bigint): MatchLine => ({
  key,
  description: key,
  quantity: qty * QTY_SCALE,
  unitPricePaise: pricePaise,
});

describe('threeWayMatch', () => {
  it('matches when all three documents agree', () => {
    const lines = [line('rice', 100n, 5_000_00n), line('oil', 20n, 1_200_00n)];
    const result = threeWayMatch({ ordered: lines, received: lines, billed: lines });
    expect(result.matched).toBe(true);
    expect(result.exceptions).toEqual([]);
    expect(result.cleanKeys).toEqual(['oil', 'rice']);
  });

  it('catches a bill for something never ordered', () => {
    // The headline case: a supplier adds a line nobody asked for.
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n), line('sugar', 10n, 4_000_00n)],
      billed: [line('rice', 100n, 5_000_00n), line('sugar', 10n, 4_000_00n)],
    });
    expect(result.matched).toBe(false);
    const exception = result.exceptions.find((e) => e.kind === 'not_ordered')!;
    expect(exception.description).toBe('sugar');
    expect(exception.costsMoney).toBe(true);
    expect(exception.detail).toMatch(/no purchase order covers/);
  });

  it('catches a bill for something never received', () => {
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n), line('oil', 20n, 1_200_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [line('rice', 100n, 5_000_00n), line('oil', 20n, 1_200_00n)],
    });
    const exception = result.exceptions.find((e) => e.kind === 'not_received')!;
    expect(exception.description).toBe('oil');
    expect(exception.detail).toMatch(/no goods receipt records/);
  });

  it('catches a short delivery, which costs nothing but matters', () => {
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 90n, 5_000_00n)],
      billed: [line('rice', 90n, 5_000_00n)],
    });
    const exception = result.exceptions.find((e) => e.kind === 'short_delivered')!;
    expect(exception.detail).toBe('Ordered 100 and received 90 of "rice".');
    expect(exception.costsMoney).toBe(false);
  });

  it('catches being billed for more than arrived', () => {
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 90n, 5_000_00n)],
      billed: [line('rice', 100n, 5_000_00n)],
    });
    const exception = result.exceptions.find((e) => e.kind === 'over_billed_quantity')!;
    expect(exception.detail).toBe('Received 90 but billed 100 of "rice".');
    expect(exception.costsMoney).toBe(true);
  });

  it('catches a price above the one agreed', () => {
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [line('rice', 100n, 5_500_00n)],
    });
    const exception = result.exceptions.find((e) => e.kind === 'price_above_order')!;
    expect(exception.detail).toMatch(/ordered at ₹5000.00 and billed at ₹5500.00/);
    expect(exception.costsMoney).toBe(true);
  });

  it('reports a price below the agreed one too, without calling it a cost', () => {
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [line('rice', 100n, 4_500_00n)],
    });
    const exception = result.exceptions.find((e) => e.kind === 'price_below_order')!;
    expect(exception.costsMoney).toBe(false);
  });

  it('applies no tolerance by default', () => {
    // A matcher that quietly accepts a 2% overcharge has been trained to approve
    // overcharges.
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [line('rice', 100n, 5_000_01n)],
    });
    expect(result.matched).toBe(false);
  });

  it('honours an explicit tolerance when one is given', () => {
    const within = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [line('rice', 100n, 5_050_00n)],
      priceToleranceBps: 100, // 1%
    });
    expect(within.matched).toBe(true);

    const beyond = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [line('rice', 100n, 5_100_00n)],
      priceToleranceBps: 100,
    });
    expect(beyond.matched).toBe(false);
  });

  it('adds up the same item appearing on two lines of one document', () => {
    const result = threeWayMatch({
      ordered: [line('rice', 60n, 5_000_00n), line('rice', 40n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [line('rice', 100n, 5_000_00n)],
    });
    expect(result.matched).toBe(true);
  });

  it('reports every exception on a line, not just the first', () => {
    // Billed for more than received, at a higher price than ordered. Both are
    // facts an approver needs.
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 90n, 5_000_00n)],
      billed: [line('rice', 100n, 5_500_00n)],
    });
    const kinds = result.exceptions.map((e) => e.kind).sort();
    expect(kinds).toEqual(['over_billed_quantity', 'price_above_order', 'short_delivered']);
  });

  it('matches an order and receipt with nothing billed yet', () => {
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [],
    });
    // Nothing is wrong; the bill simply has not arrived.
    expect(result.exceptions).toEqual([]);
    expect(result.cleanKeys).toEqual([]);
  });

  it('is clean for three empty documents', () => {
    expect(threeWayMatch({ ordered: [], received: [], billed: [] }).matched).toBe(true);
  });
});

describe('overchargePaise', () => {
  it('is zero when everything agrees', () => {
    const lines = [line('rice', 100n, 5_000_00n)];
    expect(overchargePaise(threeWayMatch({ ordered: lines, received: lines, billed: lines }))).toBe(0n);
  });

  it('prices a line that was never ordered', () => {
    const result = threeWayMatch({
      ordered: [],
      received: [line('sugar', 10n, 4_000_00n)],
      billed: [line('sugar', 10n, 4_000_00n)],
    });
    // 10 at ₹4,000 = ₹40,000.
    expect(overchargePaise(result)).toBe(40_000_00n);
  });

  it('prices the quantity billed above what arrived', () => {
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 90n, 5_000_00n)],
      billed: [line('rice', 100n, 5_000_00n)],
    });
    // 10 units billed but not received, at ₹5,000 = ₹50,000.
    expect(overchargePaise(result)).toBe(50_000_00n);
  });

  it('prices a price increase across the quantity billed', () => {
    const result = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [line('rice', 100n, 5_500_00n)],
    });
    // ₹500 more on each of 100 units = ₹50,000.
    expect(overchargePaise(result)).toBe(50_000_00n);
  });

  it('counts nothing for a short delivery or a lower price', () => {
    const short = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 90n, 5_000_00n)],
      billed: [line('rice', 90n, 5_000_00n)],
    });
    expect(overchargePaise(short)).toBe(0n);

    const cheaper = threeWayMatch({
      ordered: [line('rice', 100n, 5_000_00n)],
      received: [line('rice', 100n, 5_000_00n)],
      billed: [line('rice', 100n, 4_500_00n)],
    });
    expect(overchargePaise(cheaper)).toBe(0n);
  });

  it('handles a fractional quantity without a rounding error', () => {
    const result = threeWayMatch({
      ordered: [],
      received: [{ key: 'oil', description: 'oil', quantity: 25_000n, unitPricePaise: 1_200_00n }],
      billed: [{ key: 'oil', description: 'oil', quantity: 25_000n, unitPricePaise: 1_200_00n }],
    });
    // 2.5 at ₹1,200 = ₹3,000.
    expect(overchargePaise(result)).toBe(3_000_00n);
  });
});
