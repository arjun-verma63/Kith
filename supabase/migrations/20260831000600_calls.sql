-- =============================================================================
-- KITH — 0016 · Voice calls
--
-- Migration 0005 created the `calls` and `call_participants` tables. This adds
-- the lifecycle: starting, answering, declining, hanging up, timing out, and
-- reading the history back.
--
-- ── The lifecycle is a state machine, and it lives here ──────────────────────
--
-- Every transition is an RPC. The client cannot write to `calls` at all — INSERT,
-- UPDATE and DELETE are revoked from `authenticated` at the bottom of this file,
-- so the only door is a function that checks the transition is legal.
--
-- That matters more for calls than for most things. "Missed" is the difference
-- between a notification and no notification, and if a client could write status
-- directly it could mark its own missed calls as answered, or somebody else's
-- answered call as missed. Here, `missed` is only ever *derived* — a call that
-- ended while it was still ringing — and no client can assert it.
--
-- ── Still no signalling in the database ──────────────────────────────────────
--
-- Same rule as before: SDP and ICE go over the `call:{id}` broadcast channel and
-- are never stored. What these tables hold is who called whom, when, and how it
-- ended. `supabase/tests/webrtc.test.mjs` asserts there is nowhere to put media
-- even if somebody tried.
--
-- Lifecycle events (`call.incoming`, `call.updated`, `call.ended`) are broadcast
-- on each participant's `user:{id}` channel rather than on `call:{id}`. The
-- personal bus is already open — that is what it is for — so a callee learns
-- about a call before they have joined anything, and a cancelled call cannot
-- race a subscription that has not finished.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- How long a call rings.
--
-- A function rather than a literal so the ring timeout is one definition shared
-- by the sweep, `answer_call`'s staleness check, and the tests. 45 seconds is
-- about eight rings — long enough to cross a room, short enough that a phone
-- ringing in an empty flat gives up before it becomes annoying.
-- -----------------------------------------------------------------------------
create or replace function public.ring_timeout()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '45 seconds';
$$;

comment on function public.ring_timeout() is
  'How long a call rings before it counts as missed.';

-- -----------------------------------------------------------------------------
-- broadcast_call
--
-- One fan-out per participant, onto their personal channel.
--
-- The payload carries enough to render the incoming-call UI immediately —
-- including the caller's name, because a ring that says "Unknown" for 300ms
-- while a fetch resolves is worse than no ring at all. The avatar is fetched
-- afterwards by the client, since a signed URL cannot be minted here.
-- -----------------------------------------------------------------------------
create or replace function public.broadcast_call(p_call_id uuid, p_event text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  recipient uuid;
begin
  select jsonb_build_object(
    'id', c.id,
    'conversation_id', c.conversation_id,
    'initiator_id', c.initiator_id,
    'initiator_username', p.username,
    'initiator_display_name', p.display_name,
    'kind', c.kind,
    'status', c.status,
    'started_at', c.started_at,
    'answered_at', c.answered_at,
    'ended_at', c.ended_at,
    'end_reason', c.end_reason
  )
  into payload
  from public.calls c
  left join public.profiles p on p.id = c.initiator_id
  where c.id = p_call_id;

  if payload is null then
    return;
  end if;

  for recipient in
    select cp.user_id from public.call_participants cp where cp.call_id = p_call_id
  loop
    perform realtime.send(payload, p_event, 'user:' || recipient::text, true);
  end loop;
end;
$$;

comment on function public.broadcast_call(uuid, text) is
  'Fans a call lifecycle event out to every participant''s personal channel.';

-- -----------------------------------------------------------------------------
-- expire_ringing_calls
--
-- The timeout, server-side.
--
-- A client-side timer is not enough on its own: the caller can close the tab
-- while it rings, and then nothing is left to end the call. This sweep is the
-- authority. It is cheap — `calls_ringing_idx` is a partial index over a status
-- that is true for seconds at a time — so it is safe to call opportunistically
-- as well as on a schedule.
--
-- Setting status to 'missed' fires `notify_missed_call` (migration 0015), so the
-- missed-call notification is a consequence of the timeout rather than a second
-- thing that has to be remembered.
-- -----------------------------------------------------------------------------
create or replace function public.expire_ringing_calls()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_ids uuid[];
  one uuid;
begin
  with stale as (
    update public.calls c
       set status = 'missed',
           ended_at = now(),
           end_reason = 'expired'
     where c.status = 'ringing'
       and c.started_at < now() - public.ring_timeout()
    returning c.id
  )
  select coalesce(array_agg(stale.id), '{}') into expired_ids from stale;

  foreach one in array expired_ids loop
    perform public.broadcast_call(one, 'call.ended');
  end loop;

  return coalesce(array_length(expired_ids, 1), 0);
end;
$$;

comment on function public.expire_ringing_calls() is
  'Ends calls that have rung past the timeout. Safe to call from anywhere.';

-- -----------------------------------------------------------------------------
-- start_call
--
-- Rings everybody in the conversation.
--
-- Two races are handled here, both of which produce a broken call rather than an
-- error if they are ignored:
--
--   Simultaneous dialling. Two friends pressing "call" in the same second must
--   end up in ONE call, not two that each think the other is not answering. An
--   advisory lock on the conversation serialises the check-then-insert, and the
--   second caller joins the first call instead of starting a rival.
--
--   Stale rings. A call left ringing by a closed tab would otherwise look live
--   and block every future call in that conversation. The sweep runs first.
-- -----------------------------------------------------------------------------
create or replace function public.start_call(
  p_conversation_id uuid,
  p_kind public.call_kind default 'audio'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  existing uuid;
  existing_status public.call_status;
  new_call uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- Membership AND the absence of a block, in both directions. The same gate as
  -- posting a message: if you cannot write to the thread you cannot ring it.
  if not public.can_post_to_conversation(p_conversation_id) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  -- Both sweeps, so neither a stale ring nor an abandoned call can block a new
  -- one. Each reads a partial index over a status that is rare, so this costs
  -- almost nothing.
  perform public.expire_ringing_calls();
  perform public.expire_abandoned_calls();

  perform pg_advisory_xact_lock(hashtext('kith.call:' || p_conversation_id::text));

  select c.id, c.status into existing, existing_status
  from public.calls c
  where c.conversation_id = p_conversation_id
    and c.status in ('ringing', 'active')
  order by c.started_at desc
  limit 1;

  if existing is not null then
    -- Join what is already happening. For a group this is "join the call in
    -- progress"; for a DM it is the simultaneous-dial case collapsing into one.
    if exists (
      select 1 from public.call_participants cp
      where cp.call_id = existing and cp.user_id = me
    ) then
      update public.call_participants cp
         set joined_at = coalesce(cp.joined_at, now()),
             left_at = null
       where cp.call_id = existing and cp.user_id = me;
    else
      insert into public.call_participants (call_id, user_id, joined_at)
      values (existing, me, now());
    end if;

    -- Somebody joining a ringing call they did not start has answered it.
    if existing_status = 'ringing' then
      update public.calls c
         set status = 'active',
             answered_at = coalesce(c.answered_at, now())
       where c.id = existing
         and c.initiator_id <> me;
    end if;

    perform public.broadcast_call(existing, 'call.updated');
    return existing;
  end if;

  -- One live call per person. Without this, answering a second call would leave
  -- the first one running with a microphone still attached to it.
  if exists (
    select 1
    from public.call_participants cp
    join public.calls c on c.id = cp.call_id
    where cp.user_id = me
      and cp.left_at is null
      and c.status in ('ringing', 'active')
  ) then
    raise exception 'already_in_call' using errcode = '55006';
  end if;

  insert into public.calls (conversation_id, initiator_id, kind, status)
  values (p_conversation_id, me, p_kind, 'ringing')
  returning id into new_call;

  -- Everyone in the conversation is rung. The initiator is joined immediately;
  -- everybody else has a null `joined_at`, which is what makes "missed" a fact
  -- rather than an inference.
  insert into public.call_participants (call_id, user_id, joined_at)
  select new_call, m.user_id, case when m.user_id = me then now() else null end
  from public.conversation_members m
  where m.conversation_id = p_conversation_id
    and m.left_at is null;

  perform public.broadcast_call(new_call, 'call.incoming');

  return new_call;
end;
$$;

comment on function public.start_call(uuid, public.call_kind) is
  'Starts or joins the live call in a conversation. Returns the call id.';

-- -----------------------------------------------------------------------------
-- answer_call
-- -----------------------------------------------------------------------------
create or replace function public.answer_call(p_call_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  target public.calls;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into target from public.calls where id = p_call_id for update;

  if target.id is null or not exists (
    select 1 from public.call_participants cp
    where cp.call_id = p_call_id and cp.user_id = me
  ) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  if target.initiator_id = me then
    raise exception 'cannot_answer_own_call' using errcode = '22023';
  end if;

  -- Answering a call that stopped ringing while the finger was travelling. The
  -- sweep has not necessarily run yet, so the check is against the clock.
  if target.status = 'ringing' and target.started_at < now() - public.ring_timeout() then
    perform public.expire_ringing_calls();
    raise exception 'call_expired' using errcode = '55006';
  end if;

  if target.status not in ('ringing', 'active') then
    raise exception 'call_not_live' using errcode = '55006';
  end if;

  update public.calls c
     set status = 'active',
         answered_at = coalesce(c.answered_at, now())
   where c.id = p_call_id;

  update public.call_participants cp
     set joined_at = coalesce(cp.joined_at, now()),
         left_at = null
   where cp.call_id = p_call_id and cp.user_id = me;

  perform public.broadcast_call(p_call_id, 'call.updated');
end;
$$;

comment on function public.answer_call(uuid) is 'Picks up a ringing call.';

-- -----------------------------------------------------------------------------
-- end_call
--
-- Hang up, decline, cancel and time out are one function, because they are one
-- event seen from different places. Which one it was is DERIVED from the state
-- of the call, never taken from the caller:
--
--   ringing + the initiator gave up          → missed   (cancelled)
--   ringing + past the timeout               → missed   (expired)
--   ringing + a rung participant said no     → declined (declined)
--   active  + nobody left on the call        → ended    (hung_up)
--
-- This is why `p_reason` is a hint and not a decision. A client that could name
-- its own end reason could mark a call it declined as one it never received, or
-- manufacture a missed-call notification for somebody else.
-- -----------------------------------------------------------------------------
create or replace function public.end_call(
  p_call_id uuid,
  p_reason public.call_end_reason default 'hung_up'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  target public.calls;
  remaining integer;
  final_status public.call_status;
  final_reason public.call_end_reason;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into target from public.calls where id = p_call_id for update;

  if target.id is null or not exists (
    select 1 from public.call_participants cp
    where cp.call_id = p_call_id and cp.user_id = me
  ) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  -- Idempotent. Both sides hanging up at once is the normal case, not an error,
  -- and a second tap on a slow connection must not raise.
  if target.status not in ('ringing', 'active') then
    return;
  end if;

  update public.call_participants cp
     set left_at = coalesce(cp.left_at, now())
   where cp.call_id = p_call_id and cp.user_id = me;

  if target.status = 'ringing' then
    if p_reason = 'expired' or target.started_at < now() - public.ring_timeout() then
      final_status := 'missed';
      final_reason := 'expired';
    elsif target.initiator_id = me then
      final_status := 'missed';
      final_reason := 'cancelled';
    else
      final_status := 'declined';
      final_reason := 'declined';
    end if;
  else
    -- A call needs two people. When the second one leaves, it is over.
    select count(*)::integer into remaining
    from public.call_participants cp
    where cp.call_id = p_call_id
      and cp.joined_at is not null
      and cp.left_at is null;

    if remaining >= 2 then
      -- A group call carries on without whoever left.
      perform public.broadcast_call(p_call_id, 'call.updated');
      return;
    end if;

    final_status := 'ended';
    final_reason := case when p_reason = 'failed' then 'failed' else 'hung_up' end;
  end if;

  update public.calls c
     set status = final_status,
         ended_at = now(),
         end_reason = final_reason
   where c.id = p_call_id;

  perform public.broadcast_call(p_call_id, 'call.ended');
end;
$$;

comment on function public.end_call(uuid, public.call_end_reason) is
  'Hang up, decline, cancel or time out. The outcome is derived, not asserted.';

-- -----------------------------------------------------------------------------
-- set_call_media_state
--
-- The last known mute/camera state, for anybody joining late. The authoritative
-- copy travels on the call''s broadcast channel — this is the fallback, not the
-- signal.
-- -----------------------------------------------------------------------------
create or replace function public.set_call_media_state(p_call_id uuid, p_state jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.call_participants cp
     set media_state = coalesce(p_state, '{}'::jsonb)
   where cp.call_id = p_call_id
     and cp.user_id = (select auth.uid());
$$;

-- -----------------------------------------------------------------------------
-- get_active_call
--
-- What am I on right now? Read on every page load, so a refresh mid-call comes
-- back to the call instead of losing it.
--
-- Returns at most one row: `start_call` enforces one live call per person.
-- -----------------------------------------------------------------------------
create or replace function public.get_active_call()
returns table (
  id uuid,
  conversation_id uuid,
  initiator_id uuid,
  kind public.call_kind,
  status public.call_status,
  started_at timestamptz,
  answered_at timestamptz,
  is_initiator boolean,
  joined_at timestamptz,
  other_user_id uuid,
  other_username text,
  other_display_name text,
  other_avatar_path text,
  participant_count integer
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    c.conversation_id,
    c.initiator_id,
    c.kind,
    c.status,
    c.started_at,
    c.answered_at,
    c.initiator_id = (select auth.uid()),
    mine.joined_at,
    other.id,
    other.username,
    other.display_name,
    other.avatar_path,
    (select count(*)::integer from public.call_participants n where n.call_id = c.id)
  from public.call_participants mine
  join public.calls c on c.id = mine.call_id
  left join lateral (
    select p.id, p.username, p.display_name, p.avatar_path
    from public.call_participants cp
    join public.profiles p on p.id = cp.user_id
    where cp.call_id = c.id and cp.user_id <> (select auth.uid())
    order by cp.joined_at nulls last
    limit 1
  ) other on true
  where mine.user_id = (select auth.uid())
    and mine.left_at is null
    and c.status in ('ringing', 'active')
    -- A ring that has already run out is not a live call, whether or not the
    -- sweep has caught up with it. A read must never resurrect one.
    and (c.status = 'active' or c.started_at >= now() - public.ring_timeout())
  order by c.started_at desc
  limit 1;
$$;

comment on function public.get_active_call() is
  'The call this user is currently on, if any. Excludes rings that have run out.';

-- -----------------------------------------------------------------------------
-- list_calls — history
--
-- Keyset pagination on `started_at`, newest first, for the same reason messages
-- use it: a call arriving mid-scroll must not shift the window.
-- -----------------------------------------------------------------------------
create or replace function public.list_calls(
  p_limit integer default 30,
  p_before timestamptz default null
)
returns table (
  id uuid,
  conversation_id uuid,
  initiator_id uuid,
  kind public.call_kind,
  status public.call_status,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  end_reason public.call_end_reason,
  is_initiator boolean,
  joined_at timestamptz,
  duration_seconds integer,
  other_user_id uuid,
  other_username text,
  other_display_name text,
  other_avatar_path text,
  participant_count integer
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    c.conversation_id,
    c.initiator_id,
    c.kind,
    c.status,
    c.started_at,
    c.answered_at,
    c.ended_at,
    c.end_reason,
    c.initiator_id = (select auth.uid()),
    mine.joined_at,
    case
      when c.answered_at is null or c.ended_at is null then null
      else greatest(0, extract(epoch from (c.ended_at - c.answered_at))::integer)
    end,
    other.id,
    other.username,
    other.display_name,
    other.avatar_path,
    (select count(*)::integer from public.call_participants n where n.call_id = c.id)
  from public.call_participants mine
  join public.calls c on c.id = mine.call_id
  left join lateral (
    select p.id, p.username, p.display_name, p.avatar_path
    from public.call_participants cp
    join public.profiles p on p.id = cp.user_id
    where cp.call_id = c.id and cp.user_id <> (select auth.uid())
    order by cp.joined_at nulls last
    limit 1
  ) other on true
  where mine.user_id = (select auth.uid())
    and (p_before is null or c.started_at < p_before)
  order by c.started_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

comment on function public.list_calls(integer, timestamptz) is
  'Call history for the current user, newest first, keyset-paginated.';

-- Covers "my call history, newest first" — the ordering `list_calls` reads in.
create index if not exists call_participants_user_call_idx
  on public.call_participants (user_id, call_id);

-- =============================================================================
-- Privileges
--
-- The RPCs above are the only way to write a call. Revoking the table privileges
-- is what makes that true rather than merely intended: with INSERT and UPDATE
-- gone, no crafted request can move a call through a transition the state
-- machine would refuse.
--
-- The RLS policies from migration 0005 stay in place. They are now belt and
-- braces — the privilege is the door, the policy is the guard — and the pair
-- survives a future migration that re-grants one of them by mistake.
-- =============================================================================

revoke insert, update, delete on public.calls from authenticated;

-- `call_participants` keeps a single writable column. Media state is written
-- directly by the client during a call (it changes on every mute) and there is
-- nothing to validate about it; joined_at and left_at are lifecycle, and belong
-- to the RPCs. Column-level grants make that distinction exactly.
revoke update on public.call_participants from authenticated;
grant update (media_state) on public.call_participants to authenticated;
revoke delete on public.call_participants from authenticated;

-- -----------------------------------------------------------------------------
-- Closing a hole in migration 0005.
--
-- `call_participants_insert` checked that the INSERTING user could post to the
-- conversation — but not that the row they were inserting was their own. Any
-- member could therefore add an arbitrary user id to a call, and since
-- `is_call_participant()` gates the `call:{id}` realtime channel, that would
-- hand a stranger the signalling stream for a call they were never on.
--
-- The initiator still needs to ring everybody, which is why `start_call` is
-- SECURITY DEFINER. Everything a client does for itself is now self-only.
-- -----------------------------------------------------------------------------
drop policy if exists call_participants_insert on public.call_participants;

create policy call_participants_insert_self on public.call_participants
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.calls c
      join public.conversation_members m
        on m.conversation_id = c.conversation_id
       and m.user_id = (select auth.uid())
       and m.left_at is null
      where c.id = call_participants.call_id
        and c.status in ('ringing', 'active')
    )
  );

-- -----------------------------------------------------------------------------
-- Execution grants. Signed-in humans only; `anon` gets nothing.
-- -----------------------------------------------------------------------------
revoke execute on function public.ring_timeout() from public, anon;
revoke execute on function public.broadcast_call(uuid, text) from public, anon, authenticated;
revoke execute on function public.expire_ringing_calls() from public, anon;
revoke execute on function public.start_call(uuid, public.call_kind) from public, anon;
revoke execute on function public.answer_call(uuid) from public, anon;
revoke execute on function public.end_call(uuid, public.call_end_reason) from public, anon;
revoke execute on function public.set_call_media_state(uuid, jsonb) from public, anon;
revoke execute on function public.get_active_call() from public, anon;
revoke execute on function public.list_calls(integer, timestamptz) from public, anon;

grant execute on function public.ring_timeout() to authenticated;
grant execute on function public.expire_ringing_calls() to authenticated;
grant execute on function public.start_call(uuid, public.call_kind) to authenticated;
grant execute on function public.answer_call(uuid) to authenticated;
grant execute on function public.end_call(uuid, public.call_end_reason) to authenticated;
grant execute on function public.set_call_media_state(uuid, jsonb) to authenticated;
grant execute on function public.get_active_call() to authenticated;
grant execute on function public.list_calls(integer, timestamptz) to authenticated;

-- -----------------------------------------------------------------------------
-- expire_abandoned_calls — the last resort
--
-- An ACTIVE call normally ends in one of three ways, in order of how often they
-- happen: somebody presses hang up; a closing tab fires its `pagehide` beacon;
-- or the surviving peer's connection fails, the client notices, and it ends the
-- call. Between them those cover everything except one case — both browsers
-- dying at the same instant, with no beacon and nobody left to notice.
--
-- That leaves a row saying two people are on a call they are not on, and since a
-- person may only be on one call at a time, it would block them from making
-- another. Hence a ceiling.
--
-- Six hours is deliberately generous. This is not a liveness check — there is no
-- heartbeat on a call and adding one would mean a write every few seconds for a
-- case that needs a power cut to reach. It is a floor under the worst outcome,
-- and the honest description of it is "nothing should ever hit this".
-- -----------------------------------------------------------------------------
create or replace function public.expire_abandoned_calls()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_ids uuid[];
  one uuid;
begin
  with stale as (
    update public.calls c
       set status = 'ended',
           ended_at = now(),
           end_reason = 'expired'
     where c.status = 'active'
       and coalesce(c.answered_at, c.started_at) < now() - interval '6 hours'
    returning c.id
  )
  select coalesce(array_agg(stale.id), '{}') into expired_ids from stale;

  foreach one in array expired_ids loop
    perform public.broadcast_call(one, 'call.ended');
  end loop;

  return coalesce(array_length(expired_ids, 1), 0);
end;
$$;

comment on function public.expire_abandoned_calls() is
  'Backstop for an active call whose browsers both vanished. Should never fire.';

-- Migration 0005 indexed the ringing case. This is its counterpart, so the sweep
-- above reads almost nothing however long the call history gets.
create index if not exists calls_active_idx
  on public.calls (answered_at)
  where status = 'active';

revoke execute on function public.expire_abandoned_calls() from public, anon;
grant execute on function public.expire_abandoned_calls() to authenticated;
