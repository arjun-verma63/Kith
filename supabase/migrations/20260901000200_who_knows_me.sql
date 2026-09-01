-- =============================================================================
-- KITH — 0019 · Who Knows Me Better?
--
-- The second game. Nothing structural: an engine, a catalogue row, and the flag.
-- That is the whole point of the architecture — the lobby, seating, readiness,
-- scoring, the winner screen and rematch were written once and this game
-- inherits all of them.
--
-- `realtime` rather than `turn_based`, because everybody acts at once: the
-- subject picks their true answer while the others guess. `turn_seat` stays
-- null, so the database lets any seat move, and the engine is what stops a
-- guesser answering as though they were the subject.
-- =============================================================================

insert into public.games (key, name, tagline, audience, pace, min_players, max_players, enabled)
values (
  'who-knows-me',
  'Who Knows Me Better?',
  'One of you is the question. The rest had better be paying attention.',
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
-- The audit log was the last way to read a live secret.
--
-- `game_moves` is append-only and readable by anybody who can watch the session,
-- which is right for an audit trail and wrong for a game in progress: a move's
-- payload IS the move. In Would You Rather that means somebody's vote; here it
-- means the subject's answer, which is the entire thing the other players are
-- supposed to be guessing.
--
-- Migration 0018 took the state off the client's read path for exactly this
-- reason, and left the log behind — the state was where the secrets obviously
-- lived, and the log looked like metadata. It is not: it is the same secrets,
-- one row at a time, in the order they were committed.
--
-- Same fix, same reasoning. The timeline stays readable — who moved, when, in
-- what order, which is what an audit trail is for — and the contents do not.
-- The runtime reads payloads with the service role, so replay is unaffected.
-- -----------------------------------------------------------------------------
revoke select on public.game_moves from authenticated;

grant select (session_id, seq, player_id, created_at) on public.game_moves to authenticated;
