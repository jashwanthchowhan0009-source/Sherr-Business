/**
 * Turning a return working into a file.
 *
 * Pure: each builder takes a working that has already been computed and arranges
 * it. No figure is recalculated here, because a report and its export disagreeing
 * is worse than either being wrong alone — if the export did its own arithmetic
 * there would be two answers to the same question and no way to tell which the
 * company had acted on.
 *
 * Every file opens with provenance: what it is, which period, when it was
 * prepared, and that it is a working rather than a filing. A CSV outlives the page
 * it came from, and one found in a folder six months later must still say so.
 */
import { decimalPercent, decimalQuantity, decimalRupees, numeric, type CsvCell } from './csv';
import type { ExportFile, ExportTable } from './file';
import type { Gstr1Summary } from '@/lib/gst/returns';
import { HEAD_LABELS, type TaxAmounts } from '@/lib/gst/set-off';
import { RECON_STATUS_LABELS, type Gstr2bReconciliation } from '@/lib/gst/gstr2b';
import type { TdsRule } from '@/lib/tds/engine';
import type { Gstr1View, Gstr3bView, TdsPayableRow } from '@/server/gst-queries';

export type { ExportFile } from './file';

const DISCLAIMER =
  'A working prepared from these books. Not filed anywhere, and not professional advice. ' +
  'Figures must be verified by a chartered accountant before they are relied on.';

function notesFor(period: { from: string; to: string }, extra: string[] = []): string[] {
  return [
    `Period ${period.from} to ${period.to}`,
    `Prepared ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    ...extra,
    DISCLAIMER,
  ];
}

const TAX_HEADS: CsvCell[] = ['IGST', 'CGST', 'SGST', 'Cess'];
const taxCells = (t: TaxAmounts): CsvCell[] => [
  decimalRupees(t.igst),
  decimalRupees(t.cgst),
  decimalRupees(t.sgst),
  decimalRupees(t.cess),
];
/** The width of a tax block, for a row that has no figures to put there. */
const NO_TAX: CsvCell[] = ['', '', '', ''];

export function gstr1Export(view: Gstr1View): ExportFile {
  const byTable: ExportTable = {
    header: ['Table', 'Description', 'Invoices', 'Taxable', ...TAX_HEADS],
    rows: [
      ...view.sections.map((section) => [
        section.table.toUpperCase(),
        section.label,
        numeric(section.invoiceCount),
        decimalRupees(section.taxablePaise),
        ...taxCells(section.tax),
      ]),
      [
        'TOTAL',
        '',
        numeric(view.sections.reduce((n, s) => n + s.invoiceCount, 0)),
        decimalRupees(view.totalTaxablePaise),
        ...taxCells(view.totalTax),
      ],
    ],
  };

  const detail: ExportTable = {
    notes: ['Invoice detail — the invoices behind each table above'],
    header: [
      'Table',
      'Voucher',
      'Date',
      'Customer',
      'GSTIN',
      'Place of supply',
      'Taxable',
      ...TAX_HEADS,
    ],
    rows: view.sections.flatMap((section) =>
      section.invoices.map((inv) => [
        section.table.toUpperCase(),
        inv.voucherNo,
        inv.voucherDate,
        inv.partyName,
        inv.partyGstin,
        inv.placeOfSupplyStateCode,
        decimalRupees(inv.taxablePaise),
        ...taxCells(inv.tax),
      ]),
    ),
  };

  const exceptions: ExportTable = {
    notes: ['Rules applied, and what needs attention'],
    header: ['Item', 'Detail'],
    rows: [
      [
        'B2C large threshold per invoice',
        `${decimalRupees(view.b2clThresholdPaise).raw} — ${
          view.b2clThresholdVerified ? 'verified by a CA' : 'NOT yet verified by a CA'
        }`,
      ],
      ...(view.invoicesMissingGstin.length > 0
        ? [
            [
              'Invoices with no customer GSTIN (treated as B2C)',
              view.invoicesMissingGstin.join('; '),
            ] satisfies CsvCell[],
          ]
        : []),
      ...(view.invoicesMissingHsn.length > 0
        ? [
            [
              'Invoices with lines missing an HSN or SAC code',
              view.invoicesMissingHsn.join('; '),
            ] satisfies CsvCell[],
          ]
        : []),
    ],
  };

  return {
    filename: `gstr1-${view.from}-to-${view.to}`,
    title: 'GSTR-1 — outward supplies by table',
    notes: notesFor(view),
    tables: [byTable, detail, exceptions],
  };
}

export function gstr1HsnExport(view: Gstr1Summary): ExportFile {
  return {
    filename: `gstr1-hsn-${view.from}-to-${view.to}`,
    title: 'GSTR-1 table 12 — HSN summary',
    notes: notesFor(view),
    tables: [
      {
        header: ['HSN/SAC', 'Description', 'Quantity', 'Unit', 'Taxable', ...TAX_HEADS],
        rows: view.hsnSummary.map((row) => [
          row.hsnSac,
          row.description,
          decimalQuantity(row.quantity),
          row.unit,
          decimalRupees(row.taxablePaise),
          ...taxCells(row.tax),
        ]),
      },
    ],
  };
}

export function gstr3bExport(view: Gstr3bView): ExportFile {
  return {
    filename: `gstr3b-${view.from}-to-${view.to}`,
    title: 'GSTR-3B — summary',
    notes: notesFor(view),
    tables: [
      {
        header: ['Line', 'Taxable', ...TAX_HEADS],
        rows: [
          [
            '3.1(a) Taxable outward supplies',
            decimalRupees(view.outwardTaxable.taxablePaise),
            ...taxCells(view.outwardTaxable.tax),
          ],
          [
            '3.1(b) Zero-rated supplies',
            decimalRupees(view.outwardZeroRated.taxablePaise),
            ...taxCells(view.outwardZeroRated.tax),
          ],
          [
            '3.1(c) Nil-rated and exempt',
            decimalRupees(view.outwardNilExempt.taxablePaise),
            ...NO_TAX,
          ],
          [
            '3.1(d) Inward supplies liable to reverse charge',
            decimalRupees(view.inwardReverseCharge.taxablePaise),
            ...taxCells(view.inwardReverseCharge.tax),
          ],
          ['Total liability', '', ...taxCells(view.totalLiability)],
          ['4(A) Input tax credit available', '', ...taxCells(view.itcAvailable)],
          ['4(B) Credit reversed', '', ...taxCells(view.itcReversed)],
          ['4(C) Net credit available', '', ...taxCells(view.itcNet)],
        ],
      },
      {
        notes: [
          'Reverse-charge tax appears as both a liability on 3.1(d) and a credit on 4(A). ' +
            'The set-off working nets them, which is the correct outcome.',
        ],
        rows: [],
      },
    ],
  };
}

export function setOffExport(view: Gstr3bView): ExportFile {
  const { setOff } = view;
  return {
    filename: `gstr3b-setoff-${view.from}-to-${view.to}`,
    title: 'GSTR-3B — input tax credit set-off working',
    notes: notesFor(view, [
      'The sequence follows sections 49 and 49A with rule 88A. It has not been verified by a ' +
        "chartered accountant and must be checked against the portal's own computation before payment.",
    ]),
    tables: [
      {
        notes: ['Each step in order, with the provision it rests on'],
        header: ['Step', 'Credit used', 'Against liability', 'Amount', 'Authority'],
        rows: setOff.steps.map((step, i) => [
          numeric(i + 1),
          HEAD_LABELS[step.creditHead],
          HEAD_LABELS[step.liabilityHead],
          decimalRupees(step.amountPaise),
          step.authority,
        ]),
      },
      {
        notes: ['Position by head'],
        header: ['', ...TAX_HEADS],
        rows: [
          ['Liability', ...taxCells(setOff.liability)],
          ['Credit available', ...taxCells(setOff.creditAvailable)],
          ['Credit used', ...taxCells(setOff.creditUsed)],
          ['Credit carried forward', ...taxCells(setOff.creditCarriedForward)],
          ['Payable in cash', ...taxCells(setOff.payableInCash)],
        ],
      },
      {
        header: ['Item', 'Amount'],
        rows: [
          ['Total payable in cash', decimalRupees(setOff.totalPayableInCashPaise)],
          ['Total credit used', decimalRupees(setOff.totalCreditUsedPaise)],
        ],
      },
    ],
  };
}

export function gstr2bExport(
  recon: Gstr2bReconciliation,
  period: { from: string; to: string },
  uploadedAt: string,
): ExportFile {
  /** Five columns: taxable plus the four heads. Blank, not zero, when absent. */
  const sideCells = (taxable: bigint | null, tax: TaxAmounts | null): CsvCell[] =>
    taxable === null || tax === null ? ['', ...NO_TAX] : [decimalRupees(taxable), ...taxCells(tax)];

  return {
    filename: `gstr2b-recon-${period.from}-to-${period.to}`,
    title: 'GSTR-2B reconciliation',
    notes: notesFor(period, [
      `Portal file uploaded ${uploadedAt}`,
      `Portal period as stated in the file: ${recon.period ?? 'not stated'}`,
    ]),
    tables: [
      {
        header: ['Measure', 'Amount'],
        rows: [
          [
            'Credit at risk (claimed in books, not in GSTR-2B)',
            decimalRupees(recon.creditAtRiskPaise),
          ],
          [
            'Credit unclaimed (in GSTR-2B, not in books)',
            decimalRupees(recon.creditUnclaimedPaise),
          ],
        ],
      },
      {
        notes: [
          'A blank figure means no figure on that side at all — not a nil amount. ' +
            'Zero and "not entered" are different statements.',
        ],
        header: [
          'Status',
          'Supplier GSTIN',
          'Supplier',
          'Invoice no',
          'Invoice date',
          'Book voucher',
          'Portal taxable',
          'Portal IGST',
          'Portal CGST',
          'Portal SGST',
          'Portal cess',
          'Book taxable',
          'Book IGST',
          'Book CGST',
          'Book SGST',
          'Book cess',
          'Portal ITC available',
          'Portal ITC reason',
          'What it means',
        ],
        rows: recon.rows.map((row) => [
          RECON_STATUS_LABELS[row.status],
          row.supplierGstin,
          row.supplierName,
          row.invoiceNo,
          row.invoiceDate,
          row.bookVoucherNo,
          ...sideCells(row.portalTaxablePaise, row.portalTax),
          ...sideCells(row.bookTaxablePaise, row.bookTax),
          row.itcAvailable === null ? '' : row.itcAvailable ? 'yes' : 'no',
          row.itcReason,
          row.consequence,
        ]),
      },
    ],
  };
}

export function tdsPayableExport(
  payable: { rows: TdsPayableRow[]; totalPaise: bigint },
  period: { from: string; to: string },
): ExportFile {
  return {
    filename: `tds-payable-as-at-${period.to}`,
    title: 'Tax deducted at source — balances',
    notes: notesFor(period, [
      `Balances as at ${period.to}, from posted vouchers only.`,
      'A credit balance on TDS payable is money held on behalf of the department.',
    ]),
    tables: [
      {
        header: ['Account code', 'Account', 'Balance'],
        rows: [
          ...payable.rows.map((row) => [
            row.accountCode,
            row.accountName,
            decimalRupees(row.balancePaise),
          ]),
          ['', 'Payable to the department', decimalRupees(payable.totalPaise)],
        ],
      },
    ],
  };
}

export function tdsRulesExport(
  rules: readonly TdsRule[],
  period: { from: string; to: string },
): ExportFile {
  return {
    filename: `tds-rules-${period.to}`,
    title: 'TDS rates and thresholds applied',
    notes: notesFor(period, [
      'A payment dated in the past uses the version of a rule that was in force on that ' +
        "date, not today's.",
    ]),
    tables: [
      {
        header: [
          'Code',
          'Description',
          'Rate %',
          'Single-payment threshold',
          'Annual threshold',
          'Effective from',
          'Effective to',
          'CA verified',
          'Source',
        ],
        rows: rules.map((rule) => [
          rule.section,
          rule.label,
          decimalPercent(rule.rateBps),
          rule.thresholdSinglePaise === null ? '' : decimalRupees(rule.thresholdSinglePaise),
          rule.thresholdAnnualPaise === null ? '' : decimalRupees(rule.thresholdAnnualPaise),
          rule.effectiveFrom,
          rule.effectiveTo,
          rule.needsCaVerification ? 'NOT VERIFIED' : 'verified',
          rule.sourceNote,
        ]),
      },
    ],
  };
}

export interface TaxRuleStatusRow {
  id: string;
  kind: string;
  code: string;
  label: string;
  rateBps: number | null;
  section: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  needsCaVerification: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  sourceNote: string | null;
  isOwnRule: boolean;
}

export function taxRulesExport(
  rules: readonly TaxRuleStatusRow[],
  period: { from: string; to: string },
): ExportFile {
  const unverified = rules.filter((r) => r.needsCaVerification).length;
  return {
    filename: `tax-rule-register-${period.to}`,
    title: 'Tax rule register',
    notes: notesFor(period, [
      `${unverified} of ${rules.length} rules have not been verified by a chartered accountant.`,
      'No rate, threshold, section or due date is written into the code; each one lives in a ' +
        'versioned table with the dates it applies between.',
    ]),
    tables: [
      {
        header: [
          'Kind',
          'Code',
          'Description',
          'Section',
          'Rate %',
          'Effective from',
          'Effective to',
          'Status',
          'Verified by',
          'Verified at',
          'Source',
        ],
        rows: rules.map((rule) => [
          rule.kind,
          rule.code,
          rule.label,
          rule.section,
          rule.rateBps === null ? '' : decimalPercent(rule.rateBps),
          rule.effectiveFrom,
          rule.effectiveTo,
          rule.needsCaVerification ? 'NEEDS CA VERIFICATION' : 'verified',
          rule.verifiedBy,
          rule.verifiedAt,
          rule.sourceNote,
        ]),
      },
    ],
  };
}
