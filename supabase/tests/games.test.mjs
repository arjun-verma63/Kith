/**
 * Game architecture tests.
 *
 * The claim this phase makes is that a client cannot author game state. That is
 * worth a lot of scrutiny, because if it is false then cheating is a fetch call
 * and every game built on top of this inherits the hole.
 *
 * So most of what follows is negative, and it is aimed at the seam rather than
 * the surface: not "does the lobby work" but "can somebody who is not in this
 * game write to it", "can a player move out of turn", "can two moves at once
 * corrupt the state", "can a spectator read a hand of cards".
 *
 * The engine half runs for real. A tiny reference game is defined here — not
 * shipped, because the brief says no individual games yet — and driven through
 * exactly the path production uses: JavaScript computes the next state, SQL
 * commits it. That is the only way to show the two halves actually fit.
 *
 *     npm run games:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, asUserOnTopic, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

// Importing the index registers every engine, which is how the application
// learns what is playable. The catalogue has to agree with it.
const { registeredKeys } = await import("../../src/features/games/engine/index.ts");
const ENGINE_KEYS = registeredKeys();

let passed = 0;
let failed = 0;
const failures = [];

const ok = (n) => {
  passed += 1;
  console.log(`  ✓ ${n}`);
};
const bad = (n, d) => {
  failed += 1;
  failures.push(`${n} — ${d}`);
  console.log(`  ✗ ${n}\n      ${d}`);
};
const eq = (n, a, e) =>
  JSON.stringify(a) === JSON.stringify(e)
    ? ok(n)
    : bad(n, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const truthy = (n, v, d = "expected a truthy value") => (v ? ok(n) : bad(n, d));
const section = (t) => console.log(`\n${t}`);

async function denied(name, promise) {
  try {
    const result = await promise;
    if (result?.rows?.length === 0 || result?.affectedRows === 0) {
      ok(`${name} (no rows)`);
      return;
    }
    bad(name, `expected a refusal, got ${JSON.stringify(result?.rows ?? result)}`);
  } catch (error) {
    ok(`${name} (${error.message.split("\n")[0].slice(0, 55)})`);
  }
}

async function allowed(name, promise) {
  try {
    await promise;
    ok(name);
  } catch (error) {
    bad(name, error.message.split("\n")[0]);
  }
}

console.log("KITH — game architecture\n");

/* ==========================================================================
 * A reference engine.
 *
 * Deliberately not in src/: the brief is architecture without games. This exists
 * to prove the interface is implementable and that the pieces fit — a two-player
 * turn game where each player holds a secret number and scores by guessing.
 *
 * The secret is the point. A game with nothing hidden would never exercise the
 * split between what everybody sees and what one player sees, which is the part
 * that is hard to get right and impossible to notice getting wrong.
 * ========================================================================== */

const referenceEngine = {
  key: "reference",

  createInitialState({ players, seed }) {
    return {
      turn: 0,
      round: 0,
      // Derived from the seed, so the same session replays identically.
      secrets: Object.fromEntries(players.map((p) => [p.seat, (seed + p.seat * 7) % 10])),
      guesses: [],
      scores: Object.fromEntries(players.map((p) => [p.seat, 0])),
    };
  },

  initialTurnSeat: () => 0,

  validateMove(payload) {
    if (typeof payload !== "object" || payload === null) return null;
    const guess = payload.guess;
    return typeof guess === "number" && Number.isInteger(guess) && guess >= 0 && guess <= 9
      ? { guess }
      : null;
  },

  reduce(state, move, { seat, players }) {
    const opponent = players.find((p) => p.seat !== seat);
    if (!opponent) return { ok: false, reason: "Nobody to play against." };

    const correct = state.secrets[opponent.seat] === move.guess;
    const scores = { ...state.scores, [seat]: state.scores[seat] + (correct ? 1 : 0) };
    const round = state.round + 1;

    const next = {
      ...state,
      round,
      scores,
      guesses: [...state.guesses, { seat, guess: move.guess, correct }],
    };

    // Three rounds, then it is over.
    if (round >= 3) {
      const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
      const best = ranked[0][1];
      const winners = ranked.filter(([, v]) => v === best).map(([k]) => Number(k));

      return {
        ok: true,
        state: next,
        turnSeat: null,
        outcome: {
          scores,
          placements: Object.fromEntries(ranked.map(([k, v]) => [Number(k), v === best ? 1 : 2])),
          winnerSeats: winners,
        },
      };
    }

    const nextSeat = players.find((p) => p.seat !== seat)?.seat ?? seat;
    return { ok: true, state: next, turnSeat: nextSeat };
  },

  // The secrets never leave the server in the public view. This is the single
  // most important line in any engine that has hidden information.
  publicView: (state) => ({
    round: state.round,
    scores: state.scores,
    guesses: state.guesses,
  }),

  viewFor: (state, seat) => ({
    round: state.round,
    scores: state.scores,
    guesses: state.guesses,
    mySecret: state.secrets[seat],
  }),

  scores: (state) => state.scores,
};

/* ========================================================================== */

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");
const wren = await createUser(db, "wren");

for (const [a, b] of [
  [ada, rafa],
  [ada, wren],
  [rafa, wren],
]) {
  await asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
    a < b ? a : b,
    a < b ? b : a,
  ]);
}

const { rows: groupRows } = await asUser(db, ada, "select public.start_group($1, $2) as id", [
  "Games night",
  [rafa, wren],
]);
const room = groupRows[0].id;

// The catalogue ships entirely disabled. Enabling one is how a game becomes
// playable, and doing it here also proves the kill switch is load-bearing.
await asService(
  db,
  `insert into public.games (key, name, tagline, audience, pace, min_players, max_players, enabled)
   values ('reference', 'Reference', 'A game for testing the machinery.', 'group', 'turn_based', 2, 3, true)`,
);

/* ==========================================================================
 * 1 · The catalogue
 * ========================================================================== */

section("The catalogue");

{
  const { rows } = await asUser(db, ada, "select * from public.list_games()");
  truthy("every member can read the shelf", rows.length > 0);

  /*
   * A game is playable only when both are true: an engine is registered, and the
   * catalogue row is enabled. Asserted against the registry itself rather than a
   * list of names — the list was wrong within a day of being written, and this
   * is the actual rule.
   *
   * "reference" is this suite's own row and has no engine in `src/`, so it is
   * excluded from the comparison.
   */
  const enabled = rows
    .filter((g) => g.enabled && g.key !== "reference")
    .map((g) => g.key)
    .sort();

  eq("exactly the games with engines are enabled", enabled, [...ENGINE_KEYS].sort());
  truthy("and there is at least one", enabled.length > 0);
  eq(
    "everything else stays on the shelf as coming",
    rows.filter((g) => !g.enabled).every((g) => !ENGINE_KEYS.includes(g.key)),
    true,
  );

  await denied(
    "a member cannot add a game",
    asUser(
      db,
      ada,
      "insert into public.games (key, name, min_players, max_players) values ('cheat', 'Cheat', 1, 2)",
    ),
  );
  await denied(
    "nor enable one",
    asUser(db, ada, "update public.games set enabled = true where key = 'word-rush'"),
  );
}

/* ==========================================================================
 * 2 · Opening a lobby
 * ========================================================================== */

section("Creating a session");

await denied(
  "an outsider cannot start a game in a room they are not in",
  asUser(db, nour, "select public.create_game_session($1, 'reference') as id", [room]),
);

await denied(
  "nobody can start a disabled game",
  asUser(db, ada, "select public.create_game_session($1, 'word-rush') as id", [room]),
);

const { rows: created } = await asUser(
  db,
  ada,
  "select public.create_game_session($1, 'reference') as id",
  [room],
);
const lobby = created[0].id;
truthy("a member can open a lobby", Boolean(lobby));

{
  const { rows } = await asService(
    db,
    "select status, host_id, state, state_version, turn_seat from public.game_sessions where id = $1",
    [lobby],
  );
  eq("it starts in the lobby", rows[0].status, "lobby");
  eq("hosted by whoever opened it", rows[0].host_id, ada);
  eq("with empty state", rows[0].state, {});
  eq("at version zero", rows[0].state_version, 0);
  eq("and nobody's turn", rows[0].turn_seat, null);

  const { rows: seats } = await asService(
    db,
    "select user_id, seat from public.game_players where session_id = $1",
    [lobby],
  );
  eq("the host is seated", seats.length, 1);
  eq("at seat zero", seats[0].seat, 0);

  // Double-click: one lobby, not two.
  const { rows: again } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'reference') as id",
    [room],
  );
  eq("starting twice joins the lobby that already exists", again[0].id, lobby);

  const { rows: live } = await asService(
    db,
    "select count(*)::int as n from public.game_sessions where conversation_id = $1 and status = 'lobby'",
    [room],
  );
  eq("so the room has exactly one open lobby", live[0].n, 1);
}

/* ==========================================================================
 * 2b · Inviting
 *
 * There is no separate invite step, and that is the design: a game belongs to a
 * conversation, so opening one invites everybody already in the room. Choosing
 * where to play IS choosing who to play with.
 * ========================================================================== */

section("Inviting");

{
  const { rows } = await asService(
    db,
    `select user_id, actor_id, payload from public.notifications
      where kind = 'game_invite' and payload->>'session_id' = $1
      order by user_id`,
    [lobby],
  );

  eq("everybody else in the room is invited", rows.length, 2);
  eq(
    "and not the person who started it",
    rows.some((r) => r.user_id === ada),
    false,
  );
  eq(
    "each invitation names them",
    rows.every((r) => r.actor_id === ada),
    true,
  );
  eq(
    "and names the game",
    rows.every((r) => r.payload.game_key === "reference"),
    true,
  );
  eq(
    "the invited are exactly the other members",
    rows.map((r) => r.user_id).sort(),
    [rafa, wren].sort(),
  );
}

/* ==========================================================================
 * 3 · Seating
 * ========================================================================== */

section("Joining");

await denied(
  "an outsider cannot take a seat",
  asUser(db, nour, "select public.join_game_session($1)", [lobby]),
);

{
  const { rows } = await asUser(db, rafa, "select public.join_game_session($1) as seat", [lobby]);
  eq("a member takes the lowest free seat", rows[0].seat, 1);

  const { rows: repeat } = await asUser(db, rafa, "select public.join_game_session($1) as seat", [
    lobby,
  ]);
  eq("joining twice is idempotent", repeat[0].seat, 1);

  const { rows: third } = await asUser(db, wren, "select public.join_game_session($1) as seat", [
    lobby,
  ]);
  eq("and the next person gets the next seat", third[0].seat, 2);
}

{
  // The reference game seats three. A fourth has nowhere to sit.
  const fourth = await createUser(db, "kai");
  await asService(
    db,
    "insert into public.conversation_members (conversation_id, user_id) values ($1, $2)",
    [room, fourth],
  );

  await denied(
    "a full lobby turns people away",
    asUser(db, fourth, "select public.join_game_session($1)", [lobby]),
  );
}

/* ==========================================================================
 * 4 · Readiness
 * ========================================================================== */

section("Ready");

{
  const { rows: before } = await asUser(db, ada, "select public.can_start_game($1) as yes", [
    lobby,
  ]);
  eq("a lobby where nobody is ready cannot start", before[0].yes, false);

  await allowed(
    "a player readies up",
    asUser(db, ada, "select public.set_game_ready($1, true)", [lobby]),
  );

  await denied(
    "an outsider cannot",
    asUser(db, nour, "select public.set_game_ready($1, true)", [lobby]),
  );

  await denied(
    "and nobody can mark somebody else ready",
    asUser(
      db,
      ada,
      "update public.game_players set is_ready = true where session_id = $1 and user_id = $2",
      [lobby, rafa],
    ),
  );

  await asUser(db, rafa, "select public.set_game_ready($1, true)", [lobby]);
  await asUser(db, wren, "select public.set_game_ready($1, true)", [lobby]);

  const { rows: host } = await asUser(db, ada, "select public.can_start_game($1) as yes", [lobby]);
  eq("with everybody ready, the host can start", host[0].yes, true);

  const { rows: guest } = await asUser(db, rafa, "select public.can_start_game($1) as yes", [
    lobby,
  ]);
  eq("but only the host", guest[0].yes, false);
}

/* ==========================================================================
 * 5 · The client cannot write game state
 *
 * The claim the whole architecture rests on.
 * ========================================================================== */

section("Client writes");

await denied(
  "a player cannot write session state",
  asUser(db, ada, `update public.game_sessions set state = '{"cheat":true}'::jsonb where id = $1`, [
    lobby,
  ]),
);

await denied(
  "nor start the game by hand",
  asUser(db, ada, "update public.game_sessions set status = 'active' where id = $1", [lobby]),
);

await denied(
  "nor insert a session directly",
  asUser(
    db,
    ada,
    "insert into public.game_sessions (game_key, conversation_id, host_id) values ('reference', $1, $2)",
    [room, ada],
  ),
);

await denied(
  "nor append a move",
  asUser(
    db,
    ada,
    `insert into public.game_moves (session_id, seq, player_id, payload) values ($1, 0, $2, '{}'::jsonb)`,
    [lobby, ada],
  ),
);

await denied(
  "nor award themselves a score",
  asUser(
    db,
    ada,
    "update public.game_players set score = 999 where session_id = $1 and user_id = $2",
    [lobby, ada],
  ),
);

await denied(
  "nor seat somebody else",
  asUser(
    db,
    ada,
    "insert into public.game_players (session_id, user_id, seat) values ($1, $2, 5)",
    [lobby, nour],
  ),
);

{
  const { rows } = await asService(
    db,
    `select
       has_function_privilege('authenticated', 'public.start_game_session(uuid,uuid,jsonb,smallint)', 'execute') as start,
       has_function_privilege('authenticated', 'public.commit_game_move(uuid,uuid,integer,jsonb,jsonb,smallint,jsonb,boolean)', 'execute') as move,
       has_function_privilege('authenticated', 'public.broadcast_game(uuid,text,jsonb,jsonb)', 'execute') as broadcast`,
  );
  eq("clients cannot call start_game_session", rows[0].start, false);
  eq("nor commit_game_move", rows[0].move, false);
  eq("nor broadcast game state themselves", rows[0].broadcast, false);
}

/* ==========================================================================
 * 6 · Starting, through the engine
 *
 * The real path: JavaScript computes the opening position, SQL commits it.
 * ========================================================================== */

section("Starting");

const players = [
  { seat: 0, userId: ada, displayName: "ada" },
  { seat: 1, userId: rafa, displayName: "rafa" },
  { seat: 2, userId: wren, displayName: "wren" },
];

let state;
{
  const { rows: seedRow } = await asService(
    db,
    "select seed from public.game_sessions where id = $1",
    [lobby],
  );

  state = referenceEngine.createInitialState({
    players,
    seed: Number(BigInt(seedRow[0].seed) % 1000n),
    config: {},
    now: Date.now(),
  });

  await denied(
    "somebody who is not the host cannot start it",
    asService(db, "select public.start_game_session($1, $2, $3::jsonb, 0::smallint)", [
      lobby,
      rafa,
      JSON.stringify(state),
    ]),
  );

  const { rows } = await asService(
    db,
    "select public.start_game_session($1, $2, $3::jsonb, 0::smallint) as v",
    [lobby, ada, JSON.stringify(state)],
  );
  eq("the host starts it at version one", rows[0].v, 1);

  const { rows: session } = await asService(
    db,
    "select status, turn_seat, started_at from public.game_sessions where id = $1",
    [lobby],
  );
  eq("the game is active", session[0].status, "active");
  eq("seat zero moves first", session[0].turn_seat, 0);
  truthy("and it is stamped", session[0].started_at !== null);

  await denied(
    "starting twice is refused",
    asService(db, "select public.start_game_session($1, $2, $3::jsonb, 0::smallint)", [
      lobby,
      ada,
      JSON.stringify(state),
    ]),
  );
}

/* ==========================================================================
 * 7 · Hidden information
 * ========================================================================== */

section("What each person can see");

{
  const publicView = referenceEngine.publicView(state);
  const mine = referenceEngine.viewFor(state, 0);

  eq("the public view carries no secrets", "secrets" in publicView, false);
  eq("nor any other player's answer", JSON.stringify(publicView).includes("mySecret"), false);
  truthy("a player's own view carries theirs", typeof mine.mySecret === "number");
  eq("and only theirs", Object.keys(mine).includes("secrets"), false);

  // The database half: a spectator gets the shape and none of the contents.
  const { rows: spectator } = await asUser(db, nour, "select * from public.get_game_session($1)", [
    lobby,
  ]);
  eq("an outsider cannot see the session at all", spectator.length, 0);

  const { rows: watcher } = await asService(
    db,
    "insert into public.conversation_members (conversation_id, user_id) values ($1, $2) returning user_id",
    [room, nour],
  );
  truthy("but a room member can watch", watcher.length === 1);

  const { rows: watching } = await asUser(db, nour, "select * from public.get_game_session($1)", [
    lobby,
  ]);
  eq("a spectator sees the game exists", watching.length, 1);
  eq("with no seat", watching[0].my_seat, null);

  /*
   * And nobody gets the state over HTTP — not a spectator, not a player.
   *
   * This used to return the raw blob to anybody seated, which was fine for a
   * game with no secrets and wrong for the first one that had them. SQL cannot
   * run an engine, so it cannot redact; the fix (migration 0018) was to stop
   * carrying state on this path at all and let the engine compute both views
   * server-side. See would-you-rather.test.mjs for the version of this that
   * matters.
   */
  eq("and the session RPC carries no state for anybody", "state" in watching[0], false);

  const { rows: playing } = await asUser(db, ada, "select * from public.get_game_session($1)", [
    lobby,
  ]);
  eq("a player's read is the same shape", "state" in playing[0], false);
  eq("with a seat on it", playing[0].my_seat, 0);

  await denied(
    "and the column is not grantable to a client either",
    asUser(db, ada, "select state from public.game_sessions where id = $1", [lobby]),
  );
}

/* ==========================================================================
 * 8 · Moves
 * ========================================================================== */

section("Moves");

/** The production path, minus supabase-js: engine reduces, SQL commits. */
async function play(actor, seat, payload, expectedVersion) {
  const move = referenceEngine.validateMove(payload);
  if (!move) throw new Error("rejected_by_engine");

  const result = referenceEngine.reduce(state, move, {
    seat,
    players,
    seed: 0,
    config: {},
    now: Date.now(),
  });
  if (!result.ok) throw new Error(result.reason);

  const scoreRows = result.outcome
    ? Object.fromEntries(
        Object.entries(result.outcome.scores).map(([s, score]) => [
          s,
          { score, placement: result.outcome.placements[Number(s)] ?? null },
        ]),
      )
    : null;

  const { rows } = await asService(
    db,
    "select public.commit_game_move($1, $2, $3, $4::jsonb, $5::jsonb, $6::smallint, $7::jsonb, $8) as v",
    [
      lobby,
      actor,
      expectedVersion,
      JSON.stringify(result.state),
      JSON.stringify(payload),
      result.turnSeat,
      scoreRows ? JSON.stringify(scoreRows) : null,
      result.outcome !== undefined,
    ],
  );

  state = result.state;
  return rows[0].v;
}

{
  eq(
    "the engine rejects nonsense before it reaches the database",
    referenceEngine.validateMove({ guess: "x" }),
    null,
  );
  eq("and out-of-range values", referenceEngine.validateMove({ guess: 42 }), null);

  await denied(
    "somebody who is not in the game cannot move",
    asService(
      db,
      "select public.commit_game_move($1, $2, 1, '{}'::jsonb, '{}'::jsonb, 1::smallint)",
      [lobby, nour],
    ),
  );

  await denied(
    "and nor can a player whose turn it is not",
    asService(
      db,
      "select public.commit_game_move($1, $2, 1, '{}'::jsonb, '{}'::jsonb, 0::smallint)",
      [lobby, rafa],
    ),
  );

  const v2 = await play(ada, 0, { guess: 3 }, 1);
  eq("a legal move advances the version", v2, 2);

  const { rows: moves } = await asService(
    db,
    "select seq, player_id, payload from public.game_moves where session_id = $1 order by seq",
    [lobby],
  );
  eq("and is written to the move log", moves.length, 1);
  eq("in order", moves[0].seq, 0);
  eq("attributed to whoever made it", moves[0].player_id, ada);
  eq("with the payload as submitted", moves[0].payload, { guess: 3 });

  const { rows: turn } = await asService(
    db,
    "select turn_seat from public.game_sessions where id = $1",
    [lobby],
  );
  eq("the turn passes", turn[0].turn_seat, 1);

  // Optimistic concurrency: a move computed from a state that has moved on.
  await denied(
    "a move against a stale version is refused",
    asService(
      db,
      "select public.commit_game_move($1, $2, 1, '{}'::jsonb, '{}'::jsonb, 0::smallint)",
      [lobby, rafa],
    ),
  );

  const v3 = await play(rafa, 1, { guess: 5 }, 2);
  eq("the next player moves", v3, 3);
}

/* ==========================================================================
 * 9 · Finishing and scoring
 * ========================================================================== */

section("Finishing");

{
  await play(ada, 0, { guess: state.secrets[1] }, 3);

  const { rows } = await asService(
    db,
    "select status, ended_at, turn_seat from public.game_sessions where id = $1",
    [lobby],
  );
  eq("the game finishes when the engine says so", rows[0].status, "finished");
  truthy("with an end time", rows[0].ended_at !== null);
  eq("and nobody's turn", rows[0].turn_seat, null);

  const { rows: scores } = await asService(
    db,
    "select seat, score, placement from public.game_players where session_id = $1 order by seat",
    [lobby],
  );
  truthy(
    "scores are written to the players",
    scores.some((s) => s.score > 0),
  );
  truthy(
    "and a placement",
    scores.some((s) => s.placement === 1),
  );

  await denied(
    "a finished game accepts no more moves",
    asService(
      db,
      "select public.commit_game_move($1, $2, 4, '{}'::jsonb, '{}'::jsonb, null::smallint)",
      [lobby, ada],
    ),
  );

  await denied(
    "and the move log cannot be rewritten, even by the service role",
    asService(db, "update public.game_moves set payload = '{}'::jsonb where session_id = $1", [
      lobby,
    ]),
  );
  await denied(
    "nor deleted",
    asService(db, "delete from public.game_moves where session_id = $1", [lobby]),
  );
}

/* ==========================================================================
 * 10 · Rematch
 * ========================================================================== */

section("Rematch");

{
  const { rows } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'reference', '{}'::jsonb, $2) as id",
    [room, lobby],
  );
  const rematch = rows[0].id;

  truthy("a rematch is a new session", rematch !== lobby);

  const { rows: linked } = await asService(
    db,
    "select rematch_of, status from public.game_sessions where id = $1",
    [rematch],
  );
  eq("threaded to the game it follows", linked[0].rematch_of, lobby);
  eq("and starting fresh in a lobby", linked[0].status, "lobby");

  const { rows: previous } = await asService(
    db,
    "select score from public.game_players where session_id = $1 and seat = 0",
    [lobby],
  );
  truthy("the finished game keeps its scores", previous[0].score >= 0);

  const { rows: fresh } = await asService(
    db,
    "select score, placement from public.game_players where session_id = $1",
    [rematch],
  );
  eq("while the rematch starts at zero", fresh[0].score, 0);
  eq("with nobody placed", fresh[0].placement, null);
}

/* ==========================================================================
 * 11 · Leaving
 * ========================================================================== */

section("Leaving");

{
  const { rows } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'reference') as id",
    [room],
  );
  const session = rows[0].id;
  await asUser(db, rafa, "select public.join_game_session($1)", [session]);
  await asUser(db, wren, "select public.join_game_session($1)", [session]);

  await allowed(
    "a player leaves a lobby",
    asUser(db, wren, "select public.leave_game_session($1)", [session]),
  );

  const { rows: gone } = await asService(
    db,
    "select count(*)::int as n from public.game_players where session_id = $1 and user_id = $2",
    [session, wren],
  );
  eq("and the seat is freed outright", gone[0].n, 0);

  const { rows: seat } = await asUser(db, wren, "select public.join_game_session($1) as seat", [
    session,
  ]);
  eq("so it can be taken again", seat[0].seat, 2);

  // The host leaves; somebody has to be able to start the game.
  await asUser(db, ada, "select public.leave_game_session($1)", [session]);
  const { rows: host } = await asService(
    db,
    "select host_id from public.game_sessions where id = $1",
    [session],
  );
  truthy("the host role passes on when the host leaves", host[0].host_id !== ada);
  truthy("to somebody still at the table", [rafa, wren].includes(host[0].host_id));

  // Everybody out.
  await asUser(db, rafa, "select public.leave_game_session($1)", [session]);
  await asUser(db, wren, "select public.leave_game_session($1)", [session]);

  const { rows: status } = await asService(
    db,
    "select status, ended_at from public.game_sessions where id = $1",
    [session],
  );
  eq("an empty session is abandoned", status[0].status, "abandoned");
  truthy("and closed", status[0].ended_at !== null);
}

{
  // Mid-game departure is recorded, not erased — and ends the game if it drops
  // below the minimum.
  const { rows } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'reference') as id",
    [room],
  );
  const session = rows[0].id;
  await asUser(db, rafa, "select public.join_game_session($1)", [session]);
  await asUser(db, ada, "select public.set_game_ready($1, true)", [session]);
  await asUser(db, rafa, "select public.set_game_ready($1, true)", [session]);
  await asService(db, "select public.start_game_session($1, $2, '{}'::jsonb, 0::smallint)", [
    session,
    ada,
  ]);

  await asUser(db, rafa, "select public.leave_game_session($1)", [session]);

  const { rows: player } = await asService(
    db,
    "select left_at from public.game_players where session_id = $1 and user_id = $2",
    [session, rafa],
  );
  eq("leaving mid-game keeps the row", player.length, 1);
  truthy("marked with a time", player[0].left_at !== null);

  const { rows: status } = await asService(
    db,
    "select status from public.game_sessions where id = $1",
    [session],
  );
  eq("and the game ends below the minimum player count", status[0].status, "abandoned");
}

/* ==========================================================================
 * 12 · Realtime
 * ========================================================================== */

section("Realtime");

{
  const { rows } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'reference') as id",
    [room],
  );
  const session = rows[0].id;

  const { rows: sent } = await asService(
    db,
    "select topic, event from realtime.sent where topic = $1 order by id desc limit 3",
    [`game:${session}`],
  );
  truthy(
    "seating somebody announces itself",
    sent.some((s) => s.event === "game.lobby"),
  );

  await asUser(db, rafa, "select public.join_game_session($1)", [session]);
  const { rows: joined } = await asService(
    db,
    "select count(*)::int as n from realtime.sent where topic = $1 and event = 'game.lobby'",
    [`game:${session}`],
  );
  truthy("and so does joining", joined[0].n >= 2);

  // The nudge carries no game data, so a spectator cannot be sent something a
  // player can see.
  const { rows: payloads } = await asService(
    db,
    "select payload from realtime.sent where topic = $1 order by id desc limit 1",
    [`game:${session}`],
  );
  eq(
    "the lobby broadcast carries no state",
    Object.keys(payloads[0].payload).some((k) => k === "state" || k === "secrets"),
    false,
  );

  /* --- the channel policies, actually evaluated --------------------------- */

  const topic = `game:${session}`;
  await asService(
    db,
    "insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}'::jsonb)",
    [topic],
  );

  const canRead = async (who) => {
    const { rows: r } = await asUserOnTopic(
      db,
      who,
      topic,
      "select count(*)::int as n from realtime.messages where topic = $1",
      [topic],
    );
    return r[0].n;
  };

  eq("a player may subscribe to the table", await canRead(ada), 1);
  eq("so may a room member watching", await canRead(nour), 1);

  const outsider = await createUser(db, "zev");
  eq("somebody outside the room may not", await canRead(outsider), 0);

  const canWrite = async (who) => {
    try {
      await asUserOnTopic(
        db,
        who,
        topic,
        "insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}'::jsonb)",
        [topic],
      );
      return true;
    } catch {
      return false;
    }
  };

  eq("a player may broadcast into it", await canWrite(ada), true);
  eq("a spectator may not", await canWrite(nour), false);
  eq("and an outsider certainly may not", await canWrite(outsider), false);
}

/* ==========================================================================
 * 13 · Schema hygiene
 * ========================================================================== */

section("Schema");

{
  const { rows } = await asService(
    db,
    `select c.conname
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname in ('game_sessions', 'game_players', 'game_moves', 'games')
        and c.contype = 'f'
        and not exists (
          select 1 from pg_index i
           where i.indrelid = c.conrelid
             and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] operator(pg_catalog.=) c.conkey
        )`,
  );
  eq(
    "every game foreign key has a covering index",
    rows.map((r) => r.conname),
    [],
  );

  const { rows: definers } = await asService(
    db,
    `select proname from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname like '%game%'
        and prosecdef
        and (proconfig is null or not exists (
          select 1 from unnest(proconfig) cfg where cfg like 'search\\_path=%'
        ))
      order by proname`,
  );
  eq(
    "every SECURITY DEFINER game function pins search_path",
    definers.map((r) => r.proname),
    [],
  );

  const { rows: rls } = await asService(
    db,
    `select relname from pg_class
      where relname in ('games','game_sessions','game_players','game_moves')
        and not (relrowsecurity and relforcerowsecurity)`,
  );
  eq(
    "RLS is enabled and forced on every game table",
    rls.map((r) => r.relname),
    [],
  );
}

await db.close();

/* ========================================================================== */

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
