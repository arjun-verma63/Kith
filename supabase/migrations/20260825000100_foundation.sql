-- =============================================================================
-- KITH — 0001 · Foundation
--
-- Shared enums, shared trigger functions, and the conventions every later
-- migration depends on.
--
-- Conventions used throughout:
--   * uuid primary keys, `gen_random_uuid()` (built in since PG13 — no pgcrypto)
--   * timestamptz everywhere; never a bare `timestamp`
--   * `created_at` on every table, `updated_at` only where rows are mutated
--   * join tables use a composite primary key rather than a surrogate id
--   * relationships between two users are stored ONCE, in canonical
--     (least, greatest) order, so "are A and B related" is a single index probe
--     rather than an OR across two columns
--   * every table gets RLS in the same migration that creates it. There is no
--     "policies later" — a table with RLS off is readable by anyone holding the
--     anon key, which is a public value printed in the browser bundle.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
--
-- Preferred over text + CHECK for closed sets: the type is self-documenting,
-- shows up in the generated TypeScript as a union, and adding a value is an
-- explicit migration rather than a silently accepted typo.
-- -----------------------------------------------------------------------------

-- Mirrors the six spot inks in the design system.
create type public.profile_accent as enum ('ember', 'lantern', 'moss', 'signal', 'plum', 'ice');

-- A durable, user-chosen status. Live presence is NOT stored — see 0002.
create type public.presence_status as enum ('auto', 'active', 'away', 'busy', 'invisible');

create type public.permission_scope as enum ('everyone', 'friends', 'nobody');

create type public.theme_preference as enum ('dusk', 'daylight', 'system');
create type public.motion_preference as enum ('full', 'reduced', 'off');

create type public.friend_request_status as enum ('pending', 'accepted', 'declined', 'cancelled');

create type public.conversation_kind as enum ('dm', 'group');
create type public.member_role as enum ('owner', 'member');
create type public.message_kind as enum ('text', 'image', 'file', 'system', 'call_event');

create type public.call_kind as enum ('audio', 'video');
create type public.call_status as enum ('ringing', 'active', 'ended', 'missed', 'declined');
create type public.call_end_reason as enum (
  'hung_up',
  'declined',
  'missed',
  'failed',
  'cancelled',
  'expired'
);

create type public.game_audience as enum ('group', 'couple');
create type public.game_pace as enum ('turn_based', 'realtime');
create type public.game_status as enum ('lobby', 'active', 'finished', 'abandoned');

create type public.couple_status as enum ('pending', 'active', 'ended');

create type public.notification_kind as enum (
  'friend_request',
  'friend_accepted',
  'message',
  'call_missed',
  'game_invite',
  'couple_request',
  'couple_prompt',
  'system'
);

-- -----------------------------------------------------------------------------
-- Shared trigger functions
-- -----------------------------------------------------------------------------

-- Keeps `updated_at` honest. Doing this in the database rather than in the
-- application means it cannot be forgotten by a code path, and cannot be lied
-- about by a client sending its own timestamp.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with the server clock.';

-- Blocks any UPDATE or DELETE. Used on append-only tables (game moves, security
-- events) where history must not be rewritable, including by the service role.
create or replace function public.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Table %.% is append-only.', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

comment on function public.reject_mutation() is
  'BEFORE UPDATE OR DELETE trigger: enforces append-only tables at the database level.';
