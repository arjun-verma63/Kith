-- =============================================================================
-- KITH — 0010 · Invite redemption
--
-- Signup is invite-gated, which creates a problem the rest of the schema does
-- not have: the person redeeming a code has no account yet, so there is no
-- `auth.uid()` to write an RLS policy against. Redemption therefore happens
-- through these functions, called by the server with the service-role client.
--
-- They are SECURITY DEFINER and EXECUTE is revoked from `anon` and
-- `authenticated`. Without that revoke, any signed-in member could call
-- `consume_invite` in a loop and burn every outstanding invitation in the
-- system — a denial-of-service with no error message anywhere.
--
-- The bootstrap rule: while there are no profiles at all, the first account in
-- needs no code. A private app whose first user cannot create themselves is a
-- private app nobody can start.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- consume_invite
--
-- Atomically claims one use of a code, or raises. The `update ... returning` is
-- the whole concurrency story: the row lock serialises two people redeeming the
-- last use of the same code, so exactly one of them wins. A read-then-write would
-- let both through.
--
-- Returns the invite id, or null when the room was empty and no code was needed.
-- -----------------------------------------------------------------------------

create or replace function public.consume_invite(p_code_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed uuid;
begin
  -- Serialise the bootstrap check so two simultaneous first-signups cannot both
  -- observe an empty room.
  perform pg_advisory_xact_lock(hashtextextended('kith:signup', 0));

  if not exists (select 1 from public.profiles) then
    return null;
  end if;

  if p_code_hash is null or length(p_code_hash) = 0 then
    raise exception 'invite_required' using errcode = '42501';
  end if;

  update public.invite_codes
     set uses = uses + 1
   where code_hash = p_code_hash
     and revoked_at is null
     and expires_at > now()
     and uses < max_uses
  returning id into claimed;

  if claimed is null then
    -- Deliberately one error for every failure mode. Distinguishing "no such
    -- code" from "expired" from "already used up" tells someone probing codes
    -- which guesses were close.
    raise exception 'invalid_invite' using errcode = '42501';
  end if;

  return claimed;
end;
$$;

-- -----------------------------------------------------------------------------
-- release_invite
--
-- Compensating action. A use is claimed *before* the account is created, because
-- creating an account for someone without a valid invitation is the failure that
-- matters. If account creation then fails, the use is handed back.
-- -----------------------------------------------------------------------------

create or replace function public.release_invite(p_invite_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.invite_codes
     set uses = greatest(uses - 1, 0)
   where id = p_invite_id;
$$;

-- -----------------------------------------------------------------------------
-- record_invite_redemption
--
-- Who let whom in. Written after the account exists, so the foreign key holds.
-- -----------------------------------------------------------------------------

create or replace function public.record_invite_redemption(p_invite_id uuid, p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.invite_redemptions (invite_id, user_id)
  values (p_invite_id, p_user_id)
  on conflict do nothing;
$$;

-- -----------------------------------------------------------------------------
-- is_username_available
--
-- Lets the signup form check a username before submitting, without exposing the
-- profiles table to an unauthenticated visitor. Returns only a boolean.
-- -----------------------------------------------------------------------------

create or replace function public.is_username_available(p_username text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select not exists (
    select 1 from public.profiles p where lower(p.username) = lower(p_username)
  );
$$;

-- -----------------------------------------------------------------------------
-- Execute privileges
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default. For a
-- SECURITY DEFINER function that mutates invite state, that default is a hole.
-- -----------------------------------------------------------------------------

revoke execute on function public.consume_invite(text) from public, anon, authenticated;
revoke execute on function public.release_invite(uuid) from public, anon, authenticated;
revoke execute on function public.record_invite_redemption(uuid, uuid) from public, anon, authenticated;

grant execute on function public.consume_invite(text) to service_role;
grant execute on function public.release_invite(uuid) to service_role;
grant execute on function public.record_invite_redemption(uuid, uuid) to service_role;

-- Safe for anyone to call: it answers one boolean about a name they typed.
grant execute on function public.is_username_available(text) to anon, authenticated;
