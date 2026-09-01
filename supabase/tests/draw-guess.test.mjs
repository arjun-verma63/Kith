/**
 * Draw & Guess.
 *
 * Two things worth serious testing, and they are different in kind.
 *
 * THE SECRET. Same as the other two games: a word the guessers must not see, and
 * a correct guess that must not be echoed to the people still guessing. Checked
 * from inside the engine and from every path a browser has to the database.
 *
 * THE WIRE. This is new. A hand moving across a canvas makes dozens of points a
 * second and none of them go through the move pipeline — they are broadcast and
 * forgotten. That only works if the protocol actually reduces what is sent, and
 * "actually" is a number, so it is measured here rather than asserted by comment:
 * a realistic stroke, counted.
 *
 *     npm run draw:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

// The registry is the authority on what is playable; the catalogue must agree.
const { registeredKeys } = await import("../../src/features/games/engine/index.ts");
const ENGINE_KEYS = registeredKeys();

const {
  drawGuess: engine,
  WORDS,
  normalise,
  editDistance,
  maskWord,
} = await import("../../src/features/games/engine/games/draw-guess.ts");
const canvas = await import("../../src/features/games/canvas.ts");

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

console.log("KITH — Draw & Guess\n");

/* ========================================================================== */

const FOUR = [
  { seat: 0, userId: "u0", displayName: "Ada" },
  { seat: 1, userId: "u1", displayName: "Rafa" },
  { seat: 2, userId: "u2", displayName: "Wren" },
  { seat: 3, userId: "u3", displayName: "Nour" },
];

const NOW = 1_800_000_000_000;

const setup = (players = FOUR, seed = 808, config = {}) => ({ players, seed, config, now: NOW });
const context = (seat, players = FOUR, now = NOW) => ({
  seat,
  players,
  seed: 808,
  config: {},
  now,
});

function apply(state, seat, move, players = FOUR, now = NOW) {
  const result = engine.reduce(state, move, context(seat, players, now));
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result;
}

/* ==========================================================================
 * 1 · The wire protocol
 *
 * The requirement was to not send unnecessary data. That is measurable.
 * ========================================================================== */

section("Canvas protocol");

{
  eq("screen pixels map onto the shared grid", canvas.toGrid(0, 400), 0);
  eq("the far edge maps to the last cell", canvas.toGrid(400, 400), canvas.GRID - 1);
  eq("the middle maps to the middle", canvas.toGrid(200, 400), 512);
  eq("a drag off the left is clamped", canvas.toGrid(-50, 400), 0);
  eq("and off the right", canvas.toGrid(900, 400), canvas.GRID - 1);
  eq("a zero-width canvas does not divide by zero", canvas.toGrid(10, 0), 0);

  // The whole point of a normalised grid: two different screens agree.
  const onPhone = canvas.toGrid(180, 360);
  const onLaptop = canvas.toGrid(500, 1000);
  eq("the same relative position is the same grid point on any screen", onPhone, onLaptop);
  eq("and scales back to each", Math.round(canvas.fromGrid(onLaptop, 1000)), 500);
}

{
  // A slow, deliberate line — the case where a naive implementation drowns.
  const buffer = new canvas.StrokeBuffer();
  buffer.begin(100, 100, { colour: "#000", width: 8 });

  let offered = 1;
  let kept = 1;
  for (let i = 1; i <= 200; i += 1) {
    offered += 1;
    // One grid unit per event: far below the threshold, exactly what a slow hand
    // produces.
    if (buffer.extend(100 + i, 100)) kept += 1;
  }

  truthy("a slow hand offers a lot of points", offered === 201);
  truthy(
    "and most of them are dropped as too close to matter",
    kept < offered / 4,
    `kept ${kept} of ${offered}`,
  );
  truthy("but the line is still described", kept > 5, `kept ${kept}`);
}

{
  const buffer = new canvas.StrokeBuffer();
  eq("nothing to flush before a stroke starts", buffer.flush(), null);
  eq("and extending does nothing", buffer.extend(5, 5), false);

  buffer.begin(0, 0, { colour: "#e8503a", width: 22 });
  eq("the first point of a stroke is always kept", buffer.isDrawing, true);

  buffer.extend(200, 0);
  buffer.extend(400, 0);

  const first = buffer.flush();
  truthy("a flush produces a chunk", first !== null);
  eq("carrying the style", [first.colour, first.width], ["#e8503a", 22]);
  eq("as a flat number array, not objects", first.points, [0, 0, 200, 0, 400, 0]);
  eq("numbered so chunks can be ordered", first.seq, 1);

  buffer.extend(600, 0);
  const second = buffer.flush();
  eq("the next chunk repeats the last point", second.points.slice(0, 2), [400, 0]);
  eq("so the line joins instead of breaking at every flush", second.points, [400, 0, 600, 0]);
  eq("and belongs to the same stroke", second.id, first.id);

  const last = buffer.end();
  eq("ending marks the stroke finished", last.end, true);
  eq("and the buffer is closed", buffer.isDrawing, false);

  buffer.begin(10, 10, { colour: "#000", width: 4 });
  const nextStroke = buffer.flush();
  truthy("a new stroke gets a new id", nextStroke.id !== first.id);
}

{
  // Nothing is sent while the hand is still.
  const buffer = new canvas.StrokeBuffer();
  buffer.begin(50, 50, { colour: "#000", width: 8 });
  buffer.flush();

  for (let i = 0; i < 50; i += 1) buffer.extend(50, 50);
  eq("a stationary hand sends nothing at all", buffer.flush(), null);
}

{
  /*
   * The tail of a stroke.
   *
   * A hand lifted between flushes leaves points that have never been sent. If
   * `end` closes the buffer before flushing them, every stroke arrives at the
   * far end slightly short — the drawer sees a complete line and nobody else
   * does, and nothing reports a problem.
   */
  const buffer = new canvas.StrokeBuffer();
  buffer.begin(0, 0, { colour: "#000", width: 8 });
  buffer.flush();

  buffer.extend(300, 300);
  buffer.extend(600, 600);

  const final = buffer.end();
  truthy("lifting the pen sends what has not been sent yet", final !== null);
  eq("including the last point drawn", final.points.slice(-2), [600, 600]);
  eq("marked as the end of the stroke", final.end, true);

  eq("and ending twice sends nothing more", buffer.end(), null);
}

{
  // Reassembly, including the awkward cases the network provides for free.
  const assembler = new canvas.StrokeAssembler();
  truthy("a fresh canvas is empty", assembler.isEmpty);

  assembler.apply({ id: 1, seq: 1, colour: "#000", width: 8, points: [0, 0, 10, 10] });
  assembler.apply({ id: 1, seq: 2, colour: "#000", width: 8, points: [10, 10, 20, 20] });

  eq("chunks join into one stroke", assembler.snapshot().length, 1);
  eq("without repeating the shared point", assembler.snapshot()[0].points, [0, 0, 10, 10, 20, 20]);

  // A resend would otherwise double a segment, which on a thick brush shows.
  assembler.apply({ id: 1, seq: 2, colour: "#000", width: 8, points: [10, 10, 20, 20] });
  eq("a duplicate chunk is ignored", assembler.snapshot()[0].points, [0, 0, 10, 10, 20, 20]);

  assembler.apply({ id: 2, seq: 1, colour: "#f00", width: 4, points: [5, 5, 6, 6] });
  eq("a second stroke is separate", assembler.snapshot().length, 2);
  eq("with its own style", assembler.snapshot()[1].colour, "#f00");

  assembler.undo();
  eq("undo removes the most recent", assembler.snapshot().length, 1);
  eq("and the right one", assembler.snapshot()[0].id, 1);

  const saved = assembler.snapshot();
  assembler.clear();
  truthy("clear empties it", assembler.isEmpty);

  assembler.restore(saved);
  eq("and a snapshot restores it exactly", assembler.snapshot(), saved);

  // Restoring must replace rather than merge: a partial picture plus a full one
  // is a picture with everything drawn twice.
  assembler.restore(saved);
  eq("restoring twice does not double the picture", assembler.snapshot().length, saved.length);
}

{
  // The measurement that justifies the whole design.
  const buffer = new canvas.StrokeBuffer();
  const chunks = [];

  /*
   * A hand-drawn curve: 400 pointer events over four seconds, which is what a
   * pointer at 100Hz actually produces.
   *
   * The comparison is against what a NAIVE implementation would send — one
   * broadcast per pointer event, each carrying its own envelope and raw float
   * coordinates. That is the real alternative, so it is the honest baseline;
   * comparing against a bare coordinate pair with no message around it would be
   * flattering the result.
   */
  const EVENTS = 400;
  const FLUSH_EVERY = 6; // ~60ms at 100Hz, the cadence the component uses.

  buffer.begin(512, 100, { colour: "#1a1a1a", width: 10 });
  for (let i = 1; i <= EVENTS; i += 1) {
    const t = i / EVENTS;
    buffer.extend(Math.round(512 + Math.sin(t * Math.PI * 2) * 300), Math.round(400 + t * 400));

    if (i % FLUSH_EVERY === 0) {
      const chunk = buffer.flush();
      if (chunk) chunks.push(chunk);
    }
  }
  const tail = buffer.end();
  if (tail) chunks.push(tail);

  const bytes = chunks.reduce((total, chunk) => total + JSON.stringify(chunk).length, 0);
  const naive =
    EVENTS *
    JSON.stringify({
      id: 1,
      seq: 1,
      colour: "#1a1a1a",
      width: 10,
      points: [512.34567, 400.12345],
    }).length;

  truthy(
    "a four-second stroke is a few dozen messages, not four hundred",
    chunks.length <= EVENTS / FLUSH_EVERY + 2,
    `${chunks.length}`,
  );
  truthy(
    "and well under a third of the bytes a point-per-message would cost",
    bytes < naive / 3,
    `${bytes} vs ${naive}`,
  );
  truthy("with every chunk small enough to be one frame", bytes / chunks.length < 900);
}

/* ==========================================================================
 * 2 · Judging a guess
 * ========================================================================== */

section("Guess matching");

eq("case does not matter", normalise("Lighthouse"), normalise("lighthouse"));
eq("nor spaces", normalise("ice cream"), normalise("icecream"));
eq("nor hyphens", normalise("yo-yo"), normalise("yoyo"));
eq("nor punctuation", normalise("yo-yo!"), normalise("yoyo"));
eq("nor accents", normalise("café"), "cafe");
eq("and an empty guess reduces to nothing", normalise("!!!"), "");

eq("an exact match has no distance", editDistance("cactus", "cactus"), 0);
eq("one typo is distance one", editDistance("cactuss", "cactus"), 1);
eq("a missing letter too", editDistance("cactu", "cactus"), 1);
truthy("something unrelated is far away", editDistance("banana", "cactus") > 2);
truthy("and length alone can rule it out", editDistance("a", "lighthouse") > 2);

{
  eq("a hidden word is underscores", maskWord("cactus", 0), "_ _ _ _ _ _");
  eq(
    "spaces show through — the shape is a fair clue",
    maskWord("ice cream", 0),
    "_ _ _   _ _ _ _ _",
  );
  eq("hyphens too", maskWord("yo-yo", 0), "_ _ - _ _");
  truthy("letters appear as time runs out", maskWord("cactus", 1).includes("c"));
  truthy(
    "and more of them later",
    maskWord("cactus", 2).split("_").length < maskWord("cactus", 1).split("_").length,
  );
  eq(
    "the same word always reveals the same letters",
    maskWord("lighthouse", 2),
    maskWord("lighthouse", 2),
  );
}

/* ==========================================================================
 * 3 · Setting up
 * ========================================================================== */

section("Setup");

{
  const a = engine.createInitialState(setup(FOUR, 21));
  const b = engine.createInitialState(setup(FOUR, 21));
  const c = engine.createInitialState(setup(FOUR, 22));

  eq("the same seed builds the same game", a.rounds, b.rounds);
  truthy("a different seed does not", JSON.stringify(a.rounds) !== JSON.stringify(c.rounds));

  eq("four players draw once each", a.totalRounds, 4);
  eq(
    "and everybody draws the same number of times",
    new Set(a.rounds.map((r) => r.drawerSeat)).size,
    4,
  );

  const three = engine.createInitialState(setup(FOUR.slice(0, 3), 5));
  eq("three players get two laps", three.totalRounds, 6);
  eq("still evenly", three.totalRounds % 3, 0);

  eq("nobody holds the turn", engine.initialTurnSeat(a, setup()), null);
  truthy("there are words to draw", WORDS.length >= 40);
  eq("all distinct", new Set(WORDS).size, WORDS.length);
  eq(
    "and all drawable — no abstractions",
    WORDS.every((w) => w.length >= 4 && w.length <= 22),
    true,
  );
}

/* ==========================================================================
 * 4 · The secret
 * ========================================================================== */

section("Secrecy");

{
  const state = engine.createInitialState(setup());
  const drawer = state.drawerSeat;
  const guesser = FOUR.find((p) => p.seat !== drawer).seat;

  const view = engine.publicView(state);
  eq("the room does not get the word", view.word, null);
  eq("only a mask", view.hint.replace(/[ _]/g, ""), "");
  truthy("with its length, which is a fair clue", view.wordLength > 0);
  eq("and the raw state is nowhere in it", JSON.stringify(view).includes('"rounds"'), false);

  const drawerView = engine.viewFor(state, drawer);
  eq("the drawer gets the word", drawerView.secretWord, state.word);
  eq("and knows they are drawing", drawerView.amDrawer, true);

  const guesserView = engine.viewFor(state, guesser);
  eq("A GUESSER DOES NOT", guesserView.secretWord, null);
  eq("and knows they are not drawing", guesserView.amDrawer, false);
  eq(
    "the word appears nowhere in their view",
    JSON.stringify(guesserView).toLowerCase().includes(state.word.toLowerCase()),
    false,
  );
}

{
  // A correct guess must not be echoed — that would hand the word to everybody
  // still guessing.
  let state = engine.createInitialState(setup());
  const drawer = state.drawerSeat;
  const [first, second] = FOUR.filter((p) => p.seat !== drawer).map((p) => p.seat);

  state = apply(state, first, { type: "guess", text: state.word }).state;

  const view = engine.publicView(state);
  const correctLine = view.chat.find((line) => line.kind === "correct");

  truthy("a correct guess appears in the chat", correctLine !== undefined);
  eq("attributed to whoever got it", correctLine.seat, first);
  eq("WITH THE WORD REMOVED", correctLine.text, null);
  eq(
    "so the transcript never contains it",
    JSON.stringify(view.chat).toLowerCase().includes(state.word.toLowerCase()),
    false,
  );
  eq("but everybody knows somebody got it", view.solvedSeats, [first]);

  // A wrong guess is public, because that is what makes it a chat.
  state = apply(state, second, { type: "guess", text: "definitely not it" }).state;
  const after = engine.publicView(state);
  truthy(
    "a wrong guess is shown to everybody",
    after.chat.some((line) => line.text === "definitely not it"),
  );
}

/* ==========================================================================
 * 5 · Playing a round
 * ========================================================================== */

section("Rounds");

{
  const state = engine.createInitialState(setup());
  const drawer = state.drawerSeat;
  const guessers = FOUR.filter((p) => p.seat !== drawer).map((p) => p.seat);

  const cheat = engine.reduce(state, { type: "guess", text: state.word }, context(drawer));
  eq("the drawer cannot guess their own word", cheat.ok, false);

  // Quick guesses score more than slow ones. That is what stops everybody
  // sitting on the answer.
  const quick = apply(state, guessers[0], { type: "guess", text: state.word }, FOUR, NOW + 1000);
  const slow = apply(
    quick.state,
    guessers[1],
    { type: "guess", text: state.word },
    FOUR,
    NOW + 70_000,
  );

  truthy(
    "getting it quickly is worth more",
    slow.state.scores[guessers[0]] > slow.state.scores[guessers[1]],
    `${slow.state.scores[guessers[0]]} vs ${slow.state.scores[guessers[1]]}`,
  );
  truthy("but a late answer is still worth having", slow.state.scores[guessers[1]] >= 2);

  const twice = engine.reduce(
    slow.state,
    { type: "guess", text: slow.state.word },
    context(guessers[0]),
  );
  eq("nobody can score the same word twice", twice.ok, false);

  // The last guesser ends the round early.
  const done = apply(slow.state, guessers[2], { type: "guess", text: state.word });
  eq("everybody getting it ends the round", done.state.phase, "revealed");

  const view = engine.publicView(done.state);
  eq("and now the word is public", view.word, state.word);
  eq("the drawer scores two a head", view.drawerPoints, 6);
  eq("which is added to their total", done.state.scores[drawer], 6);
}

{
  // The clock.
  let state = engine.createInitialState(setup());
  const drawer = state.drawerSeat;
  const guessers = FOUR.filter((p) => p.seat !== drawer).map((p) => p.seat);

  state = apply(state, guessers[0], { type: "guess", text: state.word }).state;

  const early = engine.reduce(state, { type: "reveal" }, context(drawer));
  eq("a reveal while people are still guessing is refused", early.ok, false);

  const closed = apply(state, drawer, { type: "reveal" }, FOUR, state.deadline + 1);
  eq("once time is up anybody may close it", closed.state.phase, "revealed");
  eq("only the people who got it scored", closed.state.scores[guessers[1]], 0);
  eq("and the drawer scores for the one who did", closed.state.scores[drawer], 2);

  const late = engine.reduce(
    closed.state,
    { type: "guess", text: closed.state.word },
    context(guessers[1], FOUR, closed.state.deadline + 1),
  );
  eq("and no more guesses land", late.ok, false);
}

{
  // Nobody gets it. The drawer scores nothing, which is the incentive to draw
  // something recognisable rather than something clever.
  const state = engine.createInitialState(setup());
  const drawer = state.drawerSeat;

  const closed = apply(state, drawer, { type: "reveal" }, FOUR, state.deadline + 1);
  eq("a drawing nobody got scores the drawer nothing", closed.state.scores[drawer], 0);
  eq("and nobody else either", engine.publicView(closed.state).solvedSeats, []);
}

/* ==========================================================================
 * 6 · Rotation and leaving
 * ========================================================================== */

section("Rotation and leaving");

{
  let state = engine.createInitialState(setup());
  const first = state.drawerSeat;

  state = apply(state, first, { type: "reveal" }, FOUR, state.deadline + 1).state;
  state = apply(state, first, { type: "next" }).state;

  truthy("the pencil passes on", state.drawerSeat !== first);
  eq("a new word", state.word !== undefined, true);
  eq("a clean chat", state.chat, []);
  eq("and nobody has solved it", state.solved, {});
  truthy("with a fresh deadline", state.deadline > NOW);
}

{
  // The drawer walks out mid-round. Nobody else can draw the word.
  const state = engine.createInitialState(setup());
  const drawer = state.drawerSeat;
  const remaining = FOUR.filter((p) => p.seat !== drawer);

  const closed = engine.reduce(state, { type: "reveal" }, context(remaining[0].seat, remaining));
  truthy("the round can be closed without them", closed.ok);
  eq("and they score nothing for a drawing they abandoned", closed.state.scores[drawer], 0);

  const advanced = apply(closed.state, remaining[0].seat, { type: "next" }, remaining);
  truthy(
    "the rotation steps over somebody who has left",
    remaining.some((p) => p.seat === advanced.state.drawerSeat),
  );
}

{
  // A guesser leaves. The round can still end when the rest have it.
  let state = engine.createInitialState(setup());
  const drawer = state.drawerSeat;
  const guessers = FOUR.filter((p) => p.seat !== drawer).map((p) => p.seat);

  state = apply(state, guessers[0], { type: "guess", text: state.word }).state;
  const present = FOUR.filter((p) => p.seat !== guessers[2]);

  const done = apply(state, guessers[1], { type: "guess", text: state.word }, present);
  eq("the round ends when everybody still here has it", done.state.phase, "revealed");
  eq("and the drawer scores for those two only", done.state.scores[drawer], 4);
}

/* ==========================================================================
 * 7 · Finishing
 * ========================================================================== */

section("Finishing");

{
  let state = engine.createInitialState(setup(FOUR, 3));

  for (let round = 0; round < state.totalRounds; round += 1) {
    const drawer = state.drawerSeat;
    const guessers = FOUR.filter((p) => p.seat !== drawer).map((p) => p.seat);

    // One person always gets it.
    state = apply(state, guessers[0], { type: "guess", text: state.word }).state;
    state = apply(state, drawer, { type: "reveal" }, FOUR, state.deadline + 1).state;

    if (round < state.totalRounds - 1) {
      state = apply(state, drawer, { type: "next" }).state;
    } else {
      const done = engine.reduce(state, { type: "next" }, context(drawer));
      truthy("the last round ends the game", done.ok && done.outcome !== undefined);
      eq("every seat is placed", Object.keys(done.outcome.placements).length, 4);
      truthy("and somebody won", done.outcome.winnerSeats.length >= 1);
    }
  }
}

/* ==========================================================================
 * 8 · The database half
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
    "select * from public.list_games() where key = 'draw-guess'",
  );
  eq("the game is on the shelf", rows.length, 1);
  eq("and enabled", rows[0].enabled, true);
  // Two would be one person drawing for one person, which is a lesson, not a game.
  eq("three players minimum", rows[0].min_players, 3);
  eq("six maximum", rows[0].max_players, 6);
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
  const { rows: created } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'draw-guess') as id",
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

  const drawerSeat = initial.drawerSeat;
  const guesser = players.find((p) => p.seat !== drawerSeat);

  const { rows: rpc } = await asUser(
    db,
    guesser.userId,
    "select * from public.get_game_session($1)",
    [session],
  );
  eq("the session RPC carries no state", "state" in rpc[0], false);

  await denied(
    "a guesser cannot select the state column",
    asUser(db, guesser.userId, "select state from public.game_sessions where id = $1", [session]),
  );

  await denied(
    "nor read a move payload",
    asUser(db, guesser.userId, "select payload from public.game_moves where session_id = $1", [
      session,
    ]),
  );

  // The strokes are the point: none of them are here, because they never were.
  const { rows: moves } = await asService(
    db,
    "select count(*)::int as n from public.game_moves where session_id = $1",
    [session],
  );
  eq("a started game has no moves yet", moves[0].n, 0);

  const { rows: size } = await asService(
    db,
    "select length(state::text) as bytes from public.game_sessions where id = $1",
    [session],
  );
  truthy(
    "and the state stays small — no canvas data in it",
    size[0].bytes < 4000,
    `${size[0].bytes} bytes`,
  );
  eq(
    "with nothing that looks like a stroke",
    /"points"|"chunk"|"stroke"/.test(JSON.stringify(initial)),
    false,
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
