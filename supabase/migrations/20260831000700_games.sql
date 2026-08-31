-- =============================================================================
-- KITH — 0017 · Game lifecycle
--
-- Migration 0007 created the tables. This adds the lifecycle: opening a lobby,
-- joining it, readying up, starting, moving, scoring, finishing, rematching and
-- leaving.
--
-- ── Where the rules live, and where they cannot ──────────────────────────────
--
-- A game's rules are code, not SQL. "Is this a legal move in Word Rush" is a
-- question only the game's own engine can answer, and expressing it in Postgres
-- would mean rewriting each game twice in two languages that would drift.
--
-- So validation is split, and the split is the whole design:
--
--   THE ENGINE (TypeScript, server-side) decides whether a move is LEGAL. It is
--   a pure function of state and move. It never runs in a browser.
--
--   THE DATABASE decides whether the move is PERMITTED — that the person is in
--   this game, that the game is running, that it is their turn, and that the
--   state they computed from is the state that is current. None of that needs to
--   know what game it is, so all of it is enforced here, for every game, for
--   free.
--
-- ── Why clients cannot write state ───────────────────────────────────────────
--
-- `game_sessions.state` has no client-facing INSERT or UPDATE path, and neither
-- does `game_moves`. `commit_game_move` is executable by the service role only.
-- If a client could write state, cheating would be a fetch call — and hidden
-- information (a hand of cards, an unrevealed answer) would have to be sent to
-- everyone in order to be checkable, which defeats the point of hiding it.
--
-- The server route holds the user's identity and passes it in as `p_actor`.
-- Every function below re-derives permission from `p_actor` rather than trusting
-- that the route checked — the route is not a trusted component, it is just the
-- only one that can run the engine.
--
-- ── Optimistic concurrency ───────────────────────────────────────────────────
--
-- Two moves arriving at once must not interleave into a corrupt state. Every
-- write is conditional on the `state_version` the engine read; a lost race
-- updates zero rows, and the caller is told to resync rather than silently
-- overwriting somebody.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Whose turn it is, in a column.
--
-- The state blob is opaque to Postgres by design, so turn order would be
-- unenforceable if it lived only in there — every game would have to be trusted
-- to check it, and "it is not your turn" is exactly the kind of rule an attacker
-- goes at first.
--
-- One small game-agnostic column moves it into the database: the engine says who
-- is next, and every subsequent move is checked against it before any game code
-- runs. Null means the game has no turns (a realtime game where everybody acts
-- at once), which is a real answer and not an absent one.
-- -----------------------------------------------------------------------------
alter table public.game_sessions
  add column if not exists turn_seat smallint,
  add column if not exists rematch_of uuid references public.game_sessions (id) on delete set null;

comment on column public.game_sessions.turn_seat is
  'Seat that may move next; null for realtime games. Enforced by commit_game_move.';

create index if not exists game_sessions_rematch_idx
  on public.game_sessions (rematch_of)
  where rematch_of is not null;

-- -----------------------------------------------------------------------------
-- broadcast_game
--
-- Public state to the table, private state to each player.
--
-- The `game:{id}` channel is one payload for everybody who can watch, so nothing
-- secret may travel on it. A game with hidden information sends each player
-- their own view down their own `user:{id}` channel, which only they can read
-- (migration 0009). The engine decides the split; this just delivers it.
-- -----------------------------------------------------------------------------
create or replace function public.broadcast_game(
  p_session_id uuid,
  p_event text,
  p_public jsonb,
  p_private jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient uuid;
  view_for_player jsonb;
begin
  perform realtime.send(p_public, p_event, 'game:' || p_session_id::text, true);

  if p_private is null then
    return;
  end if;

  -- `p_private` is an object keyed by user id. A player who has no key simply
  -- gets nothing extra, which is correct for a spectator.
  for recipient in
    select p.user_id from public.game_players p where p.session_id = p_session_id
  loop
    view_for_player := p_private -> recipient::text;
    if view_for_player is not null then
      perform realtime.send(view_for_player, p_event, 'user:' || recipient::text, true);
    end if;
  end loop;
end;
$$;

comment on function public.broadcast_game(uuid, text, jsonb, jsonb) is
  'Public game state to game:{id}; each player''s private view to their own channel.';

-- -----------------------------------------------------------------------------
-- create_game_session
--
-- Opens a lobby and seats the host.
--
-- One live session per game per conversation. Without that, a mistimed double
-- click produces two lobbies and the group splits between them — which looks
-- exactly like the app being broken.
-- -----------------------------------------------------------------------------
create or replace function public.create_game_session(
  p_conversation_id uuid,
  p_game_key text,
  p_config jsonb default '{}'::jsonb,
  p_rematch_of uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  existing uuid;
  new_session uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- The same gate as posting a message: in the conversation, and not blocked by
  -- anybody in it. If you cannot write to the room you cannot start a game in it.
  if not public.can_post_to_conversation(p_conversation_id) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  if not exists (select 1 from public.games g where g.key = p_game_key and g.enabled) then
    raise exception 'game_unavailable' using errcode = '22023';
  end if;

  -- A lobby nobody ever started would block the next one, since this function
  -- joins the live session rather than opening a rival. Cheap: the sweep reads a
  -- partial index over a status that is rare.
  perform public.abandon_stale_games();

  perform pg_advisory_xact_lock(hashtext('kith.game:' || p_conversation_id::text || ':' || p_game_key));

  select s.id into existing
  from public.game_sessions s
  where s.conversation_id = p_conversation_id
    and s.game_key = p_game_key
    and s.status in ('lobby', 'active')
  order by s.created_at desc
  limit 1;

  if existing is not null then
    -- Join what is already open rather than starting a rival lobby.
    perform public.join_game_session(existing);
    return existing;
  end if;

  insert into public.game_sessions (game_key, conversation_id, host_id, status, config, rematch_of)
  values (p_game_key, p_conversation_id, me, 'lobby', coalesce(p_config, '{}'::jsonb), p_rematch_of)
  returning id into new_session;

  insert into public.game_players (session_id, user_id, seat)
  values (new_session, me, 0);

  return new_session;
end;
$$;

-- -----------------------------------------------------------------------------
-- join_game_session
--
-- Takes the lowest free seat.
--
-- Lowest free rather than next highest, so a lobby that somebody left and
-- rejoined does not end up with holes — games address players by seat, and a
-- gap in the middle is a whole class of off-by-one bugs in game code that has
-- not been written yet.
-- -----------------------------------------------------------------------------
create or replace function public.join_game_session(p_session_id uuid)
returns smallint
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  session_row public.game_sessions;
  limits public.games;
  seated smallint;
  taken integer;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into session_row from public.game_sessions where id = p_session_id for update;

  if session_row.id is null or not public.can_view_game_session(p_session_id) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  -- Already seated. Idempotent, because a double-tapped Join must not raise.
  select p.seat into seated
  from public.game_players p
  where p.session_id = p_session_id and p.user_id = me;

  if seated is not null then
    update public.game_players set left_at = null
     where session_id = p_session_id and user_id = me;
    return seated;
  end if;

  if session_row.status <> 'lobby' then
    raise exception 'game_in_progress' using errcode = '55006';
  end if;

  select * into limits from public.games where key = session_row.game_key;

  select count(*)::integer into taken
  from public.game_players p
  where p.session_id = p_session_id and p.left_at is null;

  if taken >= limits.max_players then
    raise exception 'game_full' using errcode = '55006';
  end if;

  -- The lowest seat nobody holds.
  select coalesce(min(s.n), 0)::smallint into seated
  from generate_series(0, limits.max_players - 1) as s(n)
  where not exists (
    select 1 from public.game_players p
    where p.session_id = p_session_id and p.seat = s.n
  );

  insert into public.game_players (session_id, user_id, seat) values (p_session_id, me, seated);

  return seated;
end;
$$;

-- -----------------------------------------------------------------------------
-- set_game_ready
--
-- The one thing a player may write about themselves.
-- -----------------------------------------------------------------------------
create or replace function public.set_game_ready(p_session_id uuid, p_ready boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.game_sessions s
    where s.id = p_session_id and s.status = 'lobby'
  ) then
    raise exception 'not_in_lobby' using errcode = '55006';
  end if;

  update public.game_players
     set is_ready = coalesce(p_ready, false)
   where session_id = p_session_id and user_id = me;

  if not found then
    raise exception 'not_permitted' using errcode = '42501';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- can_start_game
--
-- Enough players, all ready, still in the lobby, and asked by the host.
--
-- A function rather than a check inside `start_game_session`, because the lobby
-- UI needs the same answer to decide whether to enable the button — and two
-- copies of "can this start" is how a button that is enabled starts something
-- that then fails.
-- -----------------------------------------------------------------------------
create or replace function public.can_start_game(p_session_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.game_sessions s
    join public.games g on g.key = s.game_key
    where s.id = p_session_id
      and s.status = 'lobby'
      and s.host_id = (select auth.uid())
      and g.enabled
      and (
        select count(*) from public.game_players p
        where p.session_id = s.id and p.left_at is null
      ) between g.min_players and g.max_players
      and not exists (
        select 1 from public.game_players p
        where p.session_id = s.id and p.left_at is null and not p.is_ready
      )
  );
$$;

-- -----------------------------------------------------------------------------
-- start_game_session
--
-- SERVICE ROLE ONLY. The initial state comes from the engine, which does not run
-- in a browser, so this cannot be reachable from one.
--
-- `p_actor` is the person who pressed Start, passed in by the route. It is
-- re-checked here rather than trusted: the route is the only component that can
-- run the engine, which does not make it a component whose word is taken.
-- -----------------------------------------------------------------------------
create or replace function public.start_game_session(
  p_session_id uuid,
  p_actor uuid,
  p_state jsonb,
  p_turn_seat smallint default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.game_sessions;
  limits public.games;
  seated integer;
  unready integer;
begin
  select * into session_row from public.game_sessions where id = p_session_id for update;

  if session_row.id is null then
    raise exception 'no_such_session' using errcode = '42501';
  end if;

  if session_row.host_id <> p_actor then
    raise exception 'not_host' using errcode = '42501';
  end if;

  if session_row.status <> 'lobby' then
    raise exception 'not_in_lobby' using errcode = '55006';
  end if;

  select * into limits from public.games where key = session_row.game_key;

  if not limits.enabled then
    raise exception 'game_unavailable' using errcode = '22023';
  end if;

  select count(*)::integer into seated
  from public.game_players p where p.session_id = p_session_id and p.left_at is null;

  if seated < limits.min_players or seated > limits.max_players then
    raise exception 'wrong_player_count' using errcode = '55006';
  end if;

  select count(*)::integer into unready
  from public.game_players p
  where p.session_id = p_session_id and p.left_at is null and not p.is_ready;

  if unready > 0 then
    raise exception 'players_not_ready' using errcode = '55006';
  end if;

  update public.game_sessions
     set status = 'active',
         state = coalesce(p_state, '{}'::jsonb),
         state_version = 1,
         turn_seat = p_turn_seat,
         started_at = now()
   where id = p_session_id;

  return 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- commit_game_move
--
-- SERVICE ROLE ONLY. The write half of a move; the engine is the other half.
--
-- Everything checked here is game-agnostic, which is why it can be checked here
-- at all: is this person playing, is the game running, is it their turn, and is
-- the state they computed from still the current one.
--
-- Returns the new version, or raises. A version mismatch raises `stale_state`,
-- which the route turns into "resync and try again" rather than an error — two
-- people moving at the same instant is normal, not exceptional.
-- -----------------------------------------------------------------------------
create or replace function public.commit_game_move(
  p_session_id uuid,
  p_actor uuid,
  p_expected_version integer,
  p_state jsonb,
  p_move jsonb,
  p_turn_seat smallint default null,
  p_scores jsonb default null,
  p_finished boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.game_sessions;
  actor_seat smallint;
  next_seq integer;
  new_version integer;
  entry record;
begin
  select * into session_row from public.game_sessions where id = p_session_id for update;

  if session_row.id is null then
    raise exception 'no_such_session' using errcode = '42501';
  end if;

  if session_row.status <> 'active' then
    raise exception 'game_not_active' using errcode = '55006';
  end if;

  select p.seat into actor_seat
  from public.game_players p
  where p.session_id = p_session_id and p.user_id = p_actor and p.left_at is null;

  if actor_seat is null then
    raise exception 'not_a_player' using errcode = '42501';
  end if;

  -- Turn order, enforced without knowing the game. A realtime game leaves
  -- `turn_seat` null and everybody may act.
  if session_row.turn_seat is not null and session_row.turn_seat <> actor_seat then
    raise exception 'not_your_turn' using errcode = '55006';
  end if;

  -- Optimistic concurrency. A lost race is a normal event, not a fault.
  if session_row.state_version <> p_expected_version then
    raise exception 'stale_state' using errcode = '40001';
  end if;

  new_version := session_row.state_version + 1;

  select coalesce(max(m.seq) + 1, 0) into next_seq
  from public.game_moves m where m.session_id = p_session_id;

  insert into public.game_moves (session_id, seq, player_id, payload)
  values (p_session_id, next_seq, p_actor, p_move);

  update public.game_sessions
     set state = coalesce(p_state, '{}'::jsonb),
         state_version = new_version,
         turn_seat = p_turn_seat,
         status = case when p_finished then 'finished' else 'active' end::public.game_status,
         ended_at = case when p_finished then now() else null end
   where id = p_session_id;

  -- Scores arrive as { "<seat>": { "score": 12, "placement": 1 } }. Written here
  -- rather than by the client for the obvious reason.
  if p_scores is not null then
    for entry in select * from jsonb_each(p_scores) loop
      update public.game_players
         set score = coalesce((entry.value ->> 'score')::integer, score),
             placement = nullif(entry.value ->> 'placement', '')::smallint
       where session_id = p_session_id
         and seat = entry.key::smallint;
    end loop;
  end if;

  return new_version;
end;
$$;

-- -----------------------------------------------------------------------------
-- leave_game_session
--
-- Leaving a lobby is a departure. Leaving a game in progress is an event: it may
-- end the game, and it must not silently erase that somebody was playing.
-- -----------------------------------------------------------------------------
create or replace function public.leave_game_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  session_row public.game_sessions;
  limits public.games;
  remaining integer;
  next_host uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into session_row from public.game_sessions where id = p_session_id for update;
  if session_row.id is null then
    return;
  end if;

  if not exists (
    select 1 from public.game_players p
    where p.session_id = p_session_id and p.user_id = me
  ) then
    raise exception 'not_a_player' using errcode = '42501';
  end if;

  if session_row.status = 'lobby' then
    -- Nothing has happened yet, so nothing needs remembering.
    delete from public.game_players where session_id = p_session_id and user_id = me;
  else
    -- Mid-game: recorded, not erased. The score stands.
    update public.game_players
       set left_at = coalesce(left_at, now()), is_ready = false
     where session_id = p_session_id and user_id = me;
  end if;

  select count(*)::integer into remaining
  from public.game_players p
  where p.session_id = p_session_id and p.left_at is null;

  if remaining = 0 then
    -- The last person out turns the lights off.
    update public.game_sessions
       set status = 'abandoned', ended_at = coalesce(ended_at, now())
     where id = p_session_id and status in ('lobby', 'active');
    return;
  end if;

  if session_row.status = 'active' then
    select * into limits from public.games where key = session_row.game_key;
    if remaining < limits.min_players then
      update public.game_sessions
         set status = 'abandoned', ended_at = now()
       where id = p_session_id;
      return;
    end if;
  end if;

  -- The host left but the game did not. Somebody has to be able to start it.
  if session_row.host_id = me then
    select p.user_id into next_host
    from public.game_players p
    where p.session_id = p_session_id and p.left_at is null
    order by p.seat
    limit 1;

    if next_host is not null then
      update public.game_sessions set host_id = next_host where id = p_session_id;
    end if;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- abandon_stale_games
--
-- A lobby nobody ever started, or a game everybody walked away from, would sit
-- in `lobby`/`active` forever and block the next one — `create_game_session`
-- joins the live session rather than opening a rival.
--
-- Six hours is deliberately generous: this is a floor under the worst case, not
-- a liveness check. `game_sessions_live_idx` makes it read almost nothing.
-- -----------------------------------------------------------------------------
create or replace function public.abandon_stale_games()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  with stale as (
    update public.game_sessions s
       set status = 'abandoned', ended_at = now()
     where s.status in ('lobby', 'active')
       and s.updated_at < now() - interval '6 hours'
    returning s.id
  )
  select count(*)::integer into affected from stale;

  return affected;
end;
$$;

-- =============================================================================
-- Reads
-- =============================================================================

-- -----------------------------------------------------------------------------
-- list_games — the catalogue
--
-- Everything, with `enabled` included rather than filtered out. A game that is
-- coming is worth showing as coming; hiding it entirely means the shelf looks
-- empty and nobody knows anything is planned.
-- -----------------------------------------------------------------------------
create or replace function public.list_games()
returns table (
  key text,
  name text,
  tagline text,
  audience public.game_audience,
  pace public.game_pace,
  min_players smallint,
  max_players smallint,
  enabled boolean
)
language sql
stable
set search_path = ''
as $$
  select g.key, g.name, g.tagline, g.audience, g.pace, g.min_players, g.max_players, g.enabled
  from public.games g
  order by g.enabled desc, g.name;
$$;

-- -----------------------------------------------------------------------------
-- get_game_session — everything one screen needs, in one round trip
-- -----------------------------------------------------------------------------
create or replace function public.get_game_session(p_session_id uuid)
returns table (
  id uuid,
  game_key text,
  game_name text,
  min_players smallint,
  max_players smallint,
  pace public.game_pace,
  conversation_id uuid,
  host_id uuid,
  status public.game_status,
  state jsonb,
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
    s.conversation_id,
    s.host_id,
    s.status,
    -- The full state is returned only to somebody at the table. A spectator gets
    -- the shape of the game and none of its contents; what they are allowed to
    -- see is decided by the engine and delivered over the channel.
    case when public.is_game_player(s.id) then s.state else '{}'::jsonb end,
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

-- -----------------------------------------------------------------------------
-- list_game_players
-- -----------------------------------------------------------------------------
create or replace function public.list_game_players(p_session_id uuid)
returns table (
  user_id uuid,
  username text,
  display_name text,
  avatar_path text,
  seat smallint,
  is_ready boolean,
  score integer,
  placement smallint,
  is_host boolean,
  left_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    p.user_id,
    pr.username,
    pr.display_name,
    pr.avatar_path,
    p.seat,
    p.is_ready,
    p.score,
    p.placement,
    p.user_id = s.host_id,
    p.left_at
  from public.game_players p
  join public.game_sessions s on s.id = p.session_id
  join public.profiles pr on pr.id = p.user_id
  where p.session_id = p_session_id
    and public.can_view_game_session(p_session_id)
  order by p.seat;
$$;

-- -----------------------------------------------------------------------------
-- list_game_sessions — what is open in a conversation, and what was played
-- -----------------------------------------------------------------------------
create or replace function public.list_game_sessions(
  p_conversation_id uuid,
  p_limit integer default 20
)
returns table (
  id uuid,
  game_key text,
  game_name text,
  status public.game_status,
  host_id uuid,
  player_count integer,
  max_players smallint,
  am_i_in boolean,
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
    s.host_id,
    (select count(*)::integer from public.game_players p where p.session_id = s.id and p.left_at is null),
    g.max_players,
    exists (
      select 1 from public.game_players p
      where p.session_id = s.id and p.user_id = (select auth.uid()) and p.left_at is null
    ),
    s.created_at,
    s.ended_at
  from public.game_sessions s
  join public.games g on g.key = s.game_key
  where s.conversation_id = p_conversation_id
    and public.is_conversation_member(p_conversation_id)
  order by
    case when s.status in ('lobby', 'active') then 0 else 1 end,
    s.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- =============================================================================
-- Privileges
--
-- The two functions that write game state are the service role's alone. That is
-- what makes "the client cannot author state" a fact about the database rather
-- than a convention the application follows.
-- =============================================================================

revoke insert, update, delete on public.game_sessions from authenticated;
revoke insert, update, delete on public.game_moves from authenticated;
revoke insert, update, delete on public.games from authenticated;

-- Players still write one thing about themselves — but through the RPC, so that
-- readiness cannot be set on somebody else's row or outside a lobby.
revoke insert, update, delete on public.game_players from authenticated;

revoke execute on function public.broadcast_game(uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.start_game_session(uuid, uuid, jsonb, smallint) from public, anon, authenticated;
revoke execute on function public.commit_game_move(uuid, uuid, integer, jsonb, jsonb, smallint, jsonb, boolean)
  from public, anon, authenticated;

revoke execute on function public.create_game_session(uuid, text, jsonb, uuid) from public, anon;
revoke execute on function public.join_game_session(uuid) from public, anon;
revoke execute on function public.set_game_ready(uuid, boolean) from public, anon;
revoke execute on function public.leave_game_session(uuid) from public, anon;
revoke execute on function public.can_start_game(uuid) from public, anon;
revoke execute on function public.abandon_stale_games() from public, anon;
revoke execute on function public.list_games() from public, anon;
revoke execute on function public.get_game_session(uuid) from public, anon;
revoke execute on function public.list_game_players(uuid) from public, anon;
revoke execute on function public.list_game_sessions(uuid, integer) from public, anon;

grant execute on function public.create_game_session(uuid, text, jsonb, uuid) to authenticated;
grant execute on function public.join_game_session(uuid) to authenticated;
grant execute on function public.set_game_ready(uuid, boolean) to authenticated;
grant execute on function public.leave_game_session(uuid) to authenticated;
grant execute on function public.can_start_game(uuid) to authenticated;
grant execute on function public.abandon_stale_games() to authenticated;
grant execute on function public.list_games() to authenticated;
grant execute on function public.get_game_session(uuid) to authenticated;
grant execute on function public.list_game_players(uuid) to authenticated;
grant execute on function public.list_game_sessions(uuid, integer) to authenticated;

-- =============================================================================
-- Lobby realtime
--
-- Joining, readying and leaving are ordinary row writes, so nothing about them
-- reaches the other browsers on its own. A trigger rather than a `perform` in
-- each RPC: it fires however the row changed, including from a future path
-- nobody has written yet, and there is no way to add a write that forgets to
-- announce itself.
--
-- The payload is a NUDGE, not the data. Everyone refetches through
-- `get_game_session`, which applies Row Level Security and withholds the state
-- from spectators. Broadcasting the change itself would mean deciding, in SQL,
-- what each recipient is allowed to see — which is exactly the job the engine's
-- `viewFor` exists to do, and doing it twice in two languages is how they drift.
-- =============================================================================

create or replace function public.broadcast_game_lobby()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := coalesce(new.session_id, old.session_id);
begin
  perform realtime.send(
    jsonb_build_object('sessionId', target, 'at', now()),
    'game.lobby',
    'game:' || target::text,
    true
  );
  return null;
end;
$$;

create trigger game_players_broadcast
  after insert or update or delete on public.game_players
  for each row execute function public.broadcast_game_lobby();

-- The session's own transitions — started, finished, abandoned, host handed on.
-- `game.started` and `game.finished` also carry state from the runtime; this is
-- the floor under them, so a status change is never silent even when no engine
-- ran (a lobby that was abandoned, for instance).
create or replace function public.broadcast_game_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status or new.host_id is distinct from old.host_id then
    perform realtime.send(
      jsonb_build_object(
        'sessionId', new.id,
        'status', new.status,
        'hostId', new.host_id,
        'version', new.state_version
      ),
      'game.lobby',
      'game:' || new.id::text,
      true
    );
  end if;

  return null;
end;
$$;

create trigger game_sessions_broadcast_status
  after update on public.game_sessions
  for each row execute function public.broadcast_game_status();

revoke execute on function public.broadcast_game_lobby() from public, anon, authenticated;
revoke execute on function public.broadcast_game_status() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- list_my_game_sessions — the hub
--
-- Every game this person is in or was in, across every conversation, live ones
-- first. The Games page is a place you go rather than a thing you find in one
-- thread, so it needs a view that is not scoped to a room.
-- -----------------------------------------------------------------------------
create or replace function public.list_my_game_sessions(p_limit integer default 20)
returns table (
  id uuid,
  game_key text,
  game_name text,
  status public.game_status,
  conversation_id uuid,
  conversation_title text,
  player_count integer,
  max_players smallint,
  my_seat smallint,
  my_score integer,
  my_placement smallint,
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
    s.conversation_id,
    coalesce(
      c.title,
      (
        select string_agg(pr.display_name, ', ' order by pr.display_name)
        from public.conversation_members m
        join public.profiles pr on pr.id = m.user_id
        where m.conversation_id = c.id
          and m.user_id <> (select auth.uid())
          and m.left_at is null
      )
    ),
    (select count(*)::integer from public.game_players n where n.session_id = s.id and n.left_at is null),
    g.max_players,
    me.seat,
    me.score,
    me.placement,
    s.created_at,
    s.ended_at
  from public.game_players me
  join public.game_sessions s on s.id = me.session_id
  join public.games g on g.key = s.game_key
  left join public.conversations c on c.id = s.conversation_id
  where me.user_id = (select auth.uid())
  order by
    case when s.status in ('lobby', 'active') then 0 else 1 end,
    s.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke execute on function public.list_my_game_sessions(integer) from public, anon;
grant execute on function public.list_my_game_sessions(integer) to authenticated;
