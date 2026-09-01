/**
 * Guess My Answer.
 *
 * The second couple game, and the first game of any kind that is configured
 * before it opens. Three things get tested here that never have:
 *
 * FOUR SECRETS PER ROUND, not one. Both partners submit an answer AND a
 * prediction, and all four have to stay invisible until the last of them lands.
 * This is the fourth game in a row where a new secret shape has exposed a new
 * leak path in the layer under it, so the secrecy checks here are deliberately
 * blunt: serialise every view and search it for the values it must not contain.
 *
 * CONFIG. `game_sessions.config` has existed since migration 0007 and has been
 * `{}` in every session ever created. It now carries the pair's category choice,
 * which means an object from a browser is stored and then broadcast to both
 * players on every state change. Checked at all three layers: the whitelist in
 * `parseGameConfig`, the size cap in `create_couple_game`, and the engine's
 * refusal to trust any of it.
 *
 * PER-PERSON SCORES WITHOUT A WINNER. This game shows two numbers where How Well
 * shows one, and it still must not rank anybody. Both seats are asserted to come
 * back as winners no matter how lopsided the scores are.
 *
 *     npm run guess:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const {
  guessMyAnswer: engine,
  QUESTIONS,
  describeTogether,
} = await import("../../src/features/games/engine/games/guess-my-answer.ts");
const { registeredKeys } = await import("../../src/features/games/engine/index.ts");
const { GUESS_MY_ANSWER_CATEGORIES, GUESS_MY_ANSWER_CATEGORY_KEYS, parseGameConfig } =
  await import("../../src/lib/games/config.ts");

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
const falsy = (n, v, d = "expected a falsy value") => (v ? bad(n, d) : ok(n));
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

console.log("KITH — Guess My Answer\n");

/* ========================================================================== */

const PAIR = [
  { seat: 0, userId: "u0", displayName: "Ada" },
  { seat: 1, userId: "u1", displayName: "Rafa" },
];

const NOW = 1_800_000_000_000;

const setup = (seed = 909, config = {}) => ({ players: PAIR, seed, config, now: NOW });
const context = (seat, players = PAIR, now = NOW) => ({
  seat,
  players,
  seed: 909,
  config: {},
  now,
});

function apply(state, seat, move, players = PAIR, now = NOW) {
  const result = engine.reduce(state, move, context(seat, players, now));
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result;
}

function refused(state, seat, move, players = PAIR, now = NOW) {
  return engine.reduce(state, move, context(seat, players, now));
}

/** Both partners submit. `hits` says which of them predicted correctly. */
function playRound(state, { a, b, aHits, bHits }, players = PAIR, now = NOW) {
  const count = state.rounds[state.round].question.options.length;
  // Seat 0 predicts seat 1's answer, and vice versa.
  const aPredict = aHits ? b : (b + 1) % count;
  const bPredict = bHits ? a : (a + 1) % count;

  let next = apply(state, 0, { type: "submit", own: a, predict: aPredict }, players, now).state;
  next = apply(next, 1, { type: "submit", own: b, predict: bPredict }, players, now).state;
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

  eq("eight rounds by default", a.totalRounds, 8);
  eq("and that many lined up", a.rounds.length, 8);
  eq("starting on the first", a.round, 0);
  eq("answering", a.phase, "answering");
  eq("with nothing submitted", a.submissions, {});
  eq("and both on nought", a.scores, { 0: 0, 1: 0 });
  eq("nothing judged yet", a.judged, 0);
  eq("nobody holds the turn", engine.initialTurnSeat(setup()), null);
  truthy("the clock is running", a.deadline > NOW);
}

{
  eq(
    "a round count is honoured",
    engine.createInitialState(setup(1, { rounds: 4 })).totalRounds,
    4,
  );
  eq("a silly one is not", engine.createInitialState(setup(1, { rounds: 900 })).totalRounds, 8);
  eq("nor a negative one", engine.createInitialState(setup(1, { rounds: -3 })).totalRounds, 8);
  eq("nor a fractional one", engine.createInitialState(setup(1, { rounds: 4.5 })).totalRounds, 8);
  // A numeric string is read as the number it is — config arrives as jsonb and
  // has been through a browser, and refusing "4" would be pedantry. Anything
  // that is not a number at all falls back.
  eq(
    "a numeric string is read",
    engine.createInitialState(setup(1, { rounds: "4" })).totalRounds,
    4,
  );
  eq("but a word is not", engine.createInitialState(setup(1, { rounds: "lots" })).totalRounds, 8);
  eq("nor null", engine.createInitialState(setup(1, { rounds: null })).totalRounds, 8);
  eq("nor an object", engine.createInitialState(setup(1, { rounds: {} })).totalRounds, 8);
}

/* ==========================================================================
 * 2 · Categories
 * ========================================================================== */

section("Categories");

{
  const all = engine.createInitialState(setup(3));
  eq("no choice means all of them", all.categories, [...GUESS_MY_ANSWER_CATEGORY_KEYS]);

  const petty = engine.createInitialState(setup(3, { categories: ["petty"] }));
  eq("one category is kept", petty.categories, ["petty"]);
  eq(
    "and every question comes from it",
    [...new Set(petty.rounds.map((r) => r.question.category))],
    ["petty"],
  );

  const two = engine.createInitialState(setup(3, { categories: ["tender", "wild"] }));
  eq(
    "two categories, and nothing else",
    [...new Set(two.rounds.map((r) => r.question.category))].sort(),
    ["tender", "wild"],
  );
}

{
  // The engine treats config as a suggestion, not a contract. A session created
  // by an older client, or a category retired in a later release, must not be
  // able to produce a game with no questions in it.
  const nonsense = engine.createInitialState(setup(3, { categories: ["nonsense", "petty"] }));
  eq("an unknown category is dropped", nonsense.categories, ["petty"]);

  const allBad = engine.createInitialState(setup(3, { categories: ["nope"] }));
  eq("all-unknown falls back to everything", allBad.categories, [...GUESS_MY_ANSWER_CATEGORY_KEYS]);
  eq("and still has a full game", allBad.rounds.length, 8);

  const empty = engine.createInitialState(setup(3, { categories: [] }));
  eq("an empty choice means everything", empty.categories, [...GUESS_MY_ANSWER_CATEGORY_KEYS]);

  const wrongType = engine.createInitialState(setup(3, { categories: "petty" }));
  eq("a string where a list belongs is ignored", wrongType.categories, [
    ...GUESS_MY_ANSWER_CATEGORY_KEYS,
  ]);

  truthy(
    "every round has a question even from the smallest pool",
    engine
      .createInitialState(setup(3, { categories: ["past"], rounds: 20 }))
      .rounds.every((r) => r.question && r.question.options.length > 0),
  );
}

/* ==========================================================================
 * 3 · The questions
 * ========================================================================== */

section("Questions");

{
  truthy("there are questions", QUESTIONS.length >= 20);
  eq("every one has four options", QUESTIONS.filter((q) => q.options.length !== 4).length, 0);
  eq(
    "no blank text",
    QUESTIONS.filter((q) => !q.text.trim() || q.options.some((o) => !o.trim())).length,
    0,
  );
  eq(
    "no duplicate options within a question",
    QUESTIONS.filter((q) => new Set(q.options).size !== q.options.length).length,
    0,
  );
  eq("no duplicate questions", new Set(QUESTIONS.map((q) => q.text)).size, QUESTIONS.length);

  eq(
    "every question belongs to a real category",
    QUESTIONS.filter((q) => !GUESS_MY_ANSWER_CATEGORY_KEYS.includes(q.category)).length,
    0,
  );
  eq(
    "and every category has enough to fill a game",
    GUESS_MY_ANSWER_CATEGORY_KEYS.filter(
      (key) => QUESTIONS.filter((q) => q.category === key).length < 4,
    ),
    [],
  );

  /*
   * The symmetry the whole game rests on: both people answer the same question
   * about themselves in the same round. A question phrased about the other one
   * ("what would they pick") cannot be answered twice, so second-person-plural
   * wording is the one thing that would quietly break the format.
   */
  eq(
    "no question is phrased about the other person",
    QUESTIONS.filter((q) => /\b(their|they|them)\b/i.test(q.text)).map((q) => q.text),
    [],
  );

  eq("the picker offers every category", GUESS_MY_ANSWER_CATEGORIES.length, 4);
  eq(
    "and only real ones",
    GUESS_MY_ANSWER_CATEGORIES.map((c) => c.key).sort(),
    [...GUESS_MY_ANSWER_CATEGORY_KEYS].sort(),
  );
  eq(
    "each with something to read",
    GUESS_MY_ANSWER_CATEGORIES.filter((c) => !c.name.trim() || !c.blurb.trim()).length,
    0,
  );
}

{
  // Options are shuffled per round: a position must never carry information
  // between rounds, and "the first one" must not become a habit.
  const state = engine.createInitialState(setup(77, { rounds: 12 }));
  const orders = state.rounds.map((r) => r.order.join(""));
  truthy("options are shuffled per round", new Set(orders).size > 1);
  eq(
    "and every shuffle is a permutation",
    state.rounds.filter((r) => [...r.order].sort().join("") !== "0123").length,
    0,
  );
}

/* ==========================================================================
 * 4 · Validating a move
 * ========================================================================== */

section("Move validation");

{
  eq("a submit is a submit", engine.validateMove({ type: "submit", own: 1, predict: 2 }), {
    type: "submit",
    own: 1,
    predict: 2,
  });
  eq("reveal", engine.validateMove({ type: "reveal" }), { type: "reveal" });
  eq("next", engine.validateMove({ type: "next" }), { type: "next" });

  eq("half a submission is not one", engine.validateMove({ type: "submit", own: 1 }), null);
  eq("nor the other half", engine.validateMove({ type: "submit", predict: 1 }), null);
  eq("negatives", engine.validateMove({ type: "submit", own: -1, predict: 0 }), null);
  eq("fractions", engine.validateMove({ type: "submit", own: 0.5, predict: 0 }), null);
  eq("strings", engine.validateMove({ type: "submit", own: "0", predict: 0 }), null);
  eq("NaN", engine.validateMove({ type: "submit", own: Number.NaN, predict: 0 }), null);
  eq("nonsense types", engine.validateMove({ type: "explode" }), null);
  eq("null", engine.validateMove(null), null);
  eq("a string", engine.validateMove("submit"), null);
  eq("a number", engine.validateMove(7), null);
  eq("an array", engine.validateMove([1, 2]), null);
}

/* ==========================================================================
 * 5 · A round
 * ========================================================================== */

section("Playing a round");

{
  const start = engine.createInitialState(setup(21, { rounds: 3 }));

  const one = apply(start, 0, { type: "submit", own: 1, predict: 2 }).state;
  eq("one submission does not reveal", one.phase, "answering");
  eq("and is recorded", one.submissions[0], { own: 1, predict: 2 });
  eq("the other seat is untouched", one.submissions[1], undefined);
  eq(
    "nobody holds the turn",
    apply(start, 0, { type: "submit", own: 1, predict: 2 }).turnSeat,
    null,
  );

  const twice = refused(one, 0, { type: "submit", own: 3, predict: 3 });
  falsy("the same person cannot submit twice", twice.ok);
  eq("and is told why", twice.reason, "You have already answered.");

  const both = apply(one, 1, { type: "submit", own: 2, predict: 1 }).state;
  eq("the second submission reveals", both.phase, "revealed");
  eq("both predictions landed", both.lastResult.correct.sort(), [0, 1]);
  eq("and both scored", both.scores, { 0: 1, 1: 1 });

  falsy(
    "submitting after the reveal is refused",
    refused(both, 0, { type: "submit", own: 0, predict: 0 }).ok,
  );
  falsy("and so is revealing again", refused(both, 0, { type: "reveal" }).ok);
}

{
  const start = engine.createInitialState(setup(22, { rounds: 3 }));
  const count = start.rounds[0].question.options.length;

  falsy(
    "an option that does not exist is refused",
    refused(start, 0, { type: "submit", own: count, predict: 0 }).ok,
  );
  falsy("on either half", refused(start, 0, { type: "submit", own: 0, predict: count + 5 }).ok);
}

{
  // Scoring, all four shapes.
  const start = engine.createInitialState(setup(23, { rounds: 4 }));

  const both = playRound(start, { a: 0, b: 1, aHits: true, bHits: true });
  eq("both right is two points", both.scores, { 0: 1, 1: 1 });
  eq("and both are named", both.lastResult.correct.sort(), [0, 1]);

  const onlyA = playRound(start, { a: 0, b: 1, aHits: true, bHits: false });
  eq("one right is one point", onlyA.scores, { 0: 1, 1: 0 });
  eq("to the one who got it", onlyA.lastResult.correct, [0]);

  const onlyB = playRound(start, { a: 0, b: 1, aHits: false, bHits: true });
  eq("and the other way round", onlyB.scores, { 0: 0, 1: 1 });

  const neither = playRound(start, { a: 0, b: 1, aHits: false, bHits: false });
  eq("neither is no points", neither.scores, { 0: 0, 1: 0 });
  eq("and nobody named", neither.lastResult.correct, []);
}

{
  // Agreeing with yourself is not a point: the prediction is about the other
  // one. Worth asserting because "own === predict" is the easy wrong comparison.
  const start = engine.createInitialState(setup(24, { rounds: 2 }));
  let s = apply(start, 0, { type: "submit", own: 2, predict: 2 }).state;
  s = apply(s, 1, { type: "submit", own: 0, predict: 0 }).state;

  eq("predicting your own answer scores nothing", s.scores, { 0: 0, 1: 0 });
  eq("and neither of them is named", s.lastResult.correct, []);
}

/* ==========================================================================
 * 6 · The clock
 * ========================================================================== */

section("The clock");

{
  const start = engine.createInitialState(setup(31, { rounds: 3 }));
  const late = start.deadline + 60_000;

  falsy(
    "a submission after the deadline is refused",
    refused(start, 0, { type: "submit", own: 0, predict: 0 }, PAIR, late).ok,
  );
  truthy(
    "but a hair over is not — a slow request is not a cheat",
    apply(start, 0, { type: "submit", own: 0, predict: 0 }, PAIR, start.deadline + 1000).ok,
  );

  falsy("nobody may reveal early", refused(start, 0, { type: "reveal" }).ok);

  const timedOut = apply(start, 0, { type: "reveal" }, PAIR, late).state;
  eq("but the clock closes the round", timedOut.phase, "revealed");
  eq("with nothing scored", timedOut.scores, { 0: 0, 1: 0 });
  eq("and nobody blamed", timedOut.lastResult.correct, []);
  eq("an abandoned round is not out of two", engine.publicView(timedOut).played, 0);
}

{
  // One of them answered, the other ran out of time. The one who answered has
  // still not been "wrong" — there is nothing to have been wrong about.
  const start = engine.createInitialState(setup(32, { rounds: 3 }));
  const half = apply(start, 0, { type: "submit", own: 1, predict: 1 }).state;
  const closed = apply(half, 0, { type: "reveal" }, PAIR, half.deadline + 60_000).state;

  eq("a half-finished round closes", closed.phase, "revealed");
  eq("and scores nothing", closed.scores, { 0: 0, 1: 0 });
  // Neither prediction could be judged: seat 1 sent nothing to be read, and
  // seat 1 never guessed. The denominator must not grow.
  eq("and counts for nothing out of nothing", engine.publicView(closed).played, 0);
  eq("the answer that was given is still shown", closed.lastResult.own[0], 1);
  eq("and the missing one reads as missing", closed.lastResult.own[1], null);
}

{
  // A partner who walked off should not hold the round open.
  const start = engine.createInitialState(setup(33, { rounds: 3 }));
  const alone = [PAIR[0]];
  const solo = apply(start, 0, { type: "submit", own: 1, predict: 1 }, alone).state;

  eq("with one player left, their submission closes the round", solo.phase, "revealed");
  eq("and scores nothing, because there is nobody to have read", solo.scores, { 0: 0, 1: 0 });
}

/* ==========================================================================
 * 7 · Secrecy
 * ========================================================================== */

section("Secrecy");

{
  const start = engine.createInitialState(setup(41, { rounds: 3 }));
  const one = apply(start, 0, { type: "submit", own: 1, predict: 3 }).state;

  const pub = engine.publicView(one);
  const text = JSON.stringify(pub);

  eq("the public view says somebody is in", pub.submittedSeats, [0]);
  eq("but shows no answers", pub.own, {});
  eq("and no predictions", pub.predict, {});
  eq("and nobody correct", pub.correct, []);
  falsy(
    "no submission survives anywhere in the payload",
    text.includes('"own":1') || text.includes('"predict":3') || text.includes('"submissions"'),
  );
  falsy("nor the question bank", text.includes('"rounds":['));
  falsy("nor the shuffle that would decode a later index", text.includes('"order"'));

  const mine = engine.viewFor(one, 0);
  truthy("my own view has my answer back", mine.myOwn !== null);
  truthy("and my prediction", mine.myPredict !== null);
  eq("as a display position, not a canonical one", mine.myOwn, one.rounds[0].order.indexOf(1));

  const theirs = engine.viewFor(one, 1);
  eq("the other one sees nothing of mine", theirs.myOwn, null);
  eq("nor my prediction", theirs.myPredict, null);
  falsy(
    "and nothing leaks into their payload either",
    JSON.stringify(theirs).includes('"submissions"'),
  );
  eq("though they can see that I am in", theirs.submittedSeats, [0]);
}

{
  // After the reveal it is all supposed to be visible — and it has to line up
  // with the options as displayed, or the board draws the wrong row.
  const start = engine.createInitialState(setup(42, { rounds: 3 }));
  const done = playRound(start, { a: 2, b: 0, aHits: true, bHits: false });

  const pub = engine.publicView(done);
  const round = done.rounds[0];

  eq("the reveal shows what seat 0 said", pub.own[0], round.order.indexOf(2));
  eq("and what seat 1 said", pub.own[1], round.order.indexOf(0));
  eq(
    "and the option at that position is the right words",
    pub.options[pub.own[0]],
    round.question.options[2],
  );
  eq("with the correct guesser named", pub.correct, [0]);
  eq("scores on both seats", pub.scores, { 0: 1, 1: 0 });
  eq("and the pair's total", pub.together, 1);
}

/* ==========================================================================
 * 8 · Rounds and the ending
 * ========================================================================== */

section("Rounds and the ending");

{
  const start = engine.createInitialState(setup(51, { rounds: 3 }));

  falsy("next is refused mid-round", refused(start, 0, { type: "next" }).ok);

  const done = playRound(start, { a: 0, b: 0, aHits: true, bHits: true });
  const next = apply(done, 0, { type: "next" }, PAIR, NOW + 5000);

  eq("next moves on", next.state.round, 1);
  eq("back to answering", next.state.phase, "answering");
  eq("with a clean sheet", next.state.submissions, {});
  eq("nothing left from last time", next.state.lastResult, null);
  truthy("and a fresh clock", next.state.deadline > done.deadline);
  eq("scores carry", next.state.scores, { 0: 1, 1: 1 });
  eq("but no outcome yet", next.outcome, undefined);
  truthy("the round is described", typeof engine.describe(next.state) === "string");
  truthy(
    "and the description names the category",
    GUESS_MY_ANSWER_CATEGORIES.some((c) => engine.describe(next.state).startsWith(c.name)),
  );
}

{
  // A whole game, lopsided on purpose: seat 0 reads seat 1 perfectly and seat 1
  // gets nothing. This is exactly the shape that a competitive game would turn
  // into "Ada wins", and it must not here.
  let state = engine.createInitialState(setup(52, { rounds: 3 }));
  let final;

  for (let round = 0; round < 3; round += 1) {
    state = playRound(state, { a: 0, b: 1, aHits: true, bHits: false });
    const result = apply(state, 0, { type: "next" });
    state = result.state;
    final = result.outcome;
  }

  truthy("the last round ends the game", Boolean(final));

  /*
   * The lopsided run is the whole point of this block. Three individual points
   * to nought is exactly the shape that any other game would render as "Ada
   * wins" -- so what leaves the engine is one number, on both seats.
   */
  eq("what is written down is the pair's total", final.scores, { 0: 3, 1: 3 });
  eq("both placed first", final.placements, { 0: 1, 1: 1 });
  eq("and both named as winners", final.winnerSeats.sort(), [0, 1]);
  eq("nobody is ranked below the other", new Set(Object.values(final.placements)).size, 1);
  eq(
    "no seat carries a different number from the other",
    new Set(Object.values(final.scores)).size,
    1,
  );

  eq("the shared scoreboard shows the same figure", engine.scores(state), { 0: 3, 1: 3 });
  eq("and nothing jumped when the game ended", engine.scores(state), final.scores);

  // The split is still there for the screen that knows what it means.
  eq("the split survives in the game's own view", engine.publicView(state).scores, { 0: 3, 1: 0 });
  eq("with the pair's total alongside it", engine.publicView(state).together, 3);
}

{
  // The scores are shown separately, which How Well does not do. That is only
  // fair because both people guess in every single round — asserted, because it
  // is the premise the presentation rests on.
  let state = engine.createInitialState(setup(53, { rounds: 5 }));

  for (let round = 0; round < 5; round += 1) {
    const before = engine.publicView(state).submittedSeats;
    eq(`round ${round + 1} starts with nobody in`, before, []);

    state = playRound(state, { a: 1, b: 2, aHits: round % 2 === 0, bHits: true });
    eq(`round ${round + 1} needs both of them`, engine.publicView(state).submittedSeats, [0, 1]);

    if (round < 4) state = apply(state, 1, { type: "next" }).state;
  }

  eq("both guessed every round", engine.publicView(state).scores, { 0: 3, 1: 5 });
  eq("and the pair's total is the sum of the two", engine.publicView(state).together, 8);
  eq("out of two predictions per round", engine.publicView(state).played, 10);
}

{
  // The denominator the ending divides by counts what was judged, not what was
  // scheduled — so a couple who were interrupted are not shown a bad fraction.
  let state = engine.createInitialState(setup(54, { rounds: 4 }));
  state = playRound(state, { a: 0, b: 1, aHits: true, bHits: true });
  state = apply(state, 0, { type: "next" }).state;

  // Round two: nobody answers, the clock closes it.
  state = apply(state, 0, { type: "reveal" }, PAIR, state.deadline + 60_000).state;

  eq("two judged, not four", engine.publicView(state).played, 2);
  eq("and the pair kept both points", engine.publicView(state).together, 2);
}

/* ==========================================================================
 * 9 · The copy
 * ========================================================================== */

section("The copy");

{
  eq("nothing played says so", describeTogether(0, 0).title, "Nothing to report");
  truthy("a perfect run is called out", describeTogether(16, 16).title.length > 0);
  truthy("and a terrible one", describeTogether(0, 16).title.length > 0);

  const bands = [0, 2, 5, 9, 12, 16].map((s) => describeTogether(s, 16));
  eq("every band has a title", bands.filter((b) => !b.title.trim()).length, 0);
  eq("and a line under it", bands.filter((b) => !b.line.trim()).length, 0);
  truthy("and they are not all the same", new Set(bands.map((b) => b.title)).size >= 4);

  /*
   * The brief for the couple games was explicit: playful, not a measurement. A
   * number in a large typeface is exactly the sort of thing people quote at each
   * other later, so the copy is checked for anything that would invite belief.
   */
  const clinical = /compatib|psycholog|percentile|diagnos|healthy|unhealthy|concern|index|rating/i;
  const copy = [
    ...bands.flatMap((b) => [b.title, b.line]),
    ...GUESS_MY_ANSWER_CATEGORIES.flatMap((c) => [c.name, c.blurb]),
  ];
  eq(
    "no clinical language anywhere in the copy",
    copy.filter((t) => clinical.test(t)),
    [],
  );
}

/* ==========================================================================
 * 10 · Config, before it reaches the database
 * ========================================================================== */

section("Config whitelisting");

{
  eq("a game with no options takes none", parseGameConfig("draw-guess", { rounds: 4 }), {});
  eq("nor does an unknown game", parseGameConfig("not-a-game", { anything: true }), {});

  eq(
    "the category choice survives",
    parseGameConfig("guess-my-answer", { categories: ["petty"] }),
    {
      categories: ["petty"],
    },
  );
  eq(
    "so does a round count",
    parseGameConfig("guess-my-answer", { rounds: 6, categories: ["wild"] }),
    { categories: ["wild"], rounds: 6 },
  );

  eq(
    "an unknown key is dropped",
    parseGameConfig("guess-my-answer", { categories: ["past"], admin: true, state: { x: 1 } }),
    { categories: ["past"] },
  );
  eq(
    "an unknown category takes the whole object with it",
    parseGameConfig("guess-my-answer", { categories: ["mine"] }),
    {},
  );
  eq("an absurd round count too", parseGameConfig("guess-my-answer", { rounds: 5000 }), {});
  eq("and a non-object", parseGameConfig("guess-my-answer", "petty"), {});
  eq("undefined is an empty config", parseGameConfig("guess-my-answer", undefined), {});
  eq("as is nothing at all", parseGameConfig("guess-my-answer", {}), {});

  falsy(
    "an absent option is absent, not present-and-undefined",
    "rounds" in parseGameConfig("guess-my-answer", { categories: ["petty"] }),
  );

  // Whatever comes out has to survive a trip through jsonb unchanged.
  const config = parseGameConfig("guess-my-answer", { categories: ["tender", "past"], rounds: 4 });
  eq("and it round-trips as JSON", JSON.parse(JSON.stringify(config)), config);
}

/* ==========================================================================
 * 11 · The database
 * ========================================================================== */

section("The database");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");

await asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
  ada < rafa ? ada : rafa,
  ada < rafa ? rafa : ada,
]);

const { rows: proposed } = await asUser(db, ada, "select public.propose_couple($1) as id", [rafa]);
const couple = proposed[0].id;
await asUser(db, rafa, "select public.respond_to_couple($1, true)", [couple]);

{
  const { rows } = await asUser(
    db,
    ada,
    "select * from public.list_games() where key = 'guess-my-answer'",
  );
  eq("the game is on the shelf", rows.length, 1);
  eq("enabled", rows[0].enabled, true);
  eq("for couples", rows[0].audience, "couple");
  eq("exactly two players", [rows[0].min_players, rows[0].max_players], [2, 2]);
  eq("and everybody moves at once", rows[0].pace, "realtime");

  const { rows: enabled } = await asUser(
    db,
    ada,
    "select key from public.list_games() where enabled",
  );
  eq(
    "every enabled game still has an engine",
    enabled.map((g) => g.key).sort(),
    [...registeredKeys()].sort(),
  );

  const { rows: couples } = await asUser(
    db,
    ada,
    "select key from public.list_games() where enabled and audience = 'couple' order by key",
  );
  truthy(
    "and it is one of the games a couple is offered",
    couples.some((g) => g.key === "guess-my-answer"),
  );
  truthy("alongside the other one", couples.length >= 2);
}

let session;
{
  await denied(
    "somebody outside the couple cannot open one",
    asUser(db, nour, "select public.create_couple_game($1, 'guess-my-answer')", [couple]),
  );

  // The signature grew a config parameter in migration 0023. Every existing
  // caller passed two arguments, and they must keep working.
  const { rows: plain } = await asUser(
    db,
    ada,
    "select public.create_couple_game($1, 'guess-my-answer') as id",
    [couple],
  );
  truthy("a partner can open one without settings", Boolean(plain[0].id));

  const { rows: config } = await asService(
    db,
    "select config from public.game_sessions where id = $1",
    [plain[0].id],
  );
  eq("and the config defaults to empty", config[0].config, {});

  /*
   * Cleared out of the way with the service role rather than by leaving.
   *
   * A partner leaving a two-person lobby does not close it — the other one is
   * promoted to host and the session stays open — so `create_couple_game` would
   * quite correctly hand the next call this same session back, and the rest of
   * this file would be testing the wrong one. Which is worth knowing, and is
   * asserted properly further down.
   */
  await asService(
    db,
    "update public.game_sessions set status = 'abandoned', ended_at = now() where id = $1",
    [plain[0].id],
  );
}

{
  const chosen = JSON.stringify({ categories: ["petty", "wild"] });

  const { rows } = await asUser(
    db,
    rafa,
    "select public.create_couple_game($1, 'guess-my-answer', $2::jsonb) as id",
    [couple, chosen],
  );
  session = rows[0].id;
  truthy("a partner can open one with a category choice", Boolean(session));

  const { rows: stored } = await asService(
    db,
    "select config, couple_id, conversation_id, status, host_id from public.game_sessions where id = $1",
    [session],
  );
  eq("the choice is stored", stored[0].config, { categories: ["petty", "wild"] });
  eq("scoped to the couple", stored[0].couple_id, couple);
  eq("and not to a conversation", stored[0].conversation_id, null);
  eq("starting in a lobby", stored[0].status, "lobby");
  eq("hosted by whoever opened it", stored[0].host_id, rafa);

  const { rows: seats } = await asService(
    db,
    "select user_id, seat from public.game_players where session_id = $1 order by seat",
    [session],
  );
  eq("both partners are seated immediately", seats.length, 2);
  eq("and nobody else", seats.map((s) => s.user_id).sort(), [ada, rafa].sort());

  // A second call joins the open one rather than starting a rival session — and
  // a different config in that call must not quietly reconfigure the game the
  // other partner is already looking at.
  const { rows: again } = await asUser(
    db,
    ada,
    "select public.create_couple_game($1, 'guess-my-answer', $2::jsonb) as id",
    [couple, JSON.stringify({ categories: ["tender"] })],
  );
  eq("opening it twice returns the same session", again[0].id, session);

  const { rows: unchanged } = await asService(
    db,
    "select config from public.game_sessions where id = $1",
    [session],
  );
  eq("with the settings it was opened with", unchanged[0].config, {
    categories: ["petty", "wild"],
  });
}

{
  /*
   * The size cap.
   *
   * Postgres cannot know what a config means, so the one thing it can usefully
   * refuse is a big one — and it has to, because this object is stored and then
   * sent to both players on every single state change. A megabyte in here is a
   * cheap way to make every round slow for somebody else.
   */
  const huge = JSON.stringify({ categories: ["petty"], junk: "x".repeat(4000) });

  await denied(
    "a config over the cap is refused",
    asUser(db, ada, "select public.create_couple_game($1, 'guess-my-answer', $2::jsonb)", [
      couple,
      huge,
    ]),
  );

  try {
    await asUser(db, ada, "select public.create_couple_game($1, 'guess-my-answer', $2::jsonb)", [
      couple,
      huge,
    ]);
    bad("and says why", "expected config_too_large");
  } catch (error) {
    truthy("and says why", error.message.includes("config_too_large"), error.message);
  }
}

{
  // The couple scope, again, because this session was opened a new way.
  await denied(
    "an outsider cannot see the session",
    asUser(db, nour, "select * from public.get_game_session($1)", [session]),
  );
  await denied("nor join it", asUser(db, nour, "select public.join_game_session($1)", [session]));

  const { rows } = await asUser(db, ada, "select * from public.get_game_session($1)", [session]);
  eq("but a partner can", rows.length, 1);
  eq("with the couple scope on it", rows[0].couple_id, couple);
  eq("and the config, which is not secret", rows[0].config, { categories: ["petty", "wild"] });
  eq("and still no state on this path", "state" in rows[0], false);
}

{
  await asUser(db, ada, "select public.set_game_ready($1, true)", [session]);
  await asUser(db, rafa, "select public.set_game_ready($1, true)", [session]);

  const { rows: ready } = await asUser(db, rafa, "select public.can_start_game($1) as yes", [
    session,
  ]);
  eq("both ready and the host can start", ready[0].yes, true);

  const players = [
    { seat: 0, userId: rafa, displayName: "rafa" },
    { seat: 1, userId: ada, displayName: "ada" },
  ];

  const { rows: seedRow } = await asService(
    db,
    "select seed, config from public.game_sessions where id = $1",
    [session],
  );

  // Built exactly the way the runtime builds it, from the stored config.
  const initial = engine.createInitialState({
    players,
    seed: Number(BigInt(seedRow[0].seed) % 100000n),
    config: seedRow[0].config,
    now: Date.now(),
  });

  eq(
    "the stored choice reaches the engine",
    [...new Set(initial.rounds.map((r) => r.question.category))].sort(),
    ["petty", "wild"],
  );

  await asService(db, "select public.start_game_session($1, $2, $3::jsonb, null::smallint)", [
    session,
    rafa,
    JSON.stringify(initial),
  ]);

  const { rows: active } = await asService(
    db,
    "select status, turn_seat from public.game_sessions where id = $1",
    [session],
  );
  eq("the game starts", active[0].status, "active");
  eq("with nobody holding the turn", active[0].turn_seat, null);

  await denied(
    "and the state is still not fetchable by a player",
    asUser(db, ada, "select state from public.game_sessions where id = $1", [session]),
  );

  await denied(
    "an outsider cannot move in it",
    asService(
      db,
      "select public.commit_game_move($1, $2, 1, '{}'::jsonb, '{}'::jsonb, null::smallint)",
      [session, nour],
    ),
  );
}

{
  /*
   * The move log.
   *
   * In this game a move payload IS the secret — `{own, predict}` is precisely
   * what the other one is trying to work out. Migration 0019 revoked the payload
   * column after Who Knows Me Better exposed the same hole, and this is the game
   * where it would matter most, so it is asserted again rather than assumed.
   */
  const payload = JSON.stringify({ type: "submit", own: 2, predict: 3 });

  await asService(
    db,
    `insert into public.game_moves (session_id, seq, player_id, payload)
     values ($1, 1, $2, $3::jsonb)`,
    [session, rafa, payload],
  );

  await denied(
    "a player cannot read the move payloads",
    asUser(db, ada, "select payload from public.game_moves where session_id = $1", [session]),
  );
  await denied(
    "not even their own",
    asUser(db, rafa, "select payload from public.game_moves where session_id = $1", [session]),
  );

  const { rows } = await asUser(
    db,
    ada,
    "select seq, player_id from public.game_moves where session_id = $1",
    [session],
  );
  eq("but the fact that a move happened is visible", rows.length, 1);
  eq("and who made it", rows[0].player_id, rafa);
}

{
  const { rows } = await asUser(db, ada, "select * from public.list_couple_games($1)", [couple]);
  truthy("the couple can see what they have played", rows.length >= 1);
  eq("with the live one first", rows[0].status, "active");
  eq("and it is this game", rows[0].game_key, "guess-my-answer");

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
