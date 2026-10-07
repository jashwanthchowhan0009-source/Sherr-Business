import Link from 'next/link';
import { PageHeader } from '@/components/shell/PageHeader';
import { Band, EmptyState, Panel, Table, ui } from '@/components/ui';
import { can } from '@/lib/auth/permissions';
import { formatRupees, paise } from '@/lib/money';
import { getCompany } from '@/server/queries';
import { getAccounts, getItems, getParties, getPeriodLock, getVouchers } from '@/server/ledger-queries';
import { getBankAccounts, getReviewQueue } from '@/server/banking-queries';
import { getOpenPurchaseOrders } from '@/server/procurement-queries';
import { getArchivedItems, getArchivedParties, getPurchaseOrders } from '@/server/edit-queries';
import { withContext } from '../_guard';
import { InvoiceForm } from './InvoiceForm';
import { PurchaseBillForm } from './PurchaseBillForm';
import { ContraForm, JournalForm, PaymentForm, ReverseButton } from './SimpleVoucherForms';
import { BankPanel } from './BankPanel';
import { GoodsReceiptForm, PurchaseOrderForm } from './ProcurementForms';
import { ItemForm } from './ItemForm';
import { PartyForm } from './PartyForm';
import { ReceiptForm } from './ReceiptForm';

export const dynamic = 'force-dynamic';

const dateFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });

const SUPPLY_LABELS: Record<string, string> = {
  intra_state: 'CGST + SGST',
  inter_state: 'IGST',
  zero_rated: 'Zero-rated',
  exempt: 'Exempt',
};

export default async function ProcessPage() {
  return withContext(async (ctx) => {
    const [{ org }, parties, items, vouchers, accounts, lockedUpto] = await Promise.all([
      getCompany(ctx),
      getParties(ctx),
      getItems(ctx),
      getVouchers(ctx, { limit: 25 }),
      getAccounts(ctx),
      getPeriodLock(ctx),
    ]);

    const [banks, openOrders, orders, archivedParties, archivedItems] = await Promise.all([
      getBankAccounts(ctx),
      getOpenPurchaseOrders(ctx),
      getPurchaseOrders(ctx, 25),
      getArchivedParties(ctx),
      getArchivedItems(ctx),
    ]);
    const bankQueue = banks[0]
      ? await getReviewQueue(ctx, { bankAccountId: banks[0].id, limit: 50 })
      : [];

    const mayWrite = can(ctx.role, 'voucher:draft');
    const mayPost = can(ctx.role, 'voucher:post');
    const customers = parties.filter((p) => p.kind === 'customer' || p.kind === 'both');
    const suppliers = parties.filter((p) => p.kind === 'supplier' || p.kind === 'both');
    const today = new Date().toISOString().slice(0, 10);
    const asOption = (p: (typeof parties)[number]) => ({
      id: p.id,
      name: p.name,
      gstin: p.gstin,
      stateCode: p.stateCode,
      placeOfSupplyStateCode: p.placeOfSupplyStateCode,
    });
    const itemOptions = items.map((i) => ({
      id: i.id,
      name: i.name,
      hsnSac: i.hsnSac,
      unit: i.unit,
      gstRateBps: i.gstRateBps,
      salePricePaise: i.salePricePaise,
      purchasePricePaise: i.purchasePricePaise,
    }));

    return (
      <>
        <PageHeader
          title="Process"
          subtitle="Normalize, connect, validate — and record what the books must show."
        />

        {lockedUpto ? (
          <p className={ui.hint} style={{ marginBottom: 18 }}>
            The books are locked to {lockedUpto}. Nothing dated on or before that can be posted —
            date any correction after the lock.
          </p>
        ) : null}

        {!org?.stateCode ? (
          <Panel>
            <EmptyState title="Set your state first">
              GST cannot be worked out without knowing which state you supply from: it is what
              decides whether an invoice carries CGST and SGST or IGST. Set it on the Data tab.
            </EmptyState>
          </Panel>
        ) : null}

        <Band>Raise a sales invoice</Band>
        <Panel>
          {mayWrite ? (
            <InvoiceForm
              parties={customers.map(asOption)}
              items={itemOptions}
              supplierStateCode={org?.stateCode ?? null}
              today={today}
              lockedUpto={lockedUpto}
            />
          ) : (
            <EmptyState title="Not available to your role">
              Your role can read the books but not write to them.
            </EmptyState>
          )}
        </Panel>

        <Band>Record a receipt</Band>
        <Panel>
          {can(ctx.role, 'voucher:post') ? (
            <ReceiptForm
              parties={customers.map((p) => ({ id: p.id, name: p.name }))}
              today={today}
            />
          ) : (
            <EmptyState title="Not available to your role">
              Recording money received posts to the books, which your role cannot do.
            </EmptyState>
          )}
        </Panel>

        <Band>Enter a purchase bill</Band>
        <Panel>
          {mayWrite ? (
            <PurchaseBillForm
              parties={suppliers.map(asOption)}
              items={itemOptions}
              companyStateCode={org?.stateCode ?? null}
              today={today}
              lockedUpto={lockedUpto}
            />
          ) : (
            <EmptyState title="Not available to your role">
              Your role can read the books but not write to them.
            </EmptyState>
          )}
        </Panel>

        <Band>Purchase order</Band>
        <Panel>
          {can(ctx.role, 'procurement:write') ? (
            <PurchaseOrderForm
              suppliers={suppliers.map((p) => ({ id: p.id, name: p.name }))}
              items={items.map((i) => ({ id: i.id, name: i.name, unit: i.unit }))}
              today={today}
            />
          ) : (
            <EmptyState title="Not available to your role">
              Your role can read orders but not raise them.
            </EmptyState>
          )}
        </Panel>

        {orders.length > 0 ? (
          <Panel bodyless>
            <Table
              head={
                <tr>
                  <th>Order</th>
                  <th>Date</th>
                  <th>Supplier</th>
                  <th className={ui.right}>Total</th>
                  <th>State</th>
                  <th />
                </tr>
              }
            >
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.poNo}</td>
                  <td className="tnum">{o.poDate}</td>
                  <td>{o.partyName ?? '—'}</td>
                  <td className={`${ui.right} tnum`}>{formatRupees(paise(o.totalPaise))}</td>
                  <td className={ui.hint}>{o.status.replace('_', ' ')}</td>
                  <td>
                    {can(ctx.role, 'procurement:write') && o.status === 'open' ? (
                      <Link href={`/process/edit/po/${o.id}`}>Edit</Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>
        ) : null}

        <Band>What arrived</Band>
        <Panel>
          {can(ctx.role, 'procurement:write') ? (
            <GoodsReceiptForm
              suppliers={suppliers.map((p) => ({ id: p.id, name: p.name }))}
              items={items.map((i) => ({ id: i.id, name: i.name, unit: i.unit }))}
              orders={openOrders.map((o) => ({ id: o.id, poNo: o.poNo, partyId: o.partyId }))}
              today={today}
            />
          ) : (
            <EmptyState title="Not available to your role">
              Your role can read receipts but not record them.
            </EmptyState>
          )}
        </Panel>

        <Band>Pay a supplier</Band>
        <Panel>
          {mayPost ? (
            <PaymentForm
              parties={suppliers.map((p) => ({ id: p.id, name: p.name }))}
              today={today}
              lockedUpto={lockedUpto}
            />
          ) : (
            <EmptyState title="Not available to your role">
              Recording a payment posts to the books, which your role cannot do.
            </EmptyState>
          )}
        </Panel>

        <Band>Journal</Band>
        <Panel>
          {mayPost ? (
            <JournalForm
              accounts={accounts.map((a) => ({ code: a.code, name: a.name }))}
              today={today}
              lockedUpto={lockedUpto}
            />
          ) : (
            <EmptyState title="Not available to your role">
              A journal posts directly to the books, which your role cannot do.
            </EmptyState>
          )}
        </Panel>

        <Band>Contra — cash and bank</Band>
        <Panel>
          {mayPost ? (
            <ContraForm today={today} lockedUpto={lockedUpto} />
          ) : (
            <EmptyState title="Not available to your role">
              A contra posts to the books, which your role cannot do.
            </EmptyState>
          )}
        </Panel>

        <Band>
          Bank statement
          {bankQueue.length > 0 ? ` — ${bankQueue.length} awaiting a decision` : ''}
        </Band>
        <Panel>
          <BankPanel
            accounts={banks.map((b) => ({
              id: b.id,
              label: `${b.bankName} — ${b.accountLabel}${
                b.accountNumberLast4 ? ` ····${b.accountNumberLast4}` : ''
              }`,
            }))}
            ledgerAccounts={accounts
              .filter((a) => a.code === 'BANK' || a.code.startsWith('BANK'))
              .map((a) => ({ id: a.id, name: a.name }))}
            selectedAccountId={banks[0]?.id ?? null}
            queue={bankQueue.map((r) => ({
              lineId: r.lineId,
              lineDate: r.lineDate,
              narration: r.narration,
              reference: r.reference,
              amountPaise: r.amountPaise.toString(),
              status: r.status,
              suggestion: r.suggestion
                ? { ...r.suggestion, tier: r.suggestion.tier }
                : null,
            }))}
            readOnly={!can(ctx.role, 'bank:reconcile')}
          />
          {banks.length > 0 && can(ctx.role, 'bank:import') ? (
            <p className={ui.hint} style={{ marginTop: 14 }}>
              Accounts:{' '}
              {banks.map((b, index) => (
                <span key={b.id}>
                  {index > 0 ? ' · ' : ''}
                  {b.bankName} — {b.accountLabel}{' '}
                  <Link href={`/process/edit/bank/${b.id}`}>Edit</Link>
                </span>
              ))}
            </p>
          ) : null}
        </Panel>

        <div id="vouchers" />
        <Band>{vouchers.length === 0 ? 'Vouchers' : `Vouchers — ${vouchers.length} most recent`}</Band>
        <Panel bodyless={vouchers.length > 0}>
          {vouchers.length === 0 ? (
            <div className={ui.panelBody}>
              <EmptyState title="Nothing recorded yet">
                Raise an invoice above and it will appear here with its tax treatment, its total
                and a link to its PDF.
              </EmptyState>
            </div>
          ) : (
            <Table
              head={
                <tr>
                  <th>Number</th>
                  <th>Date</th>
                  <th>Party</th>
                  <th>Tax</th>
                  <th className={ui.right}>Total</th>
                  <th>State</th>
                  <th />
                </tr>
              }
            >
              {vouchers.map((v) => (
                <tr key={v.id}>
                  <td>
                    {v.voucherType === 'sales' || v.voucherType === 'credit_note' ? (
                      <a href={`/api/invoices/${v.id}/pdf`}>{v.voucherNo}</a>
                    ) : (
                      v.voucherNo
                    )}
                    <div className={ui.hint}>{v.voucherType.replace('_', ' ')}</div>
                  </td>
                  <td className="tnum">{dateFmt.format(new Date(`${v.voucherDate}T00:00:00Z`))}</td>
                  <td>{v.partyName ?? '—'}</td>
                  <td className={ui.hint}>
                    {v.supplyType ? SUPPLY_LABELS[v.supplyType] ?? v.supplyType : '—'}
                  </td>
                  <td className={`${ui.right} tnum`}>{formatRupees(paise(v.totalPaise))}</td>
                  <td>
                    {v.reversedByVoucherId
                      ? 'Reversed'
                      : v.reversesVoucherId
                        ? 'Reversal'
                        : v.status === 'posted'
                          ? 'Posted'
                          : 'Draft'}
                    {v.correctsVoucherId ? <div className={ui.hint}>Corrected entry</div> : null}
                  </td>
                  <td>
                    {/* Edit opens the entry in its own form. For a posted
                        voucher saving posts a correction (reversal plus
                        replacement) rather than overwriting it. Reverse is for
                        an entry that should not exist at all. A reversed entry,
                        or a reversal itself, offers neither. */}
                    {editable(v) ? (
                      <div className={ui.actions} style={{ marginTop: 0 }}>
                        <Link href={`/process/edit/voucher/${v.id}`}>Edit</Link>
                        {mayPost && v.status === 'posted' ? (
                          <ReverseButton voucherId={v.id} voucherNo={v.voucherNo} today={today} />
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Band>Customers and suppliers</Band>
        <Panel bodyless={false}>
          {can(ctx.role, 'party:write') ? <PartyForm /> : null}
          {parties.length > 0 ? (
            <div className={ui.tableWrap} style={{ marginTop: 20 }}>
              <table className={ui.table}>
                <thead>
                  <tr><th>Name</th><th>Kind</th><th>GSTIN</th><th>State</th><th>Credit</th><th /></tr>
                </thead>
                <tbody>
                  {parties.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className={ui.hint}>{p.kind}</td>
                      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>
                        {p.gstin ?? <span className={ui.hint}>Unregistered</span>}
                      </td>
                      <td className="tnum">{p.stateCode ?? '—'}</td>
                      <td className="tnum">{p.creditDays === 0 ? 'On receipt' : `${p.creditDays} days`}</td>
                      <td>
                        {can(ctx.role, 'party:write') ? (
                          <Link href={`/process/edit/party/${p.id}`}>Edit</Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>

        {archivedParties.length > 0 ? (
          <p className={ui.hint} style={{ marginTop: 10 }}>
            Archived:{' '}
            {archivedParties.map((p, index) => (
              <span key={p.id}>
                {index > 0 ? ', ' : ''}
                {can(ctx.role, 'party:write') ? (
                  <Link href={`/process/edit/party/${p.id}`}>{p.name}</Link>
                ) : (
                  p.name
                )}
              </span>
            ))}
          </p>
        ) : null}

        <Band>Items</Band>
        <Panel bodyless={false}>
          {can(ctx.role, 'item:write') ? <ItemForm /> : null}
          {items.length > 0 ? (
            <div className={ui.tableWrap} style={{ marginTop: 20 }}>
              <table className={ui.table}>
                <thead>
                  <tr><th>Name</th><th>HSN/SAC</th><th>Unit</th><th>GST</th><th className={ui.right}>Price</th><th /></tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.name}</td>
                      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>
                        {i.hsnSac ?? '—'}
                      </td>
                      <td>{i.unit}</td>
                      <td className="tnum">{i.gstRateBps / 100}%</td>
                      <td className={`${ui.right} tnum`}>
                        {i.salePricePaise === null ? '—' : formatRupees(paise(i.salePricePaise))}
                      </td>
                      <td>
                        {can(ctx.role, 'item:write') ? (
                          <Link href={`/process/edit/item/${i.id}`}>Edit</Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>

        {archivedItems.length > 0 ? (
          <p className={ui.hint} style={{ marginTop: 10 }}>
            Not in use:{' '}
            {archivedItems.map((i, index) => (
              <span key={i.id}>
                {index > 0 ? ', ' : ''}
                {can(ctx.role, 'item:write') ? (
                  <Link href={`/process/edit/item/${i.id}`}>{i.name}</Link>
                ) : (
                  i.name
                )}
              </span>
            ))}
          </p>
        ) : null}

        <p className={ui.hint} style={{ marginTop: 20 }}>
          Prepared by SherrByte — review by a qualified professional. Every GST rate here is
          marked as needing CA verification until one signs it off.
        </p>
      </>
    );
  });
}

/**
 * Whether a voucher offers Edit.
 *
 * A reversal exists only to cancel another entry, a reversed entry has already
 * been replaced, and a reverse-charge journal follows its bill. None of those
 * is edited directly; the server refuses them too.
 */
function editable(v: {
  voucherType: string;
  voucherNo: string;
  reversedByVoucherId: string | null;
  reversesVoucherId: string | null;
}): boolean {
  if (v.reversedByVoucherId || v.reversesVoucherId) return false;
  return !(v.voucherType === 'journal' && v.voucherNo.startsWith('RCM'));
}
