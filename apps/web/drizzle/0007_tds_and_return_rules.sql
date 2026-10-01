-- ════════════════════════════════════════════════════════════════════════════
-- Step G: TDS sections and the return thresholds, as versioned rules.
--
-- Every row below is seeded with needs_ca_verification = true and a source_note
-- saying what to check. These are the figures I believe apply; they are not
-- professional advice, they change with each Finance Act, and the engine reads
-- them from here precisely so that a correction is a row rather than a release.
--
-- Rates and thresholds are stored, never hardcoded in code. A rule that changes
-- gets a new row with its own effective_from and the old row's effective_to
-- closed, so a payment in a past period is still computed under the rule that
-- applied then.
-- ════════════════════════════════════════════════════════════════════════════

-- ── TDS sections ────────────────────────────────────────────────────────────

insert into tax_rules (
  org_id, kind, code, label, rate_bps,
  threshold_single_paise, threshold_annual_paise,
  section, effective_from, needs_ca_verification, source_note
)
select null, 'tds_section', v.code, v.label, v.rate_bps,
       v.single_paise, v.annual_paise, v.section, v.effective_from, true,
       'Seeded figure. Confirm the rate, both thresholds and the effective date '
       || 'against the current Finance Act before relying on any suggestion.'
from (values
  -- Section, label, rate in basis points, single-payment threshold, annual
  -- threshold, all in paise.
  ('194C_INDIVIDUAL', 'Payments to contractors — individual or HUF',
   100, 30000::bigint * 100, 100000::bigint * 100, '194C', date '2020-04-01'),
  ('194C_OTHER', 'Payments to contractors — other than individual or HUF',
   200, 30000::bigint * 100, 100000::bigint * 100, '194C', date '2020-04-01'),
  ('194J_PROFESSIONAL', 'Professional or technical fees',
   1000, 30000::bigint * 100, null::bigint, '194J', date '2020-04-01'),
  ('194J_TECHNICAL', 'Fees for technical services',
   200, 30000::bigint * 100, null::bigint, '194J', date '2020-04-01'),
  ('194H_COMMISSION', 'Commission or brokerage',
   200, null::bigint, 20000::bigint * 100, '194H', date '2024-10-01'),
  ('194I_LAND', 'Rent of land, building or furniture',
   1000, null::bigint, 240000::bigint * 100, '194I', date '2020-04-01'),
  ('194I_PLANT', 'Rent of plant and machinery',
   200, null::bigint, 240000::bigint * 100, '194I', date '2020-04-01'),
  ('194A_INTEREST', 'Interest other than on securities',
   1000, null::bigint, 40000::bigint * 100, '194A', date '2020-04-01'),
  ('194Q_GOODS', 'Purchase of goods',
   10, null::bigint, 5000000::bigint * 100, '194Q', date '2021-07-01')
) as v(code, label, rate_bps, single_paise, annual_paise, section, effective_from)
where not exists (
  select 1 from tax_rules t
   where t.org_id is null and t.kind = 'tds_section' and t.code = v.code
);

-- The earlier commission rate, closed off rather than deleted: a payment made
-- before October 2024 must still compute under the rate that applied then.
insert into tax_rules (
  org_id, kind, code, label, rate_bps, threshold_annual_paise,
  section, effective_from, effective_to, needs_ca_verification, source_note
)
select null, 'tds_section', '194H_COMMISSION_PRE_OCT_2024',
       'Commission or brokerage (to 30 September 2024)',
       500, 15000::bigint * 100, '194H', date '2020-04-01', date '2024-09-30', true,
       'The rate before the change I believe took effect on 1 October 2024. Kept so that a '
       || 'payment in an earlier period computes under the rate that then applied. Confirm both '
       || 'the old rate and the changeover date.'
where not exists (
  select 1 from tax_rules t
   where t.org_id is null and t.kind = 'tds_section'
     and t.code = '194H_COMMISSION_PRE_OCT_2024'
);

-- ── thresholds and floors the returns depend on ─────────────────────────────

insert into tax_rules (
  org_id, kind, code, label, rate_bps, threshold_single_paise,
  effective_from, needs_ca_verification, source_note
)
select null, 'other', v.code, v.label, v.rate_bps, v.threshold_paise,
       v.effective_from, true, v.note
from (values
  ('GSTR1_B2CL_THRESHOLD',
   'GSTR-1 B2CL threshold — inter-state supply to an unregistered person reported individually',
   null::integer, 250000::bigint * 100, date '2020-04-01',
   'The invoice value above which an inter-state B2C supply is reported invoice-by-invoice '
   || 'rather than in aggregate. This figure has changed before. Confirm it before filing.'),
  ('TDS_NO_PAN_FLOOR',
   'Section 206AA floor rate where the deductee has no PAN',
   2000, null::bigint, date '2020-04-01',
   'The higher of twice the section rate and this floor applies where there is no PAN. '
   || 'Confirm the floor against the current provision.')
) as v(code, label, rate_bps, threshold_paise, effective_from, note)
where not exists (
  select 1 from tax_rules t where t.org_id is null and t.kind = 'other' and t.code = v.code
);

-- ── signing a rule off ──────────────────────────────────────────────────────
-- A CA clears the flag. Recorded with who and when, because "a professional
-- approved this rate" is a claim that needs an owner.
--
-- SECURITY DEFINER is deliberately NOT used: the app role can update tax_rules
-- for its own organization through RLS, and a product-wide rule (org_id null)
-- is not something a tenant may sign off at all — that is a decision for whoever
-- maintains the product, made by migration.

create or replace function app_verify_tax_rule(
  p_rule_id uuid, p_verified_by text
) returns boolean
language plpgsql as $$
declare v_updated integer;
begin
  update tax_rules
     set needs_ca_verification = false,
         verified_by = p_verified_by,
         verified_at = now()
   where id = p_rule_id
     -- Only a rule belonging to this organization. A product-wide rule stays
     -- unverified for everyone until the product itself ships it verified.
     and org_id = app_current_org_id();
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end $$;

revoke all on function app_verify_tax_rule(uuid, text) from public;
grant execute on function app_verify_tax_rule(uuid, text) to sherrbyte_app;

-- ── stored GSTR-2B uploads ──────────────────────────────────────────────────
-- The parsed invoices are kept rather than only the reconciliation, so the
-- comparison can be re-run against the books as they stand later. What the
-- portal said at the time is a fact about the portal; what the books said is a
-- fact about the books, and the difference between them moves as bills are
-- entered.

create table if not exists gstr2b_uploads (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid        not null references organizations (id) on delete cascade,
  document_id   uuid,
  /** The return period the portal states, as it states it: '062025'. */
  period        text,
  period_from   date        not null,
  period_to     date        not null,
  /** Our GSTIN as the file states it, so a file for another company is caught. */
  stated_gstin  text,
  invoice_count integer     not null default 0,
  problem_count integer     not null default 0,
  /** The parsed invoices, as strings so no figure passes through a float. */
  invoices      jsonb       not null default '[]'::jsonb,
  uploaded_by   uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint gstr2b_uploads_period_check check (period_to >= period_from)
);
alter table gstr2b_uploads add constraint gstr2b_uploads_id_org_key unique (id, org_id);
alter table gstr2b_uploads add constraint gstr2b_uploads_document_org_fkey
  foreign key (document_id, org_id) references documents (id, org_id) on delete set null;
create index if not exists gstr2b_uploads_org_period_idx
  on gstr2b_uploads (org_id, period_from desc);

alter table gstr2b_uploads enable row level security;
alter table gstr2b_uploads force  row level security;

drop policy if exists gstr2b_uploads_tenant on gstr2b_uploads;
create policy gstr2b_uploads_tenant on gstr2b_uploads
  for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id());

do $$
declare v_owner text := current_user;
begin
  execute format(
    'create policy owner_full_access on gstr2b_uploads for all to %I using (true) with check (true)',
    v_owner);
end $$;

grant select, insert, update, delete on gstr2b_uploads to sherrbyte_app;
