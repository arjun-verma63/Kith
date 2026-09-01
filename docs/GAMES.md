# Games in KITH

The machinery that every game runs on, and the one interface a new game has to
implement.

**One game is built: Would You Rather** (§10). The other five catalogue rows
still ship `enabled = false` and show on the shelf as "Soon" — a game becomes
playable only when it has both a registered engine and an enabled row.

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
npm run games:test    108 assertions — the machinery
npm run wyr:test      100 assertions — Would You Rather
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

## 10. Would You Rather

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

## 11. Not built

- **The other five games.** The shelf shows them as "Soon" rather than hiding
  them and looking empty.
- **Couple games.** The schema supports them (`game_sessions.couple_id`), the
  lifecycle RPCs currently take a conversation. One branch when couples land.
- **Spectator private views.** A spectator gets `publicView` and nothing else,
  which is right for now; a game with per-spectator views (a commentator mode)
  would need `viewFor` to take a role rather than a seat.
- **Scheduled cleanup.** `abandon_stale_games()` exists and nothing calls it on a
  timer yet; it runs opportunistically from `create_game_session`.
