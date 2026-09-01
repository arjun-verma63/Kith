-- =============================================================================
-- KITH — 0020 · Draw & Guess
--
-- The third game. Like the second, nothing structural: an engine, a catalogue
-- row, a board.
--
-- Worth recording that this one adds no schema AT ALL despite being the most
-- data-heavy game by a wide margin. A hand moving across a canvas makes dozens
-- of points a second, and none of them are here — strokes are broadcast client
-- to client on `game:{id}` and never stored, the same class of thing as a typing
-- indicator (docs/ARCHITECTURE.md §6). What the database holds is what decides
-- an outcome: the word, the guesses, the scores.
--
-- Three players minimum. Two would mean one person drawing for one person
-- guessing, which is a drawing lesson rather than a game.
-- =============================================================================

insert into public.games (key, name, tagline, audience, pace, min_players, max_players, enabled)
values (
  'draw-guess',
  'Draw & Guess',
  'Your friends cannot draw. Prove it.',
  'group',
  'realtime',
  3,
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
