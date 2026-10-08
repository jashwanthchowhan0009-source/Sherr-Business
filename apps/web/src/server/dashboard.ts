import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';
import { addDays, addMonths, yearBefore } from '@/lib/dashboard/dates';

/**
 * The raw reads behind the dashboard's control-centre sections.
 *
 * Everything here is a query over posted ledger entries or live records. The
 * shaping — monthly buckets, comparisons, what needs attention — is done by the
 * pure code in src/lib/dashboard/model.ts, where it is tested; this file only
 * fetches.
 */

const guard = (ctx: RequestContext) => {
  if (!can(ctx.role, 'voucher:read')) throw forbidden('view the books');
};

export interface DayRow {
  date: string;
  /** Movement in the Sales group: revenue from operations. */
  revenuePaise: bigint;
  incomePaise: bigint;
  expensePaise: bigint;
  /** Money into cash and bank, contra transfers between them excluded. */
  cashInPaise: bigint;
  cashOutPaise: bigint;
}

export interface PeriodSums {
  revenuePaise: bigint;
  incomePaise: bigint;
  expensePaise: bigint;
  /** Finance costs and depreciation, added back to reach EBITDA. */
  addBackPaise: bigint;
}

export interface ExpenseMonthRow {
  month: string; // YYYY-MM-01
  code: string;
  name: string;
  amountPaise: bigint;
}

export interface RankedRow {
  name: string;
  amountPaise: bigint;
  quantity: bigint;
  unit: string | null;
}

export interface Counts {
  customers: number;
  newCustomers: number;
  invoices: number;
  openPurchaseOrders: number;
  openPurchaseOrderPaise: bigint;
  unmatchedBankLines: number;
  goodsItems: number;
  slowMovingItems: number;
  dealsWon: number;
  dealsLost: number;
}

export interface ControlCentreData {
  days: DayRow[];
  seriesFrom: string;
  cashBeforeSeriesPaise: bigint;
  prior: PeriodSums;
  current: PeriodSums;
  expenseMonths: ExpenseMonthRow[];
  topProducts: RankedRow[];
  fastMovers: RankedRow[];
  counts: Counts;
}

const CASH_GROUPS = sql`('CASH_IN_HAND', 'BANK_ACCOUNTS')`;

export async function getControlCentreData(
  ctx: RequestContext,
  input: { today: string; fyStart: string },
): Promise<ControlCentreData> {
  guard(ctx);
  const { today, fyStart } = input;
  const seriesFrom = yearBefore(today);
  const priorFrom = yearBefore(fyStart);
  const priorTo = yearBefore(today);
  const last30 = addDays(today, -30);
  const last90 = addDays(today, -90);
  // The two complete months before this one, plus this one, for month-on-month.
  const expenseFrom = addMonths(today, -2);

  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const daily = tx.execute<{
      d: string; revenue: string; income: string; expense: string; cash_in: string; cash_out: string;
    }>(sql`
      select l.entry_date::text as d,
             coalesce(sum(case when g.code = 'SALES' then l.credit_paise - l.debit_paise end), 0)::text as revenue,
             coalesce(sum(case when a.nature = 'income' then l.credit_paise - l.debit_paise end), 0)::text as income,
             coalesce(sum(case when a.nature = 'expense' then l.debit_paise - l.credit_paise end), 0)::text as expense,
             coalesce(sum(case when g.code in ${CASH_GROUPS} and v.voucher_type <> 'contra'
                               then l.debit_paise end), 0)::text as cash_in,
             coalesce(sum(case when g.code in ${CASH_GROUPS} and v.voucher_type <> 'contra'
                               then l.credit_paise end), 0)::text as cash_out
        from ledger_entries l
        join vouchers v on v.id = l.voucher_id and v.status = 'posted'
        join accounts a on a.id = l.account_id
        join account_groups g on g.id = a.group_id
       where l.entry_date between ${seriesFrom}::date and ${today}::date
       group by l.entry_date
       order by l.entry_date
    `);

    const cashBefore = tx.execute<{ net: string }>(sql`
      select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as net
        from ledger_entries l
        join vouchers v on v.id = l.voucher_id and v.status = 'posted'
        join accounts a on a.id = l.account_id
        join account_groups g on g.id = a.group_id
       where l.entry_date < ${seriesFrom}::date
         and g.code in ${CASH_GROUPS}
    `);

    const sums = (from: string, to: string) =>
      tx.execute<{ revenue: string; income: string; expense: string; add_back: string }>(sql`
        select
          coalesce((select sum(case v.voucher_type when 'sales' then v.taxable_paise else -v.taxable_paise end)
                      from vouchers v
                     where v.status = 'posted' and v.voucher_type in ('sales', 'credit_note')
                       and v.voucher_date between ${from}::date and ${to}::date), 0)::text as revenue,
          coalesce(sum(case when a.nature = 'income' then l.credit_paise - l.debit_paise end), 0)::text as income,
          coalesce(sum(case when a.nature = 'expense' then l.debit_paise - l.credit_paise end), 0)::text as expense,
          coalesce(sum(case when a.code in ('BANK_CHARGES', 'DEPRECIATION')
                            then l.debit_paise - l.credit_paise end), 0)::text as add_back
          from ledger_entries l
          join vouchers v on v.id = l.voucher_id and v.status = 'posted'
          join accounts a on a.id = l.account_id
         where l.entry_date between ${from}::date and ${to}::date
      `);

    const expenseMonths = tx.execute<{ m: string; code: string; name: string; amount: string }>(sql`
      select date_trunc('month', l.entry_date)::date::text as m, a.code, a.name,
             sum(l.debit_paise - l.credit_paise)::text as amount
        from ledger_entries l
        join vouchers v on v.id = l.voucher_id and v.status = 'posted'
        join accounts a on a.id = l.account_id
       where a.nature = 'expense'
         and a.code not in ('INVENTORY_CHANGE', 'ROUND_OFF')
         and l.entry_date between ${expenseFrom}::date and ${today}::date
       group by 1, 2, 3
    `);

    const ranked = (from: string, byQuantity: boolean) =>
      tx.execute<{ name: string; amount: string; qty: string; unit: string | null }>(sql`
        select coalesce(i.name, vl.description) as name,
               sum(case v.voucher_type when 'sales' then vl.taxable_paise else -vl.taxable_paise end)::text as amount,
               sum(case v.voucher_type when 'sales' then vl.quantity else -vl.quantity end)::text as qty,
               max(coalesce(i.unit, vl.unit)) as unit
          from voucher_lines vl
          join vouchers v on v.id = vl.voucher_id and v.status = 'posted'
                          and v.voucher_type in ('sales', 'credit_note')
          left join items i on i.id = vl.item_id
         where v.voucher_date between ${from}::date and ${today}::date
           ${byQuantity ? sql`and vl.item_id is not null and i.kind = 'goods'` : sql``}
         group by 1
         order by ${byQuantity ? sql`3` : sql`2`} desc
         limit 5
      `);

    const counts = tx.execute<{
      customers: string; new_customers: string; invoices: string; open_pos: string; open_po_value: string;
      unmatched: string; goods: string; slow: string; won: string; lost: string;
    }>(sql`
      select
        (select count(*) from parties where kind in ('customer', 'both') and is_active)::text as customers,
        (select count(*) from parties where kind in ('customer', 'both')
                                       and created_at::date between ${fyStart}::date and ${today}::date)::text as new_customers,
        (select count(*) from vouchers where status = 'posted' and voucher_type = 'sales'
                                       and voucher_date between ${fyStart}::date and ${today}::date)::text as invoices,
        (select count(*) from purchase_orders where status in ('open', 'part_received'))::text as open_pos,
        (select coalesce(sum(total_paise), 0) from purchase_orders
          where status in ('open', 'part_received'))::text as open_po_value,
        (select count(*) from bank_statement_lines where status in ('unmatched', 'suggested'))::text as unmatched,
        (select count(*) from items where is_active and kind = 'goods')::text as goods,
        (select count(*) from items i
          where i.is_active and i.kind = 'goods'
            and not exists (select 1 from voucher_lines vl
                              join vouchers v on v.id = vl.voucher_id and v.status = 'posted'
                             where vl.item_id = i.id and v.voucher_type = 'sales'
                               and v.voucher_date >= ${last90}::date))::text as slow,
        (select count(*) from deals where status = 'won')::text as won,
        (select count(*) from deals where status = 'lost')::text as lost
    `);

    const [d, cb, prior, current, em, top, fast, c] = await Promise.all([
      daily,
      cashBefore,
      sums(priorFrom, priorTo),
      sums(fyStart, today),
      expenseMonths,
      ranked(fyStart, false),
      ranked(last30, true),
      counts,
    ]);

    const toSums = (r: { revenue: string; income: string; expense: string; add_back: string } | undefined): PeriodSums => ({
      revenuePaise: BigInt(r?.revenue ?? '0'),
      incomePaise: BigInt(r?.income ?? '0'),
      expensePaise: BigInt(r?.expense ?? '0'),
      addBackPaise: BigInt(r?.add_back ?? '0'),
    });
    const toRanked = (rows: { name: string; amount: string; qty: string; unit: string | null }[]): RankedRow[] =>
      rows.map((r) => ({
        name: r.name,
        amountPaise: BigInt(r.amount),
        quantity: BigInt(r.qty),
        unit: r.unit,
      }));
    const row = c.rows[0];
    const n = (v: string | undefined) => Number(v ?? 0);

    return {
      seriesFrom,
      days: d.rows.map((r) => ({
        date: r.d,
        revenuePaise: BigInt(r.revenue),
        incomePaise: BigInt(r.income),
        expensePaise: BigInt(r.expense),
        cashInPaise: BigInt(r.cash_in),
        cashOutPaise: BigInt(r.cash_out),
      })),
      cashBeforeSeriesPaise: BigInt(cb.rows[0]?.net ?? '0'),
      prior: toSums(prior.rows[0]),
      current: toSums(current.rows[0]),
      expenseMonths: em.rows.map((r) => ({
        month: r.m,
        code: r.code,
        name: r.name,
        amountPaise: BigInt(r.amount),
      })),
      topProducts: toRanked(top.rows).filter((r) => r.amountPaise > 0n),
      fastMovers: toRanked(fast.rows).filter((r) => r.quantity > 0n),
      counts: {
        customers: n(row?.customers),
        newCustomers: n(row?.new_customers),
        invoices: n(row?.invoices),
        openPurchaseOrders: n(row?.open_pos),
        openPurchaseOrderPaise: BigInt(row?.open_po_value ?? '0'),
        unmatchedBankLines: n(row?.unmatched),
        goodsItems: n(row?.goods),
        slowMovingItems: n(row?.slow),
        dealsWon: n(row?.won),
        dealsLost: n(row?.lost),
      },
    };
  });
}
