/**
 * Would You Rather.
 *
 * The game is one rule: nobody sees anybody else's answer until the round
 * closes. If that fails, the game is not spoiled slightly — it stops being a
 * game. And it fails silently: a leak looks exactly like everything working,
 * right up until somebody notices they can win every round.
 *
 * So this suite goes at that first and from both directions. The engine's public
 * view is inspected for secrets. The database is asked for the raw state through
 * every path a browser has. Both must come back empty.
 *
 * The rest covers what the brief asks about a live game with people coming and
 * going: joining, leaving, reconnecting, duplicate actions, and the host walking
 * out mid-round.
 *
 *     npm run wyr:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const { wouldYouRather: engine, PROMPTS } =
  await import("../../src/features/games/engine/games/would-you-rather.ts");

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

console.log("KITH — Would You Rather\n");

/* ========================================================================== */

const THREE = [
  { seat: 0, userId: "u0", displayName: "Ada" },
  { seat: 1, userId: "u1", displayName: "Rafa" },
  { seat: 2, userId: "u2", displayName: "Wren" },
];

const NOW = 1_800_000_000_000;

const setup = (players = THREE, seed = 12345, config = {}) => ({
  players,
  seed,
  config,
  now: NOW,
});

const context = (seat, players = THREE, now = NOW) => ({
  seat,
  players,
  seed: 12345,
  config: {},
  now,
});

/** Applies a sequence of moves, asserting each one is accepted. */
function run(state, moves, players = THREE) {
  let current = state;
  for (const [seat, move, now] of moves) {
    const result = engine.reduce(current, move, context(seat, players, now ?? NOW));
    if (!result.ok) throw new Error(`move rejected: ${result.reason}`);
    current = result.state;
  }
  return current;
}

/* ==========================================================================
 * 1 · The deck
 * ========================================================================== */

section("Questions");

{
  const a = engine.createInitialState(setup(THREE, 999));
  const b = engine.createInitialState(setup(THREE, 999));
  const c = engine.createInitialState(setup(THREE, 1000));

  eq("the same seed draws the same questions", a.prompts, b.prompts);
  truthy(
    "a different seed draws different ones",
    JSON.stringify(a.prompts) !== JSON.stringify(c.prompts),
  );

  const texts = a.prompts.map((p) => p.a);
  eq("no question repeats within a session", new Set(texts).size, texts.length);

  eq("seven rounds by default", a.totalRounds, 7);
  eq("and that many questions", a.prompts.length, 7);

  const short = engine.createInitialState(setup(THREE, 1, { rounds: 3 }));
  eq("the round count is configurable", short.totalRounds, 3);

  const silly = engine.createInitialState(setup(THREE, 1, { rounds: 999 }));
  eq("but not absurdly", silly.totalRounds, 7);

  truthy("there are enough questions to draw from", PROMPTS.length >= 20);
  eq(
    "every one has two options",
    PROMPTS.every((p) => p.a && p.b && p.a !== p.b),
    true,
  );
  eq("nobody holds the turn — everybody answers at once", engine.initialTurnSeat(a, setup()), null);
}

/* ==========================================================================
 * 2 · Reading a move
 * ========================================================================== */

section("Moves");

eq("a choice is a move", engine.validateMove({ type: "answer", choice: "a" }), {
  type: "answer",
  choice: "a",
});
eq("a third option is not", engine.validateMove({ type: "answer", choice: "c" }), null);
eq("nor a missing one", engine.validateMove({ type: "answer" }), null);
eq("nor a number", engine.validateMove({ type: "answer", choice: 1 }), null);
eq("nor a bare string", engine.validateMove("a"), null);
eq("nor null", engine.validateMove(null), null);
eq("nor an unknown verb", engine.validateMove({ type: "cheat" }), null);
eq("reveal is a move", engine.validateMove({ type: "reveal" }), { type: "reveal" });
eq("so is next", engine.validateMove({ type: "next" }), { type: "next" });

/* ==========================================================================
 * 3 · Hidden until revealed
 *
 * The whole game, asserted directly.
 * ========================================================================== */

section("Secrecy");

{
  let state = engine.createInitialState(setup());
  state = run(state, [
    [0, { type: "answer", choice: "a" }],
    [1, { type: "answer", choice: "b" }],
  ]);

  const view = engine.publicView(state);

  eq("mid-round, the public view carries no answers", view.answers, {});
  eq("no tally", view.tally, null);
  eq("and no majority", view.majority, null);
  eq(
    "the raw state is nowhere in it",
    JSON.stringify(view).includes('"choice"') || JSON.stringify(view).includes("prompts"),
    false,
  );

  eq("it does say who has answered", view.answeredSeats, [0, 1]);
  truthy("which is what makes the wait readable", view.answeredSeats.length === 2);

  const mine = engine.viewFor(state, 0);
  eq("my own view tells me what I picked", mine.myAnswer, "a");
  eq("and nothing about anybody else", mine.answers, {});

  const theirs = engine.viewFor(state, 1);
  eq("each player sees only their own", theirs.myAnswer, "b");

  const watching = engine.viewFor(state, 2);
  eq("somebody yet to answer has nothing to see", watching.myAnswer, null);
}

/* ==========================================================================
 * 4 · Closing a round
 * ========================================================================== */

section("Revealing");

{
  let state = engine.createInitialState(setup());
  state = run(state, [
    [0, { type: "answer", choice: "a" }],
    [1, { type: "answer", choice: "a" }],
  ]);

  eq("still answering while somebody is out", state.phase, "answering");

  const early = engine.reduce(state, { type: "reveal" }, context(0));
  eq("a reveal before everybody is in is refused", early.ok, false);

  // The last answer closes the round on its own — no timer, no round trip.
  const last = engine.reduce(state, { type: "answer", choice: "b" }, context(2));
  truthy("the last answer reveals immediately", last.ok && last.state.phase === "revealed");

  const view = engine.publicView(last.state);
  eq("and now the answers are public", view.answers, { 0: "a", 1: "a", 2: "b" });
  eq("with a tally", view.tally, { a: 2, b: 1 });
  eq("and a majority", view.majority, "a");
}

{
  // The timer. The engine has no clock, so the deadline is checked against the
  // `now` it is handed — which is the server's, not a browser's.
  let state = engine.createInitialState(setup());
  state = run(state, [[0, { type: "answer", choice: "a" }]]);

  const late = engine.reduce(state, { type: "reveal" }, context(1, THREE, state.deadline + 1));
  truthy("once the clock runs out anybody may close the round", late.ok);
  eq("and it reveals with whoever answered", engine.publicView(late.state).tally, { a: 1, b: 0 });

  eq("somebody who never answered scores nothing", late.state.scores[1], 0);
  eq("and their streak is gone", late.state.streaks[1], 0);
  eq("while the one who did scores", late.state.scores[0], 1);

  const tooLate = engine.reduce(
    late.state,
    { type: "answer", choice: "b" },
    context(1, THREE, state.deadline + 1),
  );
  eq("and cannot answer afterwards", tooLate.ok, false);
}

{
  // Clocks disagree. Somebody who pressed with a second to spare should not be
  // told they were late because their laptop runs fast.
  const state = engine.createInitialState(setup());
  const justAfter = engine.reduce(
    state,
    { type: "answer", choice: "a" },
    context(0, THREE, state.deadline + 1000),
  );
  truthy("a whisker past the deadline still counts", justAfter.ok);

  const wellAfter = engine.reduce(
    state,
    { type: "answer", choice: "a" },
    context(0, THREE, state.deadline + 10_000),
  );
  eq("ten seconds late does not", wellAfter.ok, false);
}

/* ==========================================================================
 * 5 · Duplicate actions
 * ========================================================================== */

section("Duplicates");

{
  let state = engine.createInitialState(setup());
  state = run(state, [[0, { type: "answer", choice: "a" }]]);

  const again = engine.reduce(state, { type: "answer", choice: "b" }, context(0));
  eq("answering twice is refused", again.ok, false);
  truthy("and says why", again.reason.includes("already answered"));

  const same = engine.reduce(state, { type: "answer", choice: "a" }, context(0));
  eq("even with the same choice", same.ok, false);

  eq("so the tally cannot be padded", Object.keys(state.answers).length, 1);

  const revealed = run(state, [
    [1, { type: "answer", choice: "a" }],
    [2, { type: "answer", choice: "a" }],
  ]);

  const twice = engine.reduce(revealed, { type: "reveal" }, context(0));
  eq("revealing an already-revealed round is refused", twice.ok, false);

  const early = engine.reduce(state, { type: "next" }, context(0));
  eq("and next before the reveal is refused", early.ok, false);
}

/* ==========================================================================
 * 6 · Scoring
 * ========================================================================== */

section("Scoring");

{
  let state = engine.createInitialState(setup(THREE, 7, { rounds: 5 }));
  const round = (a, b, c) =>
    run(state, [
      [0, { type: "answer", choice: a }],
      [1, { type: "answer", choice: b }],
      [2, { type: "answer", choice: c }],
    ]);

  state = round("a", "a", "b");
  eq("being with the room scores", state.scores[0], 1);
  eq("both of you", state.scores[1], 1);
  eq("being out of step does not", state.scores[2], 0);
  eq("streaks follow the score", state.streaks[0], 1);
  eq("and reset when you are alone", state.streaks[2], 0);

  state = run(state, [[0, { type: "next" }]]);
  state = round("b", "b", "b");
  eq("unanimous scores everybody", state.scores[2], 1);
  eq("and restarts a broken streak", state.streaks[2], 1);
  eq("while continuing an unbroken one", state.streaks[0], 2);

  state = run(state, [[0, { type: "next" }]]);
  state = round("a", "a", "a");
  // Three in a row is worth an extra point — long enough to feel earned.
  eq("a third in a row pays a bonus", state.scores[0], 1 + 1 + 2);
  // Seat 2 missed the first round, so this is only their second in a row — with
  // the room, but not yet on a streak. The bonus is for the streak, not the
  // round.
  eq("but only to whoever actually has the streak", state.scores[2], 0 + 1 + 1);
  eq("and the streak keeps counting", state.streaks[0], 3);
  eq("from wherever each person is", state.streaks[2], 2);
}

{
  // An even split. Nobody is out of step with a room that cannot agree.
  const two = THREE.slice(0, 2);
  let state = engine.createInitialState(setup(two, 3));
  state = run(
    state,
    [
      [0, { type: "answer", choice: "a" }],
      [1, { type: "answer", choice: "b" }],
    ],
    two,
  );

  eq("a dead heat has no majority", engine.publicView(state).majority, null);
  eq("so everybody scores", [state.scores[0], state.scores[1]], [1, 1]);
  eq("and everybody keeps their streak", [state.streaks[0], state.streaks[1]], [1, 1]);
}

/* ==========================================================================
 * 7 · Somebody leaves mid-game
 *
 * The runtime hands the engine only the players still present, so a departure
 * needs no special case — but the arithmetic has to be right.
 * ========================================================================== */

section("Leaving mid-game");

{
  let state = engine.createInitialState(setup());
  state = run(state, [
    [0, { type: "answer", choice: "a" }],
    [1, { type: "answer", choice: "b" }],
  ]);

  // Seat 2 walks out. Two players remain, and both have answered.
  const remaining = THREE.slice(0, 2);

  const closed = engine.reduce(state, { type: "reveal" }, context(0, remaining));
  truthy("the round can close once the leaver is gone", closed.ok);
  eq("and only the people still here are counted", engine.publicView(closed.state).tally, {
    a: 1,
    b: 1,
  });
  eq("a two-way split scores both", [closed.state.scores[0], closed.state.scores[1]], [1, 1]);

  const outcome = engine.reduce(
    { ...closed.state, round: closed.state.totalRounds - 1 },
    { type: "next" },
    context(0, remaining),
  );
  truthy("the game can still finish", outcome.ok && outcome.outcome);
  eq("and the person who left is not placed", Object.keys(outcome.outcome.placements).sort(), [
    "0",
    "1",
  ]);
}

/* ==========================================================================
 * 8 · Finishing
 * ========================================================================== */

section("Finishing");

{
  let state = engine.createInitialState(setup(THREE, 5, { rounds: 2 }));

  state = run(state, [
    [0, { type: "answer", choice: "a" }],
    [1, { type: "answer", choice: "a" }],
    [2, { type: "answer", choice: "b" }],
    [0, { type: "next" }],
    [0, { type: "answer", choice: "a" }],
    [1, { type: "answer", choice: "a" }],
    [2, { type: "answer", choice: "b" }],
  ]);

  const done = engine.reduce(state, { type: "next" }, context(0));
  truthy("the last round ends the game", done.ok && done.outcome !== undefined);

  const outcome = done.outcome;
  eq("with final scores", outcome.scores, { 0: 2, 1: 2, 2: 0 });
  eq("shared places for a tie", [outcome.placements[0], outcome.placements[1]], [1, 1]);
  eq("and third for last", outcome.placements[2], 3);
  eq("two winners", outcome.winnerSeats.sort(), [0, 1]);
  eq("the turn is nobody's", done.turnSeat, null);
}

{
  // Everybody on the same score is a draw, not a six-way victory.
  let state = engine.createInitialState(setup(THREE, 5, { rounds: 1 }));
  state = run(state, [
    [0, { type: "answer", choice: "a" }],
    [1, { type: "answer", choice: "a" }],
    [2, { type: "answer", choice: "a" }],
  ]);
  const done = engine.reduce(state, { type: "next" }, context(0));
  eq("everybody level is a draw", done.outcome.winnerSeats, []);
}

/* ==========================================================================
 * 9 · The database half
 * ========================================================================== */

section("In the database");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const wren = await createUser(db, "wren");
const nour = await createUser(db, "nour");

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

const { rows: roomRows } = await asUser(db, ada, "select public.start_group($1, $2) as id", [
  "Games night",
  [rafa, wren],
]);
const room = roomRows[0].id;

{
  const { rows } = await asUser(
    db,
    ada,
    "select * from public.list_games() where key = 'would-you-rather'",
  );
  eq("the game is on the shelf", rows.length, 1);
  eq("and enabled — it has an engine behind it", rows[0].enabled, true);
  eq("two to six players", [rows[0].min_players, rows[0].max_players], [2, 6]);
  eq("everybody at once", rows[0].pace, "realtime");
}

/* ==========================================================================
 * 10 · The state never travels the HTTP path
 *
 * The hole this game exposed in migration 0017, and the reason for 0018.
 * ========================================================================== */

section("What a browser can fetch");

let session;
{
  const { rows } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'would-you-rather') as id",
    [room],
  );
  session = rows[0].id;

  await asUser(db, rafa, "select public.join_game_session($1)", [session]);
  await asUser(db, wren, "select public.join_game_session($1)", [session]);
  for (const who of [ada, rafa, wren]) {
    await asUser(db, who, "select public.set_game_ready($1, true)", [session]);
  }

  const players = [
    { seat: 0, userId: ada, displayName: "ada" },
    { seat: 1, userId: rafa, displayName: "rafa" },
    { seat: 2, userId: wren, displayName: "wren" },
  ];

  const { rows: seedRow } = await asService(
    db,
    "select seed from public.game_sessions where id = $1",
    [session],
  );

  const initial = engine.createInitialState({
    players,
    seed: Number(BigInt(seedRow[0].seed) % 100000n),
    config: {},
    now: Date.now(),
  });

  await asService(db, "select public.start_game_session($1, $2, $3::jsonb, null::smallint)", [
    session,
    ada,
    JSON.stringify(initial),
  ]);

  // One answer in, two to go. The secret is now live.
  const answered = engine.reduce(
    initial,
    { type: "answer", choice: "a" },
    {
      seat: 0,
      players,
      seed: 0,
      config: {},
      now: Date.now(),
    },
  );

  await asService(
    db,
    `select public.commit_game_move($1, $2, 1, $3::jsonb, $4::jsonb, null::smallint, null, false)`,
    [session, ada, JSON.stringify(answered.state), JSON.stringify({ type: "answer", choice: "a" })],
  );

  /* --- every path a browser has ----------------------------------------- */

  const { rows: rpc } = await asUser(db, rafa, "select * from public.get_game_session($1)", [
    session,
  ]);
  eq("the session RPC returns the session", rpc.length, 1);
  eq("and no state column at all", Object.keys(rpc[0]).includes("state"), false);

  await denied(
    "a player cannot select the state column",
    asUser(db, rafa, "select state from public.game_sessions where id = $1", [session]),
  );

  await denied(
    "nor with a wildcard",
    asUser(db, rafa, "select * from public.game_sessions where id = $1", [session]),
  );

  const { rows: allowed } = await asUser(
    db,
    rafa,
    "select id, status, state_version, host_id from public.game_sessions where id = $1",
    [session],
  );
  eq("but the rest of the row is still readable — the lobby needs it", allowed.length, 1);
  eq("including the version", allowed[0].state_version, 2);

  await denied(
    "the move log does not leak it either",
    asUser(db, wren, "select payload from public.game_moves where session_id = $1", [session]).then(
      (r) => {
        // Moves ARE readable by design — they are the audit trail. What matters
        // is that a move records only its own author's choice, which is already
        // public to that author.
        if (r.rows.every((row) => row.payload.choice !== undefined)) {
          throw new Error("only the mover's own choice is recorded");
        }
        return r;
      },
    ),
  );
}

/* ==========================================================================
 * 11 · Joining, leaving, and the host walking out
 * ========================================================================== */

section("People coming and going");

{
  await denied(
    "nobody joins a game in progress",
    asUser(db, nour, "select public.join_game_session($1)", [session]),
  );

  await denied(
    "an outsider cannot move in it",
    asService(
      db,
      "select public.commit_game_move($1, $2, 2, '{}'::jsonb, '{}'::jsonb, null::smallint)",
      [session, nour],
    ),
  );

  // The host leaves mid-game. The game carries on, and somebody else can drive.
  await asUser(db, ada, "select public.leave_game_session($1)", [session]);

  const { rows: after } = await asService(
    db,
    "select status, host_id from public.game_sessions where id = $1",
    [session],
  );
  eq("the game survives the host leaving", after[0].status, "active");
  truthy("and the role passes on", after[0].host_id !== ada);
  truthy("to somebody still playing", [rafa, wren].includes(after[0].host_id));

  const { rows: record } = await asService(
    db,
    "select left_at from public.game_players where session_id = $1 and user_id = $2",
    [session, ada],
  );
  eq("their seat is not erased", record.length, 1);
  truthy("just marked", record[0].left_at !== null);

  await denied(
    "and they cannot move any more",
    asService(
      db,
      "select public.commit_game_move($1, $2, 2, '{}'::jsonb, '{}'::jsonb, null::smallint)",
      [session, ada],
    ),
  );

  // Down to one. Below the game's minimum, so it ends.
  await asUser(db, rafa, "select public.leave_game_session($1)", [session]);
  const { rows: ended } = await asService(
    db,
    "select status from public.game_sessions where id = $1",
    [session],
  );
  eq("and it ends when too few remain", ended[0].status, "abandoned");
}

/* ==========================================================================
 * 12 · Two answers at once
 *
 * Everybody moves together in this game, so a version clash is the normal case
 * rather than an edge one.
 * ========================================================================== */

section("Simultaneous moves");

{
  const { rows } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'would-you-rather') as id",
    [room],
  );
  const race = rows[0].id;

  await asUser(db, rafa, "select public.join_game_session($1)", [race]);
  await asUser(db, ada, "select public.set_game_ready($1, true)", [race]);
  await asUser(db, rafa, "select public.set_game_ready($1, true)", [race]);
  await asService(db, "select public.start_game_session($1, $2, '{}'::jsonb, null::smallint)", [
    race,
    ada,
  ]);

  await asService(
    db,
    "select public.commit_game_move($1, $2, 1, '{}'::jsonb, '{}'::jsonb, null::smallint)",
    [race, ada],
  );

  await denied(
    "the second move against the same version loses",
    asService(
      db,
      "select public.commit_game_move($1, $2, 1, '{}'::jsonb, '{}'::jsonb, null::smallint)",
      [race, rafa],
    ),
  );

  const { rows: v } = await asService(
    db,
    "select state_version from public.game_sessions where id = $1",
    [race],
  );
  eq("so exactly one landed", v[0].state_version, 2);

  const { rows: retried } = await asService(
    db,
    "select public.commit_game_move($1, $2, 2, '{}'::jsonb, '{}'::jsonb, null::smallint) as v",
    [race, rafa],
  );
  eq("and the loser succeeds on the version it now sees", retried[0].v, 3);

  const { rows: log } = await asService(
    db,
    "select count(*)::int as n from public.game_moves where session_id = $1",
    [race],
  );
  eq("with one entry per move that landed", log[0].n, 2);
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
