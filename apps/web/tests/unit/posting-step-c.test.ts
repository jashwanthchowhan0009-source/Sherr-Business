import { describe, expect, it } from 'vitest';
import { calculateInvoice, determineSupplyType, type GstLineInput, type SupplyType } from '../../src/lib/accounting/gst';
import {
  UnbalancedPostingError,
  contraEntries,
  creditNoteEntries,
  debitNoteEntries,
  journalEntries,
  purchaseBillEntries,
  reverseChargeLiabilityEntries,
  salesInvoiceEntries,
  totals,
} from '../../src/lib/accounting/posting';
import { QTY_SCALE } from '../../src/lib/accounting/units';

const calc = (input: {
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  supplyType?: SupplyType;
  lines: readonly GstLineInput[];
}) =>
  calculateInvoice(
    input.lines,
    input.supplyType ??
      determineSupplyType({
        supplierStateCode: input.supplierStateCode,
        placeOfSupplyStateCode: input.placeOfSupplyStateCode,
      }),
  );

const line = (rupees: bigint, rateBps: number, extra: Partial<GstLineInput> = {}) => ({
  quantity: QTY_SCALE,
  unitPricePaise: rupees * 100n,
  gstRateBps: rateBps,
  ...extra,
});

const net = (
  entries: readonly { accountCode: string; debitPaise: bigint; creditPaise: bigint }[],
  code: string,
) =>
  entries
    .filter((e) => e.accountCode === code)
    .reduce((acc, e) => acc + e.debitPaise - e.creditPaise, 0n);

const balances = (entries: readonly { debitPaise: bigint; creditPaise: bigint }[]) => {
  const { debitPaise, creditPaise } = totals(entries as never);
  return debitPaise === creditPaise;
};

describe('creditNoteEntries', () => {
  const note = calc({
    supplierStateCode: '29',
    placeOfSupplyStateCode: '29',
    lines: [line(10_000n, 1800)],
  });

  it('debits Sales Returns and reverses the output tax', () => {
    const entries = creditNoteEntries(note);
    expect(net(entries, 'SALES_RETURNS')).toBe(10_000_00n); // Dr ₹10,000
    expect(net(entries, 'OUTPUT_CGST')).toBe(900_00n); // Dr ₹900 — reversing
    expect(net(entries, 'OUTPUT_SGST')).toBe(900_00n);
    expect(net(entries, 'SUNDRY_DEBTORS')).toBe(-11_800_00n); // Cr ₹11,800
  });

  it('reverses tax through the same Output accounts the invoice used', () => {
    // GSTR-1 reports output tax net of credit notes, so splitting the reversal
    // into a separate ledger would mean reassembling it at return time.
    const invoice = salesInvoiceEntries(note);
    const credit = creditNoteEntries(note);
    for (const code of ['OUTPUT_CGST', 'OUTPUT_SGST', 'SALES'].filter(
      (c) => c !== 'SALES',
    )) {
      expect(net(invoice, code) + net(credit, code)).toBe(0n);
    }
  });

  it('balances at every slab, inter-state and intra-state', () => {
    for (const rateBps of [0, 500, 1200, 1800, 2800]) {
      for (const pos of ['29', '27']) {
        const n = calc({
          supplierStateCode: '29',
          placeOfSupplyStateCode: pos,
          lines: [line(7_777n, rateBps)],
        });
        expect(balances(creditNoteEntries(n)), `${rateBps} to ${pos}`).toBe(true);
      }
    }
  });

  it('uses IGST for an inter-state credit note', () => {
    const inter = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '27',
      lines: [line(10_000n, 1800)],
    });
    const entries = creditNoteEntries(inter);
    expect(net(entries, 'OUTPUT_IGST')).toBe(1_800_00n);
    expect(entries.map((e) => e.accountCode)).not.toContain('OUTPUT_CGST');
  });
});

describe('debitNoteEntries', () => {
  const note = calc({
    supplierStateCode: '29',
    placeOfSupplyStateCode: '29',
    lines: [line(5_000n, 1200)],
  });

  it('debits the creditor and gives up the input credit', () => {
    const entries = debitNoteEntries(note);
    expect(net(entries, 'SUNDRY_CREDITORS')).toBe(5_600_00n); // Dr ₹5,600
    expect(net(entries, 'PURCHASE_RETURNS')).toBe(-5_000_00n); // Cr ₹5,000
    expect(net(entries, 'INPUT_CGST')).toBe(-300_00n); // Cr ₹300 — credit given up
    expect(net(entries, 'INPUT_SGST')).toBe(-300_00n);
  });

  it('exactly undoes the bill it relates to', () => {
    const bill = purchaseBillEntries(note);
    const debit = debitNoteEntries(note);
    for (const code of new Set([...bill, ...debit].map((e) => e.accountCode))) {
      // Purchases and Purchase Returns are deliberately different accounts, so
      // only the tax and the creditor net to zero.
      if (code === 'PURCHASES' || code === 'PURCHASE_RETURNS') continue;
      expect(net(bill, code) + net(debit, code), code).toBe(0n);
    }
  });

  it('balances at every slab', () => {
    for (const rateBps of [0, 500, 1200, 1800, 2800]) {
      const n = calc({
        supplierStateCode: '29',
        placeOfSupplyStateCode: '33',
        lines: [line(1_234n, rateBps)],
      });
      expect(balances(debitNoteEntries(n)), String(rateBps)).toBe(true);
    }
  });
});

describe('journalEntries', () => {
  it('accepts a balanced two-line entry', () => {
    const entries = journalEntries([
      { accountCode: 'RENT', debitPaise: 50_000_00n, creditPaise: 0n },
      { accountCode: 'BANK', debitPaise: 0n, creditPaise: 50_000_00n },
    ]);
    expect(net(entries, 'RENT')).toBe(50_000_00n);
    expect(balances(entries)).toBe(true);
  });

  it('accepts a multi-line entry that balances in aggregate', () => {
    const entries = journalEntries([
      { accountCode: 'SALARIES', debitPaise: 1_00_000_00n, creditPaise: 0n },
      { accountCode: 'TDS_PAYABLE', debitPaise: 0n, creditPaise: 10_000_00n },
      { accountCode: 'BANK', debitPaise: 0n, creditPaise: 90_000_00n },
    ]);
    expect(entries).toHaveLength(3);
    expect(balances(entries)).toBe(true);
  });

  it('refuses an unbalanced entry', () => {
    expect(() =>
      journalEntries([
        { accountCode: 'RENT', debitPaise: 50_000_00n, creditPaise: 0n },
        { accountCode: 'BANK', debitPaise: 0n, creditPaise: 49_999_00n },
      ]),
    ).toThrow(UnbalancedPostingError);
  });

  it('drops blank lines rather than refusing a form with spare rows', () => {
    const entries = journalEntries([
      { accountCode: 'RENT', debitPaise: 1_000_00n, creditPaise: 0n },
      { accountCode: '', debitPaise: 0n, creditPaise: 0n },
      { accountCode: 'BANK', debitPaise: 0n, creditPaise: 1_000_00n },
    ]);
    expect(entries).toHaveLength(2);
  });

  it('refuses a single-sided journal, which is not an entry', () => {
    expect(() =>
      journalEntries([{ accountCode: 'RENT', debitPaise: 1_000_00n, creditPaise: 0n }]),
    ).toThrow(/at least two lines/);
    expect(() => journalEntries([])).toThrow(/at least two lines/);
  });

  it('refuses a line with both a debit and a credit', () => {
    expect(() =>
      journalEntries([
        { accountCode: 'RENT', debitPaise: 100n, creditPaise: 100n },
        { accountCode: 'BANK', debitPaise: 100n, creditPaise: 100n },
      ]),
    ).toThrow(/both a debit and a credit/);
  });
});

describe('contraEntries', () => {
  it('moves money from bank to cash', () => {
    const entries = contraEntries({
      fromAccountCode: 'BANK',
      toAccountCode: 'CASH',
      amountPaise: 25_000_00n,
    });
    expect(net(entries, 'CASH')).toBe(25_000_00n);
    expect(net(entries, 'BANK')).toBe(-25_000_00n);
    expect(balances(entries)).toBe(true);
  });

  it('refuses a move to the same account', () => {
    expect(() =>
      contraEntries({ fromAccountCode: 'CASH', toAccountCode: 'CASH', amountPaise: 100n }),
    ).toThrow(/two different accounts/);
  });

  it('refuses a zero or negative amount', () => {
    for (const amountPaise of [0n, -1n]) {
      expect(() =>
        contraEntries({ fromAccountCode: 'BANK', toAccountCode: 'CASH', amountPaise }),
      ).toThrow(/positive/);
    }
  });
});

describe('reverseChargeLiabilityEntries', () => {
  it('raises the liability and the matching credit, netting to nothing', () => {
    const entries = reverseChargeLiabilityEntries({
      cgstPaise: 900_00n,
      sgstPaise: 900_00n,
      igstPaise: 0n,
    });
    expect(net(entries, 'INPUT_CGST')).toBe(900_00n);
    expect(net(entries, 'OUTPUT_CGST')).toBe(-900_00n);
    expect(net(entries, 'INPUT_SGST')).toBe(900_00n);
    expect(net(entries, 'OUTPUT_SGST')).toBe(-900_00n);
    expect(balances(entries)).toBe(true);
  });

  it('handles an inter-state reverse charge', () => {
    const entries = reverseChargeLiabilityEntries({
      cgstPaise: 0n,
      sgstPaise: 0n,
      igstPaise: 1_800_00n,
    });
    expect(entries.map((e) => e.accountCode).sort()).toEqual(['INPUT_IGST', 'OUTPUT_IGST']);
  });

  it('refuses a liability of zero rather than writing an empty voucher', () => {
    expect(() =>
      reverseChargeLiabilityEntries({ cgstPaise: 0n, sgstPaise: 0n, igstPaise: 0n }),
    ).toThrow(/not an entry/);
  });

  it('matches the tax the engine would have charged on the same supply', () => {
    // The liability must equal what the supply attracts, not an independently
    // chosen figure: the engine computes it, this only places it.
    const asIfTaxed = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [line(1_00_000n, 1800)],
    });
    const entries = reverseChargeLiabilityEntries({
      cgstPaise: asIfTaxed.cgstPaise,
      sgstPaise: asIfTaxed.sgstPaise,
      igstPaise: asIfTaxed.igstPaise,
    });
    expect(net(entries, 'OUTPUT_CGST')).toBe(-9_000_00n);
    expect(net(entries, 'OUTPUT_SGST')).toBe(-9_000_00n);
  });

  it('leaves the reverse-charge bill itself carrying no tax', () => {
    const bill = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [line(1_00_000n, 1800, { reverseCharge: true })],
    });
    const entries = purchaseBillEntries(bill);
    expect(net(entries, 'INPUT_CGST')).toBe(0n);
    // What the supplier's document shows: the taxable value and nothing more.
    expect(net(entries, 'SUNDRY_CREDITORS')).toBe(-1_00_000_00n);
  });
});
