-- =============================================================================
-- KITH — 0009 · Realtime authorization
--
-- Every channel in KITH is private, which means subscribing to one is checked
-- against RLS policies on `realtime.messages` rather than being open to anyone
-- holding the anon key.
--
-- This is the part people miss. Table policies protect rows; they do nothing to
-- stop somebody subscribing to `conv:<uuid>` and receiving every message
-- broadcast into a conversation they are not in. Realtime is a second, parallel
-- read path into the same data, and it needs its own door.
--
-- `realtime.topic()` returns the channel name of the current subscription, so the
-- policies below re-use exactly the same helper functions the table policies use.
-- One definition of "is this person in that conversation", enforced in both
-- places.
--
-- Requires Supabase's `realtime` schema. Applying these migrations to a plain
-- Postgres will stop here, which is correct — a plain Postgres has no realtime to
-- authorize.
-- =============================================================================

-- Safely pulls the uuid out of a `prefix:uuid` topic. Returns null for a topic
-- with the wrong prefix or a malformed id, so a policy comparing against it
-- simply fails to match rather than raising and turning a denied subscription
-- into a 500.
create or replace function public.topic_uuid(topic text, prefix text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if topic is null or topic !~ ('^' || prefix || ':') then
    return null;
  end if;

  return substring(topic from length(prefix) + 2)::uuid;
exception
  when others then
    return null;
end;
$$;

comment on function public.topic_uuid(text, text) is
  'Extracts the uuid from a "prefix:uuid" realtime topic, or null if it does not match.';

-- -----------------------------------------------------------------------------
-- user:{userId} — the personal bus
--
-- Incoming calls, friend requests, notifications, and the private half of game
-- state. Read-only from the client: things are delivered *to* you here, and
-- nobody — including you — broadcasts into it from a browser.
-- -----------------------------------------------------------------------------

create policy realtime_user_channel_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() = 'user:' || (select auth.uid())::text
  );

-- -----------------------------------------------------------------------------
-- presence:lobby — who is around
--
-- One channel for the whole room, because the room is six people. Both directions
-- are open to any member: presence only works if everyone can announce themselves.
-- Blocks are applied when rendering, not here, because a presence channel cannot
-- filter per subscriber.
-- -----------------------------------------------------------------------------

create policy realtime_presence_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() = 'presence:lobby'
  );

create policy realtime_presence_write on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() = 'presence:lobby'
  );

-- -----------------------------------------------------------------------------
-- conv:{conversationId} — messages, typing, read cursors
--
-- Same membership test as the `messages` table. Sending additionally requires
-- `can_post_to_conversation`, so a blocked user cannot reach the room over the
-- socket after being shut out of the table.
-- -----------------------------------------------------------------------------

create policy realtime_conversation_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_conversation_member(public.topic_uuid(realtime.topic(), 'conv'))
  );

create policy realtime_conversation_write on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_post_to_conversation(public.topic_uuid(realtime.topic(), 'conv'))
  );

-- -----------------------------------------------------------------------------
-- call:{callId} — signalling
--
-- SDP offers, ICE candidates, media state, hangup. Restricted to people actually
-- on the call: a conversation member who is not a participant has no business
-- receiving the negotiation for it.
-- -----------------------------------------------------------------------------

create policy realtime_call_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_call_participant(public.topic_uuid(realtime.topic(), 'call'))
  );

create policy realtime_call_write on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_call_participant(public.topic_uuid(realtime.topic(), 'call'))
  );

-- -----------------------------------------------------------------------------
-- game:{sessionId} — public game state
--
-- Anyone who can see the room may watch; only people at the table may send input.
-- Hidden information never travels on this channel — the server sends each
-- player's private view down their own `user:` channel instead.
-- -----------------------------------------------------------------------------

create policy realtime_game_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_view_game_session(public.topic_uuid(realtime.topic(), 'game'))
  );

create policy realtime_game_write on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_game_player(public.topic_uuid(realtime.topic(), 'game'))
  );
