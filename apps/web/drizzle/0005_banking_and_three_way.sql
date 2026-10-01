-- ════════════════════════════════════════════════════════════════════════════
-- Step E: bank statement import, matching, reconciliation, and the
-- purchase order → goods receipt → bill three-way match.
-- ════════════════════════════════════════════════════════════════════════════

-- ── bank accounts ───────────────────────────────────────────────────────────
-- A company's real bank accounts, each tied to the ledger account it posts to.
-- Separate from `accounts` because a bank account carries facts no ledger needs
-- (an account number, an IFSC) and because a statement is imported against a
-- bank account, not against a ledger line.

create table if not exists bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid        not null references organizations (id) on delete cascade,
  ledger_account_id uuid     not null,
  bank_name      text        not null,
  account_label  text        not null,
  -- Last four digits only. The full number is not needed to reconcile and is
  -- not worth holding.
  account_number_last4 text,
  ifsc           text,
  is_active      boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint bank_accounts_last4_check check (account_number_last4 is null
                                              or account_number_last4 ~ '^[0-9]{4}$'),
  constraint bank_accounts_ifsc_check check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$')
);
alter table bank_accounts add constraint bank_accounts_id_org_key unique (id, org_id);
alter table bank_accounts add constraint bank_accounts_ledger_org_fkey
  foreign key (ledger_account_id, org_id) references accounts (id, org_id) on delete restrict;
create index if not exists bank_accounts_org_idx on bank_accounts (org_id) where is_active;

-- ── imported statements ─────────────────────────────────────────────────────

create table if not exists bank_statements (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid        not null references organizations (id) on delete cascade,
  bank_account_id uuid        not null,
  /** The uploaded file this was parsed from, so a figure traces to a document. */
  document_id     uuid,
  period_from     date        not null,
  period_to       date        not null,
  opening_balance_paise bigint,
  closing_balance_paise bigint,
  line_count      integer     not null default 0,
  problem_count   integer     not null default 0,
  -- Whether the statement's own running balance added up when it was imported.
  balance_consistent boolean  not null default true,
  imported_by     uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint bank_statements_period_check check (period_to >= period_from)
);
alter table bank_statements add constraint bank_statements_id_org_key unique (id, org_id);
alter table bank_statements add constraint bank_statements_account_org_fkey
  foreign key (bank_account_id, org_id) references bank_accounts (id, org_id) on delete cascade;
alter table bank_statements add constraint bank_statements_document_org_fkey
  foreign key (document_id, org_id) references documents (id, org_id) on delete set null;
create index if not exists bank_statements_org_account_idx
  on bank_statements (org_id, bank_account_id, period_from desc);

-- ── statement lines ────────────────────────────────────────────────────────

create table if not exists bank_statement_lines (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid        not null references organizations (id) on delete cascade,
  statement_id    uuid        not null,
  bank_account_id uuid        not null,
  row_number      integer     not null,
  line_date       date        not null,
  narration       text        not null,
  reference       text,
  -- Positive is money in, negative is money out.
  amount_paise    bigint      not null,
  balance_paise   bigint,
  status          text        not null default 'unmatched',
  /** The voucher this line was reconciled against, once a person accepted it. */
  matched_voucher_id uuid,
  reconciled_at   timestamptz,
  reconciled_by   uuid references users (id) on delete set null,
  -- A deterministic fingerprint of the transaction, so the same statement
  -- imported twice does not produce two of every line.
  fingerprint     text        not null,
  created_at      timestamptz not null default now(),
  constraint bank_statement_lines_status_check check (status in
    ('unmatched', 'suggested', 'reconciled', 'ignored')),
  constraint bank_statement_lines_amount_check check (amount_paise <> 0),
  -- A reconciled line must name what it was reconciled against, and an
  -- unreconciled one must not pretend to.
  constraint bank_statement_lines_matched_check check (
    (status = 'reconciled') = (matched_voucher_id is not null)
  )
);
alter table bank_statement_lines add constraint bank_statement_lines_id_org_key unique (id, org_id);
alter table bank_statement_lines add constraint bank_statement_lines_statement_org_fkey
  foreign key (statement_id, org_id) references bank_statements (id, org_id) on delete cascade;
alter table bank_statement_lines add constraint bank_statement_lines_account_org_fkey
  foreign key (bank_account_id, org_id) references bank_accounts (id, org_id) on delete cascade;
alter table bank_statement_lines add constraint bank_statement_lines_voucher_org_fkey
  foreign key (matched_voucher_id, org_id) references vouchers (id, org_id) on delete restrict;

-- The same transaction cannot be imported twice into the same bank account.
-- Scoped to the bank account rather than the statement, because overlapping
-- date ranges are the normal way people export statements.
create unique index if not exists bank_statement_lines_fingerprint_key
  on bank_statement_lines (org_id, bank_account_id, fingerprint);
create index if not exists bank_statement_lines_status_idx
  on bank_statement_lines (org_id, bank_account_id, status, line_date);

-- A voucher may be reconciled against at most one statement line: two lines
-- claiming the same receipt would double-count the money.
create unique index if not exists bank_statement_lines_voucher_key
  on bank_statement_lines (matched_voucher_id)
  where matched_voucher_id is not null;

-- ── match suggestions ──────────────────────────────────────────────────────
-- Suggestions are stored rather than recomputed so that what a person was shown
-- is recoverable later: "the system proposed this and I accepted it" is a
-- different fact from "the system would propose this today".

create table if not exists bank_match_suggestions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid        not null references organizations (id) on delete cascade,
  statement_line_id uuid        not null,
  voucher_id        uuid        not null,
  tier              text        not null,
  confidence        integer     not null,
  reasons           jsonb       not null default '[]'::jsonb,
  day_difference    integer     not null default 0,
  /** Set when a person accepted or rejected it, with who and when. */
  decided_at        timestamptz,
  decided_by        uuid references users (id) on delete set null,
  decision          text,
  created_at        timestamptz not null default now(),
  constraint bank_match_suggestions_tier_check check (tier in ('exact','strong','probable','weak')),
  constraint bank_match_suggestions_confidence_check check (confidence between 0 and 100),
  constraint bank_match_suggestions_decision_check check (decision is null
                                                          or decision in ('accepted','rejected'))
);
alter table bank_match_suggestions add constraint bank_match_suggestions_line_org_fkey
  foreign key (statement_line_id, org_id) references bank_statement_lines (id, org_id) on delete cascade;
alter table bank_match_suggestions add constraint bank_match_suggestions_voucher_org_fkey
  foreign key (voucher_id, org_id) references vouchers (id, org_id) on delete cascade;
create unique index if not exists bank_match_suggestions_pair_key
  on bank_match_suggestions (statement_line_id, voucher_id);
create index if not exists bank_match_suggestions_org_idx on bank_match_suggestions (org_id);

-- ── purchase orders and goods receipts: the three-way match ────────────────
-- Neither is an accounting voucher: ordering goods and receiving them change no
-- ledger balance. They live in their own tables so that a bill can be checked
-- against what was ordered and what arrived, which is the control that stops a
-- supplier being paid for goods nobody ordered or nobody received.

create table if not exists purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid        not null references organizations (id) on delete cascade,
  po_no         text        not null,
  fy_label      text        not null,
  po_date       date        not null,
  party_id      uuid        not null,
  expected_date date,
  narration     text,
  total_paise   bigint      not null default 0,
  status        text        not null default 'open',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint purchase_orders_status_check check (status in ('open','part_received','received','closed','cancelled'))
);
alter table purchase_orders add constraint purchase_orders_id_org_key unique (id, org_id);
alter table purchase_orders add constraint purchase_orders_party_org_fkey
  foreign key (party_id, org_id) references parties (id, org_id) on delete restrict;
create unique index if not exists purchase_orders_org_no_key on purchase_orders (org_id, fy_label, po_no);

create table if not exists purchase_order_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid        not null references organizations (id) on delete cascade,
  po_id       uuid        not null,
  line_no     integer     not null,
  item_id     uuid,
  description text        not null,
  -- Scaled by 10000, four decimal places, as everywhere else.
  quantity    bigint      not null,
  unit        text,
  unit_price_paise bigint not null default 0,
  gst_rate_bps integer    not null default 0,
  created_at  timestamptz not null default now(),
  constraint purchase_order_lines_quantity_check check (quantity > 0)
);
alter table purchase_order_lines add constraint purchase_order_lines_po_org_fkey
  foreign key (po_id, org_id) references purchase_orders (id, org_id) on delete cascade;
alter table purchase_order_lines add constraint purchase_order_lines_item_org_fkey
  foreign key (item_id, org_id) references items (id, org_id) on delete restrict;
create unique index if not exists purchase_order_lines_po_line_key on purchase_order_lines (po_id, line_no);

create table if not exists goods_receipts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid        not null references organizations (id) on delete cascade,
  grn_no        text        not null,
  fy_label      text        not null,
  receipt_date  date        not null,
  party_id      uuid        not null,
  po_id         uuid,
  /** The supplier's delivery challan number, from their document. */
  challan_no    text,
  challan_date  date,
  narration     text,
  created_at    timestamptz not null default now()
);
alter table goods_receipts add constraint goods_receipts_id_org_key unique (id, org_id);
alter table goods_receipts add constraint goods_receipts_party_org_fkey
  foreign key (party_id, org_id) references parties (id, org_id) on delete restrict;
alter table goods_receipts add constraint goods_receipts_po_org_fkey
  foreign key (po_id, org_id) references purchase_orders (id, org_id) on delete restrict;
create unique index if not exists goods_receipts_org_no_key on goods_receipts (org_id, fy_label, grn_no);

create table if not exists goods_receipt_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid        not null references organizations (id) on delete cascade,
  grn_id      uuid        not null,
  po_line_id  uuid,
  line_no     integer     not null,
  item_id     uuid,
  description text        not null,
  quantity    bigint      not null,
  unit        text,
  created_at  timestamptz not null default now(),
  constraint goods_receipt_lines_quantity_check check (quantity > 0)
);
alter table goods_receipt_lines add constraint goods_receipt_lines_grn_org_fkey
  foreign key (grn_id, org_id) references goods_receipts (id, org_id) on delete cascade;
alter table goods_receipt_lines add constraint goods_receipt_lines_item_org_fkey
  foreign key (item_id, org_id) references items (id, org_id) on delete restrict;
create unique index if not exists goods_receipt_lines_grn_line_key on goods_receipt_lines (grn_id, line_no);

-- A bill records which order and which receipt it relates to, so the three can
-- be compared.
alter table vouchers add column if not exists po_id  uuid;
alter table vouchers add column if not exists grn_id uuid;
alter table vouchers add constraint vouchers_po_org_fkey
  foreign key (po_id, org_id) references purchase_orders (id, org_id) on delete set null;
alter table vouchers add constraint vouchers_grn_org_fkey
  foreign key (grn_id, org_id) references goods_receipts (id, org_id) on delete set null;

-- ── row level security ─────────────────────────────────────────────────────

do $$
declare
  t text;
  v_owner text := current_user;
  v_tables text[] := array[
    'bank_accounts','bank_statements','bank_statement_lines','bank_match_suggestions',
    'purchase_orders','purchase_order_lines','goods_receipts','goods_receipt_lines'
  ];
begin
  foreach t in array v_tables loop
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
