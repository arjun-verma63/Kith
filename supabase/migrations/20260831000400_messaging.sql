-- =============================================================================
-- KITH — 0014 · Messaging
--
-- The tables and their policies already exist (0004). This adds the read side,
-- group creation, and the realtime fan-out.
--
-- Two decisions worth reading first.
--
-- 1. PAGINATION IS KEYSET, NOT OFFSET.
--    `offset 40 limit 20` makes the database walk and discard 40 rows on every
--    page, and — worse for a chat — a message arriving mid-scroll shifts every
--    subsequent page by one, so the reader sees a duplicate or a gap. Keyset
--    pagination asks for "older than this exact message", which is stable under
--    concurrent inserts and is a single index seek however deep you scroll.
--
-- 2. REALTIME IS BROADCAST FROM A TRIGGER, NOT POSTGRES CHANGES.
--    Postgres Changes re-evaluates RLS per subscriber per row. A trigger calling
--    `realtime.send` is one fan-out, and it lets us shape the payload — so a
--    soft-deleted message broadcasts the deletion without re-broadcasting the
--    text that was just deleted. Authorization happens at SUBSCRIBE time,
--    through the `conv:{id}` policy on `realtime.messages` written in 0009.
-- =============================================================================

-- Keyset pagination needs the tiebreaker in the index, or two messages written
-- in the same millisecond can be returned twice or skipped.
drop index if exists public.messages_conversation_created_idx;
create index messages_conversation_keyset_idx
  on public.messages (conversation_id, created_at desc, id desc);

-- -----------------------------------------------------------------------------
-- who_can_message
--
-- `user_settings.who_can_message` has existed since 0002 and nothing has read it
-- until now. It is enforced at the point a conversation is OPENED rather than on
-- every message: once two people are in a conversation, membership governs, and
-- re-checking a preference on every send would let somebody silence an existing
-- thread by flipping a setting.
-- -----------------------------------------------------------------------------

create or replace function public.can_open_conversation_with(other_user uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    not public.is_blocked_either(other_user)
    and coalesce(
      (
        select case s.who_can_message
                 when 'everyone' then true
                 when 'friends' then public.are_friends(other_user)
                 else false
               end
        from public.user_settings s
        where s.user_id = other_user
      ),
      false
    );
$$;

comment on function public.can_open_conversation_with(uuid) is
  'Honours the recipient''s who_can_message setting. Checked when a conversation is opened, not on every send.';

-- Replaces the 0004 version, which did not consult who_can_message.
create or replace function public.start_dm(other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  low uuid;
  high uuid;
  key text;
  conversation uuid;
begin
  if me is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;

  if other_user = me then
    raise exception 'Cannot open a conversation with yourself.' using errcode = '22023';
  end if;

  low  := least(me, other_user);
  high := greatest(me, other_user);
  key  := low::text || ':' || high::text;

  -- An EXISTING conversation is returned regardless of the current setting.
  -- Somebody who later restricts messages to friends should not have their open
  -- threads disappear; the setting governs who may start one.
  select c.id into conversation from public.conversations c where c.dm_key = key;
  if conversation is not null then
    return conversation;
  end if;

  if not public.can_open_conversation_with(other_user) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  insert into public.conversations (kind, created_by, dm_key)
  values ('dm', me, key)
  on conflict (dm_key) do nothing
  returning id into conversation;

  if conversation is null then
    select c.id into conversation from public.conversations c where c.dm_key = key;
    return conversation;
  end if;

  insert into public.conversation_members (conversation_id, user_id)
  values (conversation, me), (conversation, other_user);

  return conversation;
end;
$$;

-- -----------------------------------------------------------------------------
-- start_group
--
-- Same shape as start_dm and for the same reason: a conversation with no members
-- is a garbage row, and a client that creates one and then fails before adding
-- them leaves exactly that.
-- -----------------------------------------------------------------------------

create or replace function public.start_group(p_title text, p_member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  conversation uuid;
  member uuid;
  clean_title text;
begin
  if me is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;

  clean_title := btrim(coalesce(p_title, ''));
  if length(clean_title) = 0 or length(clean_title) > 60 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;

  -- A "group" of one is a DM with extra steps, and a group of zero is a bug.
  if p_member_ids is null or array_length(p_member_ids, 1) is null then
    raise exception 'no_members' using errcode = '22023';
  end if;

  if array_length(p_member_ids, 1) > 20 then
    raise exception 'too_many_members' using errcode = '22023';
  end if;

  -- Every invitee is checked BEFORE anything is written, so a group is never
  -- half-created with the acceptable half of the list.
  foreach member in array p_member_ids loop
    if member <> me and not public.can_open_conversation_with(member) then
      raise exception 'not_permitted' using errcode = '42501';
    end if;
  end loop;

  insert into public.conversations (kind, title, created_by)
  values ('group', clean_title, me)
  returning id into conversation;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (conversation, me, 'owner');

  insert into public.conversation_members (conversation_id, user_id)
  select conversation, m
  from unnest(p_member_ids) as m
  where m <> me
  on conflict do nothing;

  return conversation;
end;
$$;

revoke execute on function public.start_group(text, uuid[]) from public, anon;
grant execute on function public.start_group(text, uuid[]) to authenticated;
revoke execute on function public.can_open_conversation_with(uuid) from public, anon;
grant execute on function public.can_open_conversation_with(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- list_conversations
--
-- One row per conversation with everything the list needs: the other person for
-- a DM, the title and headcount for a group, a preview of the last message, and
-- the unread count.
--
-- SECURITY INVOKER, so `conversations_select_member` still does the filtering
-- and the function adds no authority of its own.
-- -----------------------------------------------------------------------------

create or replace function public.list_conversations()
returns table (
  conversation_id uuid,
  kind public.conversation_kind,
  title text,
  last_message_at timestamptz,
  last_message_body text,
  last_message_sender_id uuid,
  last_message_kind public.message_kind,
  unread_count integer,
  member_count integer,
  other_user_id uuid,
  other_username text,
  other_display_name text,
  other_avatar_path text,
  other_status public.presence_status,
  other_last_seen_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  with me as (select auth.uid() as uid),
  mine as (
    select m.conversation_id, m.last_read_at
    from public.conversation_members m
    where m.user_id = (select uid from me) and m.left_at is null
  )
  select
    c.id,
    c.kind,
    c.title,
    c.last_message_at,
    -- The preview never shows the text of a deleted message.
    case when last.deleted_at is null then last.body else null end,
    last.sender_id,
    last.kind,
    (
      select count(*)::integer
      from public.messages um
      where um.conversation_id = c.id
        and um.created_at > mine.last_read_at
        and um.sender_id <> (select uid from me)
        and um.deleted_at is null
    ),
    (
      select count(*)::integer
      from public.conversation_members cm
      where cm.conversation_id = c.id and cm.left_at is null
    ),
    other.id,
    other.username,
    other.display_name,
    other.avatar_path,
    other.status,
    case when other.status = 'invisible' then null else other.last_seen_at end
  from mine
  join public.conversations c on c.id = mine.conversation_id
  left join lateral (
    select m.body, m.sender_id, m.kind, m.deleted_at
    from public.messages m
    where m.conversation_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) last on true
  -- For a DM, the other member. Null for a group.
  left join lateral (
    select p.id, p.username, p.display_name, p.avatar_path, p.status, p.last_seen_at
    from public.conversation_members cm
    join public.profiles p on p.id = cm.user_id
    where cm.conversation_id = c.id
      and cm.user_id <> (select uid from me)
      and c.kind = 'dm'
    limit 1
  ) other on true
  order by c.last_message_at desc nulls last, c.created_at desc;
$$;

revoke execute on function public.list_conversations() from public, anon;
grant execute on function public.list_conversations() to authenticated;

-- -----------------------------------------------------------------------------
-- list_messages — keyset pagination
--
-- Returns a page of messages OLDER than the given cursor, newest first. Passing
-- nulls returns the newest page. Because the cursor is a specific message rather
-- than a row offset, a message arriving while somebody scrolls cannot shift the
-- window and produce a duplicate or a gap.
--
-- Reactions come back aggregated, so a page of 30 messages is one query rather
-- than 31.
-- -----------------------------------------------------------------------------

create or replace function public.list_messages(
  p_conversation_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns table (
  id uuid,
  conversation_id uuid,
  sender_id uuid,
  kind public.message_kind,
  body text,
  reply_to_id uuid,
  created_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz,
  sender_username text,
  sender_display_name text,
  sender_avatar_path text,
  reactions jsonb
)
language sql
stable
set search_path = ''
as $$
  select
    m.id,
    m.conversation_id,
    m.sender_id,
    m.kind,
    -- A deleted message keeps its place in the thread but not its text. Sending
    -- the body and hiding it in the client would mean it was still delivered.
    case when m.deleted_at is null then m.body else null end,
    m.reply_to_id,
    m.created_at,
    m.edited_at,
    m.deleted_at,
    p.username,
    p.display_name,
    p.avatar_path,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object('emoji', r.emoji, 'user_ids', r.user_ids))
        from (
          select mr.emoji, jsonb_agg(mr.user_id) as user_ids
          from public.message_reactions mr
          where mr.message_id = m.id
          group by mr.emoji
          order by mr.emoji
        ) r
      ),
      '[]'::jsonb
    )
  from public.messages m
  left join public.profiles p on p.id = m.sender_id
  where m.conversation_id = p_conversation_id
    and (
      p_before_created_at is null
      or (m.created_at, m.id) < (p_before_created_at, p_before_id)
    )
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

revoke execute on function public.list_messages(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_messages(uuid, timestamptz, uuid, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- mark_conversation_read
--
-- Moves the read cursor forward only. A client that reports an older timestamp —
-- a stale tab, a request that arrived out of order — cannot resurrect messages
-- somebody has already read.
-- -----------------------------------------------------------------------------

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.conversation_members
     set last_read_at = now()
   where conversation_id = p_conversation_id
     and user_id = (select auth.uid())
     and last_read_at < now();
$$;

revoke execute on function public.mark_conversation_read(uuid) from public, anon;
grant execute on function public.mark_conversation_read(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- toggle_reaction
--
-- Insert or delete, decided by the database. Doing this as a client-side
-- read-then-write means two people double-tapping the same emoji at once can
-- both read "absent" and both insert — one gets a unique violation and a broken
-- button for no reason they can see.
-- -----------------------------------------------------------------------------

create or replace function public.toggle_reaction(p_message_id uuid, p_emoji text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  removed integer;
begin
  if me is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;

  delete from public.message_reactions
   where message_id = p_message_id and user_id = me and emoji = p_emoji;

  get diagnostics removed = row_count;
  if removed > 0 then
    return false;
  end if;

  -- RLS on message_reactions decides whether this is allowed. SECURITY INVOKER,
  -- so a non-member inserting here is refused exactly as it would be directly.
  insert into public.message_reactions (message_id, user_id, emoji)
  values (p_message_id, me, p_emoji);

  return true;
end;
$$;

revoke execute on function public.toggle_reaction(uuid, text) from public, anon;
grant execute on function public.toggle_reaction(uuid, text) to authenticated;

-- =============================================================================
-- Realtime fan-out
--
-- One broadcast per change, onto the conversation's private channel. Everyone
-- subscribed is already a member — the `conv:{id}` policy on `realtime.messages`
-- (migration 0009) is what enforces that, at subscribe time.
--
-- The payload is built by hand rather than dumping the row, for two reasons: a
-- deletion must not re-broadcast the text it just removed, and a client should
-- not receive columns it has no use for.
-- =============================================================================

create or replace function public.broadcast_message_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_name text;
begin
  event_name := case
    when tg_op = 'INSERT' then 'message.new'
    when new.deleted_at is not null and old.deleted_at is null then 'message.deleted'
    else 'message.edited'
  end;

  perform realtime.send(
    jsonb_build_object(
      'id', new.id,
      'conversation_id', new.conversation_id,
      'sender_id', new.sender_id,
      'kind', new.kind,
      -- Null once deleted. The client renders a tombstone from the flag.
      'body', case when new.deleted_at is null then new.body else null end,
      'reply_to_id', new.reply_to_id,
      'created_at', new.created_at,
      'edited_at', new.edited_at,
      'deleted_at', new.deleted_at
    ),
    event_name,
    'conv:' || new.conversation_id::text,
    true
  );

  return null;
end;
$$;

create trigger messages_broadcast
  after insert or update on public.messages
  for each row execute function public.broadcast_message_change();

create or replace function public.broadcast_reaction_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data record;
  conversation uuid;
begin
  row_data := coalesce(new, old);

  select m.conversation_id into conversation
  from public.messages m
  where m.id = row_data.message_id;

  if conversation is null then
    return null;
  end if;

  perform realtime.send(
    jsonb_build_object(
      'message_id', row_data.message_id,
      'user_id', row_data.user_id,
      'emoji', row_data.emoji,
      'added', tg_op = 'INSERT'
    ),
    'reaction.changed',
    'conv:' || conversation::text,
    true
  );

  return null;
end;
$$;

create trigger message_reactions_broadcast
  after insert or delete on public.message_reactions
  for each row execute function public.broadcast_reaction_change();
