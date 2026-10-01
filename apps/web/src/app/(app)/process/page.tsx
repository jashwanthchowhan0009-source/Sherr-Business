import { PageHeader } from '@/components/shell/PageHeader';
import { Band, EmptyState, Panel, Table, ui } from '@/components/ui';
import { can } from '@/lib/auth/permissions';
import { formatRupees, paise } from '@/lib/money';
import { getCompany } from '@/server/queries';
import { getItems, getParties, getVouchers } from '@/server/ledger-queries';
import { withContext } from '../_guard';
import { InvoiceForm } from './InvoiceForm';
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
    const [{ org }, parties, items, vouchers] = await Promise.all([
      getCompany(ctx),
      getParties(ctx),
      getItems(ctx),
      getVouchers(ctx, { limit: 25 }),
    ]);

    const mayWrite = can(ctx.role, 'voucher:draft');
    const customers = parties.filter((p) => p.kind === 'customer' || p.kind === 'both');
    const today = new Date().toISOString().slice(0, 10);

    return (
      <>
        <PageHeader
          title="Process"
          subtitle="Normalize, connect, validate — and record what the books must show."
        />

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
              parties={customers.map((p) => ({
                id: p.id,
                name: p.name,
                gstin: p.gstin,
                stateCode: p.stateCode,
                placeOfSupplyStateCode: p.placeOfSupplyStateCode,
              }))}
              items={items.map((i) => ({
                id: i.id,
                name: i.name,
                hsnSac: i.hsnSac,
                unit: i.unit,
                gstRateBps: i.gstRateBps,
                salePricePaise: i.salePricePaise,
              }))}
              supplierStateCode={org?.stateCode ?? null}
              today={today}
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
                      : v.status === 'posted'
                        ? 'Posted'
                        : 'Draft'}
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
                  <tr><th>Name</th><th>Kind</th><th>GSTIN</th><th>State</th><th>Credit</th></tr>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>

        <Band>Items</Band>
        <Panel bodyless={false}>
          {can(ctx.role, 'item:write') ? <ItemForm /> : null}
          {items.length > 0 ? (
            <div className={ui.tableWrap} style={{ marginTop: 20 }}>
              <table className={ui.table}>
                <thead>
                  <tr><th>Name</th><th>HSN/SAC</th><th>Unit</th><th>GST</th><th className={ui.right}>Price</th></tr>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>

        <p className={ui.hint} style={{ marginTop: 20 }}>
          Prepared by SherrByte — review by a qualified professional. Every GST rate here is
          marked as needing CA verification until one signs it off.
        </p>
      </>
    );
  });
}
