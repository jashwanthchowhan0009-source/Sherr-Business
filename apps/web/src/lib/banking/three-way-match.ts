/**
 * The three-way match: purchase order, goods receipt, supplier bill.
 *
 * The control this implements is the oldest one in payables: do not pay for
 * goods nobody ordered, and do not pay for goods nobody received. Each of the
 * three documents is produced by a different party — we order, they deliver,
 * they invoice — so agreement between all three is evidence, and disagreement
 * between any two is a question worth asking before money leaves.
 *
 * Pure and integer-only. Quantities are scaled by QTY_SCALE, amounts are paise,
 * and no tolerance is applied to either unless the caller asks for one: a
 * matcher that quietly accepts a 2% overcharge is a matcher that has been
 * trained to approve overcharges.
 */
import { QTY_SCALE } from '@/lib/accounting/units';

export interface MatchLine {
  /** Lines are paired by item where there is one, otherwise by description. */
  key: string;
  description: string;
  quantity: bigint;
  unitPricePaise: bigint;
}

export type ExceptionKind =
  | 'not_ordered'
  | 'not_received'
  | 'over_delivered'
  | 'short_delivered'
  | 'over_billed_quantity'
  | 'short_billed_quantity'
  | 'price_above_order'
  | 'price_below_order';

export interface MatchException {
  kind: ExceptionKind;
  key: string;
  description: string;
  /** Human-readable, specific, and always naming both figures. */
  detail: string;
  orderedQuantity: bigint | null;
  receivedQuantity: bigint | null;
  billedQuantity: bigint | null;
  orderedPricePaise: bigint | null;
  billedPricePaise: bigint | null;
  /** True when the exception means we would pay more than agreed. */
  costsMoney: boolean;
}

export interface ThreeWayResult {
  matched: boolean;
  exceptions: MatchException[];
  /** Lines where all three agree, by key. */
  cleanKeys: string[];
}

export interface ThreeWayInput {
  ordered: readonly MatchLine[];
  received: readonly MatchLine[];
  billed: readonly MatchLine[];
  /**
   * Quantity tolerance in basis points of the ordered quantity. Zero by
   * default: a short delivery is a fact worth seeing, not noise.
   */
  quantityToleranceBps?: number;
  /** Price tolerance in basis points of the ordered price. Zero by default. */
  priceToleranceBps?: number;
}

const formatQty = (scaled: bigint): string => {
  const whole = scaled / QTY_SCALE;
  const frac = (scaled % QTY_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};

const formatRupees = (paise: bigint): string => {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? '-' : ''}₹${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
};

const withinTolerance = (expected: bigint, actual: bigint, toleranceBps: number): boolean => {
  if (expected === actual) return true;
  if (toleranceBps <= 0) return false;
  const difference = actual > expected ? actual - expected : expected - actual;
  // Compared in basis points of the expected figure, in integers.
  return difference * 10_000n <= (expected < 0n ? -expected : expected) * BigInt(toleranceBps);
};

/**
 * Compares the three documents line by line.
 *
 * Lines are paired on `key` — the item id where both carry one, the normalised
 * description otherwise. A line present in one document and absent from another
 * is an exception rather than a silent omission, because "we were billed for
 * something we never ordered" is exactly the case this check exists to catch.
 */
export function threeWayMatch(input: ThreeWayInput): ThreeWayResult {
  const qtyTolerance = input.quantityToleranceBps ?? 0;
  const priceTolerance = input.priceToleranceBps ?? 0;

  const index = (lines: readonly MatchLine[]) => {
    const map = new Map<string, MatchLine>();
    for (const line of lines) {
      const existing = map.get(line.key);
      // The same item on two lines of one document is one quantity.
      if (existing) {
        map.set(line.key, {
          ...existing,
          quantity: existing.quantity + line.quantity,
        });
      } else {
        map.set(line.key, line);
      }
    }
    return map;
  };

  const ordered = index(input.ordered);
  const received = index(input.received);
  const billed = index(input.billed);

  const keys = [...new Set([...ordered.keys(), ...received.keys(), ...billed.keys()])].sort();
  const exceptions: MatchException[] = [];
  const cleanKeys: string[] = [];

  for (const key of keys) {
    const o = ordered.get(key) ?? null;
    const r = received.get(key) ?? null;
    const b = billed.get(key) ?? null;
    const description = b?.description ?? r?.description ?? o?.description ?? key;

    const base = {
      key,
      description,
      orderedQuantity: o?.quantity ?? null,
      receivedQuantity: r?.quantity ?? null,
      billedQuantity: b?.quantity ?? null,
      orderedPricePaise: o?.unitPricePaise ?? null,
      billedPricePaise: b?.unitPricePaise ?? null,
    };

    const before = exceptions.length;

    // Billed for something never ordered: the headline case.
    if (b && !o) {
      exceptions.push({
        ...base,
        kind: 'not_ordered',
        detail: `Billed ${formatQty(b.quantity)} of "${description}", which no purchase order covers.`,
        costsMoney: true,
      });
    }

    // Billed for something never received.
    if (b && !r) {
      exceptions.push({
        ...base,
        kind: 'not_received',
        detail: `Billed ${formatQty(b.quantity)} of "${description}", which no goods receipt records.`,
        costsMoney: true,
      });
    }

    // Received more or less than ordered.
    if (o && r && !withinTolerance(o.quantity, r.quantity, qtyTolerance)) {
      const over = r.quantity > o.quantity;
      exceptions.push({
        ...base,
        kind: over ? 'over_delivered' : 'short_delivered',
        detail: `Ordered ${formatQty(o.quantity)} and received ${formatQty(r.quantity)} of "${description}".`,
        costsMoney: over,
      });
    }

    // Billed for more or less than was received.
    if (r && b && !withinTolerance(r.quantity, b.quantity, qtyTolerance)) {
      const over = b.quantity > r.quantity;
      exceptions.push({
        ...base,
        kind: over ? 'over_billed_quantity' : 'short_billed_quantity',
        detail: `Received ${formatQty(r.quantity)} but billed ${formatQty(b.quantity)} of "${description}".`,
        costsMoney: over,
      });
    }

    // Billed at a different price from the one agreed.
    if (o && b && !withinTolerance(o.unitPricePaise, b.unitPricePaise, priceTolerance)) {
      const over = b.unitPricePaise > o.unitPricePaise;
      exceptions.push({
        ...base,
        kind: over ? 'price_above_order' : 'price_below_order',
        detail:
          `"${description}" was ordered at ${formatRupees(o.unitPricePaise)} and billed at ` +
          `${formatRupees(b.unitPricePaise)}.`,
        costsMoney: over,
      });
    }

    if (exceptions.length === before && o && r && b) cleanKeys.push(key);
  }

  return { matched: exceptions.length === 0, exceptions, cleanKeys };
}

/**
 * What the bill would cost beyond what was ordered and received.
 *
 * The figure an approver actually wants: not "there are four exceptions" but
 * "approving this pays ₹12,400 more than was agreed". Computed from quantity
 * billed above what was received, at the billed price, plus any price increase
 * on the quantity legitimately received.
 */
export function overchargePaise(result: ThreeWayResult): bigint {
  let total = 0n;

  for (const e of result.exceptions) {
    if (!e.costsMoney) continue;

    if (e.kind === 'not_ordered' || e.kind === 'not_received') {
      if (e.billedQuantity !== null && e.billedPricePaise !== null) {
        total += (e.billedQuantity * e.billedPricePaise) / QTY_SCALE;
      }
      continue;
    }

    if (e.kind === 'over_billed_quantity') {
      if (e.billedQuantity !== null && e.receivedQuantity !== null && e.billedPricePaise !== null) {
        total += ((e.billedQuantity - e.receivedQuantity) * e.billedPricePaise) / QTY_SCALE;
      }
      continue;
    }

    if (e.kind === 'price_above_order') {
      // The increase applies to the quantity actually billed, which is what we
      // would be paying for.
      const quantity = e.billedQuantity ?? e.receivedQuantity ?? e.orderedQuantity;
      if (quantity !== null && e.billedPricePaise !== null && e.orderedPricePaise !== null) {
        total += (quantity * (e.billedPricePaise - e.orderedPricePaise)) / QTY_SCALE;
      }
    }
  }

  return total;
}

export const EXCEPTION_LABELS: Record<ExceptionKind, string> = {
  not_ordered: 'Not ordered',
  not_received: 'Not received',
  over_delivered: 'More delivered than ordered',
  short_delivered: 'Less delivered than ordered',
  over_billed_quantity: 'Billed for more than was received',
  short_billed_quantity: 'Billed for less than was received',
  price_above_order: 'Billed above the agreed price',
  price_below_order: 'Billed below the agreed price',
};
