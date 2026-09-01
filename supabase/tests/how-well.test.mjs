/**
 * How Well Do You Know Me?
 *
 * The first couple game, which means two things get tested that never have.
 *
 * THE COUPLE SCOPE. `game_sessions` has always had two of them — a conversation
 * or a couple — and until now only one was reachable. So: a couple can open a
 * session, only the two of them can touch it, and every lifecycle function that
 * was written for conversations works unchanged on the other scope.
 *
 * NO WINNER. This is the one game in KITH that must not rank its players, and
 * "must not" is a thing to assert rather than intend. Both seats carry the same
 * score, both are listed as winners, and the result copy is checked for being a
 * joke rather than a measurement — the brief was explicit about that.
 *
 *     npm run howwell:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const {
  howWell: engine,
  QUESTIONS,
  describeResult,
} = await import("../../src/features/games/engine/games/how-well.ts");
const { registeredKeys } = await import("../../src/features/games/engine/index.ts");

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

console.log("KITH — How Well Do You Know Me?\n");

/* ========================================================================== */

const PAIR = [
  { seat: 0, userId: "u0", displayName: "Ada" },
  { seat: 1, userId: "u1", displayName: "Rafa" },
];

const NOW = 1_800_000_000_000;

const setup = (seed = 606, config = {}) => ({ players: PAIR, seed, config, now: NOW });
const context = (seat, players = PAIR, now = NOW) => ({
  seat,
  players,
  seed: 606,
  config: {},
  now,
});

function apply(state, seat, move, players = PAIR, now = NOW) {
  const result = engine.reduce(state, move, context(seat, players, now));
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result;
}

/** Both answer. `agree` decides whether the guesser matches the truth. */
function playRound(state, truth, agree, players = PAIR, now = NOW) {
  const subject = state.rounds[state.round].subjectSeat;
  const guesser = subject === 0 ? 1 : 0;
  const optionCount = state.rounds[state.round].question.options.length;
  const guess = agree ? truth : (truth + 1) % optionCount;

  let next = apply(state, subject, { type: "answer", option: truth }, players, now).state;
  next = apply(next, guesser, { type: "answer", option: guess }, players, now).state;
  return next;
}

/* ==========================================================================
 * 1 · Setting up
 * ========================================================================== */

section("Setup");

{
  const a = engine.createInitialState(setup(11));
  const b = engine.createInitialState(setup(11));
  const c = engine.createInitialState(setup(12));

  eq("the same seed builds the same game", a.rounds, b.rounds);
  truthy("a different seed does not", JSON.stringify(a.rounds) !== JSON.stringify(c.rounds));

  eq("ten rounds by default", a.totalRounds, 10);
  eq("and that many questions lined up", a.rounds.length, 10);

  // Being asked about and doing the guessing are different jobs, so an even
  // split matters.
  const subjects = a.rounds.map((r) => r.subjectSeat);
  eq("the subject alternates every round", subjects.filter((x) => x === 0).length, 5);
  eq("so both are asked about equally", subjects.filter((x) => x === 1).length, 5);
  truthy(
    "and it really alternates rather than clumping",
    subjects.every((seat, i) => (i === 0 ? true : seat !== subjects[i - 1])),
  );

  const short = engine.createInitialState(setup(1, { rounds: 4 }));
  eq("the round count is configurable", short.totalRounds, 4);
  const silly = engine.createInitialState(setup(1, { rounds: 500 }));
  eq("but not absurdly", silly.totalRounds, 10);

  eq("nobody holds the turn — both answer at once", engine.initialTurnSeat(a, setup()), null);
  eq("the score starts at zero", a.score, 0);

  truthy("there are questions", QUESTIONS.length >= 20);
  eq(
    "all with real choices",
    QUESTIONS.every((q) => q.options.length >= 3 && new Set(q.options).size === q.options.length),
    true,
  );
}

{
  // Option order shuffles per round, so a position never carries information.
  const state = engine.createInitialState(setup(77));
  const orders = state.rounds.map((r) => r.order.join(""));
  truthy("the options are not always in the same order", new Set(orders).size > 1);
}

/* ==========================================================================
 * 2 · Both answer, neither sees
 * ========================================================================== */

section("Secrecy");

{
  const state = engine.createInitialState(setup());
  const subject = state.rounds[0].subjectSeat;
  const guesser = subject === 0 ? 1 : 0;

  const afterTruth = apply(state, subject, { type: "answer", option: 1 }).state;
  const view = engine.publicView(afterTruth);

  eq("the pair is told the subject has answered", view.truthIn, true);
  eq("and never what they said", view.truthIndex, null);
  eq("the guess is still outstanding", view.guessIn, false);

  const guesserView = engine.viewFor(afterTruth, guesser);
  eq("THE GUESSER CANNOT SEE THE TRUTH", guesserView.truthIndex, null);
  eq("and has nothing of their own yet", guesserView.myAnswer, null);
  eq("but knows they are guessing", guesserView.amSubject, false);

  const subjectView = engine.viewFor(afterTruth, subject);
  truthy("the subject sees their own answer", subjectView.myAnswer !== null);
  eq("and knows they are the subject", subjectView.amSubject, true);

  const afterGuess = apply(afterTruth, guesser, { type: "answer", option: 2 }).state;
  eq("both in closes the round at once", afterGuess.phase, "revealed");

  const revealed = engine.publicView(afterGuess);
  truthy("and now both answers are visible", revealed.truthIndex !== null);
  truthy("including the guess", revealed.guessIndex !== null);
  eq("they did not match", revealed.matched, false);
}

/* ==========================================================================
 * 3 · Who does what
 * ========================================================================== */

section("Roles");

{
  let state = engine.createInitialState(setup());
  const subject = state.rounds[0].subjectSeat;
  const guesser = subject === 0 ? 1 : 0;

  state = apply(state, subject, { type: "answer", option: 0 }).state;

  const twice = engine.reduce(state, { type: "answer", option: 1 }, context(subject));
  eq("the subject cannot change their answer", twice.ok, false);
  eq("so the truth is fixed once stated", state.truth, 0);

  state = apply(state, guesser, { type: "answer", option: 0 }).state;
  const guessTwice = engine.reduce(
    { ...state, phase: "answering" },
    { type: "answer", option: 2 },
    context(guesser),
  );
  eq("and the guesser cannot change theirs", guessTwice.ok, false);

  const outOfRange = engine.reduce(
    engine.createInitialState(setup()),
    { type: "answer", option: 99 },
    context(0),
  );
  eq("nobody can pick an option that does not exist", outOfRange.ok, false);
}

/* ==========================================================================
 * 4 · The clock
 * ========================================================================== */

section("Timer");

{
  const state = engine.createInitialState(setup());
  const subject = state.rounds[0].subjectSeat;

  const withTruth = apply(state, subject, { type: "answer", option: 0 }).state;

  const early = engine.reduce(withTruth, { type: "reveal" }, context(subject));
  eq("a reveal before both are in is refused", early.ok, false);

  const closed = apply(withTruth, subject, { type: "reveal" }, PAIR, state.deadline + 1);
  eq("once time is up anybody may close it", closed.state.phase, "revealed");

  // Half a round is not a miss. It never happened.
  eq("an unfinished round does not count against them", closed.state.score, 0);
  eq("and is not recorded as a played round", closed.state.matched.length, 0);

  const nearly = engine.reduce(
    state,
    { type: "answer", option: 0 },
    context(subject, PAIR, state.deadline + 1000),
  );
  truthy("a second past the deadline still counts", nearly.ok);

  const late = engine.reduce(
    state,
    { type: "answer", option: 0 },
    context(subject, PAIR, state.deadline + 20_000),
  );
  eq("twenty seconds does not", late.ok, false);
}

/* ==========================================================================
 * 5 · One score, for the pair
 *
 * The decision this game exists to make.
 * ========================================================================== */

section("A shared score");

{
  let state = engine.createInitialState(setup(5, { rounds: 4 }));

  state = playRound(state, 1, true);
  eq("a match scores", state.score, 1);
  eq("and is recorded", state.matched, [true]);

  const scores = engine.scores(state);
  eq("BOTH SEATS CARRY THE SAME NUMBER", [scores[0], scores[1]], [1, 1]);

  state = apply(state, 0, { type: "next" }).state;
  state = playRound(state, 0, false);
  eq("a miss does not score", state.score, 1);
  eq("but is still a round played", state.matched.length, 2);

  const after = engine.scores(state);
  eq("and the two are still equal", after[0], after[1]);
}

{
  // The ending.
  let state = engine.createInitialState(setup(9, { rounds: 2 }));
  state = playRound(state, 0, true);
  state = apply(state, 0, { type: "next" }).state;
  state = playRound(state, 1, true);

  const done = engine.reduce(state, { type: "next" }, context(0));
  truthy("the last round ends the game", done.ok && done.outcome !== undefined);

  const outcome = done.outcome;
  eq("both finish on the same score", [outcome.scores[0], outcome.scores[1]], [2, 2]);
  eq("both are placed first", [outcome.placements[0], outcome.placements[1]], [1, 1]);
  eq("AND BOTH ARE WINNERS — there is nobody to beat", outcome.winnerSeats.sort(), [0, 1]);
}

{
  // Even at zero, nobody loses to the other.
  let state = engine.createInitialState(setup(4, { rounds: 2 }));
  state = playRound(state, 0, false);
  state = apply(state, 0, { type: "next" }).state;
  state = playRound(state, 1, false);

  const done = engine.reduce(state, { type: "next" }, context(0));
  eq("a bad game is bad for both of them equally", done.outcome.scores, { 0: 0, 1: 0 });
  eq("and still nobody loses", done.outcome.winnerSeats.sort(), [0, 1]);
}

/* ==========================================================================
 * 6 · Playful, not a measurement
 *
 * The brief was explicit, so it is checked rather than trusted.
 * ========================================================================== */

section("The result copy");

{
  const bands = [0, 1, 2, 4, 6, 8, 10].map((score) => describeResult(score, 10));

  eq(
    "every score gets a title",
    bands.every((b) => b.title.length > 0),
    true,
  );
  eq(
    "and a line",
    bands.every((b) => b.line.length > 0),
    true,
  );
  truthy("the bands are distinct", new Set(bands.map((b) => b.title)).size >= 5);

  const everything = JSON.stringify(bands).toLowerCase();

  // The words that would turn a quiz into a diagnosis.
  for (const word of [
    "compatib",
    "psycholog",
    "percentile",
    "score of",
    "healthy",
    "unhealthy",
    "warning",
    "concern",
  ]) {
    eq(`no clinical language: "${word}"`, everything.includes(word), false);
  }

  eq(
    "a perfect score is teased, not celebrated",
    describeResult(10, 10).title,
    "Suspiciously perfect",
  );
  truthy(
    "and a bad one is kind about it",
    /impressive|good news|room/i.test(describeResult(0, 10).line + describeResult(2, 10).line),
  );

  eq("no rounds played says so plainly", describeResult(0, 0).title, "Nothing to report");
}

/* ==========================================================================
 * 7 · Somebody leaves
 * ========================================================================== */

section("Leaving");

{
  const state = engine.createInitialState(setup());
  const subject = state.rounds[0].subjectSeat;
  const alone = PAIR.filter((p) => p.seat !== subject);

  const closed = engine.reduce(state, { type: "reveal" }, context(alone[0].seat, alone));
  truthy("the round can be closed once the subject has gone", closed.ok);
  eq("and nothing is scored against them", closed.state.score, 0);
  eq("nor recorded as played", closed.state.matched.length, 0);
}

/* ==========================================================================
 * 8 · The couple scope
 *
 * `game_sessions` has had two scopes since migration 0007 and only one was
 * reachable until now.
 * ========================================================================== */

section("Couple sessions");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");

await asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
  ada < rafa ? ada : rafa,
  ada < rafa ? rafa : ada,
]);
await asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
  ada < nour ? ada : nour,
  ada < nour ? nour : ada,
]);

const { rows: proposed } = await asUser(db, ada, "select public.propose_couple($1) as id", [rafa]);
const couple = proposed[0].id;
await asUser(db, rafa, "select public.respond_to_couple($1, true)", [couple]);

{
  const { rows } = await asUser(
    db,
    ada,
    "select * from public.list_games() where key = 'how-well'",
  );
  eq("the game is on the shelf", rows.length, 1);
  eq("enabled", rows[0].enabled, true);
  eq("for couples", rows[0].audience, "couple");
  eq("exactly two players", [rows[0].min_players, rows[0].max_players], [2, 2]);

  const { rows: enabled } = await asUser(
    db,
    ada,
    "select key from public.list_games() where enabled",
  );
  eq(
    "every enabled game has an engine",
    enabled.map((g) => g.key).sort(),
    [...registeredKeys()].sort(),
  );
}

let session;
{
  await denied(
    "somebody outside the couple cannot open one",
    asUser(db, nour, "select public.create_couple_game($1, 'how-well')", [couple]),
  );

  await denied(
    "and a group game cannot be opened as a couple game",
    asUser(db, ada, "select public.create_couple_game($1, 'would-you-rather')", [couple]),
  );

  const { rows } = await asUser(db, ada, "select public.create_couple_game($1, 'how-well') as id", [
    couple,
  ]);
  session = rows[0].id;
  truthy("a partner can open one", Boolean(session));

  const { rows: state } = await asService(
    db,
    "select conversation_id, couple_id, status from public.game_sessions where id = $1",
    [session],
  );
  eq("scoped to the couple", state[0].couple_id, couple);
  eq("and not to a conversation", state[0].conversation_id, null);
  eq("starting in a lobby", state[0].status, "lobby");

  // No lobby to fill: both are already at the table.
  const { rows: seats } = await asService(
    db,
    "select user_id, seat from public.game_players where session_id = $1 order by seat",
    [session],
  );
  eq("both partners are seated immediately", seats.length, 2);
  eq("and nobody else", seats.map((s) => s.user_id).sort(), [ada, rafa].sort());

  const { rows: again } = await asUser(
    db,
    ada,
    "select public.create_couple_game($1, 'how-well') as id",
    [couple],
  );
  eq("opening it twice returns the same session", again[0].id, session);
}

{
  // The whole point of the couple scope: only the two of them.
  await denied(
    "an outsider cannot see the session",
    asUser(db, nour, "select * from public.get_game_session($1)", [session]),
  );
  await denied(
    "nor its players",
    asUser(db, nour, "select * from public.list_game_players($1)", [session]),
  );
  await denied("nor join it", asUser(db, nour, "select public.join_game_session($1)", [session]));
  const { rows } = await asUser(db, rafa, "select * from public.get_game_session($1)", [session]);
  eq("but a partner can", rows.length, 1);
  eq("with the couple scope on it", rows[0].couple_id, couple);
  eq("and no conversation", rows[0].conversation_id, null);
  eq("and still no state on this path", "state" in rows[0], false);
  eq("with a seat", rows[0].my_seat !== null, true);
}

{
  // Everything written for conversation games works here unchanged.
  await asUser(db, ada, "select public.set_game_ready($1, true)", [session]);
  const { rows: notYet } = await asUser(db, ada, "select public.can_start_game($1) as yes", [
    session,
  ]);
  eq("one of them ready is not enough", notYet[0].yes, false);

  await asUser(db, rafa, "select public.set_game_ready($1, true)", [session]);
  const { rows: ready } = await asUser(db, ada, "select public.can_start_game($1) as yes", [
    session,
  ]);
  eq("both ready and the host can start", ready[0].yes, true);

  const players = [
    { seat: 0, userId: ada, displayName: "ada" },
    { seat: 1, userId: rafa, displayName: "rafa" },
  ];

  const { rows: seedRow } = await asService(
    db,
    "select seed from public.game_sessions where id = $1",
    [session],
  );
  const initial = engine.createInitialState({
    players,
    seed: Number(BigInt(seedRow[0].seed) % 100000n),
    config: { rounds: 2 },
    now: Date.now(),
  });

  await asService(db, "select public.start_game_session($1, $2, $3::jsonb, null::smallint)", [
    session,
    ada,
    JSON.stringify(initial),
  ]);

  const { rows: active } = await asService(
    db,
    "select status from public.game_sessions where id = $1",
    [session],
  );
  eq("the game starts", active[0].status, "active");

  await denied(
    "and the secret is still not fetchable",
    asUser(db, rafa, "select state from public.game_sessions where id = $1", [session]),
  );

  // Checked here rather than before the start: earlier, this was refused because
  // the game was not active, which is a true answer to a different question.
  // Now the game IS active, so the only thing left to refuse on is membership.
  await denied(
    "an outsider cannot move in a running couple game",
    asService(
      db,
      "select public.commit_game_move($1, $2, 1, '{}'::jsonb, '{}'::jsonb, null::smallint)",
      [session, nour],
    ),
  );
}

{
  // The history the brief asked for.
  const { rows } = await asUser(db, ada, "select * from public.list_couple_games($1)", [couple]);
  eq("the couple can see what they have played", rows.length, 1);
  eq("with the live one first", rows[0].status, "active");

  await denied(
    "and nobody else can",
    asUser(db, nour, "select * from public.list_couple_games($1)", [couple]),
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
