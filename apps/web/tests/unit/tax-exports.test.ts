import { describe, expect, it } from 'vitest';
import { cellText } from '@/lib/export/csv';
import { allCells, flatten, toCsvFile, toKeyed } from '@/lib/export/write';
import {
  gstr1Export,
  gstr1HsnExport,
  gstr2bExport,
  gstr3bExport,
  setOffExport,
  taxRulesExport,
  tdsPayableExport,
  tdsRulesExport,
} from '@/lib/export/tax-exports';
import type { ExportFile } from '@/lib/export/file';
import { buildGstr1, buildGstr3b, type ReturnSupply } from '@/lib/gst/returns';
import { setOffInputTaxCredit } from '@/lib/gst/set-off';
import { reconcileGstr2b } from '@/lib/gst/gstr2b';

const PERIOD = { from: '2025-06-01', to: '2025-06-30' };

const tax = (igst = 0n, cgst = 0n, sgst = 0n, cess = 0n) => ({ igst, cgst, sgst, cess });

function supply(over: Partial<ReturnSupply> = {}): ReturnSupply {
  return {
    voucherId: 'v1',
    voucherNo: 'INV/2025-26/0001',
    voucherType: 'sales',
    voucherDate: '2025-06-10',
    partyName: 'Acme Traders',
    partyGstin: '36AABCU9603R1ZO',
    placeOfSupplyStateCode: '36',
    supplyType: 'intra_state',
    taxablePaise: 100_000_00n,
    tax: tax(0n, 9_000_00n, 9_000_00n),
    reverseCharge: false,
    hsnLines: [
      {
        hsnSac: '1006',
        description: 'Rice',
        quantity: 100_0000n,
        unit: 'QTL',
        taxablePaise: 100_000_00n,
        tax: tax(0n, 9_000_00n, 9_000_00n),
      },
    ],
    ...over,
  };
}

const cells = allCells;

function gstr1View() {
  return {
    ...buildGstr1({ ...PERIOD, supplies: [supply()], b2clThresholdPaise: 2_50_000_00n }),
    b2clThresholdPaise: 2_50_000_00n,
    b2clThresholdVerified: false,
  };
}

function gstr3bView() {
  const summary = buildGstr3b({
    ...PERIOD,
    outward: [supply()],
    inward: [supply({ voucherType: 'purchase', voucherNo: 'BILL/0001' })],
  });
  return {
    ...summary,
    setOff: setOffInputTaxCredit({
      liability: summary.totalLiability,
      creditAvailable: summary.itcNet,
    }),
  };
}

describe('every export', () => {
  const files: [string, ExportFile][] = [
    ['gstr1', gstr1Export(gstr1View())],
    ['gstr1-hsn', gstr1HsnExport(gstr1View())],
    ['gstr3b', gstr3bExport(gstr3bView())],
    ['gstr3b-setoff', setOffExport(gstr3bView())],
    [
      'gstr2b',
      gstr2bExport(
        reconcileGstr2b({ period: '062025', portalInvoices: [], bookPurchases: [] }),
        PERIOD,
        '2025-07-11 09:00:00',
      ),
    ],
    ['tds-payable', tdsPayableExport({ rows: [], totalPaise: 0n }, PERIOD)],
    ['tds-rules', tdsRulesExport([], PERIOD)],
    ['tax-rules', taxRulesExport([], PERIOD)],
  ];

  it.each(files)('%s says it is a working and not a filing', (_name, file) => {
    const text = cells(file).join(' ');
    expect(text).toContain('Not filed anywhere');
    expect(text).toContain('chartered accountant');
  });

  it.each(files)('%s names the period it covers', (_name, file) => {
    const text = cells(file).join(' ');
    expect(text).toContain(PERIOD.from);
    expect(text).toContain(PERIOD.to);
  });

  it.each(files)('%s writes a filename safe for a download header', (_name, file) => {
    expect(file.filename).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it.each(files)('%s writes every decimal at its own exact scale, never as a float', (_name, file) => {
    // Money is exactly two places, built from integer paise; a quantity is exactly
    // four, built from the 10,000 scale. A float would show up as an exponent or at
    // some third scale that belongs to neither — 2.5, say, or 0.30000000000000004.
    for (const cell of cells(file)) {
      expect(cell).not.toMatch(/e[+-]\d/i);
      if (/^-?\d+\.\d+$/.test(cell)) {
        const places = cell.split('.')[1]!.length;
        expect([2, 4], `"${cell}" is at neither the money scale nor the quantity scale`).toContain(
          places,
        );
      }
    }
  });

  it.each(files)('%s writes a CSV and a JSON that agree cell for cell', (_name, file) => {
    const csv = toCsvFile(file);
    expect(csv.endsWith('\r\n')).toBe(true);

    const keyed = toKeyed(file);
    expect(keyed.title).toBe(file.title);
    expect(keyed.notes).toEqual(file.notes);

    // Every value in the keyed form appears in the flat form, and no row has lost
    // a cell to a missing key.
    file.tables.forEach((table, t) => {
      const keyedTable = keyed.tables[t]!;
      table.rows.forEach((row, r) => {
        const values = Object.values(keyedTable.rows[r]!);
        expect(values).toHaveLength(row.length);
        expect(values).toEqual(row.map(cellText));
      });
    });
  });

  it.each(files)('%s gives every table a header wide enough for its rows', (_name, file) => {
    for (const table of file.tables) {
      if (table.rows.length === 0) continue;
      expect(table.header, `a table of ${table.rows.length} rows has no header`).toBeDefined();
      for (const row of table.rows) {
        expect(row.length).toBeLessThanOrEqual(table.header!.length);
      }
    }
  });
});

describe('gstr1Export', () => {
  it('carries the section totals and the invoice behind them', () => {
    const text = cells(gstr1Export(gstr1View())).join('|');
    expect(text).toContain('B2B');
    expect(text).toContain('INV/2025-26/0001');
    expect(text).toContain('Acme Traders');
    expect(text).toContain('36AABCU9603R1ZO');
    // ₹1,00,000 taxable and ₹9,000 of each half.
    expect(text).toContain('100000.00');
    expect(text).toContain('9000.00');
  });

  it('says in the file whether the B2C-large threshold is verified', () => {
    // "NOT yet verified by a CA" contains "verified by a CA", so the verified case
    // is asserted by the absence of the negation rather than the presence of the
    // phrase — otherwise both branches would pass the same assertion.
    const unverified = cells(gstr1Export(gstr1View())).join(' ');
    expect(unverified).toContain('NOT yet verified by a CA');

    const verified = cells(gstr1Export({ ...gstr1View(), b2clThresholdVerified: true })).join(' ');
    expect(verified).toContain('verified by a CA');
    expect(verified).not.toContain('NOT yet verified');
  });

  it('lists the invoices missing a GSTIN so the omission travels with the file', () => {
    const view = {
      ...buildGstr1({
        ...PERIOD,
        supplies: [supply({ partyGstin: null, voucherNo: 'INV/0009' })],
        b2clThresholdPaise: 2_50_000_00n,
      }),
      b2clThresholdPaise: 2_50_000_00n,
      b2clThresholdVerified: false,
    };
    // Only asserted when the builder itself flagged it — the point is that the
    // export does not quietly drop a warning the page shows.
    if (view.invoicesMissingGstin.length > 0) {
      expect(cells(gstr1Export(view)).join(' ')).toContain('INV/0009');
    }
  });
});

describe('gstr1HsnExport', () => {
  it('unscales the quantity rather than printing the stored integer', () => {
    const text = cells(gstr1HsnExport(gstr1View())).join('|');
    expect(text).toContain('100.0000');
    expect(text).not.toContain('1000000');
    expect(text).toContain('1006');
  });
});

describe('gstr3bExport', () => {
  it('keeps each 3.1 line distinguishable', () => {
    const text = cells(gstr3bExport(gstr3bView())).join('|');
    for (const line of ['3.1(a)', '3.1(b)', '3.1(c)', '3.1(d)', '4(A)', '4(B)', '4(C)']) {
      expect(text).toContain(line);
    }
  });

  it('explains why reverse-charge tax appears twice', () => {
    expect(cells(gstr3bExport(gstr3bView())).join(' ')).toContain('Reverse-charge tax appears');
  });
});

describe('setOffExport', () => {
  it('numbers the steps and names the authority for each', () => {
    const view = gstr3bView();
    const file = setOffExport(view);
    const text = cells(file).join('|');
    expect(text).toContain('Authority');
    for (const step of view.setOff.steps) {
      expect(text).toContain(step.authority);
    }
  });

  it('shows the order, because a single payable figure would hide it', () => {
    const view = {
      ...gstr3bView(),
      setOff: setOffInputTaxCredit({
        liability: tax(50_000_00n, 10_000_00n, 10_000_00n),
        creditAvailable: tax(80_000_00n, 0n, 0n),
      }),
    };
    const steps = setOffExport(view).tables[0]!;
    expect(steps.rows.length).toBeGreaterThanOrEqual(3);
    // IGST credit is consumed against IGST liability first, then CGST, then SGST.
    expect(steps.rows.map((r) => cellText(r[2]))).toEqual(['IGST', 'CGST', 'SGST']);
  });

  it('carries the warning that the sequence is unverified', () => {
    expect(cells(setOffExport(gstr3bView())).join(' ')).toContain('rule 88A');
  });
});

describe('gstr2bExport', () => {
  it('separates the portal columns from the book columns', () => {
    const recon = reconcileGstr2b({
      period: '062025',
      portalInvoices: [
        {
          supplierGstin: '36AABCU9603R1ZO',
          supplierName: 'Acme Traders',
          invoiceNo: 'A/1',
          invoiceDate: '2025-06-05',
          taxablePaise: 100_000_00n,
          tax: tax(0n, 9_000_00n, 9_000_00n),
          itcAvailable: true,
          itcReason: null,
        },
      ],
      bookPurchases: [],
    });
    const file = gstr2bExport(recon, PERIOD, '2025-07-11 09:00:00');
    const text = cells(file).join('|');
    expect(text).toContain('Portal taxable');
    expect(text).toContain('Book taxable');
    expect(text).toContain('Credit unclaimed (in GSTR-2B, not in books)');
    expect(text).toContain('A/1');
    expect(text).toContain('2025-07-11 09:00:00');
  });

  it('leaves the missing side blank rather than writing zero', () => {
    // Zero and "we have no figure" are different statements, and a zero in the
    // book column would read as a bill entered at nil rather than one not entered.
    const recon = reconcileGstr2b({
      period: null,
      portalInvoices: [
        {
          supplierGstin: '36AABCU9603R1ZO',
          supplierName: 'Acme',
          invoiceNo: 'A/1',
          invoiceDate: '2025-06-05',
          taxablePaise: 100_00n,
          tax: tax(0n, 900n, 900n),
          itcAvailable: true,
          itcReason: null,
        },
      ],
      bookPurchases: [],
    });
    const keyed = toKeyed(gstr2bExport(recon, PERIOD, 'x'));
    const detail = keyed.tables.find((t) => t.columns.includes('Book taxable'))!;
    expect(detail.rows[0]!['Book taxable']).toBe('');
    expect(detail.rows[0]!['Portal taxable']).toBe('100.00');
  });
});

describe('tdsRulesExport', () => {
  it('marks an unverified rule in a way a reader cannot miss', () => {
    const file = tdsRulesExport(
      [
        {
          section: '194C_OTHER',
          label: '194C — Contractor, other than an individual or HUF',
          rateBps: 200,
          thresholdSinglePaise: 30_000_00n,
          thresholdAnnualPaise: 1_00_000_00n,
          effectiveFrom: '2020-04-01',
          effectiveTo: null,
          needsCaVerification: true,
          sourceNote: 'Section 194C',
        },
      ],
      PERIOD,
    );
    const text = cells(file).join('|');
    expect(text).toContain('NOT VERIFIED');
    expect(text).toContain('2.00');
    expect(text).toContain('30000.00');
    expect(text).toContain('100000.00');
    expect(text).toContain('2020-04-01');
  });
});

describe('taxRulesExport', () => {
  it('counts the unverified rules at the top of the file', () => {
    const rule = {
      id: '00000000-0000-0000-0000-000000000001',
      kind: 'tds_section',
      code: '194C_OTHER',
      label: 'Contractor',
      rateBps: 200,
      section: '194C',
      effectiveFrom: '2020-04-01',
      effectiveTo: null,
      needsCaVerification: true,
      verifiedBy: null,
      verifiedAt: null,
      sourceNote: 'Section 194C',
      isOwnRule: true,
    };
    const text = cells(taxRulesExport([rule, { ...rule, id: 'x', needsCaVerification: false }], PERIOD)).join(' ');
    expect(text).toContain('1 of 2 rules have not been verified');
    expect(text).toContain('NEEDS CA VERIFICATION');
  });
});

describe('tdsPayableExport', () => {
  it('names the total as payable to the department', () => {
    const file = tdsPayableExport(
      {
        rows: [{ accountCode: 'TDS_PAYABLE', accountName: 'TDS Payable', balancePaise: 5_000_00n }],
        totalPaise: 5_000_00n,
      },
      PERIOD,
    );
    const text = cells(file).join('|');
    expect(text).toContain('Payable to the department');
    expect(text).toContain('5000.00');
  });
});
