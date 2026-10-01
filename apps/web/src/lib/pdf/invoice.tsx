import 'server-only';
import { join } from 'node:path';
import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import { amountInWords } from '@/lib/accounting/amount-in-words';
import { formatQuantity } from '@/lib/accounting/units';
import { formatRupees, paise } from '@/lib/money';
import { STATE_CODES } from '@/lib/india/gstin';

/**
 * The GST tax invoice, as a real PDF.
 *
 * Every figure is read off the stored voucher and its lines. Nothing is
 * recalculated here: a printed invoice is a legal document, and reprinting one
 * from 2025 must produce the 2025 figures even if a rate, a price or the
 * calculation engine has changed since.
 *
 * The font is a subset of DejaVu Sans carried in the repo, because the fourteen
 * fonts built into PDF use WinAnsi encoding, which has no rupee sign — an
 * invoice rendered in Helvetica prints every amount with a missing glyph.
 */

let fontsRegistered = false;

async function registerFonts(): Promise<void> {
  if (fontsRegistered) return;
  const dir = join(process.cwd(), 'src', 'lib', 'pdf', 'fonts');
  // Absolute paths on disk, so the renderer never makes a network call while
  // producing an invoice.
  Font.register({
    family: 'Invoice',
    fonts: [
      { src: join(dir, 'invoice-regular.ttf'), fontWeight: 400 },
      { src: join(dir, 'invoice-bold.ttf'), fontWeight: 700 },
    ],
  });
  // Hyphenation off: breaking "Enterprises" across lines on an invoice looks
  // like a defect, and the columns are sized for whole words.
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

const styles = StyleSheet.create({
  page: { fontFamily: 'Invoice', fontSize: 8.5, padding: 28, color: '#111' },
  title: { fontSize: 13, fontWeight: 700, textAlign: 'center', marginBottom: 2 },
  subtitle: { fontSize: 7.5, textAlign: 'center', color: '#555', marginBottom: 10 },
  frame: { borderWidth: 0.7, borderColor: '#333' },
  row: { flexDirection: 'row' },
  partyBox: { width: '50%', padding: 7 },
  partyBoxRight: { width: '50%', padding: 7, borderLeftWidth: 0.7, borderLeftColor: '#333' },
  metaBox: { padding: 7, borderTopWidth: 0.7, borderTopColor: '#333' },
  boxLabel: { fontSize: 6.8, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 },
  partyName: { fontSize: 9.5, fontWeight: 700, marginTop: 2, marginBottom: 2 },
  line: { marginBottom: 1 },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  metaCell: { width: '25%', paddingRight: 6, marginBottom: 4 },
  metaValue: { fontSize: 8.5, marginTop: 1 },

  thead: {
    flexDirection: 'row',
    borderTopWidth: 0.7,
    borderTopColor: '#333',
    borderBottomWidth: 0.7,
    borderBottomColor: '#333',
    backgroundColor: '#f2f2f2',
  },
  tr: { flexDirection: 'row', borderBottomWidth: 0.4, borderBottomColor: '#bbb' },
  th: { fontSize: 6.8, fontWeight: 700, padding: 4, textTransform: 'uppercase' },
  td: { fontSize: 8, padding: 4 },
  cSr: { width: '5%' },
  cDesc: { width: '33%' },
  cHsn: { width: '10%' },
  cQty: { width: '10%', textAlign: 'right' },
  cRate: { width: '12%', textAlign: 'right' },
  cTaxable: { width: '13%', textAlign: 'right' },
  cTax: { width: '8%', textAlign: 'right' },
  cTotal: { width: '17%', textAlign: 'right' },

  totalsWrap: { flexDirection: 'row', borderTopWidth: 0.7, borderTopColor: '#333' },
  wordsBox: { width: '58%', padding: 7, borderRightWidth: 0.7, borderRightColor: '#333' },
  totalsBox: { width: '42%' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2.5, paddingHorizontal: 7 },
  totalRowStrong: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    paddingHorizontal: 7,
    borderTopWidth: 0.7,
    borderTopColor: '#333',
    backgroundColor: '#f2f2f2',
  },
  strong: { fontWeight: 700 },
  words: { fontSize: 8.5, marginTop: 3 },

  footer: { flexDirection: 'row', borderTopWidth: 0.7, borderTopColor: '#333' },
  declaration: { width: '62%', padding: 7, borderRightWidth: 0.7, borderRightColor: '#333' },
  signature: { width: '38%', padding: 7, alignItems: 'flex-end', justifyContent: 'space-between', minHeight: 62 },
  tiny: { fontSize: 6.8, color: '#555', lineHeight: 1.35 },
  prepared: { marginTop: 10, fontSize: 6.8, color: '#666', textAlign: 'center' },
  draftMark: {
    marginTop: 6,
    marginBottom: 2,
    padding: 4,
    borderWidth: 0.7,
    borderColor: '#b35c00',
    color: '#b35c00',
    fontSize: 8,
    fontWeight: 700,
    textAlign: 'center',
  },
});

export interface InvoicePdfInput {
  company: {
    legalName: string;
    tradeName: string | null;
    gstin: string | null;
    pan: string | null;
    stateCode: string | null;
  };
  voucher: {
    voucherNo: string;
    voucherDate: string;
    status: string;
    reference: string | null;
    narration: string | null;
    supplyType: string | null;
    supplierStateCode: string | null;
    placeOfSupplyStateCode: string | null;
    taxablePaise: bigint;
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    cessPaise: bigint;
    roundOffPaise: bigint;
    totalPaise: bigint;
  };
  party: {
    name: string;
    legalName: string | null;
    gstin: string | null;
    stateCode: string | null;
    billingAddress: string | null;
  } | null;
  lines: readonly {
    lineNo: number;
    description: string;
    hsnSac: string | null;
    unit: string | null;
    quantity: bigint;
    unitPricePaise: bigint;
    gstRateBps: number;
    taxablePaise: bigint;
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    lineTotalPaise: bigint;
  }[];
}

const money = (value: bigint) => formatRupees(paise(value));
const rate = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const stateName = (code: string | null) =>
  code ? `${STATE_CODES[code] ?? 'Unknown state'} (${code})` : '—';

const SUPPLY_LABELS: Record<string, string> = {
  intra_state: 'Intra-state — CGST + SGST',
  inter_state: 'Inter-state — IGST',
  zero_rated: 'Zero-rated (export or SEZ)',
  exempt: 'Exempt / nil-rated',
};

function InvoiceDocument({ company, voucher, party, lines }: InvoicePdfInput) {
  const intra = voucher.supplyType === 'intra_state';
  const taxLabel = intra ? 'CGST + SGST' : 'IGST';
  const taxOf = (line: InvoicePdfInput['lines'][number]) =>
    intra ? line.cgstPaise + line.sgstPaise : line.igstPaise;

  return (
    <Document
      title={`Tax invoice ${voucher.voucherNo}`}
      author={company.legalName}
      creator="SherrByte Business"
      producer="SherrByte Business"
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Tax Invoice</Text>
        <Text style={styles.subtitle}>
          {company.gstin
            ? 'Issued under the Central Goods and Services Tax Act, 2017'
            : 'This business is not GST-registered. No tax has been charged.'}
        </Text>

        {/* A draft is not an invoice. Printing one without saying so would let
            an unissued document circulate as if it had been issued. */}
        {voucher.status !== 'posted' ? (
          <Text style={styles.draftMark}>
            DRAFT — not posted to the books, and not a valid tax invoice
          </Text>
        ) : null}

        <View style={styles.frame}>
          <View style={styles.row}>
            <View style={styles.partyBox}>
              <Text style={styles.boxLabel}>Supplier</Text>
              <Text style={styles.partyName}>{company.legalName}</Text>
              {company.tradeName ? (
                <Text style={styles.line}>Trading as {company.tradeName}</Text>
              ) : null}
              {company.gstin ? <Text style={styles.line}>GSTIN {company.gstin}</Text> : null}
              {company.pan ? <Text style={styles.line}>PAN {company.pan}</Text> : null}
              <Text style={styles.line}>State {stateName(company.stateCode)}</Text>
            </View>

            <View style={styles.partyBoxRight}>
              <Text style={styles.boxLabel}>Recipient</Text>
              <Text style={styles.partyName}>{party?.name ?? 'Cash sale'}</Text>
              {party?.legalName && party.legalName !== party.name ? (
                <Text style={styles.line}>{party.legalName}</Text>
              ) : null}
              {party?.billingAddress ? (
                <Text style={styles.line}>{party.billingAddress}</Text>
              ) : null}
              <Text style={styles.line}>
                GSTIN {party?.gstin ?? 'Unregistered'}
              </Text>
              <Text style={styles.line}>State {stateName(party?.stateCode ?? null)}</Text>
            </View>
          </View>

          <View style={styles.metaBox}>
            <View style={styles.metaGrid}>
              <View style={styles.metaCell}>
                <Text style={styles.boxLabel}>Invoice no.</Text>
                <Text style={styles.metaValue}>{voucher.voucherNo}</Text>
              </View>
              <View style={styles.metaCell}>
                <Text style={styles.boxLabel}>Date</Text>
                <Text style={styles.metaValue}>{formatDate(voucher.voucherDate)}</Text>
              </View>
              <View style={styles.metaCell}>
                <Text style={styles.boxLabel}>Place of supply</Text>
                <Text style={styles.metaValue}>
                  {stateName(voucher.placeOfSupplyStateCode)}
                </Text>
              </View>
              <View style={styles.metaCell}>
                <Text style={styles.boxLabel}>Supply</Text>
                <Text style={styles.metaValue}>
                  {SUPPLY_LABELS[voucher.supplyType ?? ''] ?? '—'}
                </Text>
              </View>
              {voucher.reference ? (
                <View style={styles.metaCell}>
                  <Text style={styles.boxLabel}>Reference</Text>
                  <Text style={styles.metaValue}>{voucher.reference}</Text>
                </View>
              ) : null}
            </View>
          </View>

          <View style={styles.thead}>
            <Text style={[styles.th, styles.cSr]}>#</Text>
            <Text style={[styles.th, styles.cDesc]}>Description</Text>
            <Text style={[styles.th, styles.cHsn]}>HSN/SAC</Text>
            <Text style={[styles.th, styles.cQty]}>Qty</Text>
            <Text style={[styles.th, styles.cRate]}>Rate</Text>
            <Text style={[styles.th, styles.cTaxable]}>Taxable</Text>
            <Text style={[styles.th, styles.cTax]}>GST</Text>
            <Text style={[styles.th, styles.cTotal]}>{taxLabel}</Text>
          </View>

          {lines.map((line) => (
            <View style={styles.tr} key={line.lineNo} wrap={false}>
              <Text style={[styles.td, styles.cSr]}>{line.lineNo}</Text>
              <Text style={[styles.td, styles.cDesc]}>{line.description}</Text>
              <Text style={[styles.td, styles.cHsn]}>{line.hsnSac ?? '—'}</Text>
              <Text style={[styles.td, styles.cQty]}>
                {formatQuantity(line.quantity)}
                {line.unit ? ` ${line.unit}` : ''}
              </Text>
              <Text style={[styles.td, styles.cRate]}>{money(line.unitPricePaise)}</Text>
              <Text style={[styles.td, styles.cTaxable]}>{money(line.taxablePaise)}</Text>
              <Text style={[styles.td, styles.cTax]}>{rate(line.gstRateBps)}</Text>
              <Text style={[styles.td, styles.cTotal]}>{money(taxOf(line))}</Text>
            </View>
          ))}

          <View style={styles.totalsWrap}>
            <View style={styles.wordsBox}>
              <Text style={styles.boxLabel}>Total in words</Text>
              <Text style={styles.words}>{amountInWords(voucher.totalPaise)}</Text>
              {voucher.narration ? (
                <>
                  <Text style={[styles.boxLabel, { marginTop: 8 }]}>Note</Text>
                  <Text style={styles.line}>{voucher.narration}</Text>
                </>
              ) : null}
            </View>

            <View style={styles.totalsBox}>
              <View style={styles.totalRow}>
                <Text>Taxable value</Text>
                <Text>{money(voucher.taxablePaise)}</Text>
              </View>
              {voucher.cgstPaise > 0n ? (
                <View style={styles.totalRow}>
                  <Text>CGST</Text>
                  <Text>{money(voucher.cgstPaise)}</Text>
                </View>
              ) : null}
              {voucher.sgstPaise > 0n ? (
                <View style={styles.totalRow}>
                  <Text>SGST</Text>
                  <Text>{money(voucher.sgstPaise)}</Text>
                </View>
              ) : null}
              {voucher.igstPaise > 0n ? (
                <View style={styles.totalRow}>
                  <Text>IGST</Text>
                  <Text>{money(voucher.igstPaise)}</Text>
                </View>
              ) : null}
              {voucher.cessPaise > 0n ? (
                <View style={styles.totalRow}>
                  <Text>Compensation cess</Text>
                  <Text>{money(voucher.cessPaise)}</Text>
                </View>
              ) : null}
              {voucher.roundOffPaise !== 0n ? (
                <View style={styles.totalRow}>
                  <Text>Round off</Text>
                  <Text>{money(voucher.roundOffPaise)}</Text>
                </View>
              ) : null}
              <View style={styles.totalRowStrong}>
                <Text style={styles.strong}>Total</Text>
                <Text style={styles.strong}>{money(voucher.totalPaise)}</Text>
              </View>
            </View>
          </View>

          <View style={styles.footer}>
            <View style={styles.declaration}>
              <Text style={styles.boxLabel}>Declaration</Text>
              <Text style={styles.tiny}>
                We declare that this invoice shows the actual price of the goods or services
                described and that all particulars are true and correct.
              </Text>
              {voucher.supplyType === 'zero_rated' ? (
                <Text style={[styles.tiny, { marginTop: 4 }]}>
                  Supply meant for export or to an SEZ unit. Tax is charged at nil under the
                  zero-rating provisions; confirm the applicable route and documentation with
                  your advisor.
                </Text>
              ) : null}
            </View>
            <View style={styles.signature}>
              <Text style={styles.tiny}>For {company.legalName}</Text>
              <Text style={styles.tiny}>Authorised signatory</Text>
            </View>
          </View>
        </View>

        <Text style={styles.prepared}>
          Prepared by SherrByte — review by a qualified professional. SherrByte does not provide
          an audit opinion and does not guarantee tax compliance.
        </Text>
      </Page>
    </Document>
  );
}

/** `2025-06-15` to `15 Jun 2025`, without going through a Date and a timezone. */
function formatDate(isoDate: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [year, month, day] = isoDate.split('-');
  const index = Number(month) - 1;
  return `${day} ${MONTHS[index] ?? month} ${year}`;
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  await registerFonts();
  return renderToBuffer(<InvoiceDocument {...input} />);
}
