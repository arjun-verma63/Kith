-- =============================================================================
-- KITH — 0022 · Couple games, and the first one
--
-- Migration 0007 built `game_sessions` with two scopes: a session belongs to a
-- conversation OR to a couple, exactly one, which is what lets one table, one
-- engine and one set of policies serve both. Migration 0017 then built the
-- lifecycle and only ever handled the conversation half.
--
-- This is the other half. Almost nothing new is needed, which is the point:
-- `can_view_game_session` already understood couples, so joining, readiness,
-- starting, moving, scoring, leaving and rematching all work unchanged. What was
-- missing was a way to OPEN one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- create_couple_game
--
-- Opens a session scoped to a couple and seats both partners immediately.
--
-- Unlike a conversation game there is no lobby to fill: the guest list is two
-- people and both are already known, so waiting for somebody to "join" would be
-- waiting for a thing that cannot happen. They still have to ready up — that is
-- how you say you are at your desk rather than halfway out of the door.
-- -----------------------------------------------------------------------------
create or replace function public.create_couple_game(
  p_couple_id uuid,
  p_game_key text,
  p_rematch_of uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  partner uuid;
  existing uuid;
  new_session uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if not public.is_couple_member(p_couple_id) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.couples c where c.id = p_couple_id and c.status = 'active'
  ) then
    raise exception 'not_active' using errcode = '55006';
  end if;

  -- The catalogue decides what a couple may play. A game whose audience is
  -- `group` has no business here, and the constraint on the table already says
  -- a couple game is exactly two players.
  if not exists (
    select 1 from public.games g
    where g.key = p_game_key and g.enabled and g.audience = 'couple'
  ) then
    raise exception 'game_unavailable' using errcode = '22023';
  end if;

  select case when c.user_low = me then c.user_high else c.user_low end
    into partner
  from public.couples c where c.id = p_couple_id;

  perform public.abandon_stale_games();
  perform pg_advisory_xact_lock(hashtext('kith.couple-game:' || p_couple_id::text || ':' || p_game_key));

  -- One live session per game per couple, for the same reason as conversations:
  -- two lobbies for two people is two people in different rooms.
  select s.id into existing
  from public.game_sessions s
  where s.couple_id = p_couple_id
    and s.game_key = p_game_key
    and s.status in ('lobby', 'active')
  order by s.created_at desc
  limit 1;

  if existing is not null then
    return existing;
  end if;

  insert into public.game_sessions (game_key, couple_id, host_id, status, rematch_of)
  values (p_game_key, p_couple_id, me, 'lobby', p_rematch_of)
  returning id into new_session;

  insert into public.game_players (session_id, user_id, seat)
  values (new_session, me, 0), (new_session, partner, 1);

  return new_session;
end;
$$;

-- -----------------------------------------------------------------------------
-- list_couple_games — the history the brief asked for
-- -----------------------------------------------------------------------------
create or replace function public.list_couple_games(
  p_couple_id uuid,
  p_limit integer default 20
)
returns table (
  id uuid,
  game_key text,
  game_name text,
  status public.game_status,
  our_score integer,
  created_at timestamptz,
  ended_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    s.id,
    s.game_key,
    g.name,
    s.status,
    -- A couple game is co-operative, so both rows carry the same number and
    -- either one is "the" score. Taking the max rather than summing is what
    -- keeps that true if a future game ever scores them apart.
    (select max(p.score) from public.game_players p where p.session_id = s.id),
    s.created_at,
    s.ended_at
  from public.game_sessions s
  join public.games g on g.key = s.game_key
  where s.couple_id = p_couple_id
    and public.is_couple_member(p_couple_id)
  order by
    case when s.status in ('lobby', 'active') then 0 else 1 end,
    s.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- -----------------------------------------------------------------------------
-- get_game_session, again
--
-- A third version, to carry `couple_id`. Without it the client cannot tell a
-- couple session from a conversation one, and `rematch` — which reopens a
-- session in the same place — has nowhere to reopen it.
--
-- Still no `state` column. Migration 0018 took that off this path because SQL
-- cannot run an engine and therefore cannot redact; that has not changed.
-- -----------------------------------------------------------------------------
drop function if exists public.get_game_session(uuid);

create function public.get_game_session(p_session_id uuid)
returns table (
  id uuid,
  game_key text,
  game_name text,
  min_players smallint,
  max_players smallint,
  pace public.game_pace,
  audience public.game_audience,
  conversation_id uuid,
  couple_id uuid,
  host_id uuid,
  status public.game_status,
  state_version integer,
  turn_seat smallint,
  seed bigint,
  config jsonb,
  rematch_of uuid,
  created_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  my_seat smallint,
  can_start boolean
)
language sql
stable
set search_path = ''
as $$
  select
    s.id,
    s.game_key,
    g.name,
    g.min_players,
    g.max_players,
    g.pace,
    g.audience,
    s.conversation_id,
    s.couple_id,
    s.host_id,
    s.status,
    s.state_version,
    s.turn_seat,
    s.seed,
    s.config,
    s.rematch_of,
    s.created_at,
    s.started_at,
    s.ended_at,
    (select p.seat from public.game_players p where p.session_id = s.id and p.user_id = (select auth.uid())),
    public.can_start_game(s.id)
  from public.game_sessions s
  join public.games g on g.key = s.game_key
  where s.id = p_session_id
    and public.can_view_game_session(s.id);
$$;

comment on function public.get_game_session(uuid) is
  'Session metadata. Never the state — that is redacted per player by the engine.';

revoke execute on function public.get_game_session(uuid) from public, anon;
grant execute on function public.get_game_session(uuid) to authenticated;

revoke execute on function public.create_couple_game(uuid, text, uuid) from public, anon;
revoke execute on function public.list_couple_games(uuid, integer) from public, anon;
grant execute on function public.create_couple_game(uuid, text, uuid) to authenticated;
grant execute on function public.list_couple_games(uuid, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- The game.
--
-- `how-well` has been in the catalogue since migration 0007, disabled, as a
-- description of a shelf nobody had built yet. It now has an engine.
--
-- `realtime` rather than turn-based: both partners answer at the same time and
-- the whole point is that neither sees the other until both have.
-- -----------------------------------------------------------------------------
update public.games
   set name = 'How Well Do You Know Me?',
       tagline = 'Answer separately. Find out together.',
       pace = 'realtime',
       min_players = 2,
       max_players = 2,
       enabled = true
 where key = 'how-well';
