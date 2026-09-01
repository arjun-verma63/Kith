-- =============================================================================
-- KITH — 0025 · Account settings
--
-- What the Security page needs that the database did not already provide:
-- a list of the caller's own sessions, an enforced `who_can_call`, and a way to
-- leave.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 · profiles.deleted_at
--
-- A tombstone rather than a hole. See `anonymise_account` below for why.
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists deleted_at timestamptz;

comment on column public.profiles.deleted_at is
  'Set when the person deleted their account. The row survives so that other people''s messages, calls and games still resolve to a name; everything identifying has been scrubbed.';

create index if not exists profiles_deleted_idx
  on public.profiles (deleted_at)
  where deleted_at is not null;

-- -----------------------------------------------------------------------------
-- 2 · Deleted accounts disappear from search
--
-- The row has to stay reachable by id — five other people have messages pointing
-- at it — but it must never come back from a search box. Replaces the 0013
-- version; the only change is the `deleted_at is null` predicate.
-- -----------------------------------------------------------------------------
create or replace function public.search_profiles(p_query text)
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
  relationship text
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select auth.uid() as uid),
  needle as (select lower(btrim(coalesce(p_query, ''))) as q)
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
    case
      when exists (
        select 1 from public.friendships f
        where f.user_low = least((select uid from me), p.id)
          and f.user_high = greatest((select uid from me), p.id)
      ) then 'friend'
      when exists (
        select 1 from public.friend_requests r
        where r.status = 'pending'
          and r.requester_id = (select uid from me)
          and r.addressee_id = p.id
      ) then 'outgoing'
      when exists (
        select 1 from public.friend_requests r
        where r.status = 'pending'
          and r.addressee_id = (select uid from me)
          and r.requester_id = p.id
      ) then 'incoming'
      else 'none'
    end as relationship
  from public.profiles p
  join public.user_settings s on s.user_id = p.id
  cross join needle
  where (select uid from me) is not null
    and length(needle.q) >= 1
    and p.id <> (select uid from me)
    -- The only change from the 0013 version.
    and p.deleted_at is null
    and not public.is_blocked_either(p.id)
    and (
      s.discoverable
      or exists (
        select 1 from public.friendships f
        where f.user_low = least((select uid from me), p.id)
          and f.user_high = greatest((select uid from me), p.id)
      )
    )
    and (
      lower(p.username) like needle.q || '%'
      or lower(p.display_name) like '%' || needle.q || '%'
    )
  order by
    (lower(p.username) = needle.q) desc,
    (lower(p.username) like needle.q || '%') desc,
    lower(p.display_name)
  limit 20;
$$;

revoke execute on function public.search_profiles(text) from public, anon;
grant execute on function public.search_profiles(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3 · who_can_call, enforced
--
-- The column has existed since migration 0002 and nothing has ever read it — the
-- same state `who_can_message` was in before 0014. A privacy control that
-- controls nothing is worse than no control: it is a promise on a settings page
-- that the database does not keep.
--
-- Only meaningful for a DM, where there is exactly one other person whose
-- preference could be consulted. In a group thread there is no single "them",
-- and a member who does not want to be rung can leave or mute the conversation.
-- -----------------------------------------------------------------------------
create or replace function public.can_call_conversation(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.can_post_to_conversation(p_conversation_id)
    and not exists (
      select 1
      from public.conversations c
      join public.conversation_members m
        on m.conversation_id = c.id
       and m.user_id <> (select auth.uid())
      join public.user_settings s on s.user_id = m.user_id
      where c.id = p_conversation_id
        and c.kind = 'dm'
        and (
          s.who_can_call = 'nobody'
          or (
            s.who_can_call = 'friends'
            and not exists (
              select 1 from public.friendships f
              where f.user_low = least((select auth.uid()), m.user_id)
                and f.user_high = greatest((select auth.uid()), m.user_id)
            )
          )
        )
    );
$$;

comment on function public.can_call_conversation(uuid) is
  'Everything can_post_to_conversation requires, plus the other person''s who_can_call setting. DMs only — a group thread has no single "them".';

revoke execute on function public.can_call_conversation(uuid) from public, anon;
grant execute on function public.can_call_conversation(uuid) to authenticated;

-- Swap the gate into start_call.
--
-- The body below is migration 0016's, unchanged, plus one check. It is copied in
-- full rather than summarised because `create or replace` has no way to patch a
-- function in place: whatever is written here IS the function, and anything left
-- out is silently deleted. This one carries the one-live-call rule and two
-- broadcasts, and losing any of them would look like a bug in calls rather than
-- in a privacy setting.
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

  -- New in 0025. Separate from the membership check above so that "you are not
  -- in this conversation" and "they do not take calls" stay distinguishable —
  -- the first is a bug, the second is somebody's stated preference.
  if not public.can_call_conversation(p_conversation_id) then
    raise exception 'not_callable' using errcode = '42501';
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

revoke execute on function public.start_call(uuid, public.call_kind) from public, anon;
grant execute on function public.start_call(uuid, public.call_kind) to authenticated;

-- -----------------------------------------------------------------------------
-- 4 · list_my_sessions
--
-- Supabase's client library has no "list my sessions" call — `signOut` takes a
-- scope and that is the whole of the supported surface. But GoTrue keeps
-- `auth.sessions`, and being able to see "something signed in from a device I do
-- not recognise" is most of the value of a security page.
--
-- So: READ the table here, WRITE through the supported API. Revoking a session
-- goes through `signOut({ scope: 'others' })` rather than a delete from this
-- schema, which keeps the destructive half on the path Supabase maintains.
--
-- SECURITY DEFINER because `authenticated` has no grant on `auth.sessions` and
-- must not be given one. Filtered to the caller, and the columns are chosen: no
-- token, no refresh token, nothing that could be replayed.
--
-- `to_regclass` guard: this reads a table Supabase owns rather than one this
-- repository created. If a GoTrue upgrade renames or drops it, the page shows an
-- empty list and says so, instead of every query in the app raising.
-- -----------------------------------------------------------------------------
create or replace function public.list_my_sessions()
returns table (
  id uuid,
  created_at timestamptz,
  refreshed_at timestamptz,
  user_agent text,
  ip text,
  aal text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return;
  end if;

  if to_regclass('auth.sessions') is null then
    return;
  end if;

  return query execute $q$
    select
      s.id,
      s.created_at,
      coalesce(s.refreshed_at, s.updated_at, s.created_at) as refreshed_at,
      s.user_agent,
      host(s.ip)::text as ip,
      coalesce(s.aal::text, 'aal1') as aal
    from auth.sessions s
    where s.user_id = $1
      and (s.not_after is null or s.not_after > now())
    order by coalesce(s.refreshed_at, s.updated_at, s.created_at) desc
    limit 20
  $q$ using (select auth.uid());
exception
  -- A column this function names is gone. That is a Supabase upgrade, not a
  -- reason for the security page to 500.
  when undefined_column or undefined_table then
    return;
end;
$$;

comment on function public.list_my_sessions() is
  'The caller''s own live sessions, for the security page. Never returns a token. Reads auth.sessions, which Supabase owns — degrades to an empty list if that table changes.';

revoke execute on function public.list_my_sessions() from public, anon;
grant execute on function public.list_my_sessions() to authenticated;

-- -----------------------------------------------------------------------------
-- 5 · anonymise_account
--
-- ── Why not a hard delete ────────────────────────────────────────────────────
--
-- `profiles.id` cascades from `auth.users`, so deleting the account row would
-- take the profile with it, and the cascade does not stop there. Two of the
-- edges are other people's data:
--
--   game_sessions.host_id  on delete cascade  — every game they hosted, taking
--                                               the other players' history with it
--   couples.user_low/high  on delete cascade  — the couple record, its prompts
--                                               and both partners' answers
--
-- One person leaving a six-person room should not delete five other people's
-- evenings. Messages already knew this — `sender_id` is `on delete set null` —
-- and this is the same instinct applied to the rest.
--
-- ── So: scrub, keep the shell ────────────────────────────────────────────────
--
-- Everything identifying goes. What survives is a row with no name on it, so
-- that a two-year-old conversation still renders instead of collapsing into
-- nulls. The auth account is soft-deleted and banned by the caller afterwards,
-- which is what makes signing in impossible.
--
-- ── Not reachable from a browser ─────────────────────────────────────────────
--
-- Execute is revoked from `authenticated` entirely. This runs through the
-- service role, from a server action that has already checked the password, a
-- TOTP code where one exists, and a typed confirmation. An irreversible RPC that
-- an access token can call on its own is a one-request account wipe.
-- -----------------------------------------------------------------------------
create or replace function public.anonymise_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tombstone text := 'deleted_' || substr(replace(p_user_id::text, '-', ''), 1, 12);
begin
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'no_such_account' using errcode = '22023';
  end if;

  -- Idempotent: a retried deletion must not fail on the second attempt.
  if exists (select 1 from public.profiles p where p.id = p_user_id and p.deleted_at is not null) then
    return;
  end if;

  -- Live calls end rather than ringing an account that no longer exists.
  -- `left_at` is the whole state machine here: null means still in.
  update public.call_participants
     set left_at = now()
   where user_id = p_user_id
     and left_at is null;

  -- A couple is two people. One of them leaving ends it, the same way
  -- `end_couple` does, so the other partner's page does not point at a ghost.
  update public.couples
     set status = 'ended', ended_at = coalesce(ended_at, now())
   where status <> 'ended'
     and (user_low = p_user_id or user_high = p_user_id);

  -- Unfinished games: leave the table rather than freeze it for everyone else.
  update public.game_players
     set left_at = coalesce(left_at, now())
   where user_id = p_user_id
     and left_at is null
     and exists (
       select 1 from public.game_sessions s
       where s.id = game_players.session_id
         and s.status in ('lobby', 'active')
     );

  -- Relationships are mutual and meaningless once one side is gone.
  delete from public.friend_requests
   where requester_id = p_user_id or addressee_id = p_user_id;
  delete from public.friendships
   where user_low = p_user_id or user_high = p_user_id;
  delete from public.blocks
   where blocker_id = p_user_id or blocked_id = p_user_id;

  -- Their own inbox. Notifications ABOUT them keep working: `actor_id` is
  -- `on delete set null` and the tombstone profile is still there to name.
  delete from public.notifications where user_id = p_user_id;

  -- Out of every thread. Messages already sent stay, attributed to the
  -- tombstone, because they are half of somebody else's conversation.
  delete from public.conversation_members where user_id = p_user_id;

  -- Reactions are a signal to other people and carry no history worth keeping.
  delete from public.message_reactions where user_id = p_user_id;

  -- Settings back to the most private position available, so nothing about the
  -- row can be discovered while it waits to be forgotten.
  update public.user_settings
     set discoverable = false,
         who_can_call = 'nobody',
         who_can_message = 'nobody',
         who_can_propose = 'nobody',
         read_receipts = false,
         typing_indicators = false,
         notification_prefs = '{}'::jsonb
   where user_id = p_user_id;

  -- The profile itself. The username is replaced rather than freed: handing
  -- `@ada` to the next person who wants it would make every old message look
  -- like it came from them.
  update public.profiles
     set username = tombstone,
         display_name = 'Deleted account',
         avatar_path = null,
         bio = null,
         pronouns = null,
         status = 'auto',
         status_text = null,
         status_expires_at = null,
         accent = 'ember',
         deleted_at = now()
   where id = p_user_id;
end;
$$;

comment on function public.anonymise_account(uuid) is
  'Scrubs a profile in place and cuts every live relationship. Service role only — the caller is responsible for reauthentication and for disabling the auth account afterwards.';

-- Not callable by a session. See the header.
revoke execute on function public.anonymise_account(uuid) from public, anon, authenticated;
grant execute on function public.anonymise_account(uuid) to service_role;
