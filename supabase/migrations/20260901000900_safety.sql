-- =============================================================================
-- KITH — 0026 · Safety
--
-- Blocking has existed since migration 0002 and is checked in nine places. This
-- migration is mostly about the places it was NOT checked, and about what
-- blocking should DO beyond existing as a row.
--
-- ── The audit ────────────────────────────────────────────────────────────────
--
-- Already enforced before this migration:
--
--   profiles      profiles_select hides both directions
--   search        search_profiles excludes blocked
--   messages      can_post_to_conversation refuses the send
--   calls         start_call goes through the same gate
--   friend reqs   friend_requests_insert_own refuses the insert
--   couple        can_propose_to refuses the proposal
--   avatars       the storage policy checks it
--
-- Not enforced, and fixed here:
--
--   games         can_view_game_session checked membership and stopped. Two
--                 people in one group conversation could sit in the same game,
--                 see each other's moves and share a scoreboard, across a block.
--
--   friends list  list_friends() returned a blocked friend, with presence. The
--                 friendship was never severed, so `are_friends` stayed true.
--
--   message text  A blocked person's messages stayed visible in a shared thread.
--                 "Blocked" that still shows you what they said is a mute.
--
-- ── And what blocking now does ───────────────────────────────────────────────
--
-- A block used to be a row that other checks consulted. It now also SEVERS: the
-- friendship, any pending request in either direction, an active couple, a live
-- call, and a seat in an unfinished game. Leaving those in place is what made
-- the audit above possible — every one of those gaps was a relationship that
-- outlived the block that should have ended it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 · Reports
-- -----------------------------------------------------------------------------

create type public.report_reason as enum (
  'harassment',
  'threats',
  'spam',
  'impersonation',
  'inappropriate_content',
  'other'
);

create type public.report_status as enum ('open', 'reviewing', 'actioned', 'dismissed');

create table public.reports (
  id uuid primary key default gen_random_uuid(),

  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reported_id uuid not null references public.profiles (id) on delete cascade,

  reason public.report_reason not null,
  -- What they typed. Optional for most reasons, required for 'other' — enforced
  -- in report_user rather than as a check constraint, so the message can say
  -- which field to fill in.
  detail text,

  -- What they were looking at. Both nullable: a report can be about a person
  -- rather than about one thing they said. `on delete set null` so deleting a
  -- message does not delete the evidence that it was reported.
  message_id uuid references public.messages (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,

  /*
   * The moderation shell.
   *
   * Nothing writes these yet — there is no admin dashboard, deliberately, and
   * the service role is the only thing that could. They are here because a
   * report with nowhere to go is a report that gets triaged in somebody's head:
   * `status` is a true statement about a new report from the moment it exists,
   * and the queue a dashboard will read is `where status = 'open'`.
   */
  status public.report_status not null default 'open',
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,
  moderator_note text,

  created_at timestamptz not null default now(),

  constraint reports_no_self check (reporter_id <> reported_id),
  constraint reports_detail_length check (detail is null or char_length(detail) <= 2000),
  constraint reports_note_length check (moderator_note is null or char_length(moderator_note) <= 2000),
  -- A review has both halves or neither, so "reviewed by nobody at some time" is
  -- not a state the table can hold.
  constraint reports_review_complete check (
    (reviewed_at is null and reviewed_by is null)
    or (reviewed_at is not null and reviewed_by is not null)
  )
);

create index reports_reporter_idx on public.reports (reporter_id, created_at desc);
create index reports_reported_idx on public.reports (reported_id, created_at desc);
-- The queue a dashboard will read, when there is one.
create index reports_open_idx on public.reports (created_at) where status = 'open';
-- Covers the reported_id foreign key, and the "already reported" check.
create index reports_pair_idx on public.reports (reporter_id, reported_id) where status = 'open';

-- The remaining three foreign keys. Every one of these is a column a parent
-- delete has to scan for, and the schema-hygiene invariant in rls.test.mjs fails
-- without them — which is how these came to be here rather than being noticed
-- the first time somebody deleted a busy conversation.
create index reports_message_idx on public.reports (message_id) where message_id is not null;
create index reports_conversation_idx on public.reports (conversation_id) where conversation_id is not null;
create index reports_reviewed_by_idx on public.reports (reviewed_by) where reviewed_by is not null;

alter table public.reports enable row level security;
alter table public.reports force row level security;

/*
 * You can read what you filed. Nothing else.
 *
 * Not readable by the person reported — a report they can see is a report that
 * tells them who filed it, which is how reporting somebody in a six-person room
 * becomes something nobody does.
 *
 * No INSERT policy: `report_user` is the only way in, because a plain insert
 * cannot check the rate limit or the duplicate. No UPDATE or DELETE policy at
 * all: a report the reporter can withdraw is a report somebody can be pressured
 * into withdrawing, and a report the subject could edit would be worthless.
 */
create policy reports_select_own on public.reports
  for select to authenticated
  using (reporter_id = (select auth.uid()));

-- The MFA gate from migration 0024 applies to every table in public, and this
-- one was created after it ran.
create policy mfa_required on public.reports
  as restrictive
  for all
  to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- -----------------------------------------------------------------------------
-- 2 · report_user
--
-- SECURITY DEFINER rather than an insert policy, because two of the rules cannot
-- be expressed as a WITH CHECK: "not more than five in an hour" and "not one you
-- already have open against this person" both need to count existing rows, and a
-- policy that reads the table it is protecting is a policy that recurses.
-- -----------------------------------------------------------------------------
create or replace function public.report_user(
  p_reported_id uuid,
  p_reason public.report_reason,
  p_detail text default null,
  p_message_id uuid default null,
  p_conversation_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  detail text := nullif(btrim(coalesce(p_detail, '')), '');
  new_report uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if p_reported_id = me then
    raise exception 'cannot_report_self' using errcode = '22023';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_reported_id) then
    raise exception 'no_such_account' using errcode = '22023';
  end if;

  -- 'other' is the reason that says nothing on its own.
  if p_reason = 'other' and detail is null then
    raise exception 'detail_required' using errcode = '22023';
  end if;

  if detail is not null and char_length(detail) > 2000 then
    raise exception 'detail_too_long' using errcode = '22023';
  end if;

  /*
   * The evidence has to be evidence the reporter could actually see.
   *
   * Without this, `message_id` is an oracle: point a report at any uuid and the
   * acceptance tells you the message exists. Both are checked against the
   * caller's own visibility, and a reference they cannot see is dropped rather
   * than refused — the report itself is still worth filing.
   */
  if p_message_id is not null
     and not exists (
       select 1 from public.messages m
       where m.id = p_message_id
         and public.is_conversation_member(m.conversation_id)
     )
  then
    p_message_id := null;
  end if;

  if p_conversation_id is not null
     and not public.is_conversation_member(p_conversation_id)
  then
    p_conversation_id := null;
  end if;

  if exists (
    select 1 from public.reports r
    where r.reporter_id = me
      and r.reported_id = p_reported_id
      and r.status = 'open'
  ) then
    raise exception 'already_reported' using errcode = '55006';
  end if;

  -- A cap rather than a ban. Somebody reporting six people in an hour is either
  -- having a very bad day or is the problem, and both are worth slowing down.
  if (
    select count(*) from public.reports r
    where r.reporter_id = me
      and r.created_at > now() - interval '1 hour'
  ) >= 5 then
    raise exception 'too_many_reports' using errcode = '55006';
  end if;

  insert into public.reports (
    reporter_id, reported_id, reason, detail, message_id, conversation_id
  )
  values (me, p_reported_id, p_reason, detail, p_message_id, p_conversation_id)
  returning id into new_report;

  return new_report;
end;
$$;

comment on function public.report_user(uuid, public.report_reason, text, uuid, uuid) is
  'Files a report. Rate-limited, deduplicated per open report, and drops evidence references the reporter cannot see.';

revoke execute on function public.report_user(uuid, public.report_reason, text, uuid, uuid)
  from public, anon;
grant execute on function public.report_user(uuid, public.report_reason, text, uuid, uuid)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 3 · block_user
--
-- Blocking is no longer just a row. It severs.
--
-- The severing is the point of this function, and the reason the direct INSERT
-- policy is dropped below: a block that leaves the friendship standing leaves
-- `are_friends` true, which quietly re-opens every gate that says "friends" —
-- who can message you, who can call you, who can ask you out. Two ways to create
-- a block, one of which skips all of this, is two behaviours.
-- -----------------------------------------------------------------------------
create or replace function public.block_user(
  p_user_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if p_user_id = me then
    raise exception 'cannot_block_self' using errcode = '22023';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'no_such_account' using errcode = '22023';
  end if;

  if reason is not null and char_length(reason) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  -- Idempotent. Blocking somebody you have already blocked is a double-tap, not
  -- an error, and it must not raise on the unique constraint.
  insert into public.blocks (blocker_id, blocked_id, reason)
  values (me, p_user_id, reason)
  on conflict (blocker_id, blocked_id) do nothing;

  -- The friendship. Gone, in both directions, because there is only one row.
  delete from public.friendships
   where user_low = least(me, p_user_id)
     and user_high = greatest(me, p_user_id);

  /*
   * Pending requests, either direction.
   *
   * Cancelled rather than declined, whoever sent it. 'declined' is a statement
   * about the request; this is a statement about the person, and the difference
   * matters if the block is ever lifted.
   */
  update public.friend_requests
     set status = 'cancelled', responded_at = coalesce(responded_at, now())
   where status = 'pending'
     and (
       (requester_id = me and addressee_id = p_user_id)
       or (requester_id = p_user_id and addressee_id = me)
     );

  -- A couple. Blocking your partner is not an ambiguous act.
  update public.couples
     set status = 'ended', ended_at = coalesce(ended_at, now())
   where status <> 'ended'
     and user_low = least(me, p_user_id)
     and user_high = greatest(me, p_user_id);

  -- Any live call the two of them are in together. Both leave: the block is
  -- symmetric and a call with one person still on the line is not a call.
  update public.call_participants cp
     set left_at = now()
   where cp.left_at is null
     and cp.user_id in (me, p_user_id)
     and exists (
       select 1
       from public.calls c
       join public.call_participants other on other.call_id = c.id
       where c.id = cp.call_id
         and c.status in ('ringing', 'active')
         and other.user_id = case when cp.user_id = me then p_user_id else me end
         and other.left_at is null
     );

  -- Unfinished games with both of them in. Same reasoning as the call.
  update public.game_players gp
     set left_at = now()
   where gp.left_at is null
     and gp.user_id in (me, p_user_id)
     and exists (
       select 1
       from public.game_sessions s
       join public.game_players other on other.session_id = s.id
       where s.id = gp.session_id
         and s.status in ('lobby', 'active')
         and other.user_id = case when gp.user_id = me then p_user_id else me end
         and other.left_at is null
     );
end;
$$;

comment on function public.block_user(uuid, text) is
  'Blocks somebody and severs what the block should end: friendship, pending requests, an active couple, a live call, a seat in an unfinished game.';

revoke execute on function public.block_user(uuid, text) from public, anon;
grant execute on function public.block_user(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 4 · unblock_user
--
-- Deliberately not the inverse. Removing the block restores the ability to reach
-- each other; it does not restore the friendship, the couple, or the game, and
-- nothing here tries to. Undoing a severing would mean remembering what was
-- severed, and a block is not a pause button.
-- -----------------------------------------------------------------------------
create or replace function public.unblock_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  delete from public.blocks
   where blocker_id = me
     and blocked_id = p_user_id;
end;
$$;

comment on function public.unblock_user(uuid) is
  'Lifts a block you created. Does not restore the friendship, couple or game it ended — see block_user.';

revoke execute on function public.unblock_user(uuid) from public, anon;
grant execute on function public.unblock_user(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 5 · list_blocked
--
-- SECURITY DEFINER for an awkward but correct reason: `profiles_select` hides a
-- blocked profile in both directions, so once you block somebody you can no
-- longer read their name — which would leave the "blocked accounts" list showing
-- a column of uuids.
--
-- Safe, because it returns only people the caller blocked themselves. They chose
-- the row; they already know who is in it.
-- -----------------------------------------------------------------------------
create or replace function public.list_blocked()
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_path text,
  reason text,
  blocked_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.username,
    p.display_name,
    p.avatar_path,
    b.reason,
    b.created_at
  from public.blocks b
  join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = (select auth.uid())
  order by b.created_at desc;
$$;

revoke execute on function public.list_blocked() from public, anon;
grant execute on function public.list_blocked() to authenticated;

-- -----------------------------------------------------------------------------
-- 6 · The blocks table is written through the functions only
--
-- Both policies dropped. A direct insert skips every severing step in
-- `block_user`, and the resulting half-block — blocked but still friends, still
-- in the couple, still seated in the game — is exactly the inconsistency this
-- migration exists to remove.
--
-- SELECT stays: you can see who you have blocked, and still cannot see who has
-- blocked you.
-- -----------------------------------------------------------------------------
drop policy if exists blocks_insert_own on public.blocks;
drop policy if exists blocks_delete_own on public.blocks;

-- -----------------------------------------------------------------------------
-- 7 · Games, across a block
--
-- The gap. `can_view_game_session` checked conversation membership and stopped,
-- so two people in the same group thread could sit in one game, watch each
-- other's moves arrive and share a scoreboard, with a block between them.
--
-- Checked against the OTHER PLAYERS rather than against the conversation: a group
-- thread of six can legitimately host a game between two people who have nothing
-- to do with the person you blocked.
--
-- Note the absence of a `left_at is null` filter, which was the first version and
-- was quietly useless: `block_user` marks BOTH of them as having left, so by the
-- time this predicate runs there is nobody seated to find a block against. The
-- question is not "are they still playing" but "did I ever share this game with
-- somebody I have since blocked", and the answer hides the session either way.
-- -----------------------------------------------------------------------------
create or replace function public.can_view_game_session(target_session uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.game_sessions s
    where s.id = target_session
      and (
        (s.conversation_id is not null and public.is_conversation_member(s.conversation_id))
        or (s.couple_id is not null and public.is_couple_member(s.couple_id))
      )
  )
  and not exists (
    select 1
    from public.game_players gp
    join public.blocks b
      on (b.blocker_id = gp.user_id and b.blocked_id = (select auth.uid()))
      or (b.blocker_id = (select auth.uid()) and b.blocked_id = gp.user_id)
    where gp.session_id = target_session
      and gp.user_id <> (select auth.uid())
  );
$$;

comment on function public.can_view_game_session(uuid) is
  'Membership of the conversation or couple the session belongs to, and no block with anybody who has ever held a seat in it.';

-- -----------------------------------------------------------------------------
-- 8 · The friends list, across a block
--
-- `block_user` deletes the friendship, so in normal use this predicate never
-- fires. It is here because "the list is correct as long as the only way a block
-- was created was through the function" is not an invariant a list should rest
-- on — and because a blocked friend appearing in the roster also leaks presence.
-- -----------------------------------------------------------------------------
create or replace function public.list_friends()
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_path text,
  bio text,
  pronouns text,
  accent public.profile_accent,
  status public.presence_status,
  status_text text,
  last_seen_at timestamptz,
  friends_since timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    p.id,
    p.username,
    p.display_name,
    p.avatar_path,
    p.bio,
    p.pronouns,
    p.accent,
    p.status,
    p.status_text,
    case when p.status = 'invisible' then null else p.last_seen_at end,
    f.became_friends_at
  from public.friendships f
  join public.profiles p
    on p.id = case
                when f.user_low = (select auth.uid()) then f.user_high
                else f.user_low
              end
  where (select auth.uid()) in (f.user_low, f.user_high)
    and not public.is_blocked_either(p.id)
    and p.deleted_at is null
  order by lower(p.display_name);
$$;

revoke execute on function public.list_friends() from public, anon;
grant execute on function public.list_friends() to authenticated;

-- -----------------------------------------------------------------------------
-- 9 · Messages, across a block
--
-- "Blocked" that still shows you what they said is a mute.
--
-- ── Symmetric, and that is a real trade-off ──────────────────────────────────
--
-- The blocked person's view changes too, which tells them something happened.
-- The alternative — hiding one way — keeps the block quiet but means the blocker
-- is still being read by somebody they have blocked, which is the wrong half to
-- protect. And it is already knowable: `can_post_to_conversation` refuses their
-- next message either way.
--
-- ── What this does NOT fix ───────────────────────────────────────────────────
--
-- `conversations.last_message_at` is denormalised by a trigger and does not know
-- about blocks, so a thread can still sort as though something arrived in it.
-- The message itself does not appear. Fixing that properly means a per-viewer
-- preview, which is a different feature.
-- -----------------------------------------------------------------------------
drop policy if exists messages_select_member on public.messages;

create policy messages_select_member on public.messages
  for select to authenticated
  using (
    public.is_conversation_member(conversation_id)
    -- Written as NOT EXISTS against the table rather than as is_blocked_either()
    -- because this runs per row: the sender varies down a thread, so the helper
    -- could not be hoisted out of the loop the way it is everywhere else.
    and not exists (
      select 1
      from public.blocks b
      where (b.blocker_id = (select auth.uid()) and b.blocked_id = messages.sender_id)
         or (b.blocker_id = messages.sender_id and b.blocked_id = (select auth.uid()))
    )
  );
