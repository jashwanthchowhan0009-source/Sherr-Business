-- ════════════════════════════════════════════════════════════════════════════
-- Step F: the account closing stock is entered against.
--
-- Schedule III shows "Changes in inventories of finished goods, work-in-progress
-- and stock-in-trade" as its own expense line, so the adjustment needs its own
-- group and account rather than being buried in direct expenses.
--
-- New companies get this from the chart of accounts in TypeScript. Companies
-- that already exist were created before it, so it is backfilled here: without
-- it, entering closing stock would fail on an account that does not exist, and
-- the error would appear at period end, which is the worst moment to discover a
-- missing ledger.
-- ════════════════════════════════════════════════════════════════════════════

insert into account_groups (org_id, code, name, parent_id, nature, bucket, is_system)
select o.id, 'INVENTORY_CHANGE', 'Changes in Inventories', null, 'expense', 'expenses', true
  from organizations o
 where not exists (
   select 1 from account_groups g where g.org_id = o.id and g.code = 'INVENTORY_CHANGE'
 );

insert into accounts (org_id, group_id, code, name, nature, is_system, note)
select g.org_id, g.id, 'INVENTORY_CHANGE', 'Changes in Inventories', 'expense', true,
       'Opening stock debited, closing stock credited. Carries (opening less closing) for the period.'
  from account_groups g
 where g.code = 'INVENTORY_CHANGE'
   and not exists (
     select 1 from accounts a where a.org_id = g.org_id and a.code = 'INVENTORY_CHANGE'
   );
