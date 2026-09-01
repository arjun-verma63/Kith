import { registerEngine } from "@/features/games/engine/registry";
import {
  DEADLINE_GRACE_MS,
  mulberry32,
  outcomeFrom,
  shuffled,
} from "@/features/games/engine/support";
import type {
  GameEngine,
  MoveContext,
  MoveResult,
  PlayerSeat,
  SetupContext,
} from "@/features/games/engine/types";

/**
 * Would You Rather.
 *
 * Everybody sees the same question, everybody answers at once, and nobody sees
 * anybody else's answer until the round closes. Then the split is revealed.
 *
 * ── What it is actually about ────────────────────────────────────────────────
 *
 * There is no right answer to "would you rather", so scoring cannot be about
 * being correct. It is about being IN STEP: you score when you land with the
 * majority. For a room of six close friends that is the real question the game
 * asks — do you know these people, and are you one of them — and a streak is
 * what it looks like when the answer is yes.
 *
 * A split vote scores everybody. There is no majority to be out of step with,
 * and punishing a genuinely divisive question would be punishing the question.
 *
 * ── Simultaneous, not turn-based ─────────────────────────────────────────────
 *
 * `turnSeat` is null throughout, so the database lets anybody move. That is
 * correct here and it moves the burden onto this file: a seat that has already
 * answered must be refused, or somebody could answer twice and skew the count.
 *
 * ── Hidden until it is not ───────────────────────────────────────────────────
 *
 * `publicView` shows WHO has answered and never WHAT, right up to the reveal.
 * `viewFor` adds only that player's own choice. If those two ever drift, the
 * game stops working — an answer visible early is the whole game spoiled — so
 * both are asserted directly in the test suite.
 */

/* ========================================================================== */

const ANSWER_SECONDS = 30;
const DEFAULT_ROUNDS = 7;
/** A streak this long starts paying extra. Long enough to feel earned. */
const STREAK_BONUS_AT = 3;

export type Choice = "a" | "b";

export interface Prompt {
  a: string;
  b: string;
}

interface State {
  /** The questions for this session, drawn from the seed. Fixed at the start. */
  prompts: Prompt[];
  round: number;
  totalRounds: number;
  phase: "answering" | "revealed";
  /** Absolute epoch ms, so a client that reconnects computes the right remainder. */
  deadline: number;
  /** SECRET while answering. Never leaves the server before the reveal. */
  answers: Record<number, Choice>;
  scores: Record<number, number>;
  streaks: Record<number, number>;
  /** What the last reveal produced, for the results panel. */
  lastResult: {
    tally: { a: number; b: number };
    majority: Choice | null;
    scored: number[];
  } | null;
}

export type Move =
  | { type: "answer"; choice: Choice }
  /** Closes a round early or on time. Anybody may ask; the engine decides. */
  | { type: "reveal" }
  | { type: "next" };

/* ========================================================================== */

function draw(seed: number, count: number): Prompt[] {
  return shuffled(PROMPTS, mulberry32(seed)).slice(0, Math.min(count, PROMPTS.length));
}

function zeroed(players: PlayerSeat[]): Record<number, number> {
  return Object.fromEntries(players.map((player) => [player.seat, 0]));
}

/** Counts the votes. Present players only — somebody who left is not a vote. */
function tallyOf(answers: Record<number, Choice>, players: PlayerSeat[]) {
  let a = 0;
  let b = 0;

  for (const player of players) {
    const choice = answers[player.seat];
    if (choice === "a") a += 1;
    if (choice === "b") b += 1;
  }

  return { a, b };
}

function reveal(state: State, players: PlayerSeat[]): State {
  const tally = tallyOf(state.answers, players);
  // A dead heat has no majority. Nobody is out of step with a room that is
  // genuinely split, so everybody who answered scores.
  const majority: Choice | null = tally.a === tally.b ? null : tally.a > tally.b ? "a" : "b";

  const scores = { ...state.scores };
  const streaks = { ...state.streaks };
  const scored: number[] = [];

  for (const player of players) {
    const choice = state.answers[player.seat];

    if (choice === undefined) {
      // Ran out of time. No points, and the streak goes with them.
      streaks[player.seat] = 0;
      continue;
    }

    const inStep = majority === null || choice === majority;

    if (!inStep) {
      streaks[player.seat] = 0;
      continue;
    }

    const streak = (streaks[player.seat] ?? 0) + 1;
    streaks[player.seat] = streak;
    scores[player.seat] = (scores[player.seat] ?? 0) + 1 + (streak >= STREAK_BONUS_AT ? 1 : 0);
    scored.push(player.seat);
  }

  return {
    ...state,
    phase: "revealed",
    scores,
    streaks,
    lastResult: { tally, majority, scored },
  };
}

/* ========================================================================== */

export const wouldYouRather: GameEngine<State, Move> = {
  key: "would-you-rather",

  createInitialState({ players, seed, config, now }: SetupContext): State {
    const requested = Number(config["rounds"]);
    const totalRounds =
      Number.isInteger(requested) && requested >= 1 && requested <= 20 ? requested : DEFAULT_ROUNDS;

    return {
      prompts: draw(seed, totalRounds),
      round: 0,
      totalRounds,
      phase: "answering",
      deadline: now + ANSWER_SECONDS * 1000,
      answers: {},
      scores: zeroed(players),
      streaks: zeroed(players),
      lastResult: null,
    };
  },

  // Everybody answers at once, so nobody holds the turn. The database allows any
  // seat to move; refusing a second answer is this engine's job.
  initialTurnSeat: () => null,

  validateMove(payload: unknown): Move | null {
    if (typeof payload !== "object" || payload === null) return null;
    const value = payload as Record<string, unknown>;

    switch (value["type"]) {
      case "answer":
        return value["choice"] === "a" || value["choice"] === "b"
          ? { type: "answer", choice: value["choice"] }
          : null;
      case "reveal":
        return { type: "reveal" };
      case "next":
        return { type: "next" };
      default:
        return null;
    }
  },

  reduce(state: State, move: Move, { seat, players, now }: MoveContext): MoveResult<State> {
    switch (move.type) {
      case "answer": {
        if (state.phase !== "answering") {
          return { ok: false, reason: "That round is over." };
        }

        // Locked in. Allowing a change would mean somebody could watch the
        // answered count fill up and switch at the last moment, which is a
        // different game and a worse one.
        if (state.answers[seat] !== undefined) {
          return { ok: false, reason: "You have already answered." };
        }

        if (now > state.deadline + DEADLINE_GRACE_MS) {
          return { ok: false, reason: "Time is up." };
        }

        const answers = { ...state.answers, [seat]: move.choice };
        const everybody = players.every((player) => answers[player.seat] !== undefined);

        // The last answer closes the round immediately — waiting out a timer
        // nobody is waiting for is just dead air.
        const next = everybody ? reveal({ ...state, answers }, players) : { ...state, answers };

        return { ok: true, state: next, turnSeat: null };
      }

      case "reveal": {
        if (state.phase !== "answering") {
          return { ok: false, reason: "Already revealed." };
        }

        const everybody = players.every((player) => state.answers[player.seat] !== undefined);

        // Two ways a round may close: everybody answered, or the clock ran out.
        // Any client may ask — several will, at once — and `state_version` makes
        // sure exactly one request lands.
        if (!everybody && now < state.deadline) {
          return { ok: false, reason: "Still waiting for answers." };
        }

        return { ok: true, state: reveal(state, players), turnSeat: null };
      }

      case "next": {
        if (state.phase !== "revealed") {
          return { ok: false, reason: "The round is not finished." };
        }

        const round = state.round + 1;

        if (round >= state.totalRounds) {
          return {
            ok: true,
            state: { ...state, round },
            turnSeat: null,
            outcome: outcomeFrom(state.scores, players),
          };
        }

        return {
          ok: true,
          state: {
            ...state,
            round,
            phase: "answering",
            deadline: now + ANSWER_SECONDS * 1000,
            answers: {},
            lastResult: null,
          },
          turnSeat: null,
        };
      }

      default: {
        const exhaustive: never = move;
        return { ok: false, reason: String(exhaustive) };
      }
    }
  },

  /**
   * What the room sees.
   *
   * During answering this carries WHO has answered and never WHAT. That single
   * distinction is the game; everything else is presentation.
   */
  publicView(state: State) {
    const revealed = state.phase === "revealed";

    return {
      round: state.round,
      totalRounds: state.totalRounds,
      phase: state.phase,
      deadline: state.deadline,
      prompt: state.prompts[state.round] ?? null,
      // Seats, not choices. Enough to draw "four of six are in".
      answeredSeats: Object.keys(state.answers).map(Number).sort(),
      // Only ever populated after the reveal.
      answers: revealed ? state.answers : {},
      tally: revealed ? (state.lastResult?.tally ?? null) : null,
      majority: revealed ? (state.lastResult?.majority ?? null) : null,
      scored: revealed ? (state.lastResult?.scored ?? []) : [],
      scores: state.scores,
      streaks: state.streaks,
    };
  },

  /** The room's view, plus this player's own answer and nobody else's. */
  viewFor(state: State, seat: number) {
    return {
      ...(this.publicView(state) as Record<string, unknown>),
      mySeat: seat,
      myAnswer: state.answers[seat] ?? null,
    };
  },

  scores: (state: State) => state.scores,

  describe(state: State) {
    return state.phase === "answering"
      ? `Round ${state.round + 1} of ${state.totalRounds}`
      : `Round ${state.round + 1} revealed`;
  },
};

registerEngine(wouldYouRather);

/* ========================================================================== */

/**
 * The deck.
 *
 * Written for a room of people who already know each other — the good ones are
 * the ones that start an argument, not the ones with an obvious answer. A prompt
 * where everybody picks the same thing is a wasted round.
 *
 * In the engine rather than a table on purpose: prompts are content, not data.
 * Nothing reads or writes them at runtime, they are the same for everybody, and
 * a table would mean an admin surface for something that changes when the code
 * changes anyway.
 */
export const PROMPTS: Prompt[] = [
  { a: "Never be able to text again", b: "Never be able to call again" },
  { a: "Always be 20 minutes early", b: "Always be 10 minutes late" },
  { a: "Have every song you hear be your favourite", b: "Never hear the same song twice" },
  { a: "Know when you'll die", b: "Know how you'll die" },
  { a: "Read everyone's thoughts", b: "Have everyone read yours" },
  { a: "Live without music", b: "Live without films" },
  { a: "Be famous for something embarrassing", b: "Never be known for anything" },
  { a: "Only whisper", b: "Only shout" },
  { a: "Lose all your photos", b: "Lose all your messages" },
  { a: "Have unlimited money but no friends", b: "Have great friends and just enough" },
  { a: "Always tell the truth", b: "Always have to lie" },
  { a: "Be able to fly, badly", b: "Be invisible, unreliably" },
  { a: "Have a rewind button", b: "Have a pause button" },
  { a: "Never eat your favourite food again", b: "Only eat your favourite food" },
  { a: "Work with your best friend", b: "Live with your best friend" },
  { a: "Be slightly wrong about everything", b: "Be completely wrong about one big thing" },
  { a: "Have no sense of smell", b: "Have no sense of direction" },
  { a: "Be the funniest person in the room", b: "Be the kindest person in the room" },
  { a: "Fight one horse-sized duck", b: "Fight a hundred duck-sized horses" },
  { a: "Give up coffee", b: "Give up your phone at weekends" },
  { a: "Be stuck in a lift with your boss", b: "Be stuck in a lift with your ex" },
  { a: "Have your search history read out", b: "Have your camera roll shown" },
  { a: "Never leave your country again", b: "Never return home again" },
  { a: "Be forgotten entirely", b: "Be remembered badly" },
  { a: "Always have a song stuck in your head", b: "Always have an itch you cannot reach" },
  { a: "Live in a city forever", b: "Live somewhere remote forever" },
  { a: "Know every language", b: "Play every instrument" },
  { a: "Have one perfect day on repeat", b: "Have every day be different and fine" },
  { a: "Be able to talk to animals", b: "Be able to talk to babies" },
  { a: "Have to sing everything you say", b: "Have to say everything twice" },
  { a: "Never use the internet again", b: "Never leave the house again" },
  { a: "Win the lottery and tell nobody", b: "Not win and have everyone think you did" },
  { a: "Always be slightly too hot", b: "Always be slightly too cold" },
  { a: "Have a personal chef", b: "Have a personal driver" },
  { a: "Know what everyone thinks of you", b: "Never wonder again" },
  {
    a: "Be the best at something nobody cares about",
    b: "Be mediocre at something everybody does",
  },
  { a: "Lose the ability to lie", b: "Lose the ability to keep a secret" },
  { a: "Have unlimited free flights", b: "Have unlimited free food" },
  { a: "Restart your career", b: "Restart your twenties" },
  { a: "Only wear one outfit forever", b: "Never wear the same thing twice" },
  { a: "Be trapped in a book", b: "Be trapped in a video game" },
  { a: "Always know the time exactly", b: "Always know where north is" },
  { a: "Have everything you own be beige", b: "Have everything you own be neon" },
  { a: "Live your life backwards", b: "Live one week at a time in random order" },
];
