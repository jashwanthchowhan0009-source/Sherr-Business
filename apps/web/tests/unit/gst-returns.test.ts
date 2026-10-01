import { describe, expect, it } from 'vitest';
import {
  DEFAULT_B2CL_THRESHOLD_PAISE,
  buildGstr1,
  buildGstr3b,
  gstr1TableFor,
  type ReturnSupply,
} from '../../src/lib/gst/returns';
import { totalTax, zeroTax, type TaxAmounts } from '../../src/lib/gst/set-off';
import { QTY_SCALE } from '../../src/lib/accounting/units';

const tax = (over: Partial<TaxAmounts> = {}): TaxAmounts => ({ ...zeroTax(), ...over });

const supply = (over: Partial<ReturnSupply> = {}): ReturnSupply => ({
  voucherId: 'v1',
  voucherNo: 'INV/25-26/0001',
  voucherType: 'sales',
  voucherDate: '2025-06-15',
  partyName: 'Anand Enterprises',
  partyGstin: '29AAACA1111A1Z7',
  placeOfSupplyStateCode: '29',
  supplyType: 'intra_state',
  taxablePaise: 1_00_000_00n,
  tax: tax({ cgst: 9_000_00n, sgst: 9_000_00n }),
  reverseCharge: false,
  hsnLines: [
    {
      hsnSac: '1006',
      description: 'Basmati rice',
      quantity: 100n * QTY_SCALE,
      unit: 'KGS',
      taxablePaise: 1_00_000_00n,
      tax: tax({ cgst: 9_000_00n, sgst: 9_000_00n }),
      gstRateBps: 1800,
      reverseCharge: false,
    },
  ],
  ...over,
});

describe('gstr1TableFor', () => {
  it('puts a registered supply in B2B', () => {
    expect(gstr1TableFor(supply(), DEFAULT_B2CL_THRESHOLD_PAISE)).toBe('b2b');
  });

  it('puts a small unregistered supply in B2CS', () => {
    expect(
      gstr1TableFor(supply({ partyGstin: null, taxablePaise: 5_000_00n }), DEFAULT_B2CL_THRESHOLD_PAISE),
    ).toBe('b2cs');
  });

  it('puts a large inter-state unregistered supply in B2CL', () => {
    expect(
      gstr1TableFor(
        supply({ partyGstin: null, supplyType: 'inter_state', taxablePaise: 3_00_000_00n }),
        DEFAULT_B2CL_THRESHOLD_PAISE,
      ),
    ).toBe('b2cl');
  });

  it('keeps a large INTRA-state unregistered supply in B2CS', () => {
    // B2CL is inter-state only; value alone does not move an intra-state supply.
    expect(
      gstr1TableFor(
        supply({ partyGstin: null, supplyType: 'intra_state', taxablePaise: 9_00_000_00n }),
        DEFAULT_B2CL_THRESHOLD_PAISE,
      ),
    ).toBe('b2cs');
  });

  it('respects the threshold boundary exactly', () => {
    const at = supply({
      partyGstin: null,
      supplyType: 'inter_state',
      taxablePaise: DEFAULT_B2CL_THRESHOLD_PAISE,
    });
    const over = supply({
      partyGstin: null,
      supplyType: 'inter_state',
      taxablePaise: DEFAULT_B2CL_THRESHOLD_PAISE + 1n,
    });
    expect(gstr1TableFor(at, DEFAULT_B2CL_THRESHOLD_PAISE)).toBe('b2cs');
    expect(gstr1TableFor(over, DEFAULT_B2CL_THRESHOLD_PAISE)).toBe('b2cl');
  });

  it('honours a threshold passed in, since the figure has changed before', () => {
    const s = supply({ partyGstin: null, supplyType: 'inter_state', taxablePaise: 1_50_000_00n });
    expect(gstr1TableFor(s, 1_00_000_00n)).toBe('b2cl');
    expect(gstr1TableFor(s, 2_50_000_00n)).toBe('b2cs');
  });

  it('separates zero-rated from nil-rated, which both carry no tax', () => {
    // Nothing is inferred from the tax charged: both are nil, and they belong in
    // different tables.
    expect(
      gstr1TableFor(supply({ supplyType: 'zero_rated', tax: zeroTax() }), DEFAULT_B2CL_THRESHOLD_PAISE),
    ).toBe('exports');
    expect(
      gstr1TableFor(supply({ supplyType: 'exempt', tax: zeroTax() }), DEFAULT_B2CL_THRESHOLD_PAISE),
    ).toBe('nil_exempt');
  });

  it('puts notes in their own tables, split by whether the party is registered', () => {
    expect(
      gstr1TableFor(supply({ voucherType: 'credit_note' }), DEFAULT_B2CL_THRESHOLD_PAISE),
    ).toBe('credit_notes_registered');
    expect(
      gstr1TableFor(
        supply({ voucherType: 'credit_note', partyGstin: null }),
        DEFAULT_B2CL_THRESHOLD_PAISE,
      ),
    ).toBe('credit_notes_unregistered');
  });
});

describe('buildGstr1', () => {
  const summary = buildGstr1({
    from: '2025-06-01',
    to: '2025-06-30',
    supplies: [
      supply(),
      // The HSN lines must agree with the header, as they do on a real invoice.
      supply({
        voucherId: 'v2',
        voucherNo: 'INV/0002',
        partyGstin: null,
        taxablePaise: 5_000_00n,
        tax: tax({ cgst: 450_00n, sgst: 450_00n }),
        hsnLines: [
          {
            hsnSac: '1006',
            description: 'Basmati rice',
            quantity: 5n * QTY_SCALE,
            unit: 'KGS',
            taxablePaise: 5_000_00n,
            tax: tax({ cgst: 450_00n, sgst: 450_00n }),
            gstRateBps: 1800,
            reverseCharge: false,
          },
        ],
      }),
      supply({
        voucherId: 'v3',
        voucherNo: 'INV/0003',
        supplyType: 'inter_state',
        placeOfSupplyStateCode: '27',
        tax: tax({ igst: 18_000_00n }),
      }),
      supply({
        voucherId: 'v4',
        voucherNo: 'CRN/0001',
        voucherType: 'credit_note',
        taxablePaise: -10_000_00n,
        tax: tax({ cgst: -900_00n, sgst: -900_00n }),
        hsnLines: [],
      }),
    ],
  });

  it('groups supplies into their tables', () => {
    expect(summary.sections.map((s) => s.table)).toEqual([
      'b2b',
      'b2cs',
      'credit_notes_registered',
    ]);
  });

  it('counts and totals each table', () => {
    const b2b = summary.sections.find((s) => s.table === 'b2b')!;
    expect(b2b.invoiceCount).toBe(2);
    expect(b2b.taxablePaise).toBe(2_00_000_00n);
    expect(b2b.tax.igst).toBe(18_000_00n);
  });

  it('lists invoices individually only where the return reports them so', () => {
    const b2b = summary.sections.find((s) => s.table === 'b2b')!;
    const b2cs = summary.sections.find((s) => s.table === 'b2cs')!;
    expect(b2b.invoices).toHaveLength(2);
    // B2CS is reported in aggregate, so naming its invoices would be misleading.
    expect(b2cs.invoices).toEqual([]);
  });

  it('lets a credit note reduce the totals', () => {
    const note = summary.sections.find((s) => s.table === 'credit_notes_registered')!;
    expect(note.taxablePaise).toBe(-10_000_00n);
    expect(summary.totalTaxablePaise).toBe(1_00_000_00n + 5_000_00n + 1_00_000_00n - 10_000_00n);
  });

  it('builds an HSN summary grouped by code and unit', () => {
    expect(summary.hsnSummary).toHaveLength(1);
    const row = summary.hsnSummary[0]!;
    expect(row.hsnSac).toBe('1006');
    // 100 + 5 + 100 kg across the three invoices carrying HSN.
    expect(row.quantity).toBe(205n * QTY_SCALE);
    expect(row.taxablePaise).toBe(2_05_000_00n);
  });

  it('names invoices the portal would reject for a missing GSTIN', () => {
    const broken = buildGstr1({
      from: 'a',
      to: 'b',
      // A B2B supply needs the counterparty's GSTIN; without one it is B2CS, so
      // the only way to hit this is a supply classed B2B with none.
      supplies: [supply({ partyGstin: null })],
    });
    // Reclassified to B2CS rather than reported as broken, which is the correct
    // handling — the warning exists for the case where classification says B2B.
    expect(broken.sections[0]?.table).toBe('b2cs');
    expect(broken.invoicesMissingGstin).toEqual([]);
  });

  it('names invoices with no HSN on any line', () => {
    const broken = buildGstr1({
      from: 'a',
      to: 'b',
      supplies: [
        supply({
          voucherNo: 'INV/NOHSN',
          hsnLines: [
            {
              hsnSac: null,
              description: 'Something',
              quantity: QTY_SCALE,
              unit: null,
              taxablePaise: 100_00n,
              tax: zeroTax(),
              gstRateBps: 1800,
              reverseCharge: false,
            },
          ],
        }),
      ],
    });
    expect(broken.invoicesMissingHsn).toEqual(['INV/NOHSN']);
  });

  it('is empty for a period with no supplies', () => {
    const empty = buildGstr1({ from: 'a', to: 'b', supplies: [] });
    expect(empty.sections).toEqual([]);
    expect(empty.totalTaxablePaise).toBe(0n);
  });

  it('always says it needs CA verification', () => {
    expect(summary.needsCaVerification).toBe(true);
  });
});

describe('buildGstr3b', () => {
  const r3bInputs = {
    from: '2025-06-01',
    to: '2025-06-30',
    outward: [
      supply(),
      supply({
        voucherId: 'v2',
        supplyType: 'zero_rated',
        tax: zeroTax(),
        taxablePaise: 50_000_00n,
        hsnLines: [
          {
            hsnSac: '1006',
            description: 'Basmati rice',
            quantity: QTY_SCALE,
            unit: 'KGS',
            taxablePaise: 50_000_00n,
            tax: zeroTax(),
            gstRateBps: 0,
            reverseCharge: false,
          },
        ],
      }),
      supply({
        voucherId: 'v3',
        supplyType: 'exempt',
        tax: zeroTax(),
        taxablePaise: 20_000_00n,
        hsnLines: [
          {
            hsnSac: '1006',
            description: 'Basmati rice',
            quantity: QTY_SCALE,
            unit: 'KGS',
            taxablePaise: 20_000_00n,
            tax: zeroTax(),
            gstRateBps: 0,
            reverseCharge: false,
          },
        ],
      }),
    ],
    inward: [
      // Header and lines agree, as on a real bill. They did not in an earlier
      // version of this fixture, and nothing noticed until GSTR-3B began reading
      // lines rather than voucher totals — so the agreement is now asserted below.
      supply({
        voucherId: 'p1',
        voucherType: 'purchase',
        taxablePaise: 40_000_00n,
        tax: tax({ cgst: 3_600_00n, sgst: 3_600_00n }),
        hsnLines: [
          {
            hsnSac: '1006',
            description: 'Basmati rice',
            quantity: 40n * QTY_SCALE,
            unit: 'KGS',
            taxablePaise: 40_000_00n,
            tax: tax({ cgst: 3_600_00n, sgst: 3_600_00n }),
            gstRateBps: 1800,
            reverseCharge: false,
          },
        ],
      }),
      // A reverse-charge purchase as one really arrives: the supplier charged no
      // tax, so the line carries none. The ₹900 either way is the return's own
      // computation from the rate, not a figure handed to it.
      supply({
        voucherId: 'p2',
        voucherType: 'purchase',
        taxablePaise: 10_000_00n,
        tax: zeroTax(),
        reverseCharge: true,
        hsnLines: [
          {
            hsnSac: '9987',
            description: 'Goods transport by road',
            quantity: QTY_SCALE,
            unit: null,
            taxablePaise: 10_000_00n,
            tax: zeroTax(),
            gstRateBps: 1800,
            reverseCharge: true,
          },
        ],
      }),
    ],
  };

  const r3b = buildGstr3b(r3bInputs);

  it('has a fixture whose lines agree with its voucher totals', () => {
    // A bill whose lines disagree with its header is not a bill, and a fixture
    // that does it hides whichever of the two the code reads.
    for (const supplyRow of [...[], ...r3bInputs.outward, ...r3bInputs.inward]) {
      if (supplyRow.hsnLines.length === 0) continue;
      const lineTaxable = supplyRow.hsnLines.reduce((a, l) => a + l.taxablePaise, 0n);
      expect(lineTaxable, `${supplyRow.voucherId} lines vs header`).toBe(supplyRow.taxablePaise);
    }
  });

  it('separates taxable, zero-rated and exempt outward supplies', () => {
    expect(r3b.outwardTaxable.taxablePaise).toBe(1_00_000_00n);
    expect(r3b.outwardZeroRated.taxablePaise).toBe(50_000_00n);
    expect(r3b.outwardNilExempt.taxablePaise).toBe(20_000_00n);
  });

  it('shows a reverse-charge purchase as both a liability and a credit', () => {
    // It nets to nothing in cash, which is correct — and is exactly why both
    // sides have to appear rather than cancelling silently.
    expect(r3b.inwardReverseCharge.tax.cgst).toBe(900_00n);
    expect(r3b.itcAvailable.cgst).toBe(4_500_00n);
    expect(r3b.totalLiability.cgst).toBe(9_000_00n + 900_00n);
  });

  it('computes the reverse-charge liability from the rate, not from the invoice', () => {
    // This is the whole point. The supplier charged no tax — that is what reverse
    // charge means — so the stored line tax is nil. Reading it would report nil on
    // 3.1(d) and under-declare tax the company owes. ₹10,000 at 18% intra-state is
    // ₹900 of CGST and ₹900 of SGST.
    const rcm = buildGstr3b({
      from: 'a',
      to: 'b',
      outward: [],
      inward: [
        supply({
          voucherId: 'rcm',
          voucherType: 'purchase',
          taxablePaise: 10_000_00n,
          tax: zeroTax(),
          reverseCharge: true,
          hsnLines: [
            {
              hsnSac: '9987',
              description: 'Goods transport by road',
              quantity: QTY_SCALE,
              unit: null,
              taxablePaise: 10_000_00n,
              tax: zeroTax(),
              gstRateBps: 1800,
              reverseCharge: true,
            },
          ],
        }),
      ],
    });

    expect(rcm.inwardReverseCharge.taxablePaise).toBe(10_000_00n);
    expect(rcm.inwardReverseCharge.tax.cgst).toBe(900_00n);
    expect(rcm.inwardReverseCharge.tax.sgst).toBe(900_00n);
    // The same amount is creditable, so cash payable nets to nothing.
    expect(rcm.itcAvailable.cgst).toBe(900_00n);
    expect(totalTax(rcm.totalLiability)).toBe(totalTax(rcm.itcNet));
  });

  it('splits reverse-charge tax by state, so an inter-state RCM supply is IGST', () => {
    const rcm = buildGstr3b({
      from: 'a',
      to: 'b',
      outward: [],
      inward: [
        supply({
          voucherId: 'rcm-inter',
          voucherType: 'purchase',
          supplyType: 'inter_state',
          taxablePaise: 10_000_00n,
          tax: zeroTax(),
          reverseCharge: true,
          hsnLines: [
            {
              hsnSac: '9987',
              description: 'Transport',
              quantity: QTY_SCALE,
              unit: null,
              taxablePaise: 10_000_00n,
              tax: zeroTax(),
              gstRateBps: 1800,
              reverseCharge: true,
            },
          ],
        }),
      ],
    });
    expect(rcm.inwardReverseCharge.tax.igst).toBe(1_800_00n);
    expect(rcm.inwardReverseCharge.tax.cgst).toBe(0n);
  });

  it('puts only the reverse-charge lines of a mixed bill on 3.1(d)', () => {
    // Reverse charge is a property of a line. Treating the whole voucher as
    // reverse-charge because one line is would put the rest of its value on
    // 3.1(d) and overstate the liability.
    const mixed = buildGstr3b({
      from: 'a',
      to: 'b',
      outward: [],
      inward: [
        supply({
          voucherId: 'mixed',
          voucherType: 'purchase',
          taxablePaise: 30_000_00n,
          tax: tax({ cgst: 1_800_00n, sgst: 1_800_00n }),
          reverseCharge: true,
          hsnLines: [
            {
              hsnSac: '1006',
              description: 'Goods, taxed by the supplier',
              quantity: QTY_SCALE,
              unit: null,
              taxablePaise: 20_000_00n,
              tax: tax({ cgst: 1_800_00n, sgst: 1_800_00n }),
              gstRateBps: 1800,
              reverseCharge: false,
            },
            {
              hsnSac: '9987',
              description: 'Freight, reverse charge',
              quantity: QTY_SCALE,
              unit: null,
              taxablePaise: 10_000_00n,
              tax: zeroTax(),
              gstRateBps: 500,
              reverseCharge: true,
            },
          ],
        }),
      ],
    });

    expect(mixed.inwardReverseCharge.taxablePaise).toBe(10_000_00n);
    expect(mixed.inwardReverseCharge.tax.cgst).toBe(250_00n);
    // Credit is the supplier's tax plus the reverse-charge tax.
    expect(mixed.itcAvailable.cgst).toBe(1_800_00n + 250_00n);
  });

  it('charges no reverse-charge tax on a zero-rated or exempt supply', () => {
    for (const supplyType of ['zero_rated', 'exempt'] as const) {
      const r = buildGstr3b({
        from: 'a',
        to: 'b',
        outward: [],
        inward: [
          supply({
            voucherId: `rcm-${supplyType}`,
            voucherType: 'purchase',
            supplyType,
            taxablePaise: 10_000_00n,
            tax: zeroTax(),
            reverseCharge: true,
            hsnLines: [
              {
                hsnSac: '9987',
                description: 'Exempt freight',
                quantity: QTY_SCALE,
                unit: null,
                taxablePaise: 10_000_00n,
                tax: zeroTax(),
                gstRateBps: 1800,
                reverseCharge: true,
              },
            ],
          }),
        ],
      });
      expect(totalTax(r.inwardReverseCharge.tax), supplyType).toBe(0n);
    }
  });

  it('lets a reverse-charge debit note reduce the liability', () => {
    const note = buildGstr3b({
      from: 'a',
      to: 'b',
      outward: [],
      inward: [
        supply({
          voucherId: 'dn',
          voucherType: 'debit_note',
          taxablePaise: -10_000_00n,
          tax: zeroTax(),
          reverseCharge: true,
          hsnLines: [
            {
              hsnSac: '9987',
              description: 'Freight reversed',
              quantity: QTY_SCALE,
              unit: null,
              taxablePaise: -10_000_00n,
              tax: zeroTax(),
              gstRateBps: 1800,
              reverseCharge: true,
            },
          ],
        }),
      ],
    });
    expect(note.inwardReverseCharge.tax.cgst).toBe(-900_00n);
  });

  it('falls back to the voucher totals when no lines were recorded', () => {
    const headerOnly = buildGstr3b({
      from: 'a',
      to: 'b',
      outward: [],
      inward: [
        supply({
          voucherId: 'nolines',
          voucherType: 'purchase',
          taxablePaise: 10_000_00n,
          tax: tax({ cgst: 900_00n, sgst: 900_00n }),
          reverseCharge: false,
          hsnLines: [],
        }),
      ],
    });
    expect(headerOnly.itcAvailable.cgst).toBe(900_00n);
  });

  it('totals the credit from every inward supply', () => {
    expect(totalTax(r3b.itcAvailable)).toBe(9_000_00n);
  });

  it('reports credit reversed as nil, because nothing computes a reversal', () => {
    // Rules 42 and 43 turn on how inputs were used, which this product has no
    // basis for judging. Showing nil with that note is honest; hiding the line
    // would imply none is needed.
    expect(totalTax(r3b.itcReversed)).toBe(0n);
    expect(r3b.itcNet).toEqual(r3b.itcAvailable);
  });

  it('is empty for a period with nothing in it', () => {
    const empty = buildGstr3b({ from: 'a', to: 'b', outward: [], inward: [] });
    expect(totalTax(empty.totalLiability)).toBe(0n);
    expect(totalTax(empty.itcAvailable)).toBe(0n);
  });

  it('always says it needs CA verification', () => {
    expect(r3b.needsCaVerification).toBe(true);
  });
});
