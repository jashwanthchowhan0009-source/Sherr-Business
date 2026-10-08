import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/shell/PageHeader';
import { EmptyState, Panel, ui } from '@/components/ui';
import { can } from '@/lib/auth/permissions';
import { formatRupees, paise } from '@/lib/money';
import { getCompany } from '@/server/queries';
import { getAccounts, getItems, getParties, getPeriodLock } from '@/server/ledger-queries';
import {
  getBankAccountById,
  getItemById,
  getPartyById,
  getPurchaseOrderById,
  getVoucherForEdit,
} from '@/server/edit-queries';
import { withContext } from '../../../../_guard';
import { InvoiceForm } from '../../../InvoiceForm';
import { PurchaseBillForm } from '../../../PurchaseBillForm';
import { ReceiptForm } from '../../../ReceiptForm';
import { ContraForm, JournalForm, PaymentForm } from '../../../SimpleVoucherForms';
import { NoteForm } from '../../../NoteForm';
import { PartyForm } from '../../../PartyForm';
import { ItemForm } from '../../../ItemForm';
import { BankAccountForm } from '../../../BankAccountForm';
import { PurchaseOrderForm } from '../../../ProcurementForms';
import { formatQuantity, paiseToPlainRupees, taxLinesFromStored } from '../../../_shared/TaxLines';
import type { EditTarget } from '../../../_shared/edit';

export const dynamic = 'force-dynamic';

const KINDS = ['voucher', 'party', 'item', 'bank', 'po'] as const;
type Kind = (typeof KINDS)[number];

const TYPE_LABELS: Record<string, string> = {
  sales: 'Sales invoice',
  purchase: 'Purchase bill',
  receipt: 'Receipt',
  payment: 'Payment',
  journal: 'Journal',
  contra: 'Contra',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
};

/**
 * One page for editing any entry, chosen by the kind in the URL.
 *
 * It loads the record and hands it to the same form that created it, filled
 * in. Nothing is edited here: saving goes through the form's server action,
 * which re-checks the role and — for a posted voucher — records a correction
 * rather than overwriting anything.
 */
export default async function EditPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind, id } = await params;
  if (!(KINDS as readonly string[]).includes(kind)) notFound();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  return withContext(async (ctx) => {
    const back = (
      <p style={{ marginTop: 20 }}>
        <Link href="/process">Back to Process</Link>
      </p>
    );

    switch (kind as Kind) {
      case 'party': {
        if (!can(ctx.role, 'party:write')) return <NotAllowed back={back} />;
        const p = await getPartyById(ctx, id);
        return (
          <>
            <PageHeader title={`Edit ${p.name}`} subtitle="Customer or supplier details." />
            <Panel>
              <PartyForm
                initial={{
                  id: p.id,
                  kind: p.kind,
                  name: p.name,
                  legalName: p.legalName ?? '',
                  gstin: p.gstin ?? '',
                  pan: p.pan ?? '',
                  stateCode: p.stateCode ?? '',
                  email: p.email ?? '',
                  phone: p.phone ?? '',
                  billingAddress: p.billingAddress ?? '',
                  creditDays: p.creditDays,
                  notes: p.notes ?? '',
                  isActive: p.isActive,
                }}
              />
            </Panel>
            {back}
          </>
        );
      }

      case 'item': {
        if (!can(ctx.role, 'item:write')) return <NotAllowed back={back} />;
        const i = await getItemById(ctx, id);
        return (
          <>
            <PageHeader title={`Edit ${i.name}`} subtitle="Item details, rate and prices." />
            <Panel>
              <ItemForm
                initial={{
                  id: i.id,
                  code: i.code ?? '',
                  name: i.name,
                  kind: i.kind,
                  hsnSac: i.hsnSac ?? '',
                  unit: i.unit,
                  gstRateBps: i.gstRateBps,
                  salePriceRupees:
                    i.salePricePaise === null ? '' : paiseToPlainRupees(i.salePricePaise),
                  purchasePriceRupees:
                    i.purchasePricePaise === null ? '' : paiseToPlainRupees(i.purchasePricePaise),
                  isActive: i.isActive,
                }}
              />
            </Panel>
            {back}
          </>
        );
      }

      case 'bank': {
        if (!can(ctx.role, 'bank:import')) return <NotAllowed back={back} />;
        const [b, accounts] = await Promise.all([getBankAccountById(ctx, id), getAccounts(ctx)]);
        return (
          <>
            <PageHeader title={`Edit ${b.bankName} — ${b.accountLabel}`} subtitle="Bank account details." />
            <Panel>
              <BankAccountForm
                ledgerAccounts={accounts
                  .filter((a) => a.code === 'BANK' || a.code.startsWith('BANK'))
                  .map((a) => ({ id: a.id, name: a.name }))}
                initial={{
                  id: b.id,
                  ledgerAccountId: b.ledgerAccountId,
                  bankName: b.bankName,
                  accountLabel: b.accountLabel,
                  accountNumberLast4: b.accountNumberLast4 ?? '',
                  ifsc: b.ifsc ?? '',
                  isActive: b.isActive,
                }}
              />
            </Panel>
            {back}
          </>
        );
      }

      case 'po': {
        if (!can(ctx.role, 'procurement:write')) return <NotAllowed back={back} />;
        const [{ order, lines }, suppliers, items] = await Promise.all([
          getPurchaseOrderById(ctx, id),
          getParties(ctx, 'supplier'),
          getItems(ctx),
        ]);
        return (
          <>
            <PageHeader title={`Edit ${order.poNo}`} subtitle="Purchase order." />
            <Panel>
              {order.status !== 'open' ? (
                <EmptyState title="This order can no longer be edited">
                  Goods have already been received against it, so it is evidence in a three-way
                  match.
                </EmptyState>
              ) : (
                <PurchaseOrderForm
                  suppliers={suppliers.map((p) => ({ id: p.id, name: p.name }))}
                  items={items.map((i) => ({ id: i.id, name: i.name, unit: i.unit }))}
                  today={order.poDate}
                  initial={{
                    id: order.id,
                    poNo: order.poNo,
                    partyId: order.partyId,
                    poDate: order.poDate,
                    expectedDate: order.expectedDate ?? '',
                    narration: order.narration ?? '',
                    lines: lines.map((l) => ({
                      itemId: l.itemId ?? '',
                      description: l.description,
                      quantity: formatQuantity(l.quantity),
                      unit: l.unit ?? '',
                      unitPriceRupees: paiseToPlainRupees(l.unitPricePaise),
                    })),
                  }}
                />
              )}
            </Panel>
            {back}
          </>
        );
      }

      case 'voucher':
        return <VoucherEdit ctx={ctx} id={id} back={back} />;
    }
  });
}

function NotAllowed({ back }: { back: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Edit" />
      <Panel>
        <EmptyState title="Not available to your role">
          Your role can read this but not change it.
        </EmptyState>
      </Panel>
      {back}
    </>
  );
}

async function VoucherEdit({
  ctx,
  id,
  back,
}: {
  ctx: Parameters<Parameters<typeof withContext>[0]>[0];
  id: string;
  back: React.ReactNode;
}) {
  const [{ voucher: v, lines, entries }, { org }, allParties, items, accounts, lockedUpto] =
    await Promise.all([
      getVoucherForEdit(ctx, id),
      getCompany(ctx),
      getParties(ctx),
      getItems(ctx),
      getAccounts(ctx),
      getPeriodLock(ctx),
    ]);

  const label = TYPE_LABELS[v.voucherType] ?? v.voucherType;
  const header = (
    <PageHeader
      title={`Edit ${v.voucherNo}`}
      subtitle={`${label} · ${v.voucherDate} · ${formatRupees(paise(v.totalPaise))} · ${
        v.status === 'posted' ? 'posted' : 'draft'
      }`}
    />
  );

  const refuse = (title: string, body: string) => (
    <>
      {header}
      <Panel>
        <EmptyState title={title}>{body}</EmptyState>
      </Panel>
      {back}
    </>
  );

  // Only sales invoices and purchase bills can be drafts; every other voucher
  // is posted when it is made, so editing it is always a posting act.
  const draftable = v.voucherType === 'sales' || v.voucherType === 'purchase';
  const needs = v.status === 'posted' || !draftable ? 'voucher:post' : 'voucher:draft';
  if (!can(ctx.role, needs)) {
    return refuse('Not available to your role', 'Your role can read vouchers but not change them.');
  }
  if (v.reversesVoucherId) {
    return refuse(
      'A reversal cannot be edited',
      'It exists only to cancel another entry. Edit the entry it replaced instead.',
    );
  }
  if (v.reversedByVoucherId) {
    return refuse(
      'Already reversed',
      'This entry has been reversed, so there is nothing left to edit. Edit the entry that replaced it.',
    );
  }
  if (v.voucherType === 'journal' && v.voucherNo.startsWith('RCM')) {
    return refuse(
      'Raised automatically',
      `This is the reverse-charge liability for ${v.reference ?? 'a bill'}. Edit that bill and this follows.`,
    );
  }

  const edit: EditTarget = { voucherId: v.id, voucherNo: v.voucherNo, posted: v.status === 'posted' };
  const today = new Date().toISOString().slice(0, 10);

  // The voucher's own party is offered even if it has since been archived, so
  // an edit never silently moves an entry to someone else.
  const withOwnParty = (list: typeof allParties) => {
    if (!v.partyId || list.some((p) => p.id === v.partyId)) return list;
    const own = allParties.find((p) => p.id === v.partyId);
    return own ? [own, ...list] : list;
  };
  const customers = withOwnParty(allParties.filter((p) => p.kind === 'customer' || p.kind === 'both'));
  const suppliers = withOwnParty(allParties.filter((p) => p.kind === 'supplier' || p.kind === 'both'));
  const asOption = (p: (typeof allParties)[number]) => ({
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
  const taxLines = taxLinesFromStored(
    lines.map((l) => ({
      itemId: l.itemId,
      description: l.description,
      hsnSac: l.hsnSac,
      unit: l.unit,
      quantity: l.quantity.toString(),
      unitPricePaise: l.unitPricePaise.toString(),
      gstRateBps: l.gstRateBps,
      reverseCharge: l.reverseCharge,
    })),
  );
  const cashOrBank = (side: 'debit' | 'credit'): 'BANK' | 'CASH' => {
    const hit = entries.find(
      (e) =>
        (e.code === 'CASH' || e.code === 'BANK') &&
        (side === 'debit' ? e.debitPaise > 0n : e.creditPaise > 0n),
    );
    return hit?.code === 'CASH' ? 'CASH' : 'BANK';
  };

  let form: React.ReactNode;
  switch (v.voucherType) {
    case 'sales':
      form = (
        <InvoiceForm
          parties={customers.map(asOption)}
          items={itemOptions}
          supplierStateCode={org?.stateCode ?? null}
          today={today}
          lockedUpto={lockedUpto}
          edit={edit}
          initial={{
            partyId: v.partyId ?? '',
            voucherDate: v.voucherDate,
            placeOfSupplyStateCode: v.placeOfSupplyStateCode ?? '',
            reference: v.reference ?? '',
            narration: v.narration ?? '',
            lines: taxLines,
          }}
        />
      );
      break;
    case 'purchase':
      form = (
        <PurchaseBillForm
          parties={suppliers.map(asOption)}
          items={itemOptions}
          companyStateCode={org?.stateCode ?? null}
          today={today}
          lockedUpto={lockedUpto}
          edit={edit}
          initial={{
            partyId: v.partyId ?? '',
            voucherDate: v.voucherDate,
            supplierInvoiceNo: v.supplierInvoiceNo ?? '',
            supplierInvoiceDate: v.supplierInvoiceDate ?? v.voucherDate,
            narration: v.narration ?? '',
            lines: taxLines,
          }}
        />
      );
      break;
    case 'receipt':
    case 'payment': {
      const initial = {
        partyId: v.partyId ?? '',
        voucherDate: v.voucherDate,
        amountRupees: paiseToPlainRupees(v.totalPaise),
        accountCode: cashOrBank(v.voucherType === 'receipt' ? 'debit' : 'credit'),
        reference: v.reference ?? '',
        narration: v.narration ?? '',
      };
      form =
        v.voucherType === 'receipt' ? (
          <ReceiptForm
            parties={customers.map((p) => ({ id: p.id, name: p.name }))}
            today={today}
            edit={edit}
            initial={initial}
          />
        ) : (
          <PaymentForm
            parties={suppliers.map((p) => ({ id: p.id, name: p.name }))}
            today={today}
            lockedUpto={lockedUpto}
            edit={edit}
            initial={initial}
          />
        );
      break;
    }
    case 'journal':
      form = (
        <JournalForm
          accounts={accounts.map((a) => ({ code: a.code, name: a.name }))}
          today={today}
          lockedUpto={lockedUpto}
          edit={edit}
          initial={{
            voucherDate: v.voucherDate,
            narration: v.narration ?? '',
            lines: entries.map((e) => ({
              accountCode: e.code,
              debitRupees: e.debitPaise > 0n ? paiseToPlainRupees(e.debitPaise) : '',
              creditRupees: e.creditPaise > 0n ? paiseToPlainRupees(e.creditPaise) : '',
            })),
          }}
        />
      );
      break;
    case 'contra':
      form = (
        <ContraForm
          today={today}
          lockedUpto={lockedUpto}
          edit={edit}
          initial={{
            voucherDate: v.voucherDate,
            fromAccountCode: cashOrBank('credit'),
            amountRupees: paiseToPlainRupees(v.totalPaise),
            narration: v.narration ?? '',
          }}
        />
      );
      break;
    case 'credit_note':
    case 'debit_note':
      form = (
        <NoteForm
          kind={v.voucherType}
          parties={(v.voucherType === 'credit_note' ? customers : suppliers).map(asOption)}
          items={itemOptions}
          companyStateCode={org?.stateCode ?? null}
          lockedUpto={lockedUpto}
          edit={edit}
          initial={{
            partyId: v.partyId ?? '',
            voucherDate: v.voucherDate,
            // A note stores the invoice or bill it is against in `reference`.
            againstVoucherId:
              v.reference && /^[0-9a-f-]{36}$/i.test(v.reference) ? v.reference : '',
            supplierInvoiceNo: v.supplierInvoiceNo ?? '',
            noteReason: v.narration ?? '',
            lines: taxLines,
          }}
        />
      );
      break;
  }

  return (
    <>
      {header}
      {edit.posted ? (
        <p className={ui.hint} style={{ marginBottom: 16 }}>
          This entry is posted. Saving does not overwrite it: the original is reversed and the
          corrected entry is posted in its place, so the books keep both, with your reason.
        </p>
      ) : null}
      <Panel>{form}</Panel>
      {back}
    </>
  );
}
