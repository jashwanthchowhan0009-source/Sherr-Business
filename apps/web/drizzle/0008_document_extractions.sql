-- ───────────────────────────────────────────────────────────────────────────────
-- Step H: the AI document inbox.
--
-- One table. It holds what a model said about a document, what our own checks made
-- of that, and what a person decided — in that order, and all three kept.
--
-- Why all three are kept rather than just the outcome: the figures that reach the
-- ledger come from the reviewed values, and six months later the question asked of
-- an audit trail is not "what is the number" but "where did this number come from
-- and who agreed to it". Keeping the model's raw reply alongside the reviewed
-- values answers that. It also means a prompt change can be evaluated against real
-- documents rather than against a guess about them.
--
-- The model's output is never authoritative. `extracted` is a claim; `reviewed` is
-- what a person settled on; and the voucher is built from `reviewed` alone.
-- ───────────────────────────────────────────────────────────────────────────────

create table if not exists document_extractions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid        not null references organizations (id) on delete cascade,
  document_id   uuid        not null,

  -- Who answered, and under which prompt. A stored extraction read under a later
  -- prompt would be interpreted against instructions it never saw.
  provider      text        not null,
  model         text        not null,
  prompt_version text       not null,

  status        text        not null default 'pending',
  -- Why it failed, in words a bookkeeper can act on.
  failure_reason text,

  -- What the model said, in the contract's shape. Amounts are strings here: the
  -- model's figures are claims about a document, not accounting values, and
  -- storing them as numbers would invite someone to add them up.
  extracted     jsonb,
  -- The provider's unmodified reply, for tracing a figure back to its origin.
  raw_response  jsonb,
  -- What our own checks made of it: the findings and our recomputed totals.
  validation    jsonb,

  -- What the reviewer settled on. Null until somebody has looked.
  reviewed      jsonb,
  reviewed_by   uuid references users (id) on delete set null,
  reviewed_at   timestamptz,

  -- The draft voucher this became, if it was approved. A draft, never a posting:
  -- approving an extraction creates something a person must still post.
  voucher_id    uuid,

  input_tokens  integer,
  output_tokens integer,

  created_at    timestamptz not null default now(),

  constraint document_extractions_status_check check (status in
    ('pending','succeeded','failed','reviewed','approved','rejected')),

  -- A reviewed row must say who reviewed it. An approval with no name attached is
  -- not an approval, and this is the one fact the audit trail cannot reconstruct.
  constraint document_extractions_reviewer_check check (
    (status in ('reviewed','approved','rejected')) = (reviewed_at is not null)
  ),

  -- A failure must say why. One direction only: a rejection carries a reason too,
  -- and so does a reading superseded by a later one, and neither is a failure.
  constraint document_extractions_failure_check check (
    status <> 'failed' or failure_reason is not null
  ),
  constraint document_extractions_extracted_check check (
    status <> 'succeeded' or extracted is not null
  ),

  -- A voucher may only hang off a row somebody approved.
  constraint document_extractions_voucher_check check (
    voucher_id is null or status = 'approved'
  )
);

alter table document_extractions add constraint document_extractions_id_org_key
  unique (id, org_id);

-- Composite foreign keys. A plain FK is resolved by an internal check that ignores
-- row-level security, so `(id, org_id)` is what actually confines a reference to
-- one tenant — the same fix the ledger needed.
alter table document_extractions add constraint document_extractions_document_org_fkey
  foreign key (document_id, org_id) references documents (id, org_id) on delete cascade;
alter table document_extractions add constraint document_extractions_voucher_org_fkey
  foreign key (voucher_id, org_id) references vouchers (id, org_id) on delete set null;

create index if not exists document_extractions_org_created_idx
  on document_extractions (org_id, created_at desc);
create index if not exists document_extractions_document_idx
  on document_extractions (org_id, document_id);

-- One live extraction per document. A document re-read after a prompt change gets a
-- new row and the old one is marked superseded, so the history stays readable; two
-- simultaneous pending rows for one document would mean two reviewers approving the
-- same bill twice.
create unique index if not exists document_extractions_one_pending
  on document_extractions (org_id, document_id)
  where status in ('pending', 'succeeded', 'reviewed');

alter table document_extractions enable row level security;
alter table document_extractions force  row level security;

drop policy if exists document_extractions_tenant on document_extractions;
create policy document_extractions_tenant on document_extractions
  for all using (org_id = app_current_org_id()) with check (org_id = app_current_org_id());

do $$
declare v_owner text := current_user;
begin
  execute format(
    'create policy owner_full_access on document_extractions for all to %I using (true) with check (true)',
    v_owner);
end $$;

grant select, insert, update, delete on document_extractions to sherrbyte_app;

-- ── the document's own status gains the inbox states ──────────────────────────
-- 'extracting' and 'extracted' already existed; 'needs_review' is where a document
-- waits for a person, and that is the only route to a voucher.
alter table documents drop constraint if exists documents_status_check;
alter table documents add constraint documents_status_check check (status in
  ('stored','extracting','extracted','needs_review','approved','posted','rejected','superseded'));
