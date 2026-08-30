-- =============================================================================
-- KITH — 0003 · Social graph
--
-- friend_requests, friendships.
--
-- Two tables rather than one `friendships` table with a status column. A request
-- and a friendship are different things with different lifecycles, different
-- cardinality and — most importantly — different access rules: a request is
-- directional and private to two people, a friendship is symmetric and permanent
-- until broken. Collapsing them means every query and every policy carries a
-- status filter it could forget.
--
-- Friendships are stored ONCE, in canonical (least, greatest) order. The
-- alternative — two mirrored rows, or one row plus an OR across both columns —
-- doubles the write path, doubles the index, and makes "are A and B friends" a
-- query the planner cannot satisfy with a single primary-key probe.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- friend_requests
-- -----------------------------------------------------------------------------

create table public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status public.friend_request_status not null default 'pending',
  message text,
  created_at timestamptz not null default now(),
  responded_at timestamptz,

  constraint friend_requests_no_self check (requester_id <> addressee_id),
  constraint friend_requests_message_length check (message is null or char_length(message) <= 200),
  constraint friend_requests_responded_consistency check (
    (status = 'pending') = (responded_at is null)
  )
);

-- At most one live request between any two people, in EITHER direction. Without
-- the unordered pair, A and B can both have a pending request open at once and
-- accepting both races to create the same friendship twice.
create unique index friend_requests_pending_pair_key
  on public.friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id))
  where status = 'pending';

-- The inbox query: "requests waiting for me".
create index friend_requests_addressee_idx
  on public.friend_requests (addressee_id, status, created_at desc);

create index friend_requests_requester_idx
  on public.friend_requests (requester_id, status, created_at desc);

-- -----------------------------------------------------------------------------
-- friendships
-- -----------------------------------------------------------------------------

create table public.friendships (
  user_low uuid not null references public.profiles (id) on delete cascade,
  user_high uuid not null references public.profiles (id) on delete cascade,
  became_friends_at timestamptz not null default now(),

  primary key (user_low, user_high),
  -- Canonical ordering, enforced rather than assumed. Without this check a row
  -- could be inserted the wrong way round and every lookup would miss it.
  constraint friendships_canonical_order check (user_low < user_high)
);

-- The primary key covers user_low. This covers the other direction, so
-- "everyone I am friends with" is one index scan whichever side you are on.
create index friendships_user_high_idx on public.friendships (user_high);

create or replace function public.are_friends(other_user uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.friendships f
    where f.user_low = least((select auth.uid()), other_user)
      and f.user_high = greatest((select auth.uid()), other_user)
  );
$$;

comment on function public.are_friends(uuid) is
  'True if the caller and other_user are friends. Single primary-key probe thanks to canonical ordering.';

-- -----------------------------------------------------------------------------
-- Accepting a request creates the friendship
--
-- In a trigger, not in application code. Accepting and befriending are one fact;
-- splitting them across two client round trips means a crash between them leaves
-- an accepted request with no friendship, and nothing in the system would notice.
--
-- The trigger runs inside the same transaction as the UPDATE, so the pair either
-- both happen or neither does. RLS on friend_requests is what guarantees only the
-- addressee can reach this path.
-- -----------------------------------------------------------------------------

create or replace function public.handle_friend_request_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'accepted' and old.status = 'pending' then
    insert into public.friendships (user_low, user_high)
    values (
      least(new.requester_id, new.addressee_id),
      greatest(new.requester_id, new.addressee_id)
    )
    on conflict do nothing;
  end if;

  return new;
end;
$$;

create trigger friend_request_accepted
  after update on public.friend_requests
  for each row execute function public.handle_friend_request_accepted();

-- Stamp the response time in the database rather than trusting a client value.
create or replace function public.stamp_friend_request_response()
returns trigger
language plpgsql
as $$
begin
  if new.status <> old.status and new.status <> 'pending' then
    new.responded_at := now();
  end if;

  return new;
end;
$$;

create trigger friend_request_stamp_response
  before update on public.friend_requests
  for each row execute function public.stamp_friend_request_response();

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.friend_requests force row level security;
alter table public.friendships force row level security;

-- --- friend_requests ---------------------------------------------------------

-- Visible only to the two people involved.
create policy friend_requests_select_involved on public.friend_requests
  for select to authenticated
  using (
    requester_id = (select auth.uid())
    or addressee_id = (select auth.uid())
  );

-- You may only send as yourself, only to somebody who has not blocked you (and
-- whom you have not blocked), and only if you are not already friends.
create policy friend_requests_insert_own on public.friend_requests
  for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and status = 'pending'
    and not public.is_blocked_either(addressee_id)
    and not public.are_friends(addressee_id)
  );

-- The addressee accepts or declines; the requester may cancel. Split into two
-- policies because the permitted target states differ — allowing the requester to
-- write `accepted` would let anybody befriend anybody by sending and accepting
-- their own request.
create policy friend_requests_respond on public.friend_requests
  for update to authenticated
  using (addressee_id = (select auth.uid()) and status = 'pending')
  with check (
    addressee_id = (select auth.uid())
    and status in ('accepted', 'declined')
  );

create policy friend_requests_cancel on public.friend_requests
  for update to authenticated
  using (requester_id = (select auth.uid()) and status = 'pending')
  with check (
    requester_id = (select auth.uid())
    and status = 'cancelled'
  );

-- --- friendships -------------------------------------------------------------

create policy friendships_select_own on public.friendships
  for select to authenticated
  using (
    user_low = (select auth.uid())
    or user_high = (select auth.uid())
  );

-- No INSERT policy. A friendship is created only by the accept trigger, which
-- means the sole route into this table runs through a request the other person
-- actually agreed to. A client cannot befriend itself to anybody.

-- Unfriending is symmetric: either side may end it.
create policy friendships_delete_own on public.friendships
  for delete to authenticated
  using (
    user_low = (select auth.uid())
    or user_high = (select auth.uid())
  );
