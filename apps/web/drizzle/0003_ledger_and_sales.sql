-- ════════════════════════════════════════════════════════════════════════════
-- Step B: parties, items, versioned tax rules, number series, and the voucher
-- core with strict double entry.
--
-- Two invariants are enforced by the database rather than by application code,
-- because both are the kind of rule that a future code path will eventually
-- forget:
--   1. Every posted voucher balances: sum(debit) = sum(credit).
--   2. A posted voucher is immutable. Corrections are reversal vouchers.
-- ════════════════════════════════════════════════════════════════════════════

-- ── tax_rules: versioned, never hardcoded ───────────────────────────────────
-- Rates, thresholds and sections all live here with effective dates, so a past
-- period recomputes under the rule that applied then.

create table if not exists tax_rules (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid references organizations (id) on delete cascade,
  kind                   text        not null,
  code                   text        not null,
  label                  text        not null,
  rate_bps               integer,
  threshold_single_paise bigint,
  threshold_annual_paise bigint,
  section                text,
  section_legacy         text,
  effective_from         date        not null,
  effective_to           date,
  -- Every rule ships unverified. A CA marks it off; nothing in the product
  -- may claim a figure is compliant while this is false.
  needs_ca_verification  boolean     not null default true,
  verified_by            text,
  verified_at            timestamptz,
  source_note            text,
  created_at             timestamptz not null default now(),
  constraint tax_rules_kind_check check (kind in ('gst_rate','tds_section','cess','other')),
  constraint tax_rules_rate_check check (rate_bps is null or rate_bps between 0 and 100000),
  constraint tax_rules_period_check check (effective_to is null or effective_to > effective_from)
);
-- org_id null = a rule shipped with the product; a row with an org_id overrides
-- it for that company only.
create index if not exists tax_rules_lookup_idx on tax_rules (kind, code, effective_from desc);
create index if not exists tax_rules_org_idx on tax_rules (org_id);

-- ── parties ─────────────────────────────────────────────────────────────────

create table if not exists parties (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid        not null references organizations (id) on delete cascade,
  kind          text        not null,
  name          text        not null,
  legal_name    text,
  gstin         text,
  pan           text,
  state_code    text,
  -- Where a supply to this party is taxed. Defaults to their state but can be
  -- overridden per invoice: place of supply is not always the billing address.
  place_of_supply_state_code text,
  email         text,
  phone         text,
  billing_address text,
  credit_days   integer     not null default 0,
  credit_limit_paise bigint,
  is_active     boolean     not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint parties_kind_check check (kind in ('customer','supplier','both')),
  constraint parties_credit_days_check check (credit_days >= 0),
  constraint parties_gstin_check check (
    gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][A-Z][0-9A-Z]$'
  ),
  constraint parties_pan_check check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
);
create index if not exists parties_org_kind_idx on parties (org_id, kind) where is_active;
create unique index if not exists parties_org_gstin_key on parties (org_id, gstin) where gstin is not null;
create index if not exists parties_org_name_idx on parties (org_id, lower(name));

-- ── items ───────────────────────────────────────────────────────────────────

create table if not exists items (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid        not null references organizations (id) on delete cascade,
  code         text,
  name         text        not null,
  kind         text        not null default 'goods',
  hsn_sac      text,
  unit         text        not null default 'NOS',
  -- The rate is stored on the item rather than only referenced, so an invoice
  -- raised today is unaffected by a later rate change; tax_rules carries the
  -- history for reporting and for rate lookups when creating new items.
  gst_rate_bps integer     not null default 0,
  cess_rate_bps integer    not null default 0,
  sale_price_paise bigint,
  purchase_price_paise bigint,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint items_kind_check check (kind in ('goods','service')),
  constraint items_rate_check check (gst_rate_bps between 0 and 100000),
  constraint items_cess_check check (cess_rate_bps between 0 and 100000),
  -- Goods use HSN, services use SAC; both are digits, 4 to 8 of them.
  constraint items_hsn_check check (hsn_sac is null or hsn_sac ~ '^[0-9]{4,8}$')
);
create unique index if not exists items_org_code_key on items (org_id, code) where code is not null;
create index if not exists items_org_name_idx on items (org_id, lower(name));

-- ── number_series: one sequence per voucher type per financial year ─────────

create table if not exists number_series (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid        not null references organizations (id) on delete cascade,
  voucher_type  text        not null,
  fy_label      text        not null,
  prefix        text        not null,
  next_number   integer     not null default 1,
  width         integer     not null default 4,
  created_at    timestamptz not null default now(),
  constraint number_series_next_check check (next_number >= 1),
  constraint number_series_width_check check (width between 1 and 8)
);
create unique index if not exists number_series_org_type_fy_key
  on number_series (org_id, voucher_type, fy_label);

-- ── vouchers ────────────────────────────────────────────────────────────────

create table if not exists vouchers (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid        not null references organizations (id) on delete cascade,
  voucher_type   text        not null,
  -- Max 16 characters, unique per financial year: SB/25-26/0001
  voucher_no     text        not null,
  fy_label       text        not null,
  voucher_date   date        not null,
  party_id       uuid        references parties (id) on delete restrict,
  -- Frozen onto the voucher: the state that decided CGST/SGST versus IGST must
  -- not change if the party is edited later.
  supplier_state_code        text,
  place_of_supply_state_code text,
  supply_type    text,
  reference      text,
  narration      text,
  taxable_paise  bigint      not null default 0,
  cgst_paise     bigint      not null default 0,
  sgst_paise     bigint      not null default 0,
  igst_paise     bigint      not null default 0,
  cess_paise     bigint      not null default 0,
  round_off_paise bigint     not null default 0,
  total_paise    bigint      not null default 0,
  status         text        not null default 'draft',
  -- Set when this voucher has been reversed; the only field a posted voucher
  -- may ever have written to it.
  reversed_by_voucher_id uuid references vouchers (id) on delete restrict,
  reverses_voucher_id    uuid references vouchers (id) on delete restrict,
  source_document_id     uuid,
  posted_at      timestamptz,
  posted_by      uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint vouchers_type_check check (voucher_type in
    ('sales','purchase','receipt','payment','contra','journal','credit_note','debit_note')),
  constraint vouchers_status_check check (status in ('draft','posted')),
  constraint vouchers_no_length_check check (char_length(voucher_no) <= 16),
  constraint vouchers_supply_type_check check (supply_type is null or supply_type in
    ('intra_state','inter_state','zero_rated','exempt'))
);
create unique index if not exists vouchers_org_type_fy_no_key
  on vouchers (org_id, voucher_type, fy_label, voucher_no);
create index if not exists vouchers_org_date_idx on vouchers (org_id, voucher_date desc);
create index if not exists vouchers_org_party_idx on vouchers (org_id, party_id);
create index if not exists vouchers_org_status_idx on vouchers (org_id, status);

-- ── voucher_lines ───────────────────────────────────────────────────────────

create table if not exists voucher_lines (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid        not null references organizations (id) on delete cascade,
  voucher_id     uuid        not null references vouchers (id) on delete cascade,
  line_no        integer     not null,
  item_id        uuid        references items (id) on delete restrict,
  description    text        not null,
  hsn_sac        text,
  unit           text,
  -- Scaled by 10000: four decimal places, integer arithmetic throughout.
  quantity       bigint      not null default 10000,
  unit_price_paise bigint    not null default 0,
  discount_paise bigint      not null default 0,
  gst_rate_bps   integer     not null default 0,
  cess_rate_bps  integer     not null default 0,
  taxable_paise  bigint      not null default 0,
  cgst_paise     bigint      not null default 0,
  sgst_paise     bigint      not null default 0,
  igst_paise     bigint      not null default 0,
  cess_paise     bigint      not null default 0,
  line_total_paise bigint    not null default 0,
  reverse_charge boolean     not null default false,
  created_at     timestamptz not null default now()
);
create unique index if not exists voucher_lines_voucher_line_key on voucher_lines (voucher_id, line_no);
create index if not exists voucher_lines_org_idx on voucher_lines (org_id);

-- ── tax_lines: the tax on a voucher, by head ────────────────────────────────

create table if not exists tax_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid        not null references organizations (id) on delete cascade,
  voucher_id    uuid        not null references vouchers (id) on delete cascade,
  head          text        not null,
  rate_bps      integer     not null,
  taxable_paise bigint      not null,
  amount_paise  bigint      not null,
  created_at    timestamptz not null default now(),
  constraint tax_lines_head_check check (head in ('cgst','sgst','igst','cess'))
);
create index if not exists tax_lines_voucher_idx on tax_lines (voucher_id);
create index if not exists tax_lines_org_idx on tax_lines (org_id);

-- ── ledger_entries: the double entry itself ─────────────────────────────────

create table if not exists ledger_entries (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid        not null references organizations (id) on delete cascade,
  voucher_id   uuid        not null references vouchers (id) on delete cascade,
  account_id   uuid        not null references accounts (id) on delete restrict,
  party_id     uuid        references parties (id) on delete restrict,
  entry_date   date        not null,
  debit_paise  bigint      not null default 0,
  credit_paise bigint      not null default 0,
  narration    text,
  created_at   timestamptz not null default now(),
  -- One side or the other, never both, never neither.
  constraint ledger_entries_sides_check check (
    (debit_paise > 0 and credit_paise = 0) or (credit_paise > 0 and debit_paise = 0)
  ),
  constraint ledger_entries_non_negative_check check (debit_paise >= 0 and credit_paise >= 0)
);
create index if not exists ledger_entries_org_account_date_idx
  on ledger_entries (org_id, account_id, entry_date);
create index if not exists ledger_entries_voucher_idx on ledger_entries (voucher_id);
create index if not exists ledger_entries_org_party_idx on ledger_entries (org_id, party_id);

-- ── allocations: which receipt cleared which invoice ────────────────────────

create table if not exists voucher_allocations (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid        not null references organizations (id) on delete cascade,
  -- The receipt or payment.
  settlement_voucher_id uuid     not null references vouchers (id) on delete cascade,
  -- The invoice or bill being settled.
  target_voucher_id  uuid        not null references vouchers (id) on delete restrict,
  amount_paise       bigint      not null,
  created_at         timestamptz not null default now(),
  constraint voucher_allocations_amount_check check (amount_paise > 0),
  constraint voucher_allocations_distinct_check check (settlement_voucher_id <> target_voucher_id)
);
create unique index if not exists voucher_allocations_pair_key
  on voucher_allocations (settlement_voucher_id, target_voucher_id);
create index if not exists voucher_allocations_target_idx on voucher_allocations (target_voucher_id);

-- ── documents: private file storage ─────────────────────────────────────────

create table if not exists documents (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid        not null references organizations (id) on delete cascade,
  storage_key    text        not null,
  original_filename text     not null,
  mime_type      text        not null,
  byte_size      bigint      not null,
  -- SHA-256 of the bytes: the first duplicate gate, before anything is read.
  content_hash   text        not null,
  -- What the uploader said it is. AI classification arrives in step H.
  declared_type  text,
  status         text        not null default 'stored',
  uploaded_by    uuid        references users (id) on delete set null,
  linked_voucher_id uuid     references vouchers (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint documents_status_check check (status in
    ('stored','extracting','extracted','needs_review','posted','rejected','superseded')),
  constraint documents_size_check check (byte_size > 0)
);
create index if not exists documents_org_created_idx on documents (org_id, created_at desc);
create unique index if not exists documents_org_hash_key on documents (org_id, content_hash);

-- ── invariant 1: every voucher balances ─────────────────────────────────────
-- A CONSTRAINT TRIGGER deferred to commit, so a voucher may be built up over
-- several statements inside one transaction and is checked once, at the end.

create or replace function app_assert_voucher_balanced() returns trigger
language plpgsql as $$
declare
  v_voucher_id uuid := coalesce(new.voucher_id, old.voucher_id);
  v_debit  bigint;
  v_credit bigint;
  v_status text;
begin
  select status into v_status from vouchers where id = v_voucher_id;
  -- A draft is allowed to be unbalanced while it is being edited; posting is
  -- what asserts it.
  if v_status is null or v_status <> 'posted' then
    return null;
  end if;

  select coalesce(sum(debit_paise), 0), coalesce(sum(credit_paise), 0)
    into v_debit, v_credit
    from ledger_entries where voucher_id = v_voucher_id;

  if v_debit <> v_credit then
    raise exception
      'Voucher % does not balance: debits % paise, credits % paise (difference %)',
      v_voucher_id, v_debit, v_credit, v_debit - v_credit
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists ledger_entries_balanced on ledger_entries;
create constraint trigger ledger_entries_balanced
  after insert or update or delete on ledger_entries
  deferrable initially deferred
  for each row execute function app_assert_voucher_balanced();

-- Posting a voucher must also assert it, or a voucher with no entries at all
-- would pass: the trigger above only fires when entries change.
create or replace function app_assert_voucher_balanced_on_post() returns trigger
language plpgsql as $$
declare v_debit bigint; v_credit bigint;
begin
  if new.status <> 'posted' then return new; end if;

  select coalesce(sum(debit_paise), 0), coalesce(sum(credit_paise), 0)
    into v_debit, v_credit
    from ledger_entries where voucher_id = new.id;

  if v_debit = 0 and v_credit = 0 then
    raise exception 'Voucher % has no ledger entries and cannot be posted', new.id
      using errcode = 'check_violation';
  end if;
  if v_debit <> v_credit then
    raise exception
      'Voucher % does not balance: debits % paise, credits % paise',
      new.id, v_debit, v_credit using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists vouchers_balanced_on_post on vouchers;
create constraint trigger vouchers_balanced_on_post
  after insert or update of status on vouchers
  deferrable initially deferred
  for each row execute function app_assert_voucher_balanced_on_post();

-- ── invariant 2: a posted voucher is immutable ──────────────────────────────

-- Deleting a whole company must remain possible: an organization delete
-- cascades to its vouchers, and a blanket block would make a tenant
-- undeletable, which is not a property anyone wants to discover during an
-- erasure request. The exemption is deliberately narrow:
--
--   * it applies to DELETE only — a posted voucher can never be EDITED, by
--     anyone, including the owner;
--   * it applies only to the role that OWNS the table, which the application
--     role is not (tests/integration/rls-privileges.test.ts asserts that), so
--     no request served by the app can ever reach it.
--
-- The owner is read from the catalogue rather than hardcoded, so the check
-- stays correct whatever the deploying role is called.
create or replace function app_is_table_owner(p_table regclass) returns boolean
language sql stable as $$
  select current_user = (select pg_get_userbyid(relowner) from pg_class where oid = p_table)
$$;

create or replace function app_block_posted_voucher_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' and not app_is_table_owner('vouchers'::regclass) then
      raise exception 'Voucher % is posted and cannot be deleted. Post a reversal instead.', old.id
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.status = 'posted' then
    -- The single permitted change: recording that a reversal now exists. Every
    -- other correction is a new voucher.
    if (new.reversed_by_voucher_id is distinct from old.reversed_by_voucher_id)
       and to_jsonb(new) - 'reversed_by_voucher_id' - 'updated_at'
         = to_jsonb(old) - 'reversed_by_voucher_id' - 'updated_at' then
      return new;
    end if;
    raise exception 'Voucher % is posted and cannot be edited. Post a reversal instead.', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists vouchers_immutable_when_posted on vouchers;
create trigger vouchers_immutable_when_posted
  before update or delete on vouchers
  for each row execute function app_block_posted_voucher_change();

-- Lines and ledger entries of a posted voucher are equally immutable.
create or replace function app_block_posted_child_change() returns trigger
language plpgsql as $$
declare v_status text;
begin
  -- Same narrow exemption as above, and for the same reason: an organization
  -- delete cascades through here. An UPDATE is still refused for everyone.
  if tg_op = 'DELETE' and app_is_table_owner(tg_relid::regclass) then
    return old;
  end if;

  select status into v_status from vouchers
   where id = coalesce(new.voucher_id, old.voucher_id);
  if v_status = 'posted' then
    raise exception 'Voucher % is posted; its lines cannot be changed.',
      coalesce(new.voucher_id, old.voucher_id) using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists voucher_lines_immutable on voucher_lines;
create trigger voucher_lines_immutable
  before update or delete on voucher_lines
  for each row execute function app_block_posted_child_change();

drop trigger if exists ledger_entries_immutable on ledger_entries;
create trigger ledger_entries_immutable
  before update or delete on ledger_entries
  for each row execute function app_block_posted_child_change();

-- ── row level security ──────────────────────────────────────────────────────

do $$
declare
  t text;
  v_owner text := current_user;
  v_tenant_tables text[] := array[
    'parties','items','number_series','vouchers','voucher_lines','tax_lines',
    'ledger_entries','voucher_allocations','documents'
  ];
begin
  foreach t in array v_tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists %I on %I', t || '_tenant', t);
    execute format(
      'create policy %I on %I for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id())',
      t || '_tenant', t);
    execute format('drop policy if exists owner_full_access on %I', t);
    execute format('create policy owner_full_access on %I for all to %I using (true) with check (true)', t, v_owner);
    execute format('grant select, insert, update, delete on %I to sherrbyte_app', t);
  end loop;
end $$;

-- tax_rules holds product-wide rules (org_id null) as well as per-company
-- overrides, so its policy admits both rather than the uniform org_id rule.
alter table tax_rules enable row level security;
alter table tax_rules force  row level security;

drop policy if exists tax_rules_readable on tax_rules;
create policy tax_rules_readable on tax_rules
  for select using (org_id is null or org_id = app_current_org_id());

drop policy if exists tax_rules_tenant_write on tax_rules;
create policy tax_rules_tenant_write on tax_rules
  for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id());

do $$
declare v_owner text := current_user;
begin
  execute format('drop policy if exists owner_full_access on tax_rules');
  execute format('create policy owner_full_access on tax_rules for all to %I using (true) with check (true)', v_owner);
end $$;

grant select, insert, update, delete on tax_rules to sherrbyte_app;

-- ── number allocation ───────────────────────────────────────────────────────
-- Atomic and race-free. Two properties worth stating, because both were wrong
-- in the first draft:
--
--   1. NOT security definer. The org is taken from the tenant context, never
--      from a parameter. A definer function taking p_org_id would let any
--      caller increment — and read — another company's series, which defeats
--      the isolation everything else here is built on.
--
--   2. ON CONFLICT DO UPDATE rather than DO NOTHING followed by an UPDATE.
--      Under READ COMMITTED, two transactions creating the very first voucher
--      of a series would both insert, one would do nothing, and its follow-up
--      UPDATE would not see the other's uncommitted row — so it would find no
--      series and fail. DO UPDATE locks the existing row and re-reads it, so
--      the second transaction blocks and then gets the next number.
--
-- A new series is created with next_number = 2 and returns 1: the row records
-- what to hand out next, and 1 has just been handed out.

drop function if exists app_next_voucher_number(uuid, text, text, text, integer);

create or replace function app_next_voucher_number(
  p_voucher_type text, p_fy_label text, p_prefix text, p_width integer default 4
) returns text
language plpgsql as $$
declare
  v_org_id uuid := app_current_org_id();
  v_number integer;
  v_width  integer;
  v_prefix text;
begin
  if v_org_id is null then
    raise exception 'No tenant context: a voucher number cannot be allocated'
      using errcode = 'insufficient_privilege';
  end if;

  insert into number_series (org_id, voucher_type, fy_label, prefix, width, next_number)
  values (v_org_id, p_voucher_type, p_fy_label, p_prefix, coalesce(p_width, 4), 2)
  on conflict (org_id, voucher_type, fy_label)
    do update set next_number = number_series.next_number + 1
  returning next_number - 1, width, prefix
  into v_number, v_width, v_prefix;

  return v_prefix || '/' || p_fy_label || '/' || lpad(v_number::text, v_width, '0');
end $$;

revoke all on function app_next_voucher_number(text, text, text, integer) from public;
grant execute on function app_next_voucher_number(text, text, text, integer) to sherrbyte_app;

-- ── seeded GST slabs ────────────────────────────────────────────────────────
-- Product-wide (org_id null), and every one of them unverified until a CA says
-- otherwise. Effective date is the GST commencement; later revisions are new
-- rows rather than edits to these.

insert into tax_rules (org_id, kind, code, label, rate_bps, effective_from, needs_ca_verification, source_note)
select null, 'gst_rate', v.code, v.label, v.rate_bps, date '2017-07-01', true,
       'Seeded slab. Confirm the rate and its effective date against the current notification before relying on it.'
from (values
  ('GST_0',    'Nil rated / exempt', 0),
  ('GST_0_25', '0.25%',             25),
  ('GST_3',    '3%',               300),
  ('GST_5',    '5%',               500),
  ('GST_12',   '12%',             1200),
  ('GST_18',   '18%',             1800),
  ('GST_28',   '28%',             2800),
  ('GST_40',   '40%',             4000)
) as v(code, label, rate_bps)
where not exists (
  select 1 from tax_rules t where t.org_id is null and t.kind = 'gst_rate' and t.code = v.code
);

-- ── remove the chartless shortcut ───────────────────────────────────────────
-- app_create_organization() created an organization with no chart of accounts.
-- That looked harmless until the first voucher, which cannot post without a
-- Sundry Debtors or Sales account. Every caller now goes through
-- app_create_company() with the chart supplied, so the shortcut is removed
-- rather than left as a trap.
drop function if exists app_create_organization(text, text, uuid);

-- ── cross-tenant referential integrity ──────────────────────────────────────
-- Postgres enforces a foreign key with an internal check that does NOT apply
-- row level security. A plain `party_id references parties (id)` therefore lets
-- one company's voucher point at another company's party: the insert passes
-- its own WITH CHECK (its org_id is its own) and the FK resolves a row the
-- caller cannot see. It was reachable, and a test now proves it is not.
--
-- The fix is a composite key. Every reference between tenant tables carries
-- org_id, so the referenced row must belong to the same organization or no
-- matching key exists at all. The uniqueness below is redundant against the
-- primary key, and exists only to give the composite key a target.

alter table parties  add constraint parties_id_org_key  unique (id, org_id);
alter table items    add constraint items_id_org_key    unique (id, org_id);
alter table accounts add constraint accounts_id_org_key unique (id, org_id);
alter table vouchers add constraint vouchers_id_org_key unique (id, org_id);
alter table documents add constraint documents_id_org_key unique (id, org_id);

-- vouchers → parties
alter table vouchers drop constraint if exists vouchers_party_id_fkey;
alter table vouchers add constraint vouchers_party_org_fkey
  foreign key (party_id, org_id) references parties (id, org_id) on delete restrict;

-- A voucher may only reverse, or be reversed by, a voucher of the same company.
alter table vouchers drop constraint if exists vouchers_reversed_by_voucher_id_fkey;
alter table vouchers drop constraint if exists vouchers_reverses_voucher_id_fkey;
alter table vouchers add constraint vouchers_reversed_by_org_fkey
  foreign key (reversed_by_voucher_id, org_id) references vouchers (id, org_id) on delete restrict;
alter table vouchers add constraint vouchers_reverses_org_fkey
  foreign key (reverses_voucher_id, org_id) references vouchers (id, org_id) on delete restrict;

alter table vouchers add constraint vouchers_source_document_org_fkey
  foreign key (source_document_id, org_id) references documents (id, org_id) on delete set null;

-- voucher_lines → vouchers, items
alter table voucher_lines drop constraint if exists voucher_lines_voucher_id_fkey;
alter table voucher_lines drop constraint if exists voucher_lines_item_id_fkey;
alter table voucher_lines add constraint voucher_lines_voucher_org_fkey
  foreign key (voucher_id, org_id) references vouchers (id, org_id) on delete cascade;
alter table voucher_lines add constraint voucher_lines_item_org_fkey
  foreign key (item_id, org_id) references items (id, org_id) on delete restrict;

-- tax_lines → vouchers
alter table tax_lines drop constraint if exists tax_lines_voucher_id_fkey;
alter table tax_lines add constraint tax_lines_voucher_org_fkey
  foreign key (voucher_id, org_id) references vouchers (id, org_id) on delete cascade;

-- ledger_entries → vouchers, accounts, parties
alter table ledger_entries drop constraint if exists ledger_entries_voucher_id_fkey;
alter table ledger_entries drop constraint if exists ledger_entries_account_id_fkey;
alter table ledger_entries drop constraint if exists ledger_entries_party_id_fkey;
alter table ledger_entries add constraint ledger_entries_voucher_org_fkey
  foreign key (voucher_id, org_id) references vouchers (id, org_id) on delete cascade;
alter table ledger_entries add constraint ledger_entries_account_org_fkey
  foreign key (account_id, org_id) references accounts (id, org_id) on delete restrict;
alter table ledger_entries add constraint ledger_entries_party_org_fkey
  foreign key (party_id, org_id) references parties (id, org_id) on delete restrict;

-- voucher_allocations → vouchers (both sides)
alter table voucher_allocations drop constraint if exists voucher_allocations_settlement_voucher_id_fkey;
alter table voucher_allocations drop constraint if exists voucher_allocations_target_voucher_id_fkey;
alter table voucher_allocations add constraint voucher_allocations_settlement_org_fkey
  foreign key (settlement_voucher_id, org_id) references vouchers (id, org_id) on delete cascade;
alter table voucher_allocations add constraint voucher_allocations_target_org_fkey
  foreign key (target_voucher_id, org_id) references vouchers (id, org_id) on delete restrict;

-- documents → vouchers
alter table documents drop constraint if exists documents_linked_voucher_id_fkey;
alter table documents add constraint documents_linked_voucher_org_fkey
  foreign key (linked_voucher_id, org_id) references vouchers (id, org_id) on delete set null;

-- accounts and account_groups predate this file and have the same exposure.
alter table account_groups add constraint account_groups_id_org_key unique (id, org_id);
alter table accounts drop constraint if exists accounts_group_id_fkey;
alter table accounts add constraint accounts_group_org_fkey
  foreign key (group_id, org_id) references account_groups (id, org_id) on delete restrict;
alter table account_groups drop constraint if exists account_groups_parent_id_fkey;
alter table account_groups add constraint account_groups_parent_org_fkey
  foreign key (parent_id, org_id) references account_groups (id, org_id) on delete restrict;
