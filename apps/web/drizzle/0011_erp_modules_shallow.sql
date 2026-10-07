-- ════════════════════════════════════════════════════════════════════════════
-- Step J: shallow scaffold for four ERP modules — CRM/Sales pipeline,
-- Inventory/Warehouse ops, HR & Payroll, Projects — on top of the existing
-- accounting core.
--
-- SCOPE. This is deliberately shallow: one or two tables per module, enough to
-- hold real data and enforce tenant isolation, not a finished module. No
-- module here posts to the ledger, touches a voucher, or runs a calculation
-- engine. That is the same boundary Phase 1 draws around document extraction:
-- these tables record facts about leads, stock, people and projects; turning
-- any of them into an accounting entry is a deliberate, later integration,
-- not something this migration does implicitly.
--
-- Every new table follows the same two rules as everything else in this repo:
--   1. org_id + RLS on every table, enforced by the database, not the app.
--   2. A reference between two tenant tables carries org_id on both sides, so
--      the composite foreign key makes a cross-tenant reference impossible to
--      insert, not merely unlikely.
-- ════════════════════════════════════════════════════════════════════════════

-- ── CRM / Sales pipeline ─────────────────────────────────────────────────────
-- A deal is not an accounting voucher: nothing here changes a ledger balance.
-- The existing `parties` table is reused for the customer side rather than a
-- new "leads" table, so a party created from a deal is the same party an
-- invoice is later raised against — one record, not two to keep in sync.

create table if not exists pipeline_stages (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid        not null references organizations (id) on delete cascade,
  name       text        not null,
  sort_order integer     not null default 0,
  is_won     boolean     not null default false,
  is_lost    boolean     not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pipeline_stages_org_name_key on pipeline_stages (org_id, name);
create index if not exists pipeline_stages_org_sort_idx on pipeline_stages (org_id, sort_order);

create table if not exists deals (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid        not null references organizations (id) on delete cascade,
  party_id            uuid        references parties (id),
  stage_id            uuid        not null references pipeline_stages (id),
  title               text        not null,
  value_paise         bigint      not null default 0,
  expected_close_date date,
  status              text        not null default 'open',
  owner_user_id       uuid        references users (id) on delete set null,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint deals_status_check check (status in ('open', 'won', 'lost')),
  constraint deals_value_check  check (value_paise >= 0)
);
create index if not exists deals_org_stage_idx on deals (org_id, stage_id);
create index if not exists deals_org_status_idx on deals (org_id, status);

create table if not exists deal_activities (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid        not null references organizations (id) on delete cascade,
  deal_id    uuid        not null references deals (id) on delete cascade,
  kind       text        not null default 'note',
  body       text,
  created_by uuid        references users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint deal_activities_kind_check check (kind in ('note', 'call', 'email', 'meeting', 'stage_change'))
);
create index if not exists deal_activities_org_deal_idx on deal_activities (org_id, deal_id, created_at desc);

-- ── Inventory / Warehouse ops ────────────────────────────────────────────────
-- `items` already exists (Step B) as the catalogue the ledger prices against.
-- These tables add WHERE stock sits and WHAT moved it, without touching the
-- item record or the chart of accounts. Quantity uses the same scaled-bigint
-- convention as voucher_lines.quantity (×10,000 — see src/lib/accounting/units.ts)
-- so a quantity here and a quantity on a voucher line are directly comparable.

create table if not exists warehouses (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid        not null references organizations (id) on delete cascade,
  code       text        not null,
  name       text        not null,
  address    text,
  is_default boolean     not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists warehouses_org_code_key on warehouses (org_id, code);

create table if not exists stock_levels (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid        not null references organizations (id) on delete cascade,
  item_id           uuid        not null references items (id),
  warehouse_id      uuid        not null references warehouses (id) on delete cascade,
  quantity_on_hand  bigint      not null default 0,
  reorder_point     bigint,
  updated_at        timestamptz not null default now()
);
create unique index if not exists stock_levels_org_item_warehouse_key
  on stock_levels (org_id, item_id, warehouse_id);

create table if not exists stock_movements (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid        not null references organizations (id) on delete cascade,
  item_id         uuid        not null references items (id),
  warehouse_id    uuid        not null references warehouses (id) on delete cascade,
  movement_type   text        not null,
  quantity        bigint      not null,
  reference_kind  text,
  reference_id    text,
  note            text,
  created_by      uuid        references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint stock_movements_type_check check (
    movement_type in ('receipt', 'issue', 'transfer_in', 'transfer_out', 'adjustment')
  )
);
create index if not exists stock_movements_org_item_idx on stock_movements (org_id, item_id, created_at desc);
create index if not exists stock_movements_org_warehouse_idx on stock_movements (org_id, warehouse_id, created_at desc);

-- ── HR & Payroll ─────────────────────────────────────────────────────────────
-- A fully separate domain from Step B's chart of accounts. `monthly_ctc_paise`
-- and the payroll totals below are informational until a later integration
-- decides how (and whether) a payroll run becomes a voucher — this migration
-- does not create that link.

create table if not exists departments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid        not null references organizations (id) on delete cascade,
  name       text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists departments_org_name_key on departments (org_id, name);

create table if not exists employees (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid        not null references organizations (id) on delete cascade,
  user_id            uuid        references users (id) on delete set null,
  department_id      uuid        references departments (id) on delete set null,
  full_name          text        not null,
  email              text,
  phone              text,
  designation        text,
  employment_type    text        not null default 'full_time',
  date_of_joining    date,
  date_of_exit       date,
  status             text        not null default 'active',
  monthly_ctc_paise  bigint,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint employees_employment_type_check check (
    employment_type in ('full_time', 'part_time', 'contract', 'intern')
  ),
  constraint employees_status_check check (status in ('active', 'on_leave', 'exited'))
);
create index if not exists employees_org_department_idx on employees (org_id, department_id);
create index if not exists employees_org_status_idx on employees (org_id, status);

create table if not exists payroll_runs (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid        not null references organizations (id) on delete cascade,
  period_month            integer     not null,
  period_year             integer     not null,
  status                  text        not null default 'draft',
  total_gross_paise       bigint      not null default 0,
  total_deductions_paise  bigint      not null default 0,
  total_net_paise         bigint      not null default 0,
  approved_by             uuid        references users (id) on delete set null,
  approved_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint payroll_runs_month_check  check (period_month between 1 and 12),
  constraint payroll_runs_status_check check (status in ('draft', 'approved', 'paid'))
);
create unique index if not exists payroll_runs_org_period_key
  on payroll_runs (org_id, period_year, period_month);

create table if not exists payslips (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid        not null references organizations (id) on delete cascade,
  payroll_run_id   uuid        not null references payroll_runs (id) on delete cascade,
  employee_id      uuid        not null references employees (id),
  gross_paise      bigint      not null default 0,
  deductions_paise bigint      not null default 0,
  net_paise        bigint      not null default 0,
  created_at       timestamptz not null default now()
);
create unique index if not exists payslips_org_run_employee_key
  on payslips (org_id, payroll_run_id, employee_id);

-- ── Projects / Ops ───────────────────────────────────────────────────────────
-- A project optionally belongs to a party (a client engagement); an internal
-- project carries party_id null.

create table if not exists projects (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid        not null references organizations (id) on delete cascade,
  party_id       uuid        references parties (id),
  name           text        not null,
  status         text        not null default 'active',
  start_date     date,
  due_date       date,
  owner_user_id  uuid        references users (id) on delete set null,
  budget_paise   bigint,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint projects_status_check check (status in ('active', 'on_hold', 'completed', 'cancelled'))
);
create index if not exists projects_org_status_idx on projects (org_id, status);

create table if not exists project_tasks (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid        not null references organizations (id) on delete cascade,
  project_id        uuid        not null references projects (id) on delete cascade,
  title             text        not null,
  status            text        not null default 'todo',
  assignee_user_id  uuid        references users (id) on delete set null,
  due_date          date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint project_tasks_status_check check (status in ('todo', 'in_progress', 'done', 'blocked'))
);
create index if not exists project_tasks_org_project_idx on project_tasks (org_id, project_id);

-- ── cross-tenant referential integrity ──────────────────────────────────────
-- Same fix as Step B (see 0003's comment above its own version of this block):
-- a plain `references other_table (id)` lets company A's row point at company
-- B's row, because the FK check runs underneath RLS. Every reference between
-- two tenant tables in this migration is upgraded to a composite key.

alter table pipeline_stages add constraint pipeline_stages_id_org_key unique (id, org_id);
alter table deals           add constraint deals_id_org_key           unique (id, org_id);
alter table warehouses      add constraint warehouses_id_org_key      unique (id, org_id);
alter table departments     add constraint departments_id_org_key     unique (id, org_id);
alter table employees       add constraint employees_id_org_key       unique (id, org_id);
alter table payroll_runs    add constraint payroll_runs_id_org_key    unique (id, org_id);
alter table projects        add constraint projects_id_org_key        unique (id, org_id);

-- deals → parties, pipeline_stages
alter table deals drop constraint if exists deals_party_id_fkey;
alter table deals add constraint deals_party_org_fkey
  foreign key (party_id, org_id) references parties (id, org_id) on delete set null;
alter table deals drop constraint if exists deals_stage_id_fkey;
alter table deals add constraint deals_stage_org_fkey
  foreign key (stage_id, org_id) references pipeline_stages (id, org_id) on delete restrict;

-- deal_activities → deals
alter table deal_activities drop constraint if exists deal_activities_deal_id_fkey;
alter table deal_activities add constraint deal_activities_deal_org_fkey
  foreign key (deal_id, org_id) references deals (id, org_id) on delete cascade;

-- stock_levels, stock_movements → items, warehouses
alter table stock_levels drop constraint if exists stock_levels_item_id_fkey;
alter table stock_levels add constraint stock_levels_item_org_fkey
  foreign key (item_id, org_id) references items (id, org_id) on delete restrict;
alter table stock_levels drop constraint if exists stock_levels_warehouse_id_fkey;
alter table stock_levels add constraint stock_levels_warehouse_org_fkey
  foreign key (warehouse_id, org_id) references warehouses (id, org_id) on delete cascade;

alter table stock_movements drop constraint if exists stock_movements_item_id_fkey;
alter table stock_movements add constraint stock_movements_item_org_fkey
  foreign key (item_id, org_id) references items (id, org_id) on delete restrict;
alter table stock_movements drop constraint if exists stock_movements_warehouse_id_fkey;
alter table stock_movements add constraint stock_movements_warehouse_org_fkey
  foreign key (warehouse_id, org_id) references warehouses (id, org_id) on delete cascade;

-- employees → departments
alter table employees drop constraint if exists employees_department_id_fkey;
alter table employees add constraint employees_department_org_fkey
  foreign key (department_id, org_id) references departments (id, org_id) on delete set null;

-- payroll_runs/payslips → employees
alter table payslips drop constraint if exists payslips_payroll_run_id_fkey;
alter table payslips add constraint payslips_payroll_run_org_fkey
  foreign key (payroll_run_id, org_id) references payroll_runs (id, org_id) on delete cascade;
alter table payslips drop constraint if exists payslips_employee_id_fkey;
alter table payslips add constraint payslips_employee_org_fkey
  foreign key (employee_id, org_id) references employees (id, org_id) on delete restrict;

-- projects → parties
alter table projects drop constraint if exists projects_party_id_fkey;
alter table projects add constraint projects_party_org_fkey
  foreign key (party_id, org_id) references parties (id, org_id) on delete set null;

-- project_tasks → projects
alter table project_tasks drop constraint if exists project_tasks_project_id_fkey;
alter table project_tasks add constraint project_tasks_project_org_fkey
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade;

-- ── row level security ──────────────────────────────────────────────────────

do $$
declare
  t text;
  v_owner text := current_user;
  v_tenant_tables text[] := array[
    'pipeline_stages', 'deals', 'deal_activities',
    'warehouses', 'stock_levels', 'stock_movements',
    'departments', 'employees', 'payroll_runs', 'payslips',
    'projects', 'project_tasks'
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
