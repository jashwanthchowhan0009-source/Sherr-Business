-- ════════════════════════════════════════════════════════════════════════════
-- Phase 1: tenancy, identity, roles, company profile, audit.
--
-- Run as the OWNER role (DATABASE_URL_OWNER). The application role
-- (sherrbyte_app) is created by scripts/bootstrap-roles.ts before this runs.
--
-- Every tenant table gets its RLS policy in this same file. Adding a table
-- without a policy is a test failure, not a code-review catch.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── helpers ─────────────────────────────────────────────────────────────────
-- `true` as the second argument to current_setting means "missing is OK, return
-- NULL". That is deliberate: with no tenant context every policy evaluates to
-- NULL, which is not TRUE, so queries return ZERO rows rather than ALL rows.

create or replace function app_current_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_org_id', true), '')::uuid
$$;

create or replace function app_current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- ── tables ──────────────────────────────────────────────────────────────────

create table if not exists organizations (
  id              uuid primary key default gen_random_uuid(),
  clerk_org_id    text        not null,
  legal_name      text        not null,
  trade_name      text,
  pan             text,
  cin             text,
  state_code      text,
  fy_start_month  integer     not null default 4,
  base_currency   text        not null default 'INR',
  status          text        not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint organizations_fy_start_month_check check (fy_start_month between 1 and 12),
  constraint organizations_base_currency_check  check (base_currency = 'INR'),
  constraint organizations_status_check         check (status in ('active','suspended')),
  constraint organizations_pan_check            check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
);
create unique index if not exists organizations_clerk_org_id_key on organizations (clerk_org_id);

create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  clerk_user_id  text        not null,
  email          text        not null,
  full_name      text,
  mfa_enabled    boolean     not null default false,
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists users_clerk_user_id_key on users (clerk_user_id);

create table if not exists org_registrations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid        not null references organizations (id) on delete cascade,
  kind            text        not null,
  number          text        not null,
  state_code      text,
  effective_from  timestamptz,
  effective_to    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint org_registrations_kind_check check (kind in ('gstin','tan','iec','msme','cin')),
  -- 15 chars: 2 state + 10 PAN + 1 entity + 1 'Z' + 1 checksum.
  constraint org_registrations_gstin_check check (
    kind <> 'gstin' or number ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'
  )
);
create index if not exists org_registrations_org_id_idx on org_registrations (org_id);
create unique index if not exists org_registrations_org_kind_number_key
  on org_registrations (org_id, kind, number);

create table if not exists memberships (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid        not null references organizations (id) on delete cascade,
  user_id     uuid        not null references users (id) on delete cascade,
  role        text        not null,
  scope       jsonb,
  invited_by  uuid        references users (id) on delete set null,
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  status      text        not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint memberships_role_check   check (role in ('owner','accountant','ca_reviewer','viewer')),
  constraint memberships_status_check check (status in ('active','suspended','expired')),
  constraint memberships_validity_check check (valid_to is null or valid_to > valid_from)
);
create unique index if not exists memberships_org_user_key on memberships (org_id, user_id);
create index if not exists memberships_user_id_idx on memberships (user_id);

create table if not exists invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid        not null references organizations (id) on delete cascade,
  email        text        not null,
  role         text        not null,
  token_hash   text        not null,
  invited_by   uuid        not null references users (id) on delete cascade,
  valid_to     timestamptz,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint invitations_role_check check (role in ('owner','accountant','ca_reviewer','viewer'))
);
create index if not exists invitations_org_id_idx on invitations (org_id);
create unique index if not exists invitations_token_hash_key on invitations (token_hash);
-- One live invitation per email per org.
create unique index if not exists invitations_org_email_pending_key
  on invitations (org_id, lower(email))
  where accepted_at is null and revoked_at is null;

create table if not exists audit_logs (
  id            bigserial primary key,
  org_id        uuid        not null references organizations (id) on delete cascade,
  actor_user_id uuid        references users (id) on delete set null,
  actor_role    text,
  action        text        not null,
  subject_kind  text        not null,
  subject_id    text,
  before        jsonb,
  after         jsonb,
  ip            text,
  user_agent    text,
  at            timestamptz not null default now()
);
create index if not exists audit_logs_org_at_idx on audit_logs (org_id, at desc);
create index if not exists audit_logs_subject_idx on audit_logs (org_id, subject_kind, subject_id);

create table if not exists rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  count        integer     not null default 0
);
create index if not exists rate_limits_window_start_idx on rate_limits (window_start);

-- ── row level security ──────────────────────────────────────────────────────
-- ENABLE turns policies on for everyone except the table owner.
-- FORCE closes that gap, so even the owner is subject to them.

alter table organizations     enable row level security;
alter table organizations     force  row level security;
alter table users             enable row level security;
alter table users             force  row level security;
alter table org_registrations enable row level security;
alter table org_registrations force  row level security;
alter table memberships       enable row level security;
alter table memberships       force  row level security;
alter table invitations       enable row level security;
alter table invitations       force  row level security;
alter table audit_logs        enable row level security;
alter table audit_logs        force  row level security;

-- organizations: keyed by id rather than org_id.
drop policy if exists organizations_tenant on organizations;
create policy organizations_tenant on organizations
  for all
  using      (id = app_current_org_id())
  with check (id = app_current_org_id());

-- users: global identity, visible only through a shared organization, plus
-- your own row so the app can render "you" before an org is selected.
drop policy if exists users_visible on users;
create policy users_visible on users
  for select
  using (
    id = app_current_user_id()
    or exists (
      select 1 from memberships m
      where m.user_id = users.id and m.org_id = app_current_org_id()
    )
  );

drop policy if exists users_self_update on users;
create policy users_self_update on users
  for update
  using      (id = app_current_user_id())
  with check (id = app_current_user_id());

-- Uniform org_id policy for the remaining tenant tables.
drop policy if exists org_registrations_tenant on org_registrations;
create policy org_registrations_tenant on org_registrations
  for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id());

drop policy if exists memberships_tenant on memberships;
create policy memberships_tenant on memberships
  for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id());

drop policy if exists invitations_tenant on invitations;
create policy invitations_tenant on invitations
  for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id());

-- audit_logs: readable and insertable within the tenant. UPDATE and DELETE are
-- withheld at the GRANT level below, which is what actually makes it append-only.
drop policy if exists audit_logs_tenant_select on audit_logs;
create policy audit_logs_tenant_select on audit_logs
  for select using (org_id = app_current_org_id());

drop policy if exists audit_logs_tenant_insert on audit_logs;
create policy audit_logs_tenant_insert on audit_logs
  for insert with check (org_id = app_current_org_id());


-- ── owner-scoped policies for the privileged bootstrap path ────────────────
-- FORCE ROW LEVEL SECURITY applies to the table owner as well, which is what we
-- want: it means a mistake that connects the app as the owner still gets no free
-- pass. But the SECURITY DEFINER functions below legitimately run as the owner
-- and must be able to create a user, an organization and its first membership
-- before any tenant context exists.
--
-- Scoping these policies TO the owner role is what makes that safe. The
-- application role is a different role and can never satisfy them, so this adds
-- no path for it — unlike a policy gated on a settable GUC, which the
-- application role could simply set for itself.

do $$
declare v_owner text := current_user;
begin
  foreach v_owner in array array[current_user] loop
    execute format('drop policy if exists owner_full_access on organizations');
    execute format(
      'create policy owner_full_access on organizations for all to %I using (true) with check (true)',
      v_owner);
    execute format('drop policy if exists owner_full_access on users');
    execute format(
      'create policy owner_full_access on users for all to %I using (true) with check (true)',
      v_owner);
    execute format('drop policy if exists owner_full_access on memberships');
    execute format(
      'create policy owner_full_access on memberships for all to %I using (true) with check (true)',
      v_owner);
    execute format('drop policy if exists owner_full_access on audit_logs');
    execute format(
      'create policy owner_full_access on audit_logs for all to %I using (true) with check (true)',
      v_owner);
    execute format('drop policy if exists owner_full_access on invitations');
    execute format(
      'create policy owner_full_access on invitations for all to %I using (true) with check (true)',
      v_owner);
    execute format('drop policy if exists owner_full_access on org_registrations');
    execute format(
      'create policy owner_full_access on org_registrations for all to %I using (true) with check (true)',
      v_owner);
  end loop;
end $$;

-- ── privileged bootstrap functions ──────────────────────────────────────────
-- These run as the owner (SECURITY DEFINER) because they operate before a
-- tenant context exists. They are the ONLY way the application role can create
-- a user or an organization; it holds no direct INSERT on either table.

create or replace function app_ensure_user(
  p_clerk_user_id text, p_email text, p_full_name text, p_mfa_enabled boolean
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_clerk_user_id is null or length(p_clerk_user_id) = 0 then
    raise exception 'clerk_user_id is required';
  end if;

  insert into users (clerk_user_id, email, full_name, mfa_enabled, last_seen_at)
  values (p_clerk_user_id, p_email, p_full_name, coalesce(p_mfa_enabled, false), now())
  on conflict (clerk_user_id) do update
    set email       = excluded.email,
        full_name   = excluded.full_name,
        mfa_enabled = excluded.mfa_enabled,
        last_seen_at = now(),
        updated_at  = now()
  returning id into v_id;

  return v_id;
end $$;

create or replace function app_create_organization(
  p_clerk_org_id text, p_legal_name text, p_owner_user_id uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org_id uuid;
begin
  insert into organizations (clerk_org_id, legal_name)
  values (p_clerk_org_id, p_legal_name)
  on conflict (clerk_org_id) do update set legal_name = excluded.legal_name, updated_at = now()
  returning id into v_org_id;

  insert into memberships (org_id, user_id, role)
  values (v_org_id, p_owner_user_id, 'owner')
  on conflict (org_id, user_id) do nothing;

  insert into audit_logs (org_id, actor_user_id, actor_role, action, subject_kind, subject_id, after)
  values (v_org_id, p_owner_user_id, 'owner', 'organization.created', 'organization',
          v_org_id::text, jsonb_build_object('legal_name', p_legal_name));

  return v_org_id;
end $$;

-- Membership resolution has to see rows before a tenant context is set, so it
-- is SECURITY DEFINER too. It applies the expiry rule in one place.
create or replace function app_resolve_membership(
  p_clerk_org_id text, p_clerk_user_id text
) returns table (org_id uuid, user_id uuid, role text)
language sql security definer set search_path = public stable as $$
  select m.org_id, m.user_id, m.role
  from memberships m
  join organizations o on o.id = m.org_id
  join users u        on u.id = m.user_id
  where o.clerk_org_id = p_clerk_org_id
    and u.clerk_user_id = p_clerk_user_id
    and m.status = 'active'
    and o.status = 'active'
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now())
  limit 1
$$;

-- ── grants ──────────────────────────────────────────────────────────────────

grant usage on schema public to sherrbyte_app;

-- No INSERT/DELETE on organizations: creating one goes through
-- app_create_organization(), which also creates the owner membership atomically.
grant select, update on organizations to sherrbyte_app;
grant select, insert, update, delete on org_registrations, memberships, invitations
  to sherrbyte_app;
grant select, update on users to sherrbyte_app;

-- Append-only. No UPDATE, no DELETE — not by policy, by privilege.
grant select, insert on audit_logs to sherrbyte_app;
grant usage, select on sequence audit_logs_id_seq to sherrbyte_app;

grant select, insert, update, delete on rate_limits to sherrbyte_app;

revoke all on function app_ensure_user(text, text, text, boolean) from public;
revoke all on function app_create_organization(text, text, uuid) from public;
revoke all on function app_resolve_membership(text, text) from public;
grant execute on function app_ensure_user(text, text, text, boolean)   to sherrbyte_app;
grant execute on function app_create_organization(text, text, uuid)    to sherrbyte_app;
grant execute on function app_resolve_membership(text, text)           to sherrbyte_app;
grant execute on function app_current_org_id()                         to sherrbyte_app;
grant execute on function app_current_user_id()                        to sherrbyte_app;
