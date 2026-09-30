-- ════════════════════════════════════════════════════════════════════════════
-- Step A: company onboarding and the chart of accounts.
--
-- Run as the OWNER role. Adds the accounting skeleton a company needs before
-- any voucher can exist, and makes company creation a single transaction:
-- organization, owner membership, registrations, chart of accounts and the
-- audit row either all happen or none do.
--
-- The chart itself is passed in as JSON from src/lib/accounting/chart-of-accounts.ts
-- rather than being written out here. One source of truth, and the tests that
-- assert its structure run against the same data the database receives.
-- ════════════════════════════════════════════════════════════════════════════

-- ── organizations: the fields onboarding collects ───────────────────────────

alter table organizations
  add column if not exists registration_type text not null default 'regular',
  add column if not exists books_start_date  date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_registration_type_check') then
    alter table organizations add constraint organizations_registration_type_check
      check (registration_type in ('regular', 'composition', 'unregistered'));
  end if;
end $$;

-- ── account_groups ──────────────────────────────────────────────────────────

create table if not exists account_groups (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid        not null references organizations (id) on delete cascade,
  code       text        not null,
  name       text        not null,
  parent_id  uuid        references account_groups (id) on delete restrict,
  nature     text        not null,
  bucket     text        not null,
  is_system  boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_groups_nature_check
    check (nature in ('asset','liability','equity','income','expense')),
  constraint account_groups_bucket_check
    check (bucket in ('equity_and_liabilities','non_current_liabilities','current_liabilities',
                      'non_current_assets','current_assets','revenue','expenses'))
);
create unique index if not exists account_groups_org_code_key on account_groups (org_id, code);
create index if not exists account_groups_org_parent_idx on account_groups (org_id, parent_id);

-- ── accounts (ledgers) ──────────────────────────────────────────────────────

create table if not exists accounts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid        not null references organizations (id) on delete cascade,
  group_id   uuid        not null references account_groups (id) on delete restrict,
  code       text        not null,
  name       text        not null,
  nature     text        not null,
  -- System accounts are referenced by code by the calculation engines (the
  -- rounding rule, the GST engine, the control accounts), so they may not be
  -- deleted. Enforced in the application; recorded here so it is visible.
  is_system  boolean     not null default false,
  is_active  boolean     not null default true,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_nature_check
    check (nature in ('asset','liability','equity','income','expense'))
);
create unique index if not exists accounts_org_code_key on accounts (org_id, code);
create index if not exists accounts_org_group_idx on accounts (org_id, group_id);

-- ── row level security ──────────────────────────────────────────────────────

alter table account_groups enable row level security;
alter table account_groups force  row level security;
alter table accounts       enable row level security;
alter table accounts       force  row level security;

drop policy if exists account_groups_tenant on account_groups;
create policy account_groups_tenant on account_groups
  for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id());

drop policy if exists accounts_tenant on accounts;
create policy accounts_tenant on accounts
  for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id());

-- The owner runs migrations and the SECURITY DEFINER seeding below; FORCE
-- applies to it too, so it needs its own policy. Scoped TO the owner role, which
-- the application role can never satisfy.
do $$
declare v_owner text := current_user;
begin
  execute format('drop policy if exists owner_full_access on account_groups');
  execute format('create policy owner_full_access on account_groups for all to %I using (true) with check (true)', v_owner);
  execute format('drop policy if exists owner_full_access on accounts');
  execute format('create policy owner_full_access on accounts for all to %I using (true) with check (true)', v_owner);
end $$;

grant select, insert, update, delete on account_groups, accounts to sherrbyte_app;

-- ── company creation, in one transaction ────────────────────────────────────

create or replace function app_create_company(
  p_clerk_org_id      text,
  p_legal_name        text,
  p_owner_user_id     uuid,
  p_trade_name        text    default null,
  p_gstin             text    default null,
  p_pan               text    default null,
  p_state_code        text    default null,
  p_registration_type text    default 'regular',
  p_fy_start_month    integer default 4,
  p_books_start_date  date    default null,
  p_account_groups    jsonb   default '[]'::jsonb,
  p_accounts          jsonb   default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org_id uuid;
  v_group  jsonb;
  v_acct   jsonb;
begin
  insert into organizations (
    clerk_org_id, legal_name, trade_name, pan, state_code,
    registration_type, fy_start_month, books_start_date
  )
  values (
    p_clerk_org_id, p_legal_name, nullif(p_trade_name, ''), nullif(p_pan, ''),
    nullif(p_state_code, ''), coalesce(p_registration_type, 'regular'),
    coalesce(p_fy_start_month, 4), p_books_start_date
  )
  on conflict (clerk_org_id) do update set legal_name = excluded.legal_name, updated_at = now()
  returning id into v_org_id;

  insert into memberships (org_id, user_id, role)
  values (v_org_id, p_owner_user_id, 'owner')
  on conflict (org_id, user_id) do nothing;

  if nullif(p_gstin, '') is not null then
    insert into org_registrations (org_id, kind, number, state_code)
    values (v_org_id, 'gstin', p_gstin, left(p_gstin, 2))
    on conflict (org_id, kind, number) do nothing;
  end if;

  -- Groups first: accounts reference them, and a child group references its
  -- parent, so parents must be inserted before children. The caller supplies
  -- them already ordered.
  for v_group in select * from jsonb_array_elements(p_account_groups) loop
    insert into account_groups (org_id, code, name, parent_id, nature, bucket, is_system)
    values (
      v_org_id,
      v_group ->> 'code',
      v_group ->> 'name',
      case when v_group ->> 'parent' is null then null
           else (select id from account_groups
                  where org_id = v_org_id and code = v_group ->> 'parent') end,
      v_group ->> 'nature',
      v_group ->> 'bucket',
      true
    )
    on conflict (org_id, code) do nothing;
  end loop;

  for v_acct in select * from jsonb_array_elements(p_accounts) loop
    insert into accounts (org_id, group_id, code, name, nature, is_system, note)
    select
      v_org_id,
      g.id,
      v_acct ->> 'code',
      v_acct ->> 'name',
      g.nature,                                   -- inherited, never supplied
      coalesce((v_acct ->> 'isSystem')::boolean, false),
      v_acct ->> 'note'
    from account_groups g
    where g.org_id = v_org_id and g.code = v_acct ->> 'group'
    on conflict (org_id, code) do nothing;
  end loop;

  insert into audit_logs (org_id, actor_user_id, actor_role, action, subject_kind, subject_id, after)
  values (
    v_org_id, p_owner_user_id, 'owner', 'company.created', 'organization', v_org_id::text,
    jsonb_build_object(
      'legal_name', p_legal_name,
      'gstin', nullif(p_gstin, ''),
      'registration_type', coalesce(p_registration_type, 'regular'),
      'accounts_seeded', (select count(*) from accounts where org_id = v_org_id)
    )
  );

  return v_org_id;
end $$;

-- The original two-argument function stays as a thin wrapper so the seed script
-- and the existing tests keep working unchanged.
create or replace function app_create_organization(
  p_clerk_org_id text, p_legal_name text, p_owner_user_id uuid
) returns uuid
language sql security definer set search_path = public as $$
  select app_create_company(p_clerk_org_id, p_legal_name, p_owner_user_id);
$$;

revoke all on function app_create_company(text, text, uuid, text, text, text, text, text, integer, date, jsonb, jsonb) from public;
grant execute on function app_create_company(text, text, uuid, text, text, text, text, text, integer, date, jsonb, jsonb) to sherrbyte_app;
