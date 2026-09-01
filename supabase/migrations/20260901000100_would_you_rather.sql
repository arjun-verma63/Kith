-- =============================================================================
-- KITH — 0018 · Would You Rather, and a hole it exposed
--
-- The first game with hidden information, and the first thing to notice that
-- migration 0017's read path did not actually hide any.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The game.
--
-- Two to six. Everybody answers at once, so it is `realtime` rather than
-- turn-based — `turn_seat` stays null throughout and the database lets any seat
-- move, which is correct for a game where everybody moves together.
--
-- Enabled, because unlike the other five this one has an engine behind it. Both
-- are required: the flag is a kill switch, the registry is what makes the rules
-- exist.
-- -----------------------------------------------------------------------------
insert into public.games (key, name, tagline, audience, pace, min_players, max_players, enabled)
values (
  'would-you-rather',
  'Would You Rather',
  'Two bad options. Find out who you actually know.',
  'group',
  'realtime',
  2,
  6,
  true
)
on conflict (key) do update
  set name = excluded.name,
      tagline = excluded.tagline,
      pace = excluded.pace,
      min_players = excluded.min_players,
      max_players = excluded.max_players,
      enabled = excluded.enabled;

-- -----------------------------------------------------------------------------
-- Closing a hole in migration 0017.
--
-- `get_game_session` returned the FULL raw state to anybody seated at the table.
-- For a game with no secrets that is harmless. For this one it means a player
-- could fetch the session over HTTP mid-round and read everybody else's answer
-- before the reveal — which is the entire game.
--
-- The broadcast path was already correct: `broadcast_game` sends the engine's
-- `publicView` to the table and each player's `viewFor` down their own channel.
-- The HTTP path simply bypassed all of that, because SQL cannot run an engine
-- and so could not redact anything.
--
-- The fix is to stop trying. `state` is removed from this function's result
-- entirely, and the server component asks the runtime — which CAN run the engine
-- — for the same two views the socket would have sent. One place decides what is
-- visible, in one language, for every game.
--
-- A function's return type cannot be changed in place, hence the drop.
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
  conversation_id uuid,
  host_id uuid,
  status public.game_status,
  -- No `state` column. Deliberately. See above.
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

-- -----------------------------------------------------------------------------
-- And the same hole, one row over.
--
-- `game_sessions_select` lets any conversation member SELECT the session row,
-- which includes `state`. The RPC above no longer leaks it; a plain
-- `select * from game_sessions` still would.
--
-- Column-level privileges close it properly: the row stays readable — the lobby
-- list needs status, host and timestamps — and the one column that carries
-- secrets is simply not grantable to a client. The runtime reads it with the
-- service role, which column grants do not restrict.
-- -----------------------------------------------------------------------------
revoke select on public.game_sessions from authenticated;

grant select (
  id,
  game_key,
  conversation_id,
  couple_id,
  host_id,
  status,
  state_version,
  turn_seat,
  seed,
  config,
  rematch_of,
  created_at,
  updated_at,
  started_at,
  ended_at
) on public.game_sessions to authenticated;
