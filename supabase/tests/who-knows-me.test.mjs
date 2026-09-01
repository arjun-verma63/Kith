/**
 * Who Knows Me Better?
 *
 * This game hides two things, not one, and they have different audiences:
 *
 *   The subject's answer must be hidden from the guessers, or there is nothing
 *   to guess.
 *
 *   Each guess must be hidden from everybody INCLUDING THE SUBJECT. That is the
 *   one that is easy to get wrong — it feels harmless to let the subject see how
 *   the room is leaning, and it quietly turns the round into a formality,
 *   because they can then pick whatever the room already committed to.
 *
 * Both are asserted from the inside (the engine's views) and the outside (every
 * path a browser has to the state).
 *
 * The rest is what a rotating-subject game needs and Would You Rather did not:
 * the rotation itself, the subject leaving mid-round, and a round nobody can
 * score because the subject never answered.
 *
 *     npm run wkm:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

// The registry is the authority on what is playable; the catalogue must agree.
const { registeredKeys } = await import("../../src/features/games/engine/index.ts");
const ENGINE_KEYS = registeredKeys();

const { whoKnowsMe: engine, QUESTIONS } =
  await import("../../src/features/games/engine/games/who-knows-me.ts");

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

console.log("KITH — Who Knows Me Better?\n");

/* ========================================================================== */

const FOUR = [
  { seat: 0, userId: "u0", displayName: "Ada" },
  { seat: 1, userId: "u1", displayName: "Rafa" },
  { seat: 2, userId: "u2", displayName: "Wren" },
  { seat: 3, userId: "u3", displayName: "Nour" },
];

const NOW = 1_800_000_000_000;

const setup = (players = FOUR, seed = 4242, config = {}) => ({ players, seed, config, now: NOW });
const context = (seat, players = FOUR, now = NOW) => ({
  seat,
  players,
  seed: 4242,
  config: {},
  now,
});

function apply(state, seat, move, players = FOUR, now = NOW) {
  const result = engine.reduce(state, move, context(seat, players, now));
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result;
}

/** Everybody acts: the subject answers, the rest guess whatever they are told. */
function playRound(state, answer, guesses, players = FOUR, now = NOW) {
  let current = apply(
    state,
    state.subjectSeat,
    { type: "answer", option: answer },
    players,
    now,
  ).state;

  for (const [seat, option] of Object.entries(guesses)) {
    current = apply(current, Number(seat), { type: "guess", option }, players, now).state;
  }

  return current;
}

/* ==========================================================================
 * 1 · Setting up
 * ========================================================================== */

section("Setup");

{
  const a = engine.createInitialState(setup(FOUR, 77));
  const b = engine.createInitialState(setup(FOUR, 77));
  const c = engine.createInitialState(setup(FOUR, 78));

  eq("the same seed builds the same game", a.rounds, b.rounds);
  truthy("a different seed does not", JSON.stringify(a.rounds) !== JSON.stringify(c.rounds));
  eq("and shuffles the subject order too", a.rotation, b.rotation);

  eq("four players get one lap each", a.totalRounds, 4);
  eq("so everybody is the subject exactly once", new Set(a.rotation).size, 4);
  eq("and the rotation covers every seat", [...a.rotation].sort(), [0, 1, 2, 3]);

  // A whole number of laps, always: the subject cannot score, so an uneven
  // number of turns as subject would be an uneven number of chances to score.
  const two = engine.createInitialState(setup(FOUR.slice(0, 2), 1));
  eq("two players get two laps, not one short game", two.totalRounds, 4);

  const three = engine.createInitialState(setup(FOUR.slice(0, 3), 1));
  eq("three players get two laps", three.totalRounds, 6);
  eq("always a whole number of laps", three.totalRounds % 3, 0);

  const six = engine.createInitialState(
    setup(
      [
        ...FOUR,
        { seat: 4, userId: "u4", displayName: "Kai" },
        { seat: 5, userId: "u5", displayName: "Sam" },
      ],
      1,
    ),
  );
  eq("six players get one lap", six.totalRounds, 6);

  const long = engine.createInitialState(setup(FOUR, 1, { laps: 3 }));
  eq("laps are configurable", long.totalRounds, 12);
  const silly = engine.createInitialState(setup(FOUR, 1, { laps: 99 }));
  eq("but not absurdly", silly.totalRounds, 4);

  eq("nobody holds the turn — everybody acts at once", engine.initialTurnSeat(a, setup()), null);
  truthy("there are questions to ask", QUESTIONS.length >= 20);
  eq(
    "every question offers a real choice",
    QUESTIONS.every((q) => q.options.length >= 3 && new Set(q.options).size === q.options.length),
    true,
  );
}

{
  // Option order is shuffled per round. An answer that is always third would be
  // guessable without knowing the person at all.
  const state = engine.createInitialState(setup(FOUR, 91, { laps: 3 }));
  const orders = state.rounds.map((r) => r.order.join(""));
  truthy("the options are not always in the same order", new Set(orders).size > 1);
  eq(
    "and every ordering is a permutation of the options",
    state.rounds.every(
      (r) =>
        [...r.order].sort().join("") ===
        r.question.options
          .map((_, i) => i)
          .sort()
          .join(""),
    ),
    true,
  );
}

/* ==========================================================================
 * 2 · Reading a move
 * ========================================================================== */

section("Moves");

eq("an answer is a move", engine.validateMove({ type: "answer", option: 2 }), {
  type: "answer",
  option: 2,
});
eq("so is a guess", engine.validateMove({ type: "guess", option: 0 }), {
  type: "guess",
  option: 0,
});
eq("a negative option is not", engine.validateMove({ type: "guess", option: -1 }), null);
eq("nor a fractional one", engine.validateMove({ type: "guess", option: 1.5 }), null);
eq("nor a string", engine.validateMove({ type: "guess", option: "0" }), null);
eq("nor a missing one", engine.validateMove({ type: "guess" }), null);
eq("nor an unknown verb", engine.validateMove({ type: "peek" }), null);
eq("nor a bare number", engine.validateMove(3), null);

/* ==========================================================================
 * 3 · Who may do what
 * ========================================================================== */

section("Roles");

{
  const state = engine.createInitialState(setup());
  const subject = state.subjectSeat;
  const guesser = FOUR.find((p) => p.seat !== subject).seat;

  const wrongVerb = engine.reduce(state, { type: "guess", option: 0 }, context(subject));
  eq("the subject cannot guess", wrongVerb.ok, false);
  truthy("and is told why", wrongVerb.reason.includes("subject"));

  const impostor = engine.reduce(state, { type: "answer", option: 0 }, context(guesser));
  eq("a guesser cannot answer as the subject", impostor.ok, false);

  const outOfRange = engine.reduce(state, { type: "guess", option: 99 }, context(guesser));
  eq("and nobody can pick an option that does not exist", outOfRange.ok, false);
}

/* ==========================================================================
 * 4 · Two secrets
 *
 * The heart of it.
 * ========================================================================== */

section("Secrecy");

{
  let state = engine.createInitialState(setup());
  const subject = state.subjectSeat;
  const others = FOUR.filter((p) => p.seat !== subject).map((p) => p.seat);

  state = apply(state, subject, { type: "answer", option: 1 }).state;
  state = apply(state, others[0], { type: "guess", option: 2 }).state;

  const view = engine.publicView(state);

  eq("the room is told the subject has answered", view.answered, true);
  eq("and never what they answered", view.answerIndex, null);
  eq("the room is told who has guessed", view.guessedSeats, [others[0]]);
  eq("and never what they guessed", view.guesses, {});
  eq("nobody is marked correct yet", view.correctSeats, []);
  eq(
    "and the raw state is nowhere in the view",
    JSON.stringify(view).includes('"rotation"') || JSON.stringify(view).includes('"rounds"'),
    false,
  );

  const subjectView = engine.viewFor(state, subject);
  truthy("the subject sees their own answer", subjectView.myAnswer !== null);
  eq("marked as the subject", subjectView.amSubject, true);
  eq("with no guess of their own", subjectView.myGuess, null);

  /* --- the assertion this game exists to make --------------------------- */
  eq("AND CANNOT SEE ANYBODY'S GUESS", subjectView.guesses, {});
  eq("not even a hint of one", JSON.stringify(subjectView).includes(`"${others[0]}":2`), false);

  const guesserView = engine.viewFor(state, others[0]);
  truthy("a guesser sees their own guess", guesserView.myGuess !== null);
  eq("and not the answer they are guessing at", guesserView.answerIndex, null);
  eq("nor anybody else's guess", guesserView.guesses, {});
  eq("and knows they are not the subject", guesserView.amSubject, false);

  const bystander = engine.viewFor(state, others[2]);
  eq("somebody yet to guess has nothing of their own", bystander.myGuess, null);
  eq("and still cannot see the answer", bystander.answerIndex, null);
}

/* ==========================================================================
 * 5 · Closing a round
 * ========================================================================== */

section("Revealing");

{
  let state = engine.createInitialState(setup());
  const subject = state.subjectSeat;
  const others = FOUR.filter((p) => p.seat !== subject).map((p) => p.seat);

  state = apply(state, subject, { type: "answer", option: 1 }).state;
  state = apply(state, others[0], { type: "guess", option: 1 }).state;
  state = apply(state, others[1], { type: "guess", option: 0 }).state;

  eq("still open while somebody has not guessed", state.phase, "answering");
  eq(
    "an early reveal is refused",
    engine.reduce(state, { type: "reveal" }, context(subject)).ok,
    false,
  );

  const last = apply(state, others[2], { type: "guess", option: 1 });
  eq("the last guess closes the round", last.state.phase, "revealed");

  const view = engine.publicView(last.state);
  truthy("and now the answer is public", view.answerIndex !== null);
  eq("along with every guess", Object.keys(view.guesses).length, 3);
  eq("and who got it", view.correctSeats.sort(), [others[0], others[2]].sort());
  eq("the round was not void", view.voided, false);
}

{
  // The clock. Whoever has not acted simply misses out.
  let state = engine.createInitialState(setup());
  const subject = state.subjectSeat;
  const others = FOUR.filter((p) => p.seat !== subject).map((p) => p.seat);

  state = apply(state, subject, { type: "answer", option: 0 }).state;
  state = apply(state, others[0], { type: "guess", option: 0 }).state;

  const closed = apply(state, others[1], { type: "reveal" }, FOUR, state.deadline + 1);
  eq("once time is up anybody may close it", closed.state.phase, "revealed");
  eq("whoever guessed right scores", closed.state.scores[others[0]], 1);
  eq("whoever did not answer scores nothing", closed.state.scores[others[1]], 0);
  eq("and loses their streak", closed.state.streaks[others[1]], 0);

  const tooLate = engine.reduce(
    closed.state,
    { type: "guess", option: 0 },
    context(others[1], FOUR, state.deadline + 1),
  );
  eq("and cannot guess afterwards", tooLate.ok, false);
}

{
  // Clocks disagree. A whisker late still counts.
  const state = engine.createInitialState(setup());
  const guesser = FOUR.find((p) => p.seat !== state.subjectSeat).seat;

  const nearly = engine.reduce(
    state,
    { type: "guess", option: 0 },
    context(guesser, FOUR, state.deadline + 1000),
  );
  truthy("a second past the deadline is fine", nearly.ok);

  const late = engine.reduce(
    state,
    { type: "guess", option: 0 },
    context(guesser, FOUR, state.deadline + 20_000),
  );
  eq("twenty seconds is not", late.ok, false);
}

/* ==========================================================================
 * 6 · A round nobody can score
 * ========================================================================== */

section("When the subject never answers");

{
  let state = engine.createInitialState(setup());
  const subject = state.subjectSeat;
  const others = FOUR.filter((p) => p.seat !== subject).map((p) => p.seat);

  // Everybody guesses; the subject says nothing.
  for (const seat of others) {
    state = apply(state, seat, { type: "guess", option: 1 }).state;
  }

  eq("guesses alone do not close the round", state.phase, "answering");

  const closed = apply(state, others[0], { type: "reveal" }, FOUR, state.deadline + 1);
  const view = engine.publicView(closed.state);

  eq("the round is void", view.voided, true);
  eq("with no answer to show", view.answerIndex, null);
  eq(
    "nobody scores",
    Object.values(closed.state.scores).every((s) => s === 0),
    true,
  );
  eq("and nobody is marked correct", view.correctSeats, []);

  // The important part: a streak is not broken by somebody ELSE's silence.
  eq(
    "and nobody's streak is broken by somebody else's timeout",
    Object.values(closed.state.streaks).every((s) => s === 0),
    true,
  );
}

/* ==========================================================================
 * 7 · Duplicates
 * ========================================================================== */

section("Duplicates");

{
  let state = engine.createInitialState(setup());
  const subject = state.subjectSeat;
  const guesser = FOUR.find((p) => p.seat !== subject).seat;

  state = apply(state, subject, { type: "answer", option: 1 }).state;
  const twice = engine.reduce(state, { type: "answer", option: 2 }, context(subject));
  eq("the subject cannot change their answer", twice.ok, false);
  eq("so the truth is fixed once stated", state.answer, 1);

  state = apply(state, guesser, { type: "guess", option: 0 }).state;
  const again = engine.reduce(state, { type: "guess", option: 1 }, context(guesser));
  eq("a guesser cannot change their guess", again.ok, false);
  eq(
    "even to the same value",
    engine.reduce(state, { type: "guess", option: 0 }, context(guesser)).ok,
    false,
  );
  eq("so the count cannot be padded", Object.keys(state.guesses).length, 1);

  const early = engine.reduce(state, { type: "next" }, context(subject));
  eq("next before the reveal is refused", early.ok, false);
}

/* ==========================================================================
 * 8 · Scoring and rotation
 * ========================================================================== */

section("Scoring and rotation");

{
  let state = engine.createInitialState(setup(FOUR, 31, { laps: 1 }));
  const firstSubject = state.subjectSeat;
  const others = FOUR.filter((p) => p.seat !== firstSubject).map((p) => p.seat);

  state = playRound(state, 2, { [others[0]]: 2, [others[1]]: 2, [others[2]]: 0 });

  eq("guessing right scores", state.scores[others[0]], 1);
  eq("for everybody who did", state.scores[others[1]], 1);
  eq("guessing wrong does not", state.scores[others[2]], 0);
  eq("the subject scores nothing — they are the question", state.scores[firstSubject], 0);
  eq("streaks follow", state.streaks[others[0]], 1);
  eq("and reset", state.streaks[others[2]], 0);

  state = apply(state, firstSubject, { type: "next" }).state;
  eq("the subject rotates", state.subjectSeat !== firstSubject, true);
  eq("to the next in the order", state.subjectSeat, state.rotation[1]);
  eq("the new round is open", state.phase, "answering");
  eq("with nothing carried over", [state.answer, Object.keys(state.guesses).length], [null, 0]);
  truthy("and a fresh deadline", state.deadline > NOW);
}

{
  // Three correct in a row pays a bonus.
  let state = engine.createInitialState(setup(FOUR, 55, { laps: 1 }));
  // Seat that is never the subject in the first three rounds.
  const chaser = state.rotation[3];

  for (let round = 0; round < 3; round += 1) {
    const subject = state.subjectSeat;
    const guesses = {};
    for (const player of FOUR) {
      if (player.seat !== subject) guesses[player.seat] = 1;
    }
    state = playRound(state, 1, guesses);
    if (round < 2) state = apply(state, subject, { type: "next" }).state;
  }

  eq("three in a row pays a bonus on the third", state.scores[chaser], 1 + 1 + 2);
  eq("and the streak keeps counting", state.streaks[chaser], 3);
}

/* ==========================================================================
 * 9 · Somebody leaves
 * ========================================================================== */

section("Leaving");

{
  let state = engine.createInitialState(setup());
  const subject = state.subjectSeat;
  const others = FOUR.filter((p) => p.seat !== subject).map((p) => p.seat);

  state = apply(state, subject, { type: "answer", option: 1 }).state;
  state = apply(state, others[0], { type: "guess", option: 1 }).state;

  // Two of the guessers walk out. Only the subject and one guesser remain, and
  // that guesser has already guessed.
  const remaining = FOUR.filter((p) => p.seat === subject || p.seat === others[0]);

  const closed = engine.reduce(state, { type: "reveal" }, context(subject, remaining));
  truthy("the round closes once the leavers are gone", closed.ok);
  eq("and only the people still here are scored", closed.state.scores[others[0]], 1);
  eq("the leavers score nothing", closed.state.scores[others[1]], 0);
}

{
  // The subject themselves walks out. Nobody can answer for them.
  let state = engine.createInitialState(setup());
  const subject = state.subjectSeat;
  const others = FOUR.filter((p) => p.seat !== subject).map((p) => p.seat);

  state = apply(state, others[0], { type: "guess", option: 1 }).state;

  const withoutSubject = FOUR.filter((p) => p.seat !== subject);
  const closed = engine.reduce(state, { type: "reveal" }, context(others[0], withoutSubject));

  truthy("the round can be closed without them", closed.ok);
  eq("and is void — there was no answer to guess", engine.publicView(closed.state).voided, true);

  const advanced = apply(closed.state, others[0], { type: "next" }, withoutSubject);
  truthy(
    "the rotation steps over somebody who has left",
    withoutSubject.some((p) => p.seat === advanced.state.subjectSeat),
  );
  eq("so the next subject is somebody still here", advanced.state.subjectSeat !== subject, true);
}

/* ==========================================================================
 * 10 · Finishing
 * ========================================================================== */

section("Finishing");

{
  let state = engine.createInitialState(setup(FOUR, 12, { laps: 1 }));

  for (let round = 0; round < 4; round += 1) {
    const subject = state.subjectSeat;
    const guesses = {};
    for (const player of FOUR) {
      // One seat always guesses right, one always wrong.
      if (player.seat === subject) continue;
      guesses[player.seat] = player.seat === state.rotation[0] ? 0 : 3;
    }
    state = playRound(state, 0, guesses);

    if (round < 3) {
      state = apply(state, subject, { type: "next" }).state;
    } else {
      const done = engine.reduce(state, { type: "next" }, context(subject));
      truthy("the last round ends the game", done.ok && done.outcome !== undefined);
      eq("with nobody's turn", done.turnSeat, null);

      const outcome = done.outcome;
      eq("every seat is placed", Object.keys(outcome.placements).sort(), ["0", "1", "2", "3"]);
      truthy("somebody won", outcome.winnerSeats.length >= 1);
      eq(
        "and the winner is the top scorer",
        outcome.winnerSeats.every(
          (seat) => outcome.scores[seat] === Math.max(...Object.values(outcome.scores)),
        ),
        true,
      );
    }
  }
}

/* ==========================================================================
 * 11 · The database half
 * ========================================================================== */

section("In the database");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
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

const { rows: roomRows } = await asUser(db, ada, "select public.start_group($1, $2) as id", [
  "Games night",
  [rafa, wren],
]);
const room = roomRows[0].id;

{
  const { rows } = await asUser(
    db,
    ada,
    "select * from public.list_games() where key = 'who-knows-me'",
  );
  eq("the game is on the shelf", rows.length, 1);
  eq("and enabled — it has an engine", rows[0].enabled, true);
  eq("two to six players", [rows[0].min_players, rows[0].max_players], [2, 6]);
  eq("everybody acts at once", rows[0].pace, "realtime");

  // Counted against the registry rather than a literal: a hardcoded number here
  // breaks every time a game is added, which has now happened twice.
  const { rows: playable } = await asUser(
    db,
    ada,
    "select key from public.list_games() where enabled",
  );
  eq(
    "every enabled game has an engine behind it",
    playable.map((g) => g.key).sort(),
    [...ENGINE_KEYS].sort(),
  );
}

{
  // The whole lifecycle, through the real RPCs, with the real engine.
  const { rows: created } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'who-knows-me') as id",
    [room],
  );
  const session = created[0].id;

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

  eq("three players get two laps", initial.totalRounds, 6);

  // The subject answers. Now there is a live secret in the database.
  const subjectSeat = initial.subjectSeat;
  const subjectId = players.find((p) => p.seat === subjectSeat).userId;

  const answered = engine.reduce(
    initial,
    { type: "answer", option: 2 },
    {
      seat: subjectSeat,
      players,
      seed: 0,
      config: {},
      now: Date.now(),
    },
  );

  await asService(
    db,
    "select public.commit_game_move($1, $2, 1, $3::jsonb, $4::jsonb, null::smallint, null, false)",
    [
      session,
      subjectId,
      JSON.stringify(answered.state),
      JSON.stringify({ type: "answer", option: 2 }),
    ],
  );

  /* --- the secret must not be fetchable -------------------------------- */

  const guesser = players.find((p) => p.seat !== subjectSeat);

  const { rows: rpc } = await asUser(
    db,
    guesser.userId,
    "select * from public.get_game_session($1)",
    [session],
  );
  eq("the session RPC still carries no state", "state" in rpc[0], false);

  await denied(
    "a guesser cannot select the state column",
    asUser(db, guesser.userId, "select state from public.game_sessions where id = $1", [session]),
  );

  await denied(
    "nor with a wildcard",
    asUser(db, guesser.userId, "select * from public.game_sessions where id = $1", [session]),
  );

  /*
   * And the audit log, which was the last way in.
   *
   * `game_moves` is readable by anybody who can watch — right for an audit
   * trail, wrong while a game is running, because a move's payload IS the move.
   * Here that is the subject's answer, sitting in a table any guesser could
   * select from. Migration 0018 took the state off the client's read path and
   * left this behind; 0019 finishes the job.
   */
  await denied(
    "the move log does not expose payloads",
    asUser(db, guesser.userId, "select payload from public.game_moves where session_id = $1", [
      session,
    ]),
  );

  await denied(
    "nor via a wildcard",
    asUser(db, guesser.userId, "select * from public.game_moves where session_id = $1", [session]),
  );

  const { rows: timeline } = await asUser(
    db,
    guesser.userId,
    "select seq, player_id, created_at from public.game_moves where session_id = $1",
    [session],
  );
  eq("but the timeline is still readable — that is what an audit trail is", timeline.length, 1);
  eq("showing who moved", timeline[0].player_id, subjectId);
  eq("and in what order", timeline[0].seq, 0);

  const { rows: full } = await asService(
    db,
    "select payload from public.game_moves where session_id = $1",
    [session],
  );
  eq("while the server can still read it, so replay is unaffected", full[0].payload, {
    type: "answer",
    option: 2,
  });
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
