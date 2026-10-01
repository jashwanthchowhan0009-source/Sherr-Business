-- Step: the screen lock. A six-digit PIN in front of an already-authenticated
-- session, like a banking app's MPIN. Per user, not per company.
create table if not exists user_pins (
  user_id         uuid primary key references users (id) on delete cascade,
  pin_hash        text        not null,
  salt            text        not null,
  failed_attempts integer     not null default 0,
  -- A hard lock, not a timed one. Five wrong guesses and the only way back is
  -- re-verifying the second factor with Clerk; waiting does not help.
  locked_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint user_pins_attempts_check check (failed_attempts >= 0)
);

-- An unlock is a server-side row, not a signed cookie: revoking one is a delete
-- rather than a key rotation, and the browser holds a random token that means
-- nothing on its own.
create table if not exists pin_unlocks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references users (id) on delete cascade,
  -- SHA-256 of the token. A stolen database row cannot be replayed as a cookie.
  token_hash text        not null unique,
  created_at timestamptz not null default now(),
  -- Idle expiry: refreshed on every authenticated request, so an unlock dies
  -- five minutes after the last one rather than at a fixed time.
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists pin_unlocks_user_idx on pin_unlocks (user_id)
  where revoked_at is null;
create index if not exists pin_unlocks_expiry_idx on pin_unlocks (expires_at);

alter table user_pins   enable row level security;
alter table user_pins   force  row level security;
alter table pin_unlocks enable row level security;
alter table pin_unlocks force  row level security;

-- Keyed to the user, not the organization: the lock applies before a company
-- exists, and a PIN is nobody else's business even inside the same company.
drop policy if exists user_pins_self on user_pins;
create policy user_pins_self on user_pins
  for all using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

drop policy if exists pin_unlocks_self on pin_unlocks;
create policy pin_unlocks_self on pin_unlocks
  for all using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

do $$
declare v_owner text := current_user;
begin
  execute format('create policy owner_full_access on user_pins for all to %I using (true) with check (true)', v_owner);
  execute format('create policy owner_full_access on pin_unlocks for all to %I using (true) with check (true)', v_owner);
end $$;

grant select, insert, update, delete on user_pins   to sherrbyte_app;
grant select, insert, update, delete on pin_unlocks to sherrbyte_app;
