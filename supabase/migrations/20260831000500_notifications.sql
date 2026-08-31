-- =============================================================================
-- KITH — 0015 · Notifications
--
-- The table, its policies and the two friend triggers already exist (0008).
-- This adds the remaining kinds, the realtime fan-out, and the read operations.
--
-- Three things shape the design.
--
-- 1. NOTIFICATIONS ARE RAISED BY TRIGGERS, NEVER BY CLIENTS.
--    `notifications` has no INSERT policy at all, which is why. Without that
--    rule any account could write into any other account's feed — a spam and
--    phishing channel delivered by the product itself. Every insert below runs
--    inside a SECURITY DEFINER trigger, so the actor is whoever the database
--    saw, not whoever the request claimed to be.
--
-- 2. MESSAGE NOTIFICATIONS COLLAPSE PER CONVERSATION.
--    One notification per message means a forty-message evening produces forty
--    rows and a badge reading 40 for one conversation. A new one is only created
--    when there is no UNREAD one for that conversation already, so the badge
--    counts conversations that want you, which is the number a person can act on.
--
-- 3. READING THE CONVERSATION CLEARS ITS NOTIFICATION.
--    Otherwise the bell stays lit after you have read the messages, and a badge
--    that lies once is a badge nobody looks at again.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Realtime fan-out
--
-- Onto `user:{id}`, the personal bus. That channel is read-only from the client
-- (migration 0009) — things are delivered TO you there and nobody broadcasts
-- into it from a browser.
-- -----------------------------------------------------------------------------

create or replace function public.broadcast_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id', new.id,
      'kind', new.kind,
      'actor_id', new.actor_id,
      'payload', new.payload,
      'created_at', new.created_at
    ),
    'notification.new',
    'user:' || new.user_id::text,
    true
  );

  return null;
end;
$$;

create trigger notifications_broadcast
  after insert on public.notifications
  for each row execute function public.broadcast_notification();

-- -----------------------------------------------------------------------------
-- New message
--
-- Skips the sender, skips anybody who has left, skips muted conversations, and
-- collapses onto an existing unread notification for the same conversation.
-- -----------------------------------------------------------------------------

create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (user_id, kind, actor_id, payload)
  select
    m.user_id,
    'message',
    new.sender_id,
    jsonb_build_object(
      'conversation_id', new.conversation_id,
      'message_id', new.id
    )
  from public.conversation_members m
  where m.conversation_id = new.conversation_id
    and m.user_id <> new.sender_id
    and m.left_at is null
    and (m.muted_until is null or m.muted_until < now())
    and not exists (
      select 1
      from public.notifications n
      where n.user_id = m.user_id
        and n.kind = 'message'
        and n.read_at is null
        and n.payload ->> 'conversation_id' = new.conversation_id::text
    );

  return null;
end;
$$;

create trigger messages_notify
  after insert on public.messages
  for each row execute function public.notify_new_message();

-- Supports the collapse check above without scanning a person's whole history.
create index notifications_unread_conversation_idx
  on public.notifications (user_id, kind, (payload ->> 'conversation_id'))
  where read_at is null;

-- -----------------------------------------------------------------------------
-- Missed call
--
-- Fires when a call ends without being answered — whether the callee declined,
-- or the scheduled sweep expired a ring nobody picked up.
-- -----------------------------------------------------------------------------

create or replace function public.notify_missed_call()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'missed' or old.status = 'missed' then
    return null;
  end if;

  insert into public.notifications (user_id, kind, actor_id, payload)
  select
    p.user_id,
    'call_missed',
    new.initiator_id,
    jsonb_build_object(
      'call_id', new.id,
      'conversation_id', new.conversation_id,
      'kind', new.kind
    )
  from public.call_participants p
  where p.call_id = new.id
    and p.user_id <> new.initiator_id
    -- Somebody who answered did not miss it.
    and p.joined_at is null;

  return null;
end;
$$;

create trigger calls_notify_missed
  after update on public.calls
  for each row execute function public.notify_missed_call();

-- -----------------------------------------------------------------------------
-- Game invitation
--
-- A game started in a conversation is an invitation to everybody in it. There is
-- no separate invite table because there is no separate concept: the session IS
-- the invitation, and a parallel table would need its own lifecycle, its own
-- policies, and its own way of going stale.
-- -----------------------------------------------------------------------------

create or replace function public.notify_game_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.conversation_id is not null then
    insert into public.notifications (user_id, kind, actor_id, payload)
    select
      m.user_id,
      'game_invite',
      new.host_id,
      jsonb_build_object('session_id', new.id, 'game_key', new.game_key)
    from public.conversation_members m
    where m.conversation_id = new.conversation_id
      and m.user_id <> new.host_id
      and m.left_at is null;

  elsif new.couple_id is not null then
    insert into public.notifications (user_id, kind, actor_id, payload)
    select
      partner,
      'game_invite',
      new.host_id,
      jsonb_build_object('session_id', new.id, 'game_key', new.game_key)
    from (
      select case when c.user_low = new.host_id then c.user_high else c.user_low end as partner
      from public.couples c
      where c.id = new.couple_id
    ) p
    where partner <> new.host_id;
  end if;

  return null;
end;
$$;

create trigger game_sessions_notify
  after insert on public.game_sessions
  for each row execute function public.notify_game_invite();

-- -----------------------------------------------------------------------------
-- Couple proposal
-- -----------------------------------------------------------------------------

create or replace function public.notify_couple_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient uuid;
begin
  if new.status <> 'pending' then
    return null;
  end if;

  recipient := case
    when new.user_low = new.proposed_by then new.user_high
    else new.user_low
  end;

  insert into public.notifications (user_id, kind, actor_id, payload)
  values (recipient, 'couple_request', new.proposed_by, jsonb_build_object('couple_id', new.id));

  return null;
end;
$$;

create trigger couples_notify_request
  after insert on public.couples
  for each row execute function public.notify_couple_request();

-- Accepting a proposal tells the person who made it.
create or replace function public.notify_couple_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' and old.status = 'pending' then
    insert into public.notifications (user_id, kind, actor_id, payload)
    values (
      new.proposed_by,
      'couple_request',
      case when new.user_low = new.proposed_by then new.user_high else new.user_low end,
      jsonb_build_object('couple_id', new.id, 'accepted', true)
    );
  end if;

  return null;
end;
$$;

create trigger couples_notify_accepted
  after update on public.couples
  for each row execute function public.notify_couple_accepted();

-- =============================================================================
-- Reading
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reading a conversation clears its notification.
--
-- Replaces the 0014 version. Two facts that were always the same fact —
-- "I have read this conversation" and "this conversation no longer wants me" —
-- now move together, in one transaction, so the badge cannot outlive the reason
-- for it.
-- -----------------------------------------------------------------------------

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.conversation_members
     set last_read_at = now()
   where conversation_id = p_conversation_id
     and user_id = (select auth.uid())
     and last_read_at < now();

  update public.notifications
     set read_at = now()
   where user_id = (select auth.uid())
     and kind = 'message'
     and read_at is null
     and payload ->> 'conversation_id' = p_conversation_id::text;
end;
$$;

revoke execute on function public.mark_conversation_read(uuid) from public, anon;
grant execute on function public.mark_conversation_read(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- mark_notifications_read
--
-- Null marks everything. Both paths go through `notifications_update_own`
-- because this is SECURITY INVOKER — passing somebody else's notification id
-- matches no rows rather than marking it.
-- -----------------------------------------------------------------------------

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.notifications
     set read_at = now()
   where user_id = (select auth.uid())
     and read_at is null
     and (p_ids is null or id = any (p_ids));

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- list_notifications
--
-- The actor's profile comes back joined, so a panel of twenty notifications is
-- one query rather than twenty-one. SECURITY INVOKER: `notifications_select_own`
-- is what limits this to your own feed.
-- -----------------------------------------------------------------------------

create or replace function public.list_notifications(p_limit integer default 30)
returns table (
  id uuid,
  kind public.notification_kind,
  payload jsonb,
  read_at timestamptz,
  created_at timestamptz,
  actor_id uuid,
  actor_username text,
  actor_display_name text,
  actor_avatar_path text
)
language sql
stable
set search_path = ''
as $$
  select
    n.id,
    n.kind,
    n.payload,
    n.read_at,
    n.created_at,
    n.actor_id,
    p.username,
    p.display_name,
    p.avatar_path
  from public.notifications n
  left join public.profiles p on p.id = n.actor_id
  where n.user_id = (select auth.uid())
  order by n.created_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

revoke execute on function public.list_notifications(integer) from public, anon;
grant execute on function public.list_notifications(integer) to authenticated;

-- -----------------------------------------------------------------------------
-- prune_notifications
--
-- For a scheduled job. Read notifications older than thirty days answer no
-- question anybody is going to ask, and an unbounded table is a slow one
-- eventually. Unread rows are never pruned however old — an unanswered friend
-- request from six weeks ago is still unanswered.
-- -----------------------------------------------------------------------------

create or replace function public.prune_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.notifications
   where read_at is not null
     and read_at < now() - interval '30 days';

  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke execute on function public.prune_notifications() from public, anon, authenticated;
