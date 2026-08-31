# Games in KITH

The machinery that every game runs on, and the one interface a new game has to
implement.

**No individual game exists yet.** That is deliberate: building the lobby around
whichever game happened to be written first is how a lobby ends up with that
game's assumptions baked into it. The five rows in the catalogue all ship
`enabled = false`, and the engine registry is empty.

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

The database enforces the same boundary on the HTTP path: `get_game_session`
returns `state` only to somebody seated. A spectator sees that the game exists,
who is playing and the score, and none of its contents.

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
npm run games:test    105 assertions
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

## 10. Not built

- **Any actual game.** By instruction, and by preference: the shelf is honest
  about it, showing every catalogue entry with "Soon" rather than hiding them and
  looking empty.
- **The board.** `Board` in `game-session-view.tsx` is where a game's component
  mounts, keyed by `session.gameKey`. It currently says so plainly rather than
  rendering something that looks broken.
- **Couple games.** The schema supports them (`game_sessions.couple_id`), the
  lifecycle RPCs currently take a conversation. One branch when couples land.
- **Spectator private views.** A spectator gets `publicView` and nothing else,
  which is right for now; a game with per-spectator views (a commentator mode)
  would need `viewFor` to take a role rather than a seat.
- **Scheduled cleanup.** `abandon_stale_games()` exists and nothing calls it on a
  timer yet; it runs opportunistically from `create_game_session`.
