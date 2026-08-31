-- =============================================================================
-- KITH — 0013 · Friends
--
-- The tables, constraints and policies for friendship already exist (0003).
-- What this adds is the read side: search, and the three list shapes the
-- Friends page needs.
--
-- They are database functions rather than PostgREST queries for one reason that
-- is not style. A friendship row is `(user_low, user_high)` in canonical order,
-- so "my friends" means "the OTHER column, whichever side I am on" — which is a
-- conditional join PostgREST cannot express. The alternatives are two round
-- trips and a client-side merge, or storing every friendship twice. Both are
-- worse than a function that returns the right rows the first time.
--
-- Note which of these are SECURITY DEFINER and which are not. `list_friends`
-- and `list_friend_requests` run as the CALLER, so Row Level Security still
-- filters them and the function adds no authority of its own. Only
-- `search_profiles` needs to be DEFINER, because it reads other people's
-- `user_settings` to honour their discoverability — and it is written to return
-- strictly less than the caller could already see.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- search_profiles
--
-- Three rules, each of which is a privacy decision:
--
--   1. A BLANK QUERY RETURNS NOTHING. An empty search that lists every member
--      turns the search box into a directory, which is exactly what an
--      invitation-only app should not have.
--   2. `discoverable = false` HIDES YOU FROM STRANGERS, not from your friends.
--      Someone who has already added you can still find you; that is what the
--      setting means, and hiding you from them would just look like a bug.
--   3. BLOCKS ARE SYMMETRIC AND SILENT. A blocked person is not "no results
--      for this name" — they are absent from the set entirely, with no way to
--      tell the difference between blocked and non-existent.
--
-- The relationship is computed here rather than in the client, so a page of
-- results is one query instead of one plus N.
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
    -- Somebody who has chosen to be invisible is reported as invisible, not as
    -- whatever the heartbeat says. The derivation in the client cannot leak what
    -- it is never sent.
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
  -- Username prefix matches first: typing "ad" and getting @ada third is the
  -- kind of ordering that makes a search box feel broken.
  order by
    (lower(p.username) = needle.q) desc,
    (lower(p.username) like needle.q || '%') desc,
    lower(p.display_name)
  limit 20;
$$;

comment on function public.search_profiles(text) is
  'Member search honouring discoverability and blocks. Blank query returns nothing, by design.';

revoke execute on function public.search_profiles(text) from public, anon;
grant execute on function public.search_profiles(text) to authenticated;

-- -----------------------------------------------------------------------------
-- list_friends
--
-- SECURITY INVOKER (the default): runs as the caller, so `friendships_select_own`
-- and `profiles_select` do the filtering. The function is a join, not a
-- privilege — which is what it should be when the caller can already read
-- everything it touches.
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
    -- The other side of the pair, whichever side I am on.
    on p.id = case
                when f.user_low = (select auth.uid()) then f.user_high
                else f.user_low
              end
  where (select auth.uid()) in (f.user_low, f.user_high)
  order by lower(p.display_name);
$$;

revoke execute on function public.list_friends() from public, anon;
grant execute on function public.list_friends() to authenticated;

-- -----------------------------------------------------------------------------
-- list_friend_requests
--
-- One function with a direction rather than two near-identical ones. Also
-- SECURITY INVOKER — `friend_requests_select_involved` already restricts the
-- rows to the two people concerned.
-- -----------------------------------------------------------------------------

create or replace function public.list_friend_requests(p_direction text)
returns table (
  request_id uuid,
  created_at timestamptz,
  message text,
  id uuid,
  username text,
  display_name text,
  avatar_path text,
  pronouns text,
  accent public.profile_accent,
  status public.presence_status,
  last_seen_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    r.id,
    r.created_at,
    r.message,
    p.id,
    p.username,
    p.display_name,
    p.avatar_path,
    p.pronouns,
    p.accent,
    p.status,
    case when p.status = 'invisible' then null else p.last_seen_at end
  from public.friend_requests r
  join public.profiles p
    on p.id = case
                when p_direction = 'incoming' then r.requester_id
                else r.addressee_id
              end
  where r.status = 'pending'
    and case
          when p_direction = 'incoming' then r.addressee_id = (select auth.uid())
          else r.requester_id = (select auth.uid())
        end
  order by r.created_at desc;
$$;

revoke execute on function public.list_friend_requests(text) from public, anon;
grant execute on function public.list_friend_requests(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Search support
--
-- `lower(username)` is already covered by the case-insensitive unique index, and
-- `lower(display_name)` by an index from 0002 — both of which serve the
-- `LIKE 'prefix%'` patterns above. The display-name search is an infix `%q%`
-- and cannot use a b-tree; at six members that is a sequential scan of six rows,
-- and adding a trigram index for it would be ceremony.
-- -----------------------------------------------------------------------------
