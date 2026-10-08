import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { withTenant } from '../../src/lib/db/tenant';
import { allocateVoucherNumber, createVoucher, postVoucher } from '../../src/lib/db/ledger';
import { journalEntries } from '../../src/lib/accounting/posting';
import { getControlCentreData } from '../../src/server/dashboard';
import type { RequestContext } from '../../src/lib/auth/context';
import { cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * The dashboard's raw reads, against a real database: the SQL runs under RLS,
 * a figure lands on the day it was posted, and another company's entries
 * never appear.
 */
describe('dashboard data', () => {
  let owner: Pool;
  let fx: Fixture;
  const asContext = (orgId: string, userId: string): RequestContext =>
    ({ orgId, userId, role: 'owner', clerkUserId: 'test', ip: null, userAgent: null }) as unknown as RequestContext;

  const rentPaid = (orgId: string, date: string, rupees: bigint) =>
    withTenant({ orgId, userId: null }, async (tx) => {
      const voucherNo = await allocateVoucherNumber(tx, { voucherType: 'journal', fyLabel: '26-27', prefix: 'JV' });
      const v = await createVoucher(tx, {
        voucherType: 'journal', voucherNo, fyLabel: '26-27', voucherDate: date, partyId: null,
        supplierStateCode: null, placeOfSupplyStateCode: null, supplyType: null, reference: null,
        narration: 'Rent', calculation: null, lines: [],
        entries: journalEntries([
          { accountCode: 'RENT', debitPaise: rupees * 100n, creditPaise: 0n },
          { accountCode: 'CASH', debitPaise: 0n, creditPaise: rupees * 100n },
        ]),
        totalPaise: rupees * 100n,
      });
      await postVoucher(tx, { voucherId: v.id, userId: null });
    });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `dash${Date.now()}`);
    await rentPaid(fx.orgA, '2026-09-10', 12_000n);
    await rentPaid(fx.orgB, '2026-09-10', 99_000n);
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  it('puts an expense and its cash on the day it was posted, and only for this company', async () => {
    const data = await getControlCentreData(asContext(fx.orgA, fx.userA), {
      today: '2026-10-08',
      fyStart: '2026-04-01',
    });
    expect(data.days).toHaveLength(1);
    expect(data.days[0]).toMatchObject({
      date: '2026-09-10',
      expensePaise: 12_000_00n,
      cashOutPaise: 12_000_00n,
      cashInPaise: 0n,
      revenuePaise: 0n,
    });
    expect(data.current.expensePaise).toBe(12_000_00n);
    expect(data.prior.expensePaise).toBe(0n);
    expect(data.expenseMonths).toEqual([
      { month: '2026-09-01', code: 'RENT', name: expect.any(String), amountPaise: 12_000_00n },
    ]);
  });

  it('counts nothing that is not there', async () => {
    const { counts, topProducts, fastMovers } = await getControlCentreData(asContext(fx.orgA, fx.userA), {
      today: '2026-10-08',
      fyStart: '2026-04-01',
    });
    expect(counts.invoices).toBe(0);
    expect(counts.dealsWon + counts.dealsLost).toBe(0);
    expect(topProducts).toEqual([]);
    expect(fastMovers).toEqual([]);
  });
});
