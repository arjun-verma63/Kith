# Games in KITH

The machinery that every game runs on, and the one interface a new game has to
implement.

**Four games are built** (§10): Would You Rather, Who Knows Me Better?,
Draw & Guess, and How Well Do You Know Me? — the first for couples. The
remaining catalogue rows still ship `enabled = false` and show on the shelf as
"Soon"; a game becomes playable only when it has both a registered engine and an
enabled row.

---

## 1. The one rule

**A client cannot author game state.**

`game_sessions.state` and `game_moves` have no client-facing write path — INSERT,
UPDATE and DELETE are revoked from `authenticated`. The two functions that do
write are executable by the service role alone.

If that were not true:

- Cheating would be a fetch call. Not a clever exploit — a `POST`.
- Hidden information could not be hidden. A hand of cards or an unrevealed answer
  would have to be sent to every player in order for anyone to check a move
  against it, which is the same as not hiding it.

Everything below follows from that one rule.

---

## 2. Where validation happens

A game's rules are code, not SQL. "Is this a legal move in Word Rush" is a
question only that game can answer, and writing it in Postgres would mean
maintaining each game twice in two languages that would drift.

So validation is split, and the split is the architecture:

|                  | Answers                 | Where it runs                                 |
| ---------------- | ----------------------- | --------------------------------------------- |
| **The engine**   | Is this move LEGAL?     | TypeScript, `server-only`, never in a browser |
| **The database** | Is this move PERMITTED? | SQL, for every game, without knowing which    |

"Permitted" means: you are in this game, the game is running, it is your turn,
and the state you computed from is still the current one. **None of that needs to
know what game it is**, so all of it is enforced once and inherited by every game
ever added.

The order a move goes through:

```
  browser ─── payload (unknown) ───▶ server action
                                       │
                                       │  1. can this person see the session?
                                       │     (read through THEIR client — RLS)
                                       ▼
                                     runtime  (server-only)
                                       │
                                       │  2. validateMove: is this a move at all?
                                       │  3. reduce: is it legal? what happens?
                                       ▼
                                  commit_game_move  (service role only)
                                       │
                                       │  4. seated? active? your turn?
                                       │     version still current?
                                       ▼
                                  state written, move appended, broadcast
```

Steps 1 and 4 do not trust steps 2 and 3. The route is the only component that
_can_ run the engine; that does not make it a component whose word is taken.

---

## 3. Turn order lives in a column

`game_sessions.turn_seat` is a `smallint`, not a field inside the state blob.

The blob is opaque to Postgres by design, so anything inside it is unenforceable
— every game would have to be trusted to check whose turn it was, and "it is not
your turn" is exactly the rule an attacker goes at first.

One small game-agnostic column moves it into the database. The engine says who is
next; `commit_game_move` checks it before any game code runs. `null` means the
game has no turns — a realtime game where everybody acts at once — which is a
real answer rather than an absent one.

---

## 4. Two moves at once

`state_version` gives optimistic concurrency. Every write is conditional on the
version the engine read; a lost race raises `stale_state`, and the client
resyncs and tries again against what is now true.

That is a normal event, not an error. Two people pressing a button in the same
tick is what a multiplayer game _is_, and resolving it by "whoever's render
happened last" would corrupt the state silently.

---

## 5. Hidden information

One state, two audiences:

```
                    engine.publicView(state)
  game:{sessionId} ◀──────────────────────────  everybody who can see the room
                                                (spectators included)

                    engine.viewFor(state, seat)
  user:{userId}    ◀──────────────────────────  one player, their eyes only
```

`broadcast_game` does the split. The engine decides it.

An engine that returns the whole state from `publicView` has published its own
secrets, and no amount of care in the transport will fix that — which is why
`publicView` and `viewFor` are separate methods rather than one with a flag.

### The HTTP path had to be fixed too

`get_game_session` originally returned the raw state to anybody seated at the
table. For a game with no secrets that is harmless — and every game was
hypothetical when it was written. The first game with hidden answers made it a
hole: a player could fetch the session mid-round and read everybody's vote
before the reveal.

SQL cannot run an engine, so it cannot redact anything, and no amount of policy
writing fixes that. Migration 0018 takes the state off that path entirely:

- `get_game_session` has no `state` column.
- `authenticated` has a column-level `SELECT` grant on `game_sessions` that
  omits `state`, so a plain `select *` is refused too.
- The server component calls `viewsForRender`, which runs the engine and returns
  the same public/private split the socket sends.

One place decides what is visible, in one language, for every game. A spectator
sees that the game exists, who is playing and the score, and none of its
contents.

### And the audit log was the same hole, one table over

`game_moves` is append-only and readable by anybody who can watch the session,
which is right for an audit trail and wrong for a game in progress. **A move's
payload IS the move** — somebody's vote in Would You Rather, the subject's own
answer in Who Knows Me Better. A guesser could simply `select payload from
game_moves` mid-round.

Migration 0018 took the state off the client's read path and left this behind,
because the state was where the secrets obviously lived and the log looked like
metadata. It is not: it is the same secrets, one row at a time, in commit order.

Migration 0019 applies the same fix. The timeline stays readable — who moved,
when, in what order — and the payload column is simply not granted:

```sql
revoke select on public.game_moves from authenticated;
grant select (session_id, seq, player_id, created_at) on public.game_moves to authenticated;
```

The runtime reads payloads with the service role, so replay is unaffected.

---

## 6. Adding a game

Three steps. Nothing else changes — not the lobby, not the seating, not the turn
indicator, the scoreboard, the winner screen or rematch.

**1. Implement the interface** in `src/features/games/engine/games/<key>.ts`:

```ts
import { registerEngine } from "@/features/games/engine/registry";
import type { GameEngine } from "@/features/games/engine/types";

interface State { /* whatever survives JSON */ }
interface Move { /* whatever a turn is */ }

const engine: GameEngine<State, Move> = {
  key: "word-rush",

  createInitialState({ players, seed, config }) { … },
  initialTurnSeat: () => 0,          // or null for a realtime game

  validateMove(payload) { … },       // unknown → Move, or null
  reduce(state, move, { seat }) { … },

  publicView: (state) => ({ … }),    // no secrets here
  viewFor: (state, seat) => ({ … }), // that player's own view
  scores: (state) => state.scores,
};

registerEngine(engine);
```

**2. Import it** in `src/features/games/engine/index.ts`.

**3. Enable its catalogue row** in a migration:

```sql
update public.games set enabled = true where key = 'word-rush';
```

Both are required. The flag is a kill switch that takes a broken game off the
shelf without a deploy; the registry is what makes the rules exist at all. Either
one alone would leave a game half-available.

### The rules an engine must follow

- **Pure.** No clock, no randomness, no network, no storage. Everything variable
  is passed in — `seed` for shuffling, `now` for timing. That is what makes a
  session replayable from its move log, and every rule testable without a
  database.
- **Never in a browser.** Enforced by `server-only` on the runtime that loads it.
- **`publicView` publishes.** Anything it returns is visible to every spectator.

---

## 7. The lifecycle

```
   create_game_session ──▶ lobby ──▶ start_game_session ──▶ active
                             │                                 │
                             │ leave (row deleted)             │ commit_game_move ↺
                             │                                 │
                             ▼                                 ▼
                         abandoned                     finished / abandoned
                                                              │
                                                              ▼
                                                     create_game_session
                                                        (rematch_of)
```

**Inviting** is not a separate step. A game belongs to a conversation, so opening
one invites everybody in the room — `notify_game_invite` fires on the session
insert. Choosing where to play is choosing who to play with, which is also what
gives the game a place to talk while it happens.

**One live session per game per conversation.** An advisory lock makes a
double-clicked Start join the lobby that already exists rather than opening a
rival one and splitting the group between them.

**Seats are the lowest free number**, not the next highest, so a lobby somebody
left and rejoined has no holes in it. Games address players by seat, and a gap in
the middle is a class of off-by-one bugs in code nobody has written yet.

**Leaving a lobby deletes the row** — nothing has happened, so nothing needs
remembering. **Leaving a game in progress records it**: `left_at` is set, the
score stands, the host role passes to the next seat, and if the table drops below
the game's minimum the session is abandoned.

**A rematch is a new session**, threaded to the old one by `rematch_of`. The
finished game keeps its scores and its move log; a rematch is the next game, not
the same game with its memory wiped.

---

## 8. What the client holds

Nothing authoritative. `useGameSession` is a mirror:

- `session` — from the server, refetched when the lobby changes.
- `view.publicState` — off the `game:{id}` channel.
- `view.privateState` — off `user:{id}`, this player's alone.

Every broadcast carries a version. Out-of-order arrivals are dropped, because
broadcast delivery is not ordered end to end and a stale board is worse than a
slightly late one.

Public state is server-rendered, so a refresh mid-game shows the board before any
socket connects. A private view only ever travels over a socket, so a client that
reconnects asks for one — `resyncGameAction`, which re-checks visibility through
the caller's own identity before touching the runtime.

---

## 9. Testing

```
npm run games:test    109 assertions — the machinery
npm run wyr:test      102 assertions — Would You Rather
npm run wkm:test      112 assertions — Who Knows Me Better?
npm run draw:test     125 assertions — Draw & Guess, including the wire protocol
npm run howwell:test   95 assertions — How Well, and the couple scope
```

Mostly negative, and aimed at the seam rather than the surface. Can somebody not
in the game write to it? Can a player move out of turn? Can two moves at once
corrupt the state? Can a spectator read a hand of cards? Can a client call
`commit_game_move` directly?

A reference engine lives **in the test file**, not in `src/` — a two-player game
where each person holds a secret number. It exists to prove the interface is
implementable and that the halves fit, and it is driven through exactly the path
production uses: JavaScript computes the next state, SQL commits it. The secret
is the point; a game with nothing hidden would never exercise the public/private
split, which is the part that is hard to get right and impossible to notice
getting wrong.

It also evaluates the `game:{id}` channel policies for real — a player may
subscribe and broadcast, a spectator may subscribe but not broadcast, and an
outsider may do neither.

---

## 10. The games

### Would You Rather

The first game, and the one that proved the architecture by breaking part of it.

Two options, everybody answers at once, nothing is visible until the round
closes. **Scoring is majority-matching** — there is no right answer to "would
you rather", so the game asks a different question: are you in step with this
room? A streak of three starts paying a bonus. An even split scores everybody,
because nobody is out of step with a room that cannot agree.

Notable pieces, all of which the machinery already supported:

- **Simultaneous, not turn-based.** `turnSeat` stays null, so the database lets
  any seat move. That puts the duplicate check on the engine, which refuses a
  second answer from a seat that has already answered — locked in, so nobody can
  watch the count fill and switch at the last moment.
- **The timer is closed by the clients.** An engine is pure and cannot see a
  clock, so when the deadline passes every client asks for a reveal at once and
  `state_version` settles which one lands. The engine validates the deadline
  against the server's `now`, with a 2.5-second grace so a fast laptop does not
  cost somebody their answer.
- **The last answer reveals immediately** rather than waiting out a timer nobody
  is waiting for.
- **Prompts come from the seed.** Deterministic shuffle, no repeats within a
  session, so a session replays identically from its move log.
- **Leaving needs no special case.** The runtime hands the engine only the
  players still present, so a departure changes the tally and nothing else.

### Who Knows Me Better?

One person is the subject; a question is asked about them; they pick the true
answer while everybody else guesses it. Reveal together, score the people who
knew, rotate.

**It hides two things, not one, and that is the whole difference.** Would You
Rather hides each person's own answer from everybody. This hides:

- the subject's answer, from the guessers — or there is nothing to guess;
- every guess, from everybody **including the subject** — or the subject can
  pick whatever the room already committed to, and the round is a formality.

The second is the one that is easy to get wrong, because letting the subject see
how the room is leaning feels harmless. `viewFor(subjectSeat)` returning an
empty `guesses` map is asserted directly.

Other decisions worth the words:

- **The subject does not score.** They are the question, not a player of it —
  which is only fair if everybody is the subject the same number of times, so the
  round count is always a whole number of laps. Two players get two laps, six get
  one.
- **A round with no answer is void, not lost.** If the subject times out there is
  nothing to be right about, so nobody scores — and, importantly, nobody's streak
  is broken by somebody else's silence.
- **Option order is shuffled per round.** An answer that is always third is not a
  secret.
- **The rotation steps over people who have left.** A subject who is gone cannot
  answer, so the round would be unanswerable.
- Indices are stored canonically and converted to display positions in one place,
  so the shuffle can never make the state and the UI disagree about which option
  was picked.

### Draw & Guess

One person gets a word and draws it; everybody else types guesses into the
game's chat. Correct guesses score by how fast they arrive, the drawer scores by
how many people got there, and the pencil passes on.

**The drawing does not go through the move pipeline, and that is the whole
design.** A hand moving across a canvas makes dozens of points a second. Through
the engine each one would be a row in an append-only log, a rewrite of the state
blob and a version bump racing every other player — for data that is worthless
the moment the round ends.

So strokes are **broadcast client to client and never stored**, the same class of
thing as a typing indicator (§ARCHITECTURE 6). What stays authoritative is
everything that decides an outcome: the word, the guesses, who was right, when.
Migration 0020 adds no schema at all despite this being by far the most
data-heavy game.

#### Four things that make the stream small

`features/games/canvas.ts` is the protocol, and it is pure so all of it is
tested:

1. **Vectors, not pixels.** A stroke is a handful of numbers; a PNG of it is tens
   of kilobytes.
2. **A normalised 0–1023 integer grid.** Smaller on the wire than floats, and —
   the real reason — resolution-independent, so a phone and a laptop draw the
   same picture rather than one scaled wrongly.
3. **Simplification.** Points closer than six grid units to the last kept one are
   dropped. A slow, deliberate line is where the point count explodes and where
   the extra points carry nothing.
4. **Batching.** Points accumulate and flush on a 60ms timer. Same trick as
   trickle ICE, same reason: the free tier has a monthly message allowance.

The suite measures it rather than asserting it in a comment — a realistic
four-second stroke, counted against what one-broadcast-per-pointer-event would
cost.

#### Reconnecting

Strokes are never stored, so a guesser who refreshes has nothing to fetch. They
broadcast `draw.request` and the drawer — who still holds the whole picture —
replies with a snapshot. No server storage, one message.

#### Two other decisions

- **Guessing is chat, and chat is a move.** A few per player per round, so the
  cost is nothing and correctness is decided server-side. A client that judged
  its own guesses would be a client that always guessed correctly.
- **A correct guess is never echoed.** Publishing it hands the word to everybody
  still guessing, so the chat says "Ada got it" and the word waits for the
  reveal.

#### The one thing a client has to police

The `game:{id}` write policy allows any player to broadcast, because SQL cannot
know which of them is drawing this round. Stroke events from anybody who is not
the current drawer are therefore ignored client-side. The worst a mischievous
player can do is send messages nobody applies — worth knowing, and written down
rather than discovered.

### How Well Do You Know Me?

The first **couple** game, and the first one with no winner.

Each round asks about one of the two. That person answers honestly, the other
guesses what they said, both submit at once, and the answers appear together.
Next round it is about the other one.

#### There is no winner, deliberately

Every other game here ranks its players. This one must not. Two people who are
together, playing a game that ends by telling one of them they know the other
better than they are known, is a subtly hostile object — and the thing they
actually want to find out is a fact about the pair.

So **the score is shared**: one number, both seats carrying it, both listed as
winners, and a result panel built around a single figure rather than a table.
The engine returns `winnerSeats: [0, 1]` on purpose.

The generic winner panel would announce that both people won — true, and
completely the wrong tone — so a game may now supply its own ending. `hasOwnResult`
in the board registry is that seam; everything else keeps the shared panel.

#### Playful, not a measurement

The brief was explicit, so it is **asserted rather than intended**. The result
comes back as a band with a joke attached ("Suspiciously perfect", "Have you two
met?") rather than a percentage with a verdict, the panel carries a line saying
outright that it measures nothing, and the suite greps the copy for clinical
language — `compatib`, `psycholog`, `percentile`, `healthy`, `concern`. A number
that looks scientific invites people to believe it, and this is a multiple-choice
quiz about holidays.

#### Both act every round

Which is the difference from Who Knows Me Better, where the subject sits out.
With exactly two people, somebody sitting out is half the room doing nothing.

## 11. The couple scope

`game_sessions` has had two scopes since migration 0007 — a conversation **or** a
couple, exactly one, which is what lets one table, one engine and one set of
policies serve both. Migration 0017 built the lifecycle and only handled
conversations; migration 0022 finished it.

Almost nothing new was needed, which is the point. `can_view_game_session`
already understood couples, so joining, readiness, starting, moving, scoring,
leaving and rematching all worked unchanged. What was missing was a way to
**open** one:

- `create_couple_game(couple_id, game_key)` seats both partners immediately —
  there is no lobby to fill when the guest list is two people who are both
  already known. They still ready up, which is how you say you are at your desk.
- The catalogue decides what a couple may play: `audience = 'couple'`, enforced
  in SQL rather than by the UI offering the right list.
- `get_game_session` gained `couple_id`, because rematch reopens a session in the
  scope it was played in and had nowhere to look.
- `list_couple_games` is the history, and takes `max(score)` rather than a sum —
  a co-operative game writes the same number to both rows.

Couple games are offered on the **couple page**, not the games shelf. Putting one
beside Draw & Guess would mean asking "who do you want to play this with", which
is the one question it does not have.

## 12. Not built

- **The other five games.** The shelf shows them as "Soon" rather than hiding
  them and looking empty.
- **Couple games.** The schema supports them (`game_sessions.couple_id`), the
  lifecycle RPCs currently take a conversation. One branch when couples land.
- **Spectator private views.** A spectator gets `publicView` and nothing else,
  which is right for now; a game with per-spectator views (a commentator mode)
  would need `viewFor` to take a role rather than a seat.
- **Scheduled cleanup.** `abandon_stale_games()` exists and nothing calls it on a
  timer yet; it runs opportunistically from `create_game_session`.
