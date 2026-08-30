-- =============================================================================
-- KITH — 0004 · Messaging
--
-- conversations, conversation_members, messages, message_reactions.
--
-- This migration contains the recursion trap that RLS is famous for, and the
-- way out of it.
--
-- The natural policies are: you can see a conversation if you are a member of it,
-- and you can see a membership row if you are in that conversation. Written
-- directly, `conversations` policies query `conversation_members`, whose policies
-- query `conversations`, and Postgres raises `infinite recursion detected in
-- policy for relation`. The tempting fix is to disable RLS on one of the two
-- tables, which opens the entire message store to anyone holding the anon key.
--
-- The correct fix is `public.is_conversation_member()` below: a SECURITY DEFINER
-- function that reads the membership table with policies bypassed, returning only
-- a boolean about the caller. It leaks nothing and it terminates.
--
-- Read receipts are `conversation_members.last_read_at`, not a per-message
-- receipt table. One row per member instead of one row per member per message
-- turns the hottest write in a chat app into an occasional timestamp bump. At six
-- users the per-message table would be the largest thing in the database and it
-- would answer no question the cursor cannot.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- conversations
-- -----------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind public.conversation_kind not null default 'dm',
  title text,
  created_by uuid references public.profiles (id) on delete set null,

  -- Deterministic key for direct messages: 'lowuuid:highuuid'. It is what makes
  -- "one DM per pair" a database guarantee instead of a race between two clients
  -- that both check-then-insert. Null for group conversations.
  dm_key text unique,

  -- Denormalised for the conversation list, which sorts by recency on every
  -- render. The alternative is a correlated max(created_at) over messages per
  -- row, which is the query that quietly gets slow first.
  last_message_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint conversations_dm_key_presence check ((kind = 'dm') = (dm_key is not null)),
  constraint conversations_title_length check (title is null or char_length(title) <= 60),
  constraint conversations_group_has_title check (kind <> 'group' or title is not null)
);

create index conversations_recent_idx on public.conversations (last_message_at desc nulls last);

-- Covers the FK. Without it, deleting an account sequentially scans this table
-- to find the rows it has to null out.
create index conversations_created_by_idx
  on public.conversations (created_by)
  where created_by is not null;

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- conversation_members
-- -----------------------------------------------------------------------------

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.member_role not null default 'member',

  joined_at timestamptz not null default now(),
  -- Soft departure. A hard delete would orphan the sender of every message they
  -- wrote and break the "who was in this conversation" question forever.
  left_at timestamptz,

  -- The entire read-receipt model.
  last_read_at timestamptz not null default now(),
  muted_until timestamptz,

  primary key (conversation_id, user_id)
);

-- "My conversations", which is the query behind the whole Messages destination.
create index conversation_members_user_idx
  on public.conversation_members (user_id)
  where left_at is null;

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,

  -- SET NULL rather than CASCADE: deleting an account must not silently remove
  -- half of everyone else's conversation history. The message survives, attributed
  -- to a departed member.
  sender_id uuid references public.profiles (id) on delete set null,

  kind public.message_kind not null default 'text',
  body text,
  reply_to_id uuid references public.messages (id) on delete set null,
  attachments jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  edited_at timestamptz,
  -- Soft delete: replies pointing at this message keep their anchor, and
  -- "this message was deleted" stays renderable in place.
  deleted_at timestamptz,

  constraint messages_text_has_body check (
    deleted_at is not null
    or kind <> 'text'
    or (body is not null and char_length(body) between 1 and 4000)
  ),
  constraint messages_attachments_is_array check (jsonb_typeof(attachments) = 'array')
);

-- The only query that matters: a page of a conversation, newest first.
create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

-- Covers the sender FK, and answers "everything X ever said" for account export.
create index messages_sender_idx
  on public.messages (sender_id)
  where sender_id is not null;

create index messages_reply_to_idx
  on public.messages (reply_to_id)
  where reply_to_id is not null;

-- -----------------------------------------------------------------------------
-- message_reactions
-- -----------------------------------------------------------------------------

create table public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),

  -- One of each emoji per person per message, enforced structurally rather than
  -- by the client remembering to toggle rather than insert.
  primary key (message_id, user_id, emoji),
  constraint message_reactions_emoji_length check (char_length(emoji) between 1 and 16)
);

-- -----------------------------------------------------------------------------
-- Access helpers
-- -----------------------------------------------------------------------------

create or replace function public.is_conversation_member(target_conversation uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_members m
    where m.conversation_id = target_conversation
      and m.user_id = (select auth.uid())
      and m.left_at is null
  );
$$;

comment on function public.is_conversation_member(uuid) is
  'Breaks the conversations <-> conversation_members policy recursion. SECURITY DEFINER, pinned search_path, returns only a boolean about the caller.';

-- Membership alone is not permission to speak. Posting also requires that nobody
-- else in the conversation has blocked you — enforced here so a blocked user
-- cannot reach anyone by crafting a request directly against the API.
create or replace function public.can_post_to_conversation(target_conversation uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    public.is_conversation_member(target_conversation)
    and not exists (
      select 1
      from public.conversation_members m
      join public.blocks b
        on (b.blocker_id = m.user_id and b.blocked_id = (select auth.uid()))
        or (b.blocker_id = (select auth.uid()) and b.blocked_id = m.user_id)
      where m.conversation_id = target_conversation
        and m.user_id <> (select auth.uid())
        and m.left_at is null
    );
$$;

comment on function public.can_post_to_conversation(uuid) is
  'Membership plus the absence of a block in either direction with any other active member.';

-- Who may add a membership row.
--
-- The obvious policy — "you may insert a row where user_id = auth.uid()" — is a
-- hole big enough to walk a stranger through: it lets anybody add THEMSELVES to
-- any conversation whose id they can guess or observe, and from there read every
-- message in it. Membership must be granted by someone already inside, not
-- claimed from outside.
--
--   dm    only the creator, and only while the pair is still being assembled.
--         A direct message cannot grow a third participant, ever.
--   group the creator, or any current member, may bring somebody in.
--
-- And nobody may be pulled across a block in either direction.
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
  select coalesce(
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
        and (
          target_user = (select auth.uid())
          or not public.is_blocked_either(target_user)
        )
      from public.conversations c
      where c.id = target_conversation
    ),
    false
  );
$$;

comment on function public.can_add_conversation_member(uuid, uuid) is
  'Membership is granted from inside the conversation, never claimed from outside.';

-- Keeps the conversation list ordered without a correlated subquery per row.
create or replace function public.touch_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id;

  return new;
end;
$$;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation_on_message();

-- -----------------------------------------------------------------------------
-- start_dm — the supported way to open a direct message
--
-- A conversation with no members is a garbage row, and a client that creates one
-- and then crashes before adding them leaves exactly that. Worse, two people
-- opening a DM with each other at the same moment both check-then-insert and one
-- of them gets a unique violation on `dm_key`.
--
-- So the whole thing is one atomic, idempotent call: it returns the existing
-- conversation if there is one, and otherwise creates the conversation and both
-- memberships in a single transaction. Calling it twice is harmless, which is
-- what makes it safe to retry.
--
-- SECURITY DEFINER because it writes membership rows for somebody other than the
-- caller — which the RLS policy correctly refuses. The authorization it replaces
-- is done explicitly in the first two checks, and it can only ever create a
-- conversation the caller is themselves a member of.
-- -----------------------------------------------------------------------------

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

  if not exists (select 1 from public.profiles p where p.id = other_user) then
    raise exception 'No such user.' using errcode = '23503';
  end if;

  if public.is_blocked_either(other_user) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  low  := least(me, other_user);
  high := greatest(me, other_user);
  key  := low::text || ':' || high::text;

  select c.id into conversation
  from public.conversations c
  where c.dm_key = key;

  if conversation is not null then
    return conversation;
  end if;

  insert into public.conversations (kind, created_by, dm_key)
  values ('dm', me, key)
  on conflict (dm_key) do nothing
  returning id into conversation;

  -- Lost the race with a concurrent caller: take theirs.
  if conversation is null then
    select c.id into conversation from public.conversations c where c.dm_key = key;
    return conversation;
  end if;

  insert into public.conversation_members (conversation_id, user_id)
  values (conversation, me), (conversation, other_user);

  return conversation;
end;
$$;

comment on function public.start_dm(uuid) is
  'Atomically opens (or returns) the single DM between the caller and other_user.';

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;

alter table public.conversations force row level security;
alter table public.conversation_members force row level security;
alter table public.messages force row level security;
alter table public.message_reactions force row level security;

-- --- conversations -----------------------------------------------------------

-- Members can read it — and so can whoever created it, which is not redundant.
-- `INSERT ... RETURNING` applies the SELECT policy to the new row, and a
-- conversation has no members for the instant between being created and having
-- its first membership inserted. Without the second clause, creating a
-- conversation succeeds and then fails to return its own id.
create policy conversations_select_member on public.conversations
  for select to authenticated
  using (
    public.is_conversation_member(id)
    or created_by = (select auth.uid())
  );

create policy conversations_insert_own on public.conversations
  for insert to authenticated
  with check (created_by = (select auth.uid()));

-- Renaming a group. DMs have no title, so there is nothing to change.
create policy conversations_update_member on public.conversations
  for update to authenticated
  using (public.is_conversation_member(id) and kind = 'group')
  with check (public.is_conversation_member(id) and kind = 'group');

-- No DELETE policy. Conversations are left, not destroyed — one member deleting
-- a thread would take everyone else's history with them.

-- --- conversation_members ----------------------------------------------------

create policy conversation_members_select on public.conversation_members
  for select to authenticated
  using (public.is_conversation_member(conversation_id));

-- Adding people. See can_add_conversation_member: membership is granted from
-- inside, never claimed from outside, and a DM can never gain a third member.
create policy conversation_members_insert on public.conversation_members
  for insert to authenticated
  with check (public.can_add_conversation_member(conversation_id, user_id));

-- You may only ever update your own membership row: your read cursor, your mute.
-- Notably this stops anyone marking somebody else's messages as read.
create policy conversation_members_update_own on public.conversation_members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy conversation_members_delete_own on public.conversation_members
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- --- messages ----------------------------------------------------------------

create policy messages_select_member on public.messages
  for select to authenticated
  using (public.is_conversation_member(conversation_id));

create policy messages_insert_member on public.messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.can_post_to_conversation(conversation_id)
    and deleted_at is null
    and edited_at is null
  );

-- Editing and soft-deleting your own message. The USING clause pins it to the
-- sender; the WITH CHECK stops an edit from moving a message into a different
-- conversation or reassigning its author.
create policy messages_update_own on public.messages
  for update to authenticated
  using (sender_id = (select auth.uid()))
  with check (sender_id = (select auth.uid()));

-- No DELETE policy: `deleted_at` is the delete. A hard delete would break every
-- reply anchored to the message and leave a hole in the thread.

-- --- message_reactions -------------------------------------------------------

create policy message_reactions_select on public.message_reactions
  for select to authenticated
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id
        and public.is_conversation_member(m.conversation_id)
    )
  );

create policy message_reactions_insert_own on public.message_reactions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id
        and public.can_post_to_conversation(m.conversation_id)
    )
  );

create policy message_reactions_delete_own on public.message_reactions
  for delete to authenticated
  using (user_id = (select auth.uid()));
