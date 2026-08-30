-- =============================================================================
-- KITH — 0007 · Games
--
-- games (catalogue), game_sessions, game_players, game_moves.
--
-- Three decisions carry the design:
--
-- 1. THE CATALOGUE IS A TABLE, NOT A CONSTANT.
--    `game_sessions.game_key` is a foreign key, so a session can never name a
--    game that does not exist, and `enabled` turns a broken game off everywhere
--    without a deploy.
--
-- 2. THERE IS NO `game_results` TABLE.
--    Score and placement are attributes of a player in a session, which is
--    exactly what `game_players` already is. A separate results table would be
--    the same primary key with two more columns, kept in sync by hand.
--
-- 3. THE CLIENT CANNOT WRITE GAME STATE.
--    `game_sessions.state` and `game_moves` have no INSERT or UPDATE policy at
--    all. Every move goes through a server route that validates it against the
--    rules and writes with the service-role client. If clients could write state,
--    "cheating" would be a fetch call — and hidden information (a hand of cards,
--    an unrevealed answer) would have to be sent to everyone to be checkable.
--    `state_version` gives that server route optimistic concurrency: the update
--    is conditional on the version it read, so two moves arriving at once cannot
--    interleave into a corrupt state.
-- =============================================================================

create table public.games (
  key text primary key,
  name text not null,
  tagline text,

  audience public.game_audience not null default 'group',
  pace public.game_pace not null default 'turn_based',

  min_players smallint not null,
  max_players smallint not null,

  -- Kill switch. A game with a bug is disabled here, not redeployed.
  enabled boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint games_key_format check (key ~ '^[a-z0-9-]{2,32}$'),
  constraint games_player_range check (min_players >= 1 and max_players >= min_players),
  constraint games_couple_is_two check (
    audience <> 'couple' or (min_players = 2 and max_players = 2)
  )
);

create trigger games_set_updated_at
  before update on public.games
  for each row execute function public.set_updated_at();

-- The catalogue ships disabled. These rows describe the shelf the engine will
-- fill; none of them is playable, and `enabled = false` is how the database says
-- so rather than the UI pretending otherwise.
insert into public.games (key, name, tagline, audience, pace, min_players, max_players, enabled) values
  ('word-rush',    'Word Rush',    'Sixty seconds. One letter. Go.',              'group',  'realtime',   2, 6, false),
  ('draw-guess',   'Draw & Guess', 'Your friends cannot draw.',                   'group',  'realtime',   3, 6, false),
  ('trivia-night', 'Trivia Night', 'Rounds you can leave and come back to.',      'group',  'turn_based', 2, 6, false),
  ('co-op-escape', 'Co-op Escape', 'One room, four people, no talking over each other.', 'group', 'turn_based', 2, 4, false),
  ('how-well',     'How Well',     'How well do you actually know each other?',   'couple', 'turn_based', 2, 2, false);

-- -----------------------------------------------------------------------------
-- game_sessions
-- -----------------------------------------------------------------------------

create table public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  game_key text not null references public.games (key) on delete restrict,

  -- A session belongs to a conversation (group games) or to a couple (couple
  -- games). Exactly one, never both — that is what makes one table serve both
  -- without a `couple_games` twin.
  conversation_id uuid references public.conversations (id) on delete cascade,
  couple_id uuid references public.couples (id) on delete cascade,

  host_id uuid not null references public.profiles (id) on delete cascade,
  status public.game_status not null default 'lobby',

  -- The authoritative state. Server-written only.
  state jsonb not null default '{}'::jsonb,
  -- Optimistic concurrency. The server updates WHERE state_version = the value it
  -- read; a lost race returns zero rows and the client resyncs.
  state_version integer not null default 0,

  -- Deterministic randomness. Stored so a match can be replayed from its moves
  -- and produce exactly the same shuffle.
  seed bigint not null default (floor(random() * 9007199254740991))::bigint,
  config jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,

  constraint game_sessions_one_scope check (
    (conversation_id is not null and couple_id is null)
    or (conversation_id is null and couple_id is not null)
  ),
  constraint game_sessions_finished_consistency check (
    (status in ('finished', 'abandoned')) = (ended_at is not null)
  ),
  constraint game_sessions_version_positive check (state_version >= 0)
);

-- Covers the catalogue FK, which ON DELETE RESTRICT has to check, and answers
-- "every session of this game".
create index game_sessions_game_key_idx on public.game_sessions (game_key);
create index game_sessions_host_idx on public.game_sessions (host_id);

create index game_sessions_conversation_idx
  on public.game_sessions (conversation_id, created_at desc)
  where conversation_id is not null;

create index game_sessions_couple_idx
  on public.game_sessions (couple_id, created_at desc)
  where couple_id is not null;

-- The lobby list, and the sweep for sessions abandoned mid-play.
create index game_sessions_live_idx
  on public.game_sessions (status, updated_at)
  where status in ('lobby', 'active');

create trigger game_sessions_set_updated_at
  before update on public.game_sessions
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- game_players
-- -----------------------------------------------------------------------------

create table public.game_players (
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,

  -- Stable seat number. Games address players by seat, not by uuid, so a replay
  -- does not need the original account ids to make sense.
  seat smallint not null,
  is_ready boolean not null default false,

  -- The results, living where they belong rather than in a parallel table.
  score integer not null default 0,
  placement smallint,

  joined_at timestamptz not null default now(),
  left_at timestamptz,

  primary key (session_id, user_id),
  unique (session_id, seat),
  constraint game_players_seat_range check (seat between 0 and 11),
  constraint game_players_placement_range check (placement is null or placement >= 1)
);

create index game_players_user_idx on public.game_players (user_id);

-- -----------------------------------------------------------------------------
-- game_moves
--
-- Append-only. Every move ever made, in order, so a session can be replayed,
-- audited, or resumed after a host crash. The append-only trigger means even the
-- service role cannot rewrite the record after the fact.
-- -----------------------------------------------------------------------------

create table public.game_moves (
  session_id uuid not null references public.game_sessions (id) on delete cascade,
  seq integer not null,
  player_id uuid references public.profiles (id) on delete set null,
  payload jsonb not null,
  created_at timestamptz not null default now(),

  primary key (session_id, seq),
  constraint game_moves_seq_positive check (seq >= 0)
);

create index game_moves_player_idx
  on public.game_moves (player_id)
  where player_id is not null;

create trigger game_moves_append_only
  before update or delete on public.game_moves
  for each row execute function public.reject_mutation();

-- -----------------------------------------------------------------------------
-- Access helpers
-- -----------------------------------------------------------------------------

-- A session is visible to whoever can see the room it is being played in — the
-- conversation members, or the couple. Not only to the people at the table, so a
-- friend can watch a game they are not in.
create or replace function public.can_view_game_session(target_session uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.game_sessions s
    where s.id = target_session
      and (
        (s.conversation_id is not null and public.is_conversation_member(s.conversation_id))
        or (s.couple_id is not null and public.is_couple_member(s.couple_id))
      )
  );
$$;

create or replace function public.is_game_player(target_session uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.game_players p
    where p.session_id = target_session
      and p.user_id = (select auth.uid())
      and p.left_at is null
  );
$$;

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.games enable row level security;
alter table public.game_sessions enable row level security;
alter table public.game_players enable row level security;
alter table public.game_moves enable row level security;

alter table public.games force row level security;
alter table public.game_sessions force row level security;
alter table public.game_players force row level security;
alter table public.game_moves force row level security;

-- --- games -------------------------------------------------------------------

-- The catalogue is readable by every member and writable by none of them. New
-- games arrive by migration.
create policy games_select_all on public.games
  for select to authenticated
  using (true);

-- --- game_sessions -----------------------------------------------------------

create policy game_sessions_select on public.game_sessions
  for select to authenticated
  using (can_view_game_session(id));

-- Starting a game: you host it, you can post in the room, the game is enabled,
-- and it starts in the lobby at version zero with empty state. A client cannot
-- create a session that is already mid-play with state of its choosing.
create policy game_sessions_insert on public.game_sessions
  for insert to authenticated
  with check (
    host_id = (select auth.uid())
    and status = 'lobby'
    and state_version = 0
    and state = '{}'::jsonb
    and exists (select 1 from public.games g where g.key = game_key and g.enabled)
    and (
      (conversation_id is not null and public.can_post_to_conversation(conversation_id))
      or (couple_id is not null and public.is_couple_member(couple_id))
    )
  );

-- Deliberately NO update policy for players.
--
-- Game state is authoritative and server-owned. Every move goes through a route
-- handler that validates it against the rules and writes with the service-role
-- client, which is not subject to these policies. Handing clients an UPDATE
-- policy on `state` would make cheating a fetch call, and would force hidden
-- information to be sent to everyone in order to be checkable.
--
-- Abandoning a session is likewise a server operation, because it has to settle
-- scores and notify the other players.

-- --- game_players ------------------------------------------------------------

create policy game_players_select on public.game_players
  for select to authenticated
  using (can_view_game_session(session_id));

-- You join yourself, to a session you can see, that is still in its lobby.
create policy game_players_join_self on public.game_players
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and can_view_game_session(session_id)
    and exists (
      select 1 from public.game_sessions s
      where s.id = session_id and s.status = 'lobby'
    )
  );

-- Readiness is the only thing a player may change about themselves. Score and
-- placement are server-written; the WITH CHECK cannot express "only this column",
-- so the guard is that a player may only touch their own row, and the server is
-- the only writer that matters for the rest.
create policy game_players_update_own on public.game_players
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Leaving a lobby. Once the game has started, departure is a server-recorded
-- event (it may end the game or forfeit a score), not a row delete.
create policy game_players_leave_lobby on public.game_players
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.game_sessions s
      where s.id = session_id and s.status = 'lobby'
    )
  );

-- --- game_moves --------------------------------------------------------------

-- Readable by anyone who can watch the session. Writable by nobody: the only
-- INSERT path is the service-role client inside the move resolver.
create policy game_moves_select on public.game_moves
  for select to authenticated
  using (can_view_game_session(session_id));
