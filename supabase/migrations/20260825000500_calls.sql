-- =============================================================================
-- KITH — 0005 · Calls
--
-- calls, call_participants.
--
-- What is stored here is metadata and nothing else: who called whom, when, for
-- how long, and how it ended. There is no column for signalling and there never
-- will be. SDP offers and ICE candidates are transient, worthless a second after
-- they are exchanged, and belong on a Realtime broadcast channel — writing them
-- to disk would mean a row per candidate per call for data with a two-second
-- shelf life. Media is peer to peer and never touches the database at all.
--
-- A call hangs off a conversation rather than off a list of user ids. That gives
-- it a membership model for free (the conversation's), keeps 1:1 and group calls
-- identical in shape, and lets a missed call appear in the thread as a message.
-- =============================================================================

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  initiator_id uuid references public.profiles (id) on delete set null,

  kind public.call_kind not null default 'audio',
  status public.call_status not null default 'ringing',

  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  end_reason public.call_end_reason,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A finished call must say when and why; a live one must not claim to have.
  constraint calls_ended_consistency check (
    (status in ('ended', 'missed', 'declined')) = (ended_at is not null)
  ),
  constraint calls_end_reason_consistency check (
    (ended_at is null) = (end_reason is null)
  ),
  constraint calls_answered_consistency check (
    answered_at is null or answered_at >= started_at
  )
);

-- Call history for a conversation.
create index calls_conversation_started_idx
  on public.calls (conversation_id, started_at desc);

create index calls_initiator_idx
  on public.calls (initiator_id)
  where initiator_id is not null;

-- The sweep that expires unanswered calls. A partial index over a status that is
-- true for seconds at a time keeps that scheduled job reading almost nothing,
-- however long the call history gets.
create index calls_ringing_idx
  on public.calls (started_at)
  where status = 'ringing';

create trigger calls_set_updated_at
  before update on public.calls
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- call_participants
--
-- Rows are created when the call starts, one per invited member, so an unanswered
-- call still records who was rung. `joined_at` stays null for anyone who never
-- picked up — which is what makes "missed" a fact rather than an inference.
-- -----------------------------------------------------------------------------

create table public.call_participants (
  call_id uuid not null references public.calls (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,

  joined_at timestamptz,
  left_at timestamptz,

  -- Mute, camera, screen share. Transient during the call — the authoritative
  -- copy travels on the call's broadcast channel, and this is the last known
  -- state for anyone joining late.
  media_state jsonb not null default '{}'::jsonb,

  primary key (call_id, user_id),
  constraint call_participants_left_after_join check (
    left_at is null or joined_at is null or left_at >= joined_at
  )
);

-- "My call history", which is the Calls destination.
create index call_participants_user_idx on public.call_participants (user_id);

create or replace function public.is_call_participant(target_call uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.call_participants p
    where p.call_id = target_call
      and p.user_id = (select auth.uid())
  );
$$;

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.calls enable row level security;
alter table public.call_participants enable row level security;
alter table public.calls force row level security;
alter table public.call_participants force row level security;

-- --- calls -------------------------------------------------------------------

-- Membership of the conversation is the gate, so a call is visible to the same
-- people the thread is — including the record of one they were rung for and
-- missed.
create policy calls_select_member on public.calls
  for select to authenticated
  using (public.is_conversation_member(conversation_id));

-- Starting a call requires the same standing as posting a message: in the
-- conversation, and not blocked by anyone in it.
create policy calls_insert_member on public.calls
  for insert to authenticated
  with check (
    initiator_id = (select auth.uid())
    and public.can_post_to_conversation(conversation_id)
    and status = 'ringing'
    and ended_at is null
  );

-- Answering, declining and hanging up. Restricted to people actually on the
-- call rather than everyone in the conversation, so a bystander cannot end
-- somebody else's call from a third device.
create policy calls_update_participant on public.calls
  for update to authenticated
  using (public.is_call_participant(id))
  with check (public.is_call_participant(id));

-- No DELETE policy: call history is not editable. A call you would rather forget
-- is still a call that happened, and the other person's history references it.

-- --- call_participants -------------------------------------------------------

create policy call_participants_select on public.call_participants
  for select to authenticated
  using (
    exists (
      select 1 from public.calls c
      where c.id = call_participants.call_id
        and public.is_conversation_member(c.conversation_id)
    )
  );

-- The initiator rings everyone in the conversation; anyone in the conversation
-- may add themselves (joining a call already in progress).
create policy call_participants_insert on public.call_participants
  for insert to authenticated
  with check (
    exists (
      select 1 from public.calls c
      where c.id = call_participants.call_id
        and public.can_post_to_conversation(c.conversation_id)
    )
  );

-- Your own joined/left/media state, and nobody else's. This is what stops one
-- participant muting another by writing to their row.
create policy call_participants_update_own on public.call_participants
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
