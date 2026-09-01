-- =============================================================================
-- KITH — 0028 · Security hardening
--
-- Four findings from the audit in docs/SECURITY.md, all reachable by a member of
-- the room with a browser console and the anon key — which is public by design,
-- so "a member turns malicious or gets compromised" is the threat model that
-- matters for an invitation-only app.
--
--   1  notification_enabled leaked another member's settings
--   2  invite codes were unlimited, so the room was not closed
--   3  nothing rate-limited a message, so one account could fill the database
--   4  adding a blocked member to a group silently revoked the blocker's ability
--      to post in it
--
-- Each is fixed below with the probe that found it named, so the fix and the
-- attack stay attached to each other.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 · notification_enabled was an oracle over user_settings
--
-- ── The bug ──────────────────────────────────────────────────────────────────
--
-- `user_settings` is strictly own-row: `user_settings_select_own` restricts every
-- read to `auth.uid()`. But migration 0027 added a SECURITY DEFINER function
-- that takes a user id as a PARAMETER, reads that person's `notification_prefs`,
-- and was granted to `authenticated`.
--
--     select public.notification_enabled('<somebody else>', 'message');  -- false
--
-- One boolean per call, seven kinds, and a member could read out another
-- member's notification settings a bit at a time — the exact column the policy
-- exists to protect.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- Revoke it from sessions entirely. The only caller is the BEFORE INSERT trigger
-- on `notifications`, which is itself SECURITY DEFINER and therefore executes as
-- the owner — it never needed the grant, and it keeps working without it.
--
-- The general lesson is the one the suite now enforces: a SECURITY DEFINER
-- function that takes an identity instead of reading `auth.uid()` must not be
-- callable from a session.
-- -----------------------------------------------------------------------------
revoke execute on function public.notification_enabled(uuid, public.notification_kind)
  from public, anon, authenticated;

grant execute on function public.notification_enabled(uuid, public.notification_kind)
  to service_role;

comment on function public.notification_enabled(uuid, public.notification_kind) is
  'Whether this person wants notifications of this kind. NOT callable from a session — it takes an identity rather than reading auth.uid(), and reads a column that is otherwise own-row. Called only by the apply_notification_prefs trigger, which runs as the owner.';

-- -----------------------------------------------------------------------------
-- 2 · Invite codes were unlimited
--
-- ── The bug ──────────────────────────────────────────────────────────────────
--
-- `invite_codes_insert_own` checked that you were creating a code in your own
-- name, and nothing else. `max_uses` caps a single code at 20 signups; nothing
-- capped the number of codes.
--
--     for (let i = 0; i < 200; i++) insert into invite_codes ...   -- all 200 land
--
-- Four thousand accounts, from one member, into a room whose entire premise is
-- that there are six people in it and no strangers. Of the four findings this is
-- the one that changes what the product IS.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- A ceiling on LIVE codes — unredeemed, unexpired, unrevoked — rather than on
-- codes ever created. Somebody who invites five people, watches them join, and
-- invites five more is behaving normally and is not stopped; somebody minting
-- two hundred is.
--
-- A trigger rather than a policy, because a `WITH CHECK` cannot count rows in
-- the table it is protecting without recursing.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_invite_ceiling()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  live integer;
begin
  select count(*) into live
  from public.invite_codes c
  where c.created_by = new.created_by
    and c.revoked_at is null
    and c.expires_at > now()
    and c.uses < c.max_uses;

  -- Five outstanding invitations is more than a six-person room ever needs at
  -- once, and is a number somebody has to work at to reach honestly.
  if live >= 5 then
    raise exception 'too_many_invites' using errcode = '55006';
  end if;

  return new;
end;
$$;

comment on function public.enforce_invite_ceiling() is
  'Caps live invitations per member. A policy cannot count rows in the table it protects without recursing, so this is a trigger.';

drop trigger if exists invite_codes_ceiling on public.invite_codes;

create trigger invite_codes_ceiling
  before insert on public.invite_codes
  for each row execute function public.enforce_invite_ceiling();

-- The count above is per creator over live codes, which is exactly this shape.
create index if not exists invite_codes_live_idx
  on public.invite_codes (created_by)
  where revoked_at is null;

-- -----------------------------------------------------------------------------
-- 3 · Nothing rate-limited a message
--
-- ── The bug ──────────────────────────────────────────────────────────────────
--
-- Every authorization rule around messages is correct — you must be a member,
-- you must not be blocked, you must be the sender. None of them says how MANY.
--
-- A compromised account in a legitimate conversation could insert rows until the
-- project's storage ran out, which on a free-tier database is a denial of
-- service against all six people, not just against the person whose account it
-- was. Nothing in the app would have refused a single one of those inserts.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- A per-sender ceiling over a rolling minute, counted in a ledger of its own.
--
-- The first version of this counted rows in `messages` directly, and it was
-- wrong twice over. Finding 6 is the first way: `created_at` was client-supplied,
-- so backdating every insert made the count zero and the limit decorative.
--
-- The second way is what three test fixtures found by failing. Counting the
-- table cannot tell a session's insert from our own server's, so a bulk write
-- attributed to somebody — a fixture, an import, a restore — spends a budget
-- they never used and locks them out of their own conversation. A rate limit
-- that a trusted write can trigger against an innocent member is a bug, and no
-- amount of care in the fixtures fixes the mechanism.
--
-- A ledger records only what a session actually did. It is unreadable and
-- unwritable from a session, it is keyed on `auth.uid()` rather than on a column
-- anybody can supply, and it keeps its own clock — so nothing a client sends can
-- move it. It prunes itself on each write and stays around thirty rows a member.
--
-- The number is chosen to be invisible: a fast typist in a heated conversation
-- sends perhaps ten messages a minute, so 30 leaves a wide margin for somebody
-- excited and stops a script on its thirty-first insert.
--
-- Deliberately a raise, not a queue, a delay or a soft throttle. A raise is
-- legible — the composer shows why and the message is kept — where a silent drop
-- looks like the app losing what somebody wrote.
-- -----------------------------------------------------------------------------
create table if not exists public.rate_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  at timestamptz not null default now()
);

comment on table public.rate_events is
  'What a session has done recently, for rate limiting. Written only by definer triggers and readable by nobody: a limit counted from a table the limited party can write is not a limit.';

-- The only query: one member's recent events of one kind.
create index if not exists rate_events_lookup_idx
  on public.rate_events (user_id, kind, at desc);

alter table public.rate_events enable row level security;
alter table public.rate_events force row level security;

revoke all on public.rate_events from public, anon, authenticated;

/*
 * The refusal is written down rather than implied.
 *
 * RLS with no policy at all already denies everything, and the first draft of
 * this table relied on that — which the RLS suite rejected, correctly, on an
 * invariant it has carried since migration 0002: a table with RLS on and no
 * policy is nearly always somebody who forgot, and a reader cannot tell that
 * case apart from this one. `using (false)` says which it is.
 *
 * The grants above are the second, independent lock. Either alone would do; a
 * future migration that adds a policy to this table by reflex should still find
 * the door shut.
 */
create policy rate_events_no_session_access on public.rate_events
  for all to authenticated
  using (false)
  with check (false);

/*
 * And the gate from migration 0024, which that migration's `do` block applied to
 * every table that existed at the time. A table added later has to bring its
 * own, or an aal1 session belonging to an enrolled account slips through the one
 * hole two-factor exists to close. The RLS suite asserts this for every table
 * precisely so a new one cannot be forgotten.
 */
create policy mfa_required on public.rate_events
  as restrictive
  for all
  to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

create or replace function public.enforce_message_rate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent integer;
begin
  -- A rate limit governs what a SESSION may do. Inserts with no session behind
  -- them are our own server code and the triggers that write system messages;
  -- the service key is `server-only` and never reaches a browser, so there is
  -- nobody on the other side of this branch to limit.
  if actor is null then
    return new;
  end if;

  -- System messages are written by triggers, not by people.
  if new.kind = 'system' then
    return new;
  end if;

  -- Self-pruning: each send clears its own sender's expired rows, so the table
  -- stays at roughly the ceiling per member without a scheduler.
  delete from public.rate_events e
  where e.user_id = actor
    and e.at <= now() - interval '1 minute';

  select count(*) into recent
  from public.rate_events e
  where e.user_id = actor
    and e.kind = 'message';

  if recent >= 30 then
    raise exception 'sending_too_fast' using errcode = '55006';
  end if;

  insert into public.rate_events (user_id, kind) values (actor, 'message');

  return new;
end;
$$;

comment on function public.enforce_message_rate() is
  'Thirty messages a minute per session. Not about spam between friends — about one compromised account being able to fill a free-tier database for everybody.';

drop trigger if exists messages_rate_limit on public.messages;

create trigger messages_rate_limit
  before insert on public.messages
  for each row execute function public.enforce_message_rate();

-- -----------------------------------------------------------------------------
-- 4 · A blocked member could be added to a group
--
-- ── The bug ──────────────────────────────────────────────────────────────────
--
-- `can_add_conversation_member` let any member of a group add anybody. It never
-- consulted blocks — and `can_post_to_conversation` refuses to let you post if
-- you are blocked with ANY other active member of the thread.
--
-- Put those together and adding a blocked person to a group silently takes the
-- group away from the person who did the blocking:
--
--     Ada is in a group and can post.
--     Rafa adds Mallory, whom Ada has blocked.
--     Ada can no longer post in her own group.
--
-- Which is a denial of service dressed as a feature, and a way to force contact
-- on somebody who has explicitly refused it. It works whether the person adding
-- is malicious or simply unaware.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- Nobody may be added to a conversation where a block exists in either direction
-- with anybody already in it. Symmetric, like every other block rule here, and
-- checked against active members only — somebody who has already left is not a
-- reason to refuse.
--
-- The body is otherwise migration 0004's, unchanged. `create or replace` has no
-- way to patch a function, so whatever is written here IS the function.
-- -----------------------------------------------------------------------------
create or replace function public.can_add_conversation_member(
  target_conversation uuid,
  target_user uuid
)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    coalesce(
      (
        select
          case
            when c.kind = 'dm' then
              c.created_by = (select auth.uid())
              and (
                select count(*) from public.conversation_members m
                where m.conversation_id = c.id
              ) < 2
            else
              c.created_by = (select auth.uid())
              or public.is_conversation_member(c.id)
          end
        from public.conversations c
        where c.id = target_conversation
      ),
      false
    )
    -- New in 0028. Checked against the person being ADDED and everybody already
    -- there, not against the caller: the harm is done to the member who blocked,
    -- who is not the one making the request.
    and not exists (
      select 1
      from public.conversation_members m
      join public.blocks b
        on (b.blocker_id = m.user_id and b.blocked_id = target_user)
        or (b.blocker_id = target_user and b.blocked_id = m.user_id)
      where m.conversation_id = target_conversation
        and m.left_at is null
        and m.user_id <> target_user
    );
$$;

comment on function public.can_add_conversation_member(uuid, uuid) is
  'Membership is granted from inside the conversation, never claimed from outside — and never across a block with anybody already in it.';

-- -----------------------------------------------------------------------------
-- 5 · The maintenance sweepers were session-callable
--
-- ── The bug ──────────────────────────────────────────────────────────────────
--
-- `abandon_stale_games`, `expire_ringing_calls` and `expire_abandoned_calls`
-- were all granted to `authenticated`. Each does an unbounded UPDATE across a
-- table, and each was only ever meant to be swept opportunistically from inside
-- another function — `start_call` and `create_game_session` call them so the
-- housekeeping happens without a scheduler.
--
--     select public.abandon_stale_games();   -- from a browser console, in a loop
--
-- They are time-gated, so a member cannot use them to end a call or a game that
-- is still live. What they can do is make the database work, repeatedly and for
-- free, which is the cheap end of the same denial of service as finding 3.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- Revoked. Every caller is SECURITY DEFINER and therefore runs as the owner, so
-- none of them needed the grant — it was reflex rather than requirement.
-- -----------------------------------------------------------------------------
revoke execute on function public.abandon_stale_games() from public, anon, authenticated;
revoke execute on function public.expire_ringing_calls() from public, anon, authenticated;
revoke execute on function public.expire_abandoned_calls() from public, anon, authenticated;

grant execute on function public.abandon_stale_games() to service_role;
grant execute on function public.expire_ringing_calls() to service_role;
grant execute on function public.expire_abandoned_calls() to service_role;

-- -----------------------------------------------------------------------------
-- 6 · A session could choose its own `created_at`
--
-- ── The bug ──────────────────────────────────────────────────────────────────
--
-- Found by finding 3's own trigger failing the messaging suite, which is the
-- best kind of finding: the fix could not be trusted until this was true.
--
-- `messages.created_at` has a default and no grant excluding it, so a session
-- may supply it. The app never does — `sendMessage` inserts four columns and
-- lets the default fire — but the policy is what a member is bound by, not the
-- app, and a browser console speaks to PostgREST directly.
--
--     insert into messages (..., created_at) values (..., '1970-01-01');
--
-- Two consequences, both proven with a probe before this migration:
--
--   · Finding 3's first draft counted rows `where created_at > now() - 1min`.
--     Backdate every insert and that count is always zero — 500 messages went
--     through a limit of 30. That half is now closed at the source instead: the
--     ledger above keeps its own clock and never reads a client's value, which
--     is the right place for it, because a limit that depends on a stamping
--     trigger elsewhere is a limit with a second thing to get wrong.
--
--   · Threads order by `created_at`. A message dated 3000-01-01 sits at the top
--     of a conversation permanently, above everything anybody says afterwards.
--     This is the half that still needs a fix, and it is a real one on its own.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- The server stamps the time. Not a CHECK that the value is plausible and not a
-- revoked column grant — either would make the app's insert fail on a column it
-- is not trying to set. An overwrite is invisible to every honest caller and
-- leaves a forged value with nowhere to land.
--
-- Only when a session is behind the insert. Fixtures and our own server code
-- backdate deliberately — the messaging suite's pagination fixture writes 75
-- rows across a spread of timestamps, which is legitimate and must keep working.
-- `auth.uid()` is null in both of those contexts and non-null in exactly the
-- context this is defending against, because it comes from a signed JWT.
--
-- `friend_requests` has the same shape with a much smaller blast radius — the
-- worst a forged timestamp does is sort your request to the top of a list of
-- five. Fixed too, by the same trigger: the rule is "a session does not choose
-- when something happened", and a rule with an exception is a rule people forget.
-- -----------------------------------------------------------------------------
create or replace function public.stamp_created_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.created_at := now();
  end if;
  return new;
end;
$$;

comment on function public.stamp_created_at() is
  'The server decides when a row happened, not the session that wrote it. Left alone for inserts with no session behind them, which are fixtures and our own server code.';

drop trigger if exists messages_created_at on public.messages;

create trigger messages_created_at
  before insert on public.messages
  for each row execute function public.stamp_created_at();

drop trigger if exists friend_requests_created_at on public.friend_requests;

create trigger friend_requests_created_at
  before insert on public.friend_requests
  for each row execute function public.stamp_created_at();
