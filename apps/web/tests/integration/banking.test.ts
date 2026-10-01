import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../src/lib/db/tenant';
import {
  allocateVoucherNumber,
  createVoucher,
  postVoucher,
  resolveAccountIds,
} from '../../src/lib/db/ledger';
import {
  acceptSuggestion,
  generateSuggestions,
  ignoreLine,
  rejectSuggestion,
  storeStatement,
  unreconcileLine,
} from '../../src/lib/db/banking';
import { calculateInvoice } from '../../src/lib/accounting/gst';
import { receiptEntries, salesInvoiceEntries } from '../../src/lib/accounting/posting';
import { QTY_SCALE } from '../../src/lib/accounting/units';
import { parseStatement, verifyRunningBalance } from '../../src/lib/banking/statement-parser';
import { getReconciliation, getReviewQueue } from '../../src/server/banking-queries';
import { cleanup, expectDbRejection, ownerPool, seedTwoOrgs, type Fixture } from './_db';
import type { RequestContext } from '../../src/lib/auth/context';

/**
 * Bank import, matching and reconciliation against real Postgres.
 *
 * The assertion that matters is the reconciliation arithmetic: book balance plus
 * what the bank knows and the books do not, less what the books know and the bank
 * does not, must land on the statement's own closing figure. An unexplained
 * difference is the entire reason to run the report.
 */
describe('banking', () => {
  let owner: Pool;
  let fx: Fixture;
  let ctx: RequestContext;
  let ctxB: RequestContext;
  let bankAccountId: string;
  let bankLedgerId: string;
  let customer: string;

  const asContext = (orgId: string, userId: string): RequestContext =>
    ({ orgId, userId, role: 'owner', clerkUserId: 'test', ip: null, userAgent: null }) as unknown as RequestContext;

  const invoice = (input: { date: string; rupees: bigint }) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const lines = [
        {
          itemId: null,
          description: 'Goods',
          hsnSac: '1006',
          unit: 'NOS',
          quantity: QTY_SCALE,
          unitPricePaise: input.rupees * 100n,
          discountPaise: 0n,
          gstRateBps: 1800,
          cessRateBps: 0,
          reverseCharge: false,
        },
      ];
      const calculation = calculateInvoice(lines, 'intra_state');
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'sales',
        fyLabel: '25-26',
        prefix: 'INV',
      });
      const created = await createVoucher(tx, {
        voucherType: 'sales',
        voucherNo,
        fyLabel: '25-26',
        voucherDate: input.date,
        partyId: customer,
        supplierStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: 'intra_state',
        reference: null,
        narration: null,
        calculation,
        lines,
        entries: salesInvoiceEntries(calculation),
      });
      await postVoucher(tx, { voucherId: created.id, userId: null });
      return created;
    });

  const receipt = (input: { date: string; amountPaise: bigint }) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'receipt',
        fyLabel: '25-26',
        prefix: 'RCT',
      });
      const created = await createVoucher(tx, {
        voucherType: 'receipt',
        voucherNo,
        fyLabel: '25-26',
        voucherDate: input.date,
        partyId: customer,
        supplierStateCode: null,
        placeOfSupplyStateCode: null,
        supplyType: null,
        reference: null,
        narration: null,
        calculation: null,
        lines: [],
        entries: receiptEntries({ amountPaise: input.amountPaise, intoAccountCode: 'BANK' }),
        totalPaise: input.amountPaise,
      });
      await postVoucher(tx, { voucherId: created.id, userId: null });
      return created;
    });

  const importCsv = (csv: string) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const parsed = parseStatement(csv);
      const balance = verifyRunningBalance(parsed.lines);
      const stored = await storeStatement(tx, {
        bankAccountId,
        documentId: null,
        lines: parsed.lines,
        problemCount: parsed.problems.length,
        openingBalancePaise: parsed.openingBalancePaise,
        closingBalancePaise: parsed.closingBalancePaise,
        balanceConsistent: balance.consistent,
        importedBy: null,
      });
      const matched = await generateSuggestions(tx, { bankAccountId });
      return { ...stored, matched, parsed };
    });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `bank${Date.now()}`);
    ctx = asContext(fx.orgA, fx.userA);
    ctxB = asContext(fx.orgB, fx.userB);

    ({ bankLedgerId, bankAccountId, customer } = await withTenant(
      { orgId: fx.orgA, userId: null },
      async (tx) => {
        const ids = await resolveAccountIds(tx, ['BANK']);
        const ledger = ids.get('BANK')!;
        const bank = await tx.execute<{ id: string }>(sql`
          insert into bank_accounts (org_id, ledger_account_id, bank_name, account_label,
                                     account_number_last4, ifsc)
          values (app_current_org_id(), ${ledger}::uuid, 'HDFC Bank', 'Current account',
                  '5678', 'HDFC0001234')
          returning id
        `);
        const party = await tx.execute<{ id: string }>(sql`
          insert into parties (org_id, kind, name, state_code, place_of_supply_state_code, credit_days)
          values (app_current_org_id(), 'customer', 'Anand Enterprises', '29', '29', 30)
          returning id
        `);
        return {
          bankLedgerId: ledger,
          bankAccountId: bank.rows[0]!.id,
          customer: party.rows[0]!.id,
        };
      },
    ));
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  describe('bank accounts', () => {
    it('stores only the last four digits of the account number', async () => {
      const row = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ last4: string; ifsc: string }>(sql`
          select account_number_last4 as last4, ifsc from bank_accounts
           where id = ${bankAccountId}::uuid
        `);
        return rows[0];
      });
      expect(row?.last4).toBe('5678');
      expect(row?.ifsc).toBe('HDFC0001234');
    });

    it('refuses a malformed IFSC', async () => {
      await expectDbRejection(
        withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
          tx.execute(sql`
            insert into bank_accounts (org_id, ledger_account_id, bank_name, account_label, ifsc)
            values (app_current_org_id(), ${bankLedgerId}::uuid, 'X', 'Y', 'NOTANIFSC')
          `),
        ),
        /bank_accounts_ifsc_check/i,
      );
    });

    it("refuses a ledger account from another company", async () => {
      const foreign = await withTenant({ orgId: fx.orgB, userId: null }, async (tx) => {
        const ids = await resolveAccountIds(tx, ['BANK']);
        return ids.get('BANK')!;
      });
      await expectDbRejection(
        withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
          tx.execute(sql`
            insert into bank_accounts (org_id, ledger_account_id, bank_name, account_label)
            values (app_current_org_id(), ${foreign}::uuid, 'X', 'Y')
          `),
        ),
        /violates foreign key constraint/i,
      );
    });
  });

  describe('import', () => {
    const statement = [
      'Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '05/06/2025,"NEFT CR-ANAND ENTERPRISES",N111111,,"59,000.00","59,000.00"',
      '12/06/2025,"BANK CHARGES GST",,"118.00",,"58,882.00"',
      '20/06/2025,"NEFT CR-ANAND ENTERPRISES",N222222,,"23,600.00","82,482.00"',
    ].join('\n');

    it('stores every readable transaction', async () => {
      await invoice({ date: '2025-06-01', rupees: 50_000n }); // ₹59,000 with tax
      const result = await importCsv(statement);
      expect(result.inserted).toBe(3);
      expect(result.duplicates).toBe(0);
      expect(result.parsed.problems).toEqual([]);
    });

    it('skips lines already imported, rather than refusing the file', async () => {
      // People export overlapping date ranges as a matter of course.
      const again = await importCsv(statement);
      expect(again.inserted).toBe(0);
      expect(again.duplicates).toBe(3);
    });

    it('records the statement balance it read', async () => {
      const row = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ closing: string; consistent: boolean }>(sql`
          select closing_balance_paise::text as closing, balance_consistent as consistent
            from bank_statements order by created_at limit 1
        `);
        return rows[0];
      });
      expect(row?.closing).toBe('8248200');
      expect(row?.consistent).toBe(true);
    });

    it('refuses a file with no readable transactions', async () => {
      await expect(importCsv('Date,Narration,Amount\n')).rejects.toThrow(/no readable transactions/i);
    });
  });

  describe('matching', () => {
    it('suggests the invoice for the matching deposit', async () => {
      const queue = await getReviewQueue(ctx, { bankAccountId });
      const deposit = queue.find((r) => r.amountPaise === 59_000_00n)!;
      expect(deposit.suggestion).not.toBeNull();
      expect(deposit.suggestion?.tier).toBe('strong');
      expect(deposit.suggestion?.reasons.some((r) => r.includes('Anand Enterprises'))).toBe(true);
    });

    it('leaves a bank charge unmatched, since no voucher exists for it', async () => {
      const queue = await getReviewQueue(ctx, { bankAccountId });
      const charge = queue.find((r) => r.narration.includes('BANK CHARGES'))!;
      expect(charge.suggestion).toBeNull();
      expect(charge.status).toBe('unmatched');
    });

    it('puts suggested lines before unmatched ones', async () => {
      const queue = await getReviewQueue(ctx, { bankAccountId });
      const firstUnmatched = queue.findIndex((r) => r.status === 'unmatched');
      const lastSuggested = queue.map((r) => r.status).lastIndexOf('suggested');
      if (firstUnmatched !== -1 && lastSuggested !== -1) {
        expect(lastSuggested).toBeLessThan(firstUnmatched);
      }
    });

    it('never offers a voucher that is already reconciled elsewhere', async () => {
      const queue = await getReviewQueue(ctx, { bankAccountId });
      const suggestedVouchers = queue
        .map((r) => r.suggestion?.voucherId)
        .filter((v): v is string => Boolean(v));
      expect(new Set(suggestedVouchers).size).toBe(suggestedVouchers.length);
    });
  });

  describe('deciding', () => {
    it('reconciles a line when the suggestion is accepted, without posting anything', async () => {
      const before = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ n: string }>(sql`
          select count(*)::text as n from ledger_entries
        `);
        return Number(rows[0]!.n);
      });

      const queue = await getReviewQueue(ctx, { bankAccountId });
      const deposit = queue.find((r) => r.suggestion !== null)!;
      await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        acceptSuggestion(tx, { suggestionId: deposit.suggestion!.id, userId: fx.userA }),
      );

      const after = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ n: string; status: string }>(sql`
          select (select count(*) from ledger_entries)::text as n,
                 (select status from bank_statement_lines where id = ${deposit.lineId}::uuid) as status
        `);
        return rows[0]!;
      });

      // The voucher already carried its entries; reconciling records agreement.
      expect(Number(after.n)).toBe(before);
      expect(after.status).toBe('reconciled');
    });

    it('refuses to accept the same suggestion twice', async () => {
      const decided = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          select id from bank_match_suggestions where decision = 'accepted' limit 1
        `);
        return rows[0]!.id;
      });
      await expect(
        withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
          acceptSuggestion(tx, { suggestionId: decided, userId: fx.userA }),
        ),
      ).rejects.toThrow(/already been decided/i);
    });

    it('refuses two statement lines claiming the same voucher', async () => {
      const voucherId = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          select matched_voucher_id as id from bank_statement_lines
           where matched_voucher_id is not null limit 1
        `);
        return rows[0]!.id;
      });
      const otherLine = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          select id from bank_statement_lines where status <> 'reconciled' limit 1
        `);
        return rows[0]!.id;
      });

      // Two lines claiming one receipt would double-count the money.
      await expectDbRejection(
        withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
          tx.execute(sql`
            update bank_statement_lines
               set status = 'reconciled', matched_voucher_id = ${voucherId}::uuid
             where id = ${otherLine}::uuid
          `),
        ),
        /bank_statement_lines_voucher_key|duplicate key/i,
      );
    });

    it('marks a bank charge as ignored, which is not the same as reconciled', async () => {
      const queue = await getReviewQueue(ctx, { bankAccountId });
      const charge = queue.find((r) => r.narration.includes('BANK CHARGES'))!;
      await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        ignoreLine(tx, { statementLineId: charge.lineId, userId: fx.userA }),
      );

      const status = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ status: string; matched: string | null }>(sql`
          select status, matched_voucher_id as matched from bank_statement_lines
           where id = ${charge.lineId}::uuid
        `);
        return rows[0]!;
      });
      expect(status.status).toBe('ignored');
      expect(status.matched).toBeNull();
    });

    it('can undo a reconciliation so a mistake can be corrected', async () => {
      const line = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          select id from bank_statement_lines where status = 'reconciled' limit 1
        `);
        return rows[0]!.id;
      });
      await withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
        unreconcileLine(tx, { statementLineId: line }),
      );
      const status = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ status: string }>(sql`
          select status from bank_statement_lines where id = ${line}::uuid
        `);
        return rows[0]!.status;
      });
      expect(status).toBe('unmatched');
    });

    it('returns a line to unmatched when its only suggestion is rejected', async () => {
      await withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
        generateSuggestions(tx, { bankAccountId }),
      );
      const queue = await getReviewQueue(ctx, { bankAccountId });
      const suggested = queue.find((r) => r.suggestion !== null);
      if (!suggested) return;

      await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        rejectSuggestion(tx, { suggestionId: suggested.suggestion!.id, userId: fx.userA }),
      );
      const status = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ status: string }>(sql`
          select status from bank_statement_lines where id = ${suggested.lineId}::uuid
        `);
        return rows[0]!.status;
      });
      expect(status).toBe('unmatched');
    });
  });

  describe('the reconciliation statement', () => {
    it('reconciles the books to the statement exactly', async () => {
      // Set the whole thing up cleanly: one invoice, one receipt that matches a
      // deposit, and a bank charge the books do not know about.
      const clean = await seedTwoOrgs(owner, `rec${Date.now()}`);
      const cleanCtx = asContext(clean.orgA, clean.userA);

      const setup = await withTenant({ orgId: clean.orgA, userId: null }, async (tx) => {
        const ids = await resolveAccountIds(tx, ['BANK', 'SUNDRY_DEBTORS']);
        const bank = await tx.execute<{ id: string }>(sql`
          insert into bank_accounts (org_id, ledger_account_id, bank_name, account_label)
          values (app_current_org_id(), ${ids.get('BANK')!}::uuid, 'ICICI', 'Current')
          returning id
        `);
        const party = await tx.execute<{ id: string }>(sql`
          insert into parties (org_id, kind, name, state_code, credit_days)
          values (app_current_org_id(), 'customer', 'Clean Customer', '29', 0)
          returning id
        `);
        return { accountId: bank.rows[0]!.id, partyId: party.rows[0]!.id };
      });

      // A receipt of ₹59,000 into the bank on 5 June.
      const rct = await withTenant({ orgId: clean.orgA, userId: null }, async (tx) => {
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: 'receipt',
          fyLabel: '25-26',
          prefix: 'RCT',
        });
        const created = await createVoucher(tx, {
          voucherType: 'receipt',
          voucherNo,
          fyLabel: '25-26',
          voucherDate: '2025-06-05',
          partyId: setup.partyId,
          supplierStateCode: null,
          placeOfSupplyStateCode: null,
          supplyType: null,
          reference: 'N111111',
          narration: null,
          calculation: null,
          lines: [],
          entries: receiptEntries({ amountPaise: 59_000_00n, intoAccountCode: 'BANK' }),
          totalPaise: 59_000_00n,
        });
        await postVoucher(tx, { voucherId: created.id, userId: null });
        return created;
      });

      // The statement shows that deposit and a bank charge the books lack.
      const csv = [
        'Date,Narration,Ref No.,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '05/06/2025,"NEFT CR-CLEAN CUSTOMER",N111111,,"59,000.00","59,000.00"',
        '12/06/2025,"BANK CHARGES",,"118.00",,"58,882.00"',
      ].join('\n');

      await withTenant({ orgId: clean.orgA, userId: null }, async (tx) => {
        const parsed = parseStatement(csv);
        await storeStatement(tx, {
          bankAccountId: setup.accountId,
          documentId: null,
          lines: parsed.lines,
          problemCount: 0,
          openingBalancePaise: parsed.openingBalancePaise,
          closingBalancePaise: parsed.closingBalancePaise,
          balanceConsistent: true,
          importedBy: null,
        });
        await generateSuggestions(tx, { bankAccountId: setup.accountId });
      });

      // Accept the deposit match.
      const queue = await getReviewQueue(cleanCtx, { bankAccountId: setup.accountId });
      const deposit = queue.find((r) => r.amountPaise === 59_000_00n)!;
      expect(deposit.suggestion?.voucherId).toBe(rct.id);
      await withTenant({ orgId: clean.orgA, userId: clean.userA }, (tx) =>
        acceptSuggestion(tx, { suggestionId: deposit.suggestion!.id, userId: clean.userA }),
      );

      const rec = await getReconciliation(cleanCtx, {
        bankAccountId: setup.accountId,
        asOf: '2025-06-30',
      });

      // Books hold ₹59,000. The bank also took ₹118 the books do not know about.
      expect(rec.bookBalancePaise).toBe(59_000_00n);
      expect(rec.unreconciledStatementTotalPaise).toBe(-118_00n);
      expect(rec.unpresentedTotalPaise).toBe(0n);
      // 59,000 − 118 = 58,882, which is the statement's own closing figure.
      expect(rec.reconciledBalancePaise).toBe(58_882_00n);
      expect(rec.statementBalancePaise).toBe(58_882_00n);
      expect(rec.differencePaise).toBe(0n);

      await cleanup(owner, clean);
    });

    it('shows a voucher the bank has not seen as unpresented', async () => {
      // A cheque written but not yet cleared.
      await receipt({ date: '2025-06-28', amountPaise: 7_777_00n });
      const rec = await getReconciliation(ctx, { bankAccountId, asOf: '2025-06-30' });
      expect(rec.unpresentedVouchers.length).toBeGreaterThan(0);
      expect(rec.unpresentedTotalPaise).toBeGreaterThan(0n);
    });

    it('counts an ignored line towards the reconciliation', async () => {
      // "Accounted for elsewhere" still appeared on the statement and still has
      // to be explained by the arithmetic.
      const rec = await getReconciliation(ctx, { bankAccountId, asOf: '2025-06-30' });
      expect(rec.unreconciledStatementLines.some((l) => l.status === 'ignored')).toBe(true);
    });

    it('refuses a bank account from another company', async () => {
      await expect(
        getReconciliation(ctxB, { bankAccountId, asOf: '2025-06-30' }),
      ).rejects.toThrow(/does not exist in this company/i);
    });

    it('shows no statement lines to another company', async () => {
      const queue = await getReviewQueue(ctxB, { bankAccountId });
      expect(queue).toEqual([]);
    });
  });
});
