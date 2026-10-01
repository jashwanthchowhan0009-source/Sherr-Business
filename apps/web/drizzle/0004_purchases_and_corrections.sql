-- ════════════════════════════════════════════════════════════════════════════
-- Step C: purchase bills, payments, credit and debit notes, journals, contras.
--
-- Most of this step needs no new tables: a purchase bill is a voucher, and the
-- voucher core already enforces balance and immutability. What it does need is
-- the supplier's own document reference, and the duplicate guard that reference
-- makes possible.
-- ════════════════════════════════════════════════════════════════════════════

-- ── the supplier's own invoice reference ────────────────────────────────────
-- A purchase bill has two numbers: ours (vouchers.voucher_no) and the
-- supplier's, printed on their document. Only the supplier's can detect a
-- duplicate, which is the single most common and most expensive data-entry
-- error in payables — the same bill entered twice, paid twice.

alter table vouchers add column if not exists supplier_invoice_no   text;
alter table vouchers add column if not exists supplier_invoice_date date;

-- One bill per supplier per reference per financial year.
--
-- Scoped to the financial year, not for all time, because suppliers restart
-- their numbering every April: "INV/001" from the same supplier in 25-26 and in
-- 26-27 are different bills. Scoped to purchases and debit notes only, since a
-- sales invoice's number is ours and already unique.
--
-- Deliberately a constraint rather than a check in application code: the race
-- between two people entering the same bill is exactly the case a code check
-- misses.
create unique index if not exists vouchers_supplier_ref_key
  on vouchers (org_id, party_id, upper(supplier_invoice_no), fy_label)
  where supplier_invoice_no is not null
    and voucher_type in ('purchase', 'debit_note')
    and status = 'posted';

create index if not exists vouchers_supplier_invoice_idx
  on vouchers (org_id, supplier_invoice_no)
  where supplier_invoice_no is not null;

-- ── a contra may only move money between cash and bank ─────────────────────
-- Enforced in the database because a contra that touched a revenue account
-- would be a disguised sale, and that is worth more than a code comment.
--
-- The check runs on the ledger entry rather than on the voucher, because the
-- accounts are what must be constrained, and it reads the account's group to
-- avoid naming individual accounts a company may add its own versions of.

create or replace function app_assert_contra_accounts() returns trigger
language plpgsql as $$
declare
  v_type  text;
  v_group text;
begin
  select voucher_type into v_type from vouchers where id = new.voucher_id;
  if v_type is distinct from 'contra' then return new; end if;

  select g.code into v_group
    from accounts a join account_groups g on g.id = a.group_id
   where a.id = new.account_id;

  if v_group not in ('CASH_IN_HAND', 'BANK_ACCOUNTS') then
    raise exception
      'A contra moves money between cash and bank only; % is not such an account', new.account_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists ledger_entries_contra_accounts on ledger_entries;
create trigger ledger_entries_contra_accounts
  before insert on ledger_entries
  for each row execute function app_assert_contra_accounts();

-- ── a reversal must reverse something, and only once ───────────────────────

-- A voucher cannot reverse itself.
alter table vouchers drop constraint if exists vouchers_no_self_reversal;
alter table vouchers add constraint vouchers_no_self_reversal
  check (reverses_voucher_id is null or reverses_voucher_id <> id);

-- A posted voucher may be reversed once. A second reversal would double the
-- correction, and the first is already recorded on the original.
create unique index if not exists vouchers_one_reversal_key
  on vouchers (reverses_voucher_id)
  where reverses_voucher_id is not null;

-- ── period locking groundwork ───────────────────────────────────────────────
-- Step F locks periods properly. The column exists here so that the voucher
-- date check has somewhere to read from, and so a later migration adds
-- behaviour rather than schema to a table that by then holds real vouchers.

create table if not exists period_locks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid        not null references organizations (id) on delete cascade,
  locked_upto date        not null,
  reason      text,
  locked_by   uuid references users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists period_locks_org_key on period_locks (org_id);

alter table period_locks enable row level security;
alter table period_locks force  row level security;

drop policy if exists period_locks_tenant on period_locks;
create policy period_locks_tenant on period_locks
  for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id());

do $$
declare v_owner text := current_user;
begin
  execute format(
    'create policy owner_full_access on period_locks for all to %I using (true) with check (true)',
    v_owner);
end $$;

grant select, insert, update, delete on period_locks to sherrbyte_app;

-- Posting into a locked period is refused. The lock is a date, so a voucher
-- dated on or before it cannot be posted, whatever its type.
create or replace function app_assert_period_open() returns trigger
language plpgsql as $$
declare v_locked_upto date;
begin
  if new.status <> 'posted' then return new; end if;

  select locked_upto into v_locked_upto from period_locks where org_id = new.org_id;
  if v_locked_upto is not null and new.voucher_date <= v_locked_upto then
    raise exception
      'The books are locked to %. A voucher dated % cannot be posted; date the correction after the lock.',
      v_locked_upto, new.voucher_date
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists vouchers_period_open on vouchers;
create trigger vouchers_period_open
  before insert or update of status on vouchers
  for each row execute function app_assert_period_open();
