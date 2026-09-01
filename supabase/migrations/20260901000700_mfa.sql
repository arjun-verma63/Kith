-- =============================================================================
-- KITH — 0024 · Two-factor authentication
--
-- Supabase Auth (GoTrue) owns TOTP entirely: it generates the secret, renders
-- the QR code, verifies codes, and upgrades the session. Nothing in this
-- migration stores a secret, and nothing in this repository ever should — see
-- docs/MFA.md.
--
-- What this migration is for is the part GoTrue does NOT do for you, and the
-- part that is easy to skip because the app appears to work without it:
--
--   ENFORCING SECOND-FACTOR AT THE DATA LAYER.
--
-- ── Why a redirect is not two-factor authentication ──────────────────────────
--
-- Completing a password login gives you a real, valid session at `aal1`, before
-- any TOTP code is entered. That session's access token works against PostgREST
-- immediately. So an attacker holding a stolen password can skip the browser
-- entirely, take the aal1 token, and read the whole account over HTTP — while
-- the app dutifully shows a "enter your code" screen to nobody.
--
-- Middleware decides where to SEND somebody. Row Level Security decides what
-- they can READ. Only the second one is two-factor authentication.
--
-- So: a RESTRICTIVE policy on every table in `public`, which requires `aal2`
-- from any user who has a verified factor. Restrictive policies are ANDed with
-- everything else, so this cannot be widened by a permissive policy somebody
-- adds later — it can only be forgotten on a new table, and there is an
-- invariant in the suite that fails when it is.
--
-- ── Deliberately not "everyone must use aal2" ────────────────────────────────
--
-- The condition is per-user: if you have enrolled, your session must be aal2; if
-- you have not, aal1 is your ceiling and nothing changes for you. Two-factor is
-- opt-in, and a blanket `aal = 'aal2'` policy would lock out every account that
-- has not enrolled — which is all of them, the moment this ships.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- mfa_satisfied
--
-- SECURITY DEFINER because `authenticated` has no grant on `auth.mfa_factors`
-- and must not be given one — the factor table carries secrets. This function
-- reads it on the caller's behalf, about the caller only, and returns a single
-- boolean, so there is nothing to leak through it.
--
-- STABLE, and every call site wraps it in a scalar subselect, so the planner
-- evaluates it once per statement as an InitPlan rather than once per row.
--
-- Three cases:
--
--   no session      → true. There is no user to require a factor from; the
--                     table's own policies decide, as they always did.
--   no verified     → true. Not enrolled, so aal1 is the whole story.
--   verified factor → the JWT must say aal2.
--
-- An UNVERIFIED factor deliberately does not count. Enrolling creates a factor
-- before the first code is entered; if that locked the account to aal2, opening
-- the enrolment screen would lock you out of the app halfway through enrolling,
-- with no way to finish.
-- -----------------------------------------------------------------------------
create or replace function public.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    case
      when (select auth.uid()) is null then true
      when exists (
        select 1
        from auth.mfa_factors f
        where f.user_id = (select auth.uid())
          and f.status = 'verified'
      )
      then coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      else true
    end;
$$;

comment on function public.mfa_satisfied() is
  'True unless the caller has a verified MFA factor and has not completed it this session. Used by the restrictive mfa_required policy on every table.';

revoke execute on function public.mfa_satisfied() from public;
grant execute on function public.mfa_satisfied() to authenticated, anon, service_role;

-- -----------------------------------------------------------------------------
-- The gate itself, on every table in public.
--
-- Written as a loop rather than twenty-two hand-copied policies, because the
-- policy is character-for-character identical everywhere and the whole point is
-- that there are no exceptions. A hand-written list is a list somebody adds a
-- table to and forgets.
--
-- `to authenticated` only: `anon` has no uid, so the function would return true
-- anyway, and `service_role` must never be gated — the game runtime and the
-- signup path write with it and have no session to have a factor on.
-- -----------------------------------------------------------------------------
do $gate$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
    order by c.relname
  loop
    execute format(
      'drop policy if exists mfa_required on public.%I',
      t.relname
    );

    execute format(
      'create policy mfa_required on public.%I
         as restrictive
         for all
         to authenticated
         using ((select public.mfa_satisfied()))
         with check ((select public.mfa_satisfied()))',
      t.relname
    );
  end loop;
end;
$gate$;

-- -----------------------------------------------------------------------------
-- The audit trail
--
-- `security_events` has existed since migration 0002, append-only, readable by
-- its subject and writable by nobody through the API. Nothing has written to it
-- until now. Enrolling, enabling, disabling and failing a factor are exactly
-- what it was for.
--
-- Writes go through the service role from the server actions, not through a new
-- RPC: an event log that the client can append to is an event log the client can
-- fill with noise, and there is nothing here a user needs to write themselves.
--
-- The index is what makes "your recent security activity" on the settings page a
-- lookup rather than a scan; the existing (user_id, created_at desc) index
-- already serves it, so this adds only the partial index for the security page's
-- default filter.
-- -----------------------------------------------------------------------------
create index if not exists security_events_mfa_idx
  on public.security_events (user_id, created_at desc)
  where event like 'mfa.%';
