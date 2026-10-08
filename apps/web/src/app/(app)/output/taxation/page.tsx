import { Fragment } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/shell/PageHeader';
import { Band, EmptyState, type MetricStatus, Panel, StatusPill, Table, ui } from '@/components/ui';
import { formatRupees, paise } from '@/lib/money';
import { can } from '@/lib/auth/permissions';
import { getCompany } from '@/server/queries';
import {
  getGstr1,
  getGstr3b,
  getStoredGstr2bRecon,
  getTaxRuleStatus,
  getTdsPayable,
  getTdsRules,
} from '@/server/gst-queries';
import { RECON_STATUS_LABELS, type ReconStatus } from '@/lib/gst/gstr2b';
import { HEAD_LABELS, type TaxAmounts } from '@/lib/gst/set-off';
import { Gstr2bUpload } from './Gstr2bUpload';
import { VerifyRuleForm } from './VerifyRuleForm';
import { withContext } from '../../_guard';

export const dynamic = 'force-dynamic';

/**
 * Returns and deductions.
 *
 * Everything on this page is a **working**, not a filing. Nothing is submitted to
 * any portal and no credit is claimed: the figures are what these books say,
 * arranged the way the return asks for them, so that a professional can check
 * them against the portal and file. Every rule behind a rate or a threshold is
 * versioned, and the register at the foot of the page says which of them a CA has
 * signed off and which have not been looked at yet.
 */
export default async function TaxationPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  return withContext(async (ctx) => {
    const params = await searchParams;
    const { org } = await getCompany(ctx);
    const period = resolvePeriod(params);

    const [gstr1, gstr3b, recon, tdsRules, tdsPayable, rules] = await Promise.all([
      getGstr1(ctx, period),
      getGstr3b(ctx, period),
      getStoredGstr2bRecon(ctx, period),
      getTdsRules(ctx),
      getTdsPayable(ctx, period.to),
      can(ctx.role, 'taxrule:read') ? getTaxRuleStatus(ctx) : Promise.resolve([]),
    ]);

    const unverified = rules.filter((r) => r.needsCaVerification).length;
    const exportQuery = `from=${period.from}&to=${period.to}`;

    return (
      <>
        <PageHeader
          title="Taxation"
          subtitle={`Return workings for ${period.from} to ${period.to}. Nothing here is filed.`}
        />

        <Panel
          title="Period"
          note="A return covers one month or one quarter. Change the dates to recompute everything below."
        >
          {/* A plain GET form: the period belongs in the URL so a working can be
              linked to and reloaded, and so no figure depends on client state. */}
          <form method="get" className={ui.formGrid}>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="from">From</label>
              <input className={ui.input} id="from" name="from" type="date" defaultValue={period.from} />
            </div>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="to">To</label>
              <input className={ui.input} id="to" name="to" type="date" defaultValue={period.to} />
            </div>
            <div className={ui.field} style={{ justifyContent: 'flex-end' }}>
              <button className={ui.button} type="submit">Recompute</button>
            </div>
          </form>
          <p className={ui.hint}>
            <Link href="/output">← Back to the rest of the reports</Link>
          </p>
        </Panel>

        {/* ─── GSTR-1 ─────────────────────────────────────────────────── */}
        <Band>GSTR-1 — outward supplies</Band>
        <Panel
          title="By table"
          note="Drawn from posted sales invoices and credit notes. A credit note reduces its table rather than appearing separately, so each line is net."
        >
          {gstr1.sections.length === 0 ? (
            <EmptyState title="No outward supplies in this period">
              Raise an invoice on the Process page and it will appear here.
            </EmptyState>
          ) : (
            <Table
              head={
                <tr>
                  <th>Table</th>
                  <th className={ui.right}>Invoices</th>
                  <th className={ui.right}>Taxable</th>
                  <th className={ui.right}>IGST</th>
                  <th className={ui.right}>CGST</th>
                  <th className={ui.right}>SGST</th>
                  <th className={ui.right}>Cess</th>
                </tr>
              }
            >
              {gstr1.sections.map((section) => (
                <tr key={section.table}>
                  <td>
                    <b>{section.table.toUpperCase()}</b> · {section.label}
                  </td>
                  <td className={`${ui.right} tnum`}>{section.invoiceCount}</td>
                  <td className={`${ui.right} tnum`}>{formatRupees(paise(section.taxablePaise))}</td>
                  <TaxCells tax={section.tax} />
                </tr>
              ))}
              <tr>
                <td><b>Total</b></td>
                <td className={`${ui.right} tnum`}>
                  {gstr1.sections.reduce((n, s) => n + s.invoiceCount, 0)}
                </td>
                <td className={`${ui.right} tnum`}>
                  <b>{formatRupees(paise(gstr1.totalTaxablePaise))}</b>
                </td>
                <TaxCells tax={gstr1.totalTax} bold />
              </tr>
            </Table>
          )}

          <p className={ui.hint}>
            B2C large uses a threshold of {formatRupees(paise(gstr1.b2clThresholdPaise))} per
            invoice, held as a versioned rule and{' '}
            {gstr1.b2clThresholdVerified ? 'signed off by a CA.' : 'not yet verified by a CA.'}
          </p>

          {gstr1.invoicesMissingGstin.length > 0 ? (
            <p className={ui.statusErr}>
              {gstr1.invoicesMissingGstin.length} invoice
              {gstr1.invoicesMissingGstin.length === 1 ? '' : 's'} to a registered customer carry no
              GSTIN, so they have fallen into B2C: {gstr1.invoicesMissingGstin.slice(0, 8).join(', ')}
              {gstr1.invoicesMissingGstin.length > 8 ? ' …' : ''}. Your customer cannot claim credit
              on these.
            </p>
          ) : null}
          {gstr1.invoicesMissingHsn.length > 0 ? (
            <p className={ui.hint}>
              {gstr1.invoicesMissingHsn.length} invoice
              {gstr1.invoicesMissingHsn.length === 1 ? '' : 's'} have lines with no HSN or SAC code,
              which the HSN summary needs: {gstr1.invoicesMissingHsn.slice(0, 8).join(', ')}
              {gstr1.invoicesMissingHsn.length > 8 ? ' …' : ''}.
            </p>
          ) : null}

          <ExportLinks report="gstr1" query={exportQuery} />
        </Panel>

        <div style={{ marginTop: 20 }}>
          <Panel title="HSN summary" note="Table 12. Quantities are summed per HSN and unit.">
            {gstr1.hsnSummary.length === 0 ? (
              <EmptyState title="Nothing to summarise">
                Invoice lines need an HSN or SAC code to appear here.
              </EmptyState>
            ) : (
              <Table
                head={
                  <tr>
                    <th>HSN / SAC</th>
                    <th>Description</th>
                    <th className={ui.right}>Quantity</th>
                    <th>Unit</th>
                    <th className={ui.right}>Taxable</th>
                    <th className={ui.right}>IGST</th>
                    <th className={ui.right}>CGST</th>
                    <th className={ui.right}>SGST</th>
                    <th className={ui.right}>Cess</th>
                  </tr>
                }
              >
                {gstr1.hsnSummary.map((row) => (
                  <tr key={`${row.hsnSac}-${row.unit ?? ''}`}>
                    <td className="tnum">{row.hsnSac}</td>
                    <td>{row.description}</td>
                    <td className={`${ui.right} tnum`}>{formatQuantity(row.quantity)}</td>
                    <td>{row.unit ?? '—'}</td>
                    <td className={`${ui.right} tnum`}>{formatRupees(paise(row.taxablePaise))}</td>
                    <TaxCells tax={row.tax} />
                  </tr>
                ))}
              </Table>
            )}
            <ExportLinks report="gstr1-hsn" query={exportQuery} />
          </Panel>
        </div>

        {/* ─── GSTR-3B ────────────────────────────────────────────────── */}
        <Band>GSTR-3B — summary and set-off</Band>
        <Panel title="Liability and credit">
          <Table
            head={
              <tr>
                <th>Line</th>
                <th className={ui.right}>Taxable</th>
                <th className={ui.right}>IGST</th>
                <th className={ui.right}>CGST</th>
                <th className={ui.right}>SGST</th>
                <th className={ui.right}>Cess</th>
              </tr>
            }
          >
            <tr>
              <td>3.1(a) Taxable outward supplies</td>
              <td className={`${ui.right} tnum`}>
                {formatRupees(paise(gstr3b.outwardTaxable.taxablePaise))}
              </td>
              <TaxCells tax={gstr3b.outwardTaxable.tax} />
            </tr>
            <tr>
              <td>3.1(b) Zero-rated supplies</td>
              <td className={`${ui.right} tnum`}>
                {formatRupees(paise(gstr3b.outwardZeroRated.taxablePaise))}
              </td>
              <TaxCells tax={gstr3b.outwardZeroRated.tax} />
            </tr>
            <tr>
              <td>3.1(c) Nil-rated and exempt</td>
              <td className={`${ui.right} tnum`}>
                {formatRupees(paise(gstr3b.outwardNilExempt.taxablePaise))}
              </td>
              <td className={ui.right} colSpan={4}>—</td>
            </tr>
            <tr>
              <td>3.1(d) Inward supplies liable to reverse charge</td>
              <td className={`${ui.right} tnum`}>
                {formatRupees(paise(gstr3b.inwardReverseCharge.taxablePaise))}
              </td>
              <TaxCells tax={gstr3b.inwardReverseCharge.tax} />
            </tr>
            <tr>
              <td><b>Total liability</b></td>
              <td className={ui.right}>—</td>
              <TaxCells tax={gstr3b.totalLiability} bold />
            </tr>
            <tr>
              <td>4(A) Input tax credit available</td>
              <td className={ui.right}>—</td>
              <TaxCells tax={gstr3b.itcAvailable} />
            </tr>
            <tr>
              <td>4(B) Credit reversed</td>
              <td className={ui.right}>—</td>
              <TaxCells tax={gstr3b.itcReversed} />
            </tr>
            <tr>
              <td><b>4(C) Net credit available</b></td>
              <td className={ui.right}>—</td>
              <TaxCells tax={gstr3b.itcNet} bold />
            </tr>
          </Table>
          <p className={ui.hint}>
            Reverse-charge tax appears twice on purpose: once as a liability on 3.1(d) and once as
            credit on 4(A). The set-off below nets them, which is the correct outcome.
          </p>
          <ExportLinks report="gstr3b" query={exportQuery} />
        </Panel>

        <div style={{ marginTop: 20 }}>
          <Panel
            title="Set-off working"
            note="Each step in order, with the provision it rests on. The order is the part a CA needs to check, so it is shown rather than summarised."
          >
            {gstr3b.setOff.steps.length === 0 ? (
              <EmptyState title="Nothing to set off">
                Either there is no liability in this period, or no credit to apply against it.
              </EmptyState>
            ) : (
              <Table
                head={
                  <tr>
                    <th className={ui.right}>#</th>
                    <th>Credit used</th>
                    <th>Against liability</th>
                    <th className={ui.right}>Amount</th>
                    <th>Authority</th>
                  </tr>
                }
              >
                {gstr3b.setOff.steps.map((step, i) => (
                  <tr key={i}>
                    <td className={`${ui.right} tnum`}>{i + 1}</td>
                    <td>{HEAD_LABELS[step.creditHead]}</td>
                    <td>{HEAD_LABELS[step.liabilityHead]}</td>
                    <td className={`${ui.right} tnum`}>{formatRupees(paise(step.amountPaise))}</td>
                    <td className={ui.hint}>{step.authority}</td>
                  </tr>
                ))}
              </Table>
            )}

            <div style={{ marginTop: 16 }}>
              <Table
                head={
                  <tr>
                    <th>After set-off</th>
                    <th className={ui.right}>IGST</th>
                    <th className={ui.right}>CGST</th>
                    <th className={ui.right}>SGST</th>
                    <th className={ui.right}>Cess</th>
                  </tr>
                }
              >
                <tr>
                  <td>Credit used</td>
                  <TaxCells tax={gstr3b.setOff.creditUsed} />
                </tr>
                <tr>
                  <td>Credit carried forward</td>
                  <TaxCells tax={gstr3b.setOff.creditCarriedForward} />
                </tr>
                <tr>
                  <td><b>Payable in cash</b></td>
                  <TaxCells tax={gstr3b.setOff.payableInCash} bold />
                </tr>
              </Table>
            </div>

            <p className={ui.statusOk} style={{ marginTop: 12 }}>
              Cash payable in total: {formatRupees(paise(gstr3b.setOff.totalPayableInCashPaise))}.
              Credit used: {formatRupees(paise(gstr3b.setOff.totalCreditUsedPaise))}.
            </p>
            <p className={ui.hint}>
              A set-off working is not a filing and not advice. The sequence follows sections 49 and
              49A with rule 88A; a professional must confirm it against the portal&apos;s own
              computation before you pay.
            </p>
            <ExportLinks report="gstr3b-setoff" query={exportQuery} />
          </Panel>
        </div>

        {/* ─── GSTR-2B ────────────────────────────────────────────────── */}
        <Band>GSTR-2B reconciliation</Band>
        <Panel title="Upload the portal file">
          <Gstr2bUpload
            periodFrom={period.from}
            periodTo={period.to}
            readOnly={!can(ctx.role, 'voucher:post')}
          />
        </Panel>

        <div style={{ marginTop: 20 }}>
          <Panel
            title="Differences"
            note={
              recon
                ? `Against the file uploaded on ${recon.uploadedAt.slice(0, 16)}.`
                : 'No GSTR-2B has been uploaded for this period yet.'
            }
          >
            {!recon ? (
              <EmptyState title="Nothing to reconcile">
                Upload the period&apos;s GSTR-2B JSON above and the differences appear here.
              </EmptyState>
            ) : (
              <>
                <div className={ui.formGrid} style={{ marginBottom: 12 }}>
                  <p className={ui.statusErr} style={{ margin: 0 }}>
                    Credit at risk: {formatRupees(paise(recon.reconciliation.creditAtRiskPaise))} —
                    taken in the books but not supported by GSTR-2B.
                  </p>
                  <p className={ui.statusOk} style={{ margin: 0 }}>
                    Credit unclaimed: {formatRupees(paise(recon.reconciliation.creditUnclaimedPaise))}{' '}
                    — in GSTR-2B but not in the books.
                  </p>
                </div>

                <Table
                  head={
                    <tr>
                      <th>Status</th>
                      <th>Supplier</th>
                      <th>Invoice</th>
                      <th className={ui.right}>Portal tax</th>
                      <th className={ui.right}>Book tax</th>
                      <th>What it means</th>
                    </tr>
                  }
                >
                  {recon.reconciliation.rows.map((row, i) => (
                    <tr key={`${row.invoiceNo}-${row.supplierGstin ?? ''}-${i}`}>
                      <td>
                        <StatusPill status={statusTone(row.status)}>
                          {RECON_STATUS_LABELS[row.status]}
                        </StatusPill>
                      </td>
                      <td>
                        {row.supplierName ?? '—'}
                        <br />
                        <span className={ui.hint}>{row.supplierGstin ?? 'No GSTIN'}</span>
                      </td>
                      <td>
                        {row.invoiceNo}
                        <br />
                        <span className={ui.hint}>
                          {row.invoiceDate ?? '—'}
                          {row.bookVoucherNo ? ` · ${row.bookVoucherNo}` : ''}
                        </span>
                      </td>
                      <td className={`${ui.right} tnum`}>
                        {row.portalTax === null ? '—' : formatRupees(paise(totalTax(row.portalTax)))}
                      </td>
                      <td className={`${ui.right} tnum`}>
                        {row.bookTax === null ? '—' : formatRupees(paise(totalTax(row.bookTax)))}
                      </td>
                      <td className={ui.hint}>
                        {row.consequence}
                        {row.itcAvailable === false && row.itcReason
                          ? ` The portal says credit is not available: ${row.itcReason}`
                          : ''}
                      </td>
                    </tr>
                  ))}
                </Table>
                <ExportLinks report="gstr2b" query={exportQuery} />
              </>
            )}
          </Panel>
        </div>

        {/* ─── TDS ────────────────────────────────────────────────────── */}
        <Band>Tax deducted at source</Band>
        <Panel
          title="Payable"
          note={`Deducted and not yet paid over, as at ${period.to}. Drawn from posted vouchers only.`}
        >
          {tdsPayable.rows.length === 0 ? (
            <EmptyState title="No TDS movement">
              Nothing has been deducted or suffered yet.
            </EmptyState>
          ) : (
            <Table
              head={
                <tr>
                  <th>Account</th>
                  <th className={ui.right}>Balance</th>
                </tr>
              }
            >
              {tdsPayable.rows.map((row) => (
                <tr key={row.accountCode}>
                  <td>
                    {row.accountName} <span className={ui.hint}>{row.accountCode}</span>
                  </td>
                  <td className={`${ui.right} tnum`}>{formatRupees(paise(row.balancePaise))}</td>
                </tr>
              ))}
              <tr>
                <td><b>Payable to the department</b></td>
                <td className={`${ui.right} tnum`}>
                  <b>{formatRupees(paise(tdsPayable.totalPaise))}</b>
                </td>
              </tr>
            </Table>
          )}
          <p className={ui.hint}>
            A credit balance on TDS payable is money held on someone else&apos;s behalf. It is due by
            the 7th of the following month — your CA will confirm the date for your case.
          </p>
          <ExportLinks report="tds-payable" query={exportQuery} />
        </Panel>

        <div style={{ marginTop: 20 }}>
          <Panel
            title="Rates applied"
            note="The versioned rules the suggestion engine draws on. A payment entered for an earlier date uses the version in force on that date, not today's."
          >
            <Table
              head={
                <tr>
                  <th>Section</th>
                  <th className={ui.right}>Rate</th>
                  <th className={ui.right}>Single payment</th>
                  <th className={ui.right}>Annual</th>
                  <th>In force</th>
                  <th>Verified</th>
                </tr>
              }
            >
              {tdsRules.map((rule) => (
                <tr key={`${rule.section}-${rule.effectiveFrom}`}>
                  <td>{rule.label}</td>
                  <td className={`${ui.right} tnum`}>{(rule.rateBps / 100).toFixed(2)}%</td>
                  <td className={`${ui.right} tnum`}>
                    {rule.thresholdSinglePaise === null
                      ? '—'
                      : formatRupees(paise(rule.thresholdSinglePaise))}
                  </td>
                  <td className={`${ui.right} tnum`}>
                    {rule.thresholdAnnualPaise === null
                      ? '—'
                      : formatRupees(paise(rule.thresholdAnnualPaise))}
                  </td>
                  <td className={ui.hint}>
                    {rule.effectiveFrom} → {rule.effectiveTo ?? 'current'}
                  </td>
                  <td>
                    <StatusPill status={rule.needsCaVerification ? 'provisional' : 'verified'}>
                      {rule.needsCaVerification ? 'Needs CA' : 'Verified'}
                    </StatusPill>
                  </td>
                </tr>
              ))}
            </Table>
            <ExportLinks report="tds-rules" query={exportQuery} />
          </Panel>
        </div>

        {/* ─── the rule register ─────────────────────────────────────── */}
        <Band>Tax rule register</Band>
        <Panel
          title={unverified === 0 ? 'All rules signed off' : `${unverified} rules need a CA`}
          note="No rate, threshold, section or due date is written into the code. Each one lives here with the dates it applies between, and carries a marker until a professional has checked it."
        >
          {!can(ctx.role, 'taxrule:read') ? (
            <p className={ui.hint}>Your role cannot see the rule register.</p>
          ) : rules.length === 0 ? (
            <EmptyState title="No rules loaded">
              Run the migrations to seed the rule table.
            </EmptyState>
          ) : (
            <>
              {unverified > 0 ? (
                <p className={ui.statusErr}>
                  {unverified} of {rules.length} rules have not been verified by a chartered
                  accountant. Figures that depend on them are workings, not filings. This product
                  does not replace a CA and does not guarantee tax compliance.
                </p>
              ) : null}
              <Table
                head={
                  <tr>
                    <th>Rule</th>
                    <th className={ui.right}>Rate</th>
                    <th>In force</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Sign-off</th>
                  </tr>
                }
              >
                {rules.map((rule) => (
                  <Fragment key={rule.id}>
                    <tr>
                      <td>
                        {rule.label}
                        <br />
                        <span className={ui.hint}>
                          {rule.kind} · {rule.code}
                          {rule.section ? ` · ${rule.section}` : ''}
                        </span>
                      </td>
                      <td className={`${ui.right} tnum`}>
                        {rule.rateBps === null ? '—' : `${(rule.rateBps / 100).toFixed(2)}%`}
                      </td>
                      <td className={ui.hint}>
                        {rule.effectiveFrom} → {rule.effectiveTo ?? 'current'}
                      </td>
                      <td>
                        <StatusPill status={rule.needsCaVerification ? 'provisional' : 'verified'}>
                          {rule.needsCaVerification ? 'Needs CA verification' : 'Verified'}
                        </StatusPill>
                        {rule.verifiedBy ? (
                          <>
                            <br />
                            <span className={ui.hint}>
                              {rule.verifiedBy}
                              {rule.verifiedAt ? ` · ${rule.verifiedAt.slice(0, 10)}` : ''}
                            </span>
                          </>
                        ) : null}
                      </td>
                      <td className={ui.hint}>{rule.sourceNote ?? '—'}</td>
                      <td>
                        {rule.needsCaVerification && can(ctx.role, 'taxrule:verify') ? (
                          <VerifyRuleForm
                            ruleId={rule.id}
                            ruleLabel={rule.label}
                            isOwnRule={rule.isOwnRule}
                          />
                        ) : (
                          <span className={ui.hint}>—</span>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </Table>
              <ExportLinks report="tax-rules" query={exportQuery} />
            </>
          )}
        </Panel>

        <p className={ui.hint} style={{ marginTop: 24 }}>
          {org?.legalName ?? 'This company'} — these are workings prepared from your own books. They
          are not filed anywhere and they are not professional advice. SherrByte does not replace a
          chartered accountant and does not guarantee tax compliance.
        </p>
      </>
    );
  });
}

/**
 * The period to report on.
 *
 * Defaults to the month that has just ended rather than the one in progress: a
 * return is prepared after the month closes, and a half-finished month shown by
 * default invites someone to read it as complete.
 */
function resolvePeriod(params: { from?: string; to?: string }): { from: string; to: string } {
  const isIso = (v: string | undefined): v is string => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
  if (isIso(params.from) && isIso(params.to) && params.to >= params.from) {
    return { from: params.from, to: params.to };
  }

  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth(); // 0-based; the previous month is this index
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function totalTax(t: TaxAmounts): bigint {
  return t.igst + t.cgst + t.sgst + t.cess;
}

/**
 * Amber is the strongest attention tone the pill has, so it is reserved for the
 * two rows that mean credit already taken may not be allowed. A supplier invoice
 * absent from the books is credit going unclaimed — worth acting on, but it is not
 * an exposure, so it stays neutral.
 */
function statusTone(status: ReconStatus): MetricStatus {
  if (status === 'matched') return 'verified';
  if (status === 'in_books_not_in_2b' || status === 'mismatched') return 'provisional';
  return 'draft';
}

/** Quantities are stored scaled by 10,000. */
function formatQuantity(scaled: bigint): string {
  const whole = scaled / 10_000n;
  const frac = (scaled < 0n ? -scaled : scaled) % 10_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(4, '0').replace(/0+$/, '')}`;
}

function TaxCells({ tax, bold = false }: { tax: TaxAmounts; bold?: boolean }) {
  const cells = [tax.igst, tax.cgst, tax.sgst, tax.cess];
  return (
    <>
      {cells.map((value, i) => (
        <td key={i} className={`${ui.right} tnum`}>
          {bold ? <b>{formatRupees(paise(value))}</b> : formatRupees(paise(value))}
        </td>
      ))}
    </>
  );
}

/**
 * Where a working can be taken out of the product.
 *
 * CSV rather than a spreadsheet binary, because a CSV is the one format every
 * portal utility, Tally import and accountant's spreadsheet reads without a
 * library — and because it is plain text, so what was exported can be read back
 * and checked. JSON carries the same figures with their structure intact.
 */
function ExportLinks({ report, query }: { report: string; query: string }) {
  return (
    <p className={ui.hint} style={{ marginTop: 12 }}>
      Export:{' '}
      <a href={`/api/export/${report}?${query}&format=csv`}>CSV</a>
      {' · '}
      <a href={`/api/export/${report}?${query}&format=json`}>JSON</a>
    </p>
  );
}
