-- =============================================================================
-- KITH — 0002 · Identity
--
-- profiles, user_settings, blocks, invite codes, security events.
--
-- Two decisions worth reading before the SQL:
--
-- 1. THERE IS NO `user_presence` TABLE, deliberately.
--    Live presence is ephemeral. Writing a row every time somebody's tab regains
--    focus turns a read-mostly database into a write-amplified one, and the data
--    is stale the moment it lands. Presence belongs on the wire: Supabase
--    Realtime Presence holds who is online right now, and `profiles.last_seen_at`
--    — written at most once a minute and on disconnect — covers "last seen 20m
--    ago" after they have gone. A user's *durable* choices (do not disturb, a
--    status message) are 1:1 with the user, so they are columns on `profiles`
--    rather than a second table joined on every read.
--
-- 2. `blocks` lives here rather than with the friend graph.
--    A block is not a social relationship, it is an access-control fact, and it
--    is referenced by the RLS policies of nearly every table that follows. It has
--    to exist before anything that filters on it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------

create table public.profiles (
  -- Shares the primary key with auth.users rather than carrying a foreign key to
  -- it: one row per account, enforced structurally, and `profiles.id` IS the
  -- user id everywhere else in the schema.
  id uuid primary key references auth.users (id) on delete cascade,

  username text not null,
  display_name text not null,
  avatar_url text,
  bio text,
  pronouns text,
  accent public.profile_accent not null default 'ember',

  -- Durable, user-chosen. Not live presence.
  status public.presence_status not null default 'auto',
  status_text text,
  status_expires_at timestamptz,

  -- Written at most once a minute and on disconnect. Powers "last seen", not
  -- "is online" — that question is answered by Realtime Presence.
  last_seen_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 40),
  constraint profiles_bio_length check (bio is null or char_length(bio) <= 280),
  constraint profiles_pronouns_length check (pronouns is null or char_length(pronouns) <= 24),
  constraint profiles_status_text_length check (status_text is null or char_length(status_text) <= 60)
);

-- Case-insensitive uniqueness without depending on the citext extension. Keeps
-- the displayed capitalisation the user chose while making "Ada" and "ada" the
-- same name. Lookups must use `lower(username) = lower($1)` to hit this index.
create unique index profiles_username_lower_key on public.profiles (lower(username));

-- Supports the friend-search prefix query.
create index profiles_display_name_idx on public.profiles (lower(display_name));

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

comment on column public.profiles.last_seen_at is
  'Throttled heartbeat for "last seen". Live online state comes from Realtime Presence, not this column.';

-- -----------------------------------------------------------------------------
-- user_settings
--
-- 1:1 with profiles. Split out rather than widening profiles because these are
-- read on a different cadence: a profile is read constantly (every avatar,
-- every message row), settings only by their owner and by policy checks.
-- -----------------------------------------------------------------------------

create table public.user_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,

  -- Privacy. These are read by RLS policies, which is why they live in the
  -- database and not in localStorage.
  discoverable boolean not null default true,
  who_can_call public.permission_scope not null default 'friends',
  who_can_message public.permission_scope not null default 'friends',
  read_receipts boolean not null default true,
  typing_indicators boolean not null default true,

  -- Appearance. Mirrors the design system's data-theme / data-motion attributes.
  theme public.theme_preference not null default 'dusk',
  motion public.motion_preference not null default 'full',

  notification_prefs jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- blocks
-- -----------------------------------------------------------------------------

create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),

  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id),
  constraint blocks_reason_length check (reason is null or char_length(reason) <= 500)
);

-- The reverse lookup: "who has blocked me". Needed because every block check is
-- symmetric — being blocked hides you just as thoroughly as blocking someone.
create index blocks_blocked_id_idx on public.blocks (blocked_id);

-- -----------------------------------------------------------------------------
-- Access helpers
--
-- These exist to break RLS policy recursion, and every one of them follows the
-- same three rules:
--
--   SECURITY DEFINER — runs as the owner, so it can read the table a policy is
--     currently being evaluated for without re-entering that policy. Without
--     this, `conversation_members` policies that reference `conversations` (whose
--     policies reference `conversation_members`) recurse infinitely. The usual
--     "fix" people reach for is disabling RLS on one of the tables, which quietly
--     opens everything.
--
--   SET search_path = '' — NOT a style preference. A SECURITY DEFINER function
--     with a mutable search_path can be hijacked by a caller who creates a
--     shadowing object in a schema earlier on the path. This is a documented
--     privilege-escalation vector. Everything is schema-qualified as a result.
--
--   STABLE — lets the planner call it once per statement instead of once per row.
--
-- Each returns only a boolean about the *calling* user's own relationships, so
-- running as the owner leaks nothing.
-- -----------------------------------------------------------------------------

create or replace function public.is_blocked_either(other_user uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = other_user)
       or (b.blocker_id = other_user and b.blocked_id = (select auth.uid()))
  );
$$;

comment on function public.is_blocked_either(uuid) is
  'True if a block exists in either direction between the caller and other_user. Blocking is symmetric in effect.';

-- -----------------------------------------------------------------------------
-- invite_codes
--
-- KITH has no public sign-up. An account cannot be created without a valid code
-- from somebody already inside.
--
-- The code itself is never stored — only its SHA-256 digest, exactly as a
-- password would be handled. A database leak therefore does not hand out working
-- invitations, and nobody with dashboard access can read a code out and use it.
-- -----------------------------------------------------------------------------

create table public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  created_by uuid not null references public.profiles (id) on delete cascade,
  note text,

  max_uses smallint not null default 1,
  uses smallint not null default 0,

  expires_at timestamptz not null default (now() + interval '14 days'),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),

  constraint invite_codes_max_uses_range check (max_uses between 1 and 20),
  constraint invite_codes_uses_range check (uses >= 0 and uses <= max_uses),
  constraint invite_codes_note_length check (note is null or char_length(note) <= 100)
);

create index invite_codes_created_by_idx on public.invite_codes (created_by);

-- Who let whom in. Small table, large value the first time somebody has to ask.
create table public.invite_redemptions (
  invite_id uuid not null references public.invite_codes (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (invite_id, user_id)
);

create index invite_redemptions_user_idx on public.invite_redemptions (user_id);

-- -----------------------------------------------------------------------------
-- security_events
--
-- Append-only audit trail. Sign-ins, MFA changes, password changes, blocks,
-- reports. Writable only by the service role; the append-only trigger means even
-- that cannot rewrite history.
-- -----------------------------------------------------------------------------

create table public.security_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  event text not null,
  ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index security_events_user_created_idx
  on public.security_events (user_id, created_at desc);

create trigger security_events_append_only
  before update or delete on public.security_events
  for each row execute function public.reject_mutation();

-- -----------------------------------------------------------------------------
-- New user bootstrap
--
-- Creating the profile in a trigger rather than in application code means an
-- account can never exist without one. A signup path that forgets the second
-- insert — or crashes between them — would otherwise leave a user who can
-- authenticate but has no identity, and every join in the schema would miss them.
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  final_username text;
  suffix integer := 0;
begin
  requested_username := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    'member' || substr(replace(new.id::text, '-', ''), 1, 8)
  );

  -- Usernames are claimed at signup and must be unique. Rather than failing the
  -- whole account creation on a race, fall back to a suffixed variant; the user
  -- can change it afterwards.
  final_username := requested_username;
  while exists (
    select 1 from public.profiles p where lower(p.username) = lower(final_username)
  ) loop
    suffix := suffix + 1;
    final_username := substr(requested_username, 1, 16) || suffix::text;
  end loop;

  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    final_username,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), final_username)
  );

  insert into public.user_settings (user_id) values (new.id);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.blocks enable row level security;
alter table public.invite_codes enable row level security;
alter table public.invite_redemptions enable row level security;
alter table public.security_events enable row level security;

-- FORCE applies policies to the table owner as well. Without it, anything
-- connecting as the owner silently skips every policy below.
alter table public.profiles force row level security;
alter table public.user_settings force row level security;
alter table public.blocks force row level security;
alter table public.invite_codes force row level security;
alter table public.invite_redemptions force row level security;
alter table public.security_events force row level security;

-- --- profiles ----------------------------------------------------------------

-- KITH is one small invited room, so any member may see any member — except
-- across a block, which hides both directions. Finer-grained visibility would be
-- theatre in a six-person app where everyone already knows everyone.
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or not public.is_blocked_either(id)
  );

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No INSERT policy and no DELETE policy, on purpose: rows are created by the
-- signup trigger and removed by the cascade from auth.users. A client can do
-- neither, which is exactly right — you cannot mint a profile, and you cannot
-- delete an identity out from under the foreign keys that depend on it.

-- --- user_settings -----------------------------------------------------------

create policy user_settings_select_own on public.user_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy user_settings_update_own on public.user_settings
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- --- blocks ------------------------------------------------------------------

-- You can see the blocks you created. You cannot see who has blocked you — that
-- would turn the feature into a notification.
create policy blocks_select_own on public.blocks
  for select to authenticated
  using (blocker_id = (select auth.uid()));

create policy blocks_insert_own on public.blocks
  for insert to authenticated
  with check (blocker_id = (select auth.uid()));

create policy blocks_delete_own on public.blocks
  for delete to authenticated
  using (blocker_id = (select auth.uid()));

-- --- invite_codes ------------------------------------------------------------

-- Only the issuer sees their own invitations, and only ever the hash.
create policy invite_codes_select_own on public.invite_codes
  for select to authenticated
  using (created_by = (select auth.uid()));

create policy invite_codes_insert_own on public.invite_codes
  for insert to authenticated
  with check (created_by = (select auth.uid()));

-- Revoking is the only permitted update, and only by the issuer.
create policy invite_codes_revoke_own on public.invite_codes
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

-- Redemption is deliberately absent from these policies. The person redeeming a
-- code has no account yet, so there is no `auth.uid()` to write a policy against.
-- It happens in a server route using the service-role client, which verifies the
-- hash, checks expiry and use count, and increments atomically.

create policy invite_redemptions_select_own on public.invite_redemptions
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.invite_codes c
      where c.id = invite_redemptions.invite_id
        and c.created_by = (select auth.uid())
    )
  );

-- --- security_events ---------------------------------------------------------

-- Readable by the person the event is about; writable by nobody through the API.
create policy security_events_select_own on public.security_events
  for select to authenticated
  using (user_id = (select auth.uid()));
