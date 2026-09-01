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
 * Who Knows Me Better?
 *
 * One person is the subject. A question is asked about them, they quietly pick
 * the true answer, and everybody else picks the answer they think is true. The
 * lot is revealed together, the people who got it right score, and the subject
 * finds out who actually knows them.
 *
 * ── Two kinds of secret, not one ─────────────────────────────────────────────
 *
 * Would You Rather hides one thing: each person's own answer. This hides two,
 * and they have different audiences:
 *
 *   The subject's answer must be hidden from the guessers, or there is nothing
 *   to guess.
 *
 *   Each guess must be hidden from everybody INCLUDING THE SUBJECT, or the
 *   subject could pick whichever answer the room had already committed to and
 *   the round would become a formality.
 *
 * Both are enforced the same way — `publicView` never carries either until the
 * reveal — but the second is the one that is easy to get wrong, because it feels
 * harmless to let the subject see how the room is leaning.
 *
 * ── Everybody moves at once ──────────────────────────────────────────────────
 *
 * The subject answers while the others guess. There is no advantage in it: with
 * everything hidden, seeing that four people have locked in tells you nothing
 * about what they locked in. And a phase where four people watch one person
 * think is dead air.
 *
 * ── The subject does not score ───────────────────────────────────────────────
 *
 * They are the question, not a player of it. Which is only fair if everybody is
 * the subject the same number of times, so the round count is always a whole
 * number of laps.
 */

/* ========================================================================== */

const ANSWER_SECONDS = 35;
/** A round count below this is over before it starts. */
const MINIMUM_ROUNDS = 4;
const STREAK_BONUS_AT = 3;

export interface Question {
  /** Reads with "they" — the subject's name is substituted by the UI. */
  prompt: string;
  options: string[];
}

interface Round {
  question: Question;
  /** Option order is shuffled per round, so position carries no information. */
  order: number[];
}

interface State {
  rounds: Round[];
  round: number;
  totalRounds: number;
  /** Seat order for the subject rotation. Fixed at the start. */
  rotation: number[];
  subjectSeat: number;
  phase: "answering" | "revealed";
  deadline: number;

  /** SECRET until the reveal. The truth. */
  answer: number | null;
  /** SECRET until the reveal, from the subject too. */
  guesses: Record<number, number>;

  scores: Record<number, number>;
  streaks: Record<number, number>;

  lastResult: {
    answer: number | null;
    correctSeats: number[];
    /** Null when the subject never answered — the round is void, not lost. */
    voided: boolean;
  } | null;
}

export type Move =
  | { type: "answer"; option: number }
  | { type: "guess"; option: number }
  | { type: "reveal" }
  | { type: "next" };

/* ========================================================================== */

function zeroed(players: PlayerSeat[]): Record<number, number> {
  return Object.fromEntries(players.map((player) => [player.seat, 0]));
}

/**
 * How many rounds.
 *
 * Always a whole number of laps, because the subject cannot score and it would
 * be plainly unfair for one person to sit out more rounds than another. Small
 * groups get more laps so the game is not over in ninety seconds.
 */
function roundsFor(playerCount: number, requestedLaps: unknown): number {
  const laps = Number(requestedLaps);
  const chosen =
    Number.isInteger(laps) && laps >= 1 && laps <= 4
      ? laps
      : Math.max(1, Math.ceil(MINIMUM_ROUNDS / Math.max(playerCount, 1)));

  return playerCount * chosen;
}

/** Everyone still here, other than the subject. The people doing the guessing. */
function guessersOf(players: PlayerSeat[], subjectSeat: number): PlayerSeat[] {
  return players.filter((player) => player.seat !== subjectSeat);
}

/**
 * The next person in the rotation who is still here.
 *
 * Somebody who left cannot be the subject — the round would be unanswerable —
 * so the rotation steps over them. It walks the whole ring, so it cannot loop
 * forever when almost everybody has gone.
 */
function nextSubject(state: State, players: PlayerSeat[]): number {
  const present = new Set(players.map((player) => player.seat));
  const at = state.rotation.indexOf(state.subjectSeat);

  for (let step = 1; step <= state.rotation.length; step += 1) {
    const seat = state.rotation[(at + step) % state.rotation.length];
    if (seat !== undefined && present.has(seat)) return seat;
  }

  return state.subjectSeat;
}

function reveal(state: State, players: PlayerSeat[]): State {
  const stillHere = players.some((player) => player.seat === state.subjectSeat);

  // No answer means nothing to be right about. The round is void: nobody scores
  // and — importantly — nobody's streak is broken by somebody else's timeout.
  if (state.answer === null || !stillHere) {
    return {
      ...state,
      phase: "revealed",
      lastResult: { answer: null, correctSeats: [], voided: true },
    };
  }

  const scores = { ...state.scores };
  const streaks = { ...state.streaks };
  const correctSeats: number[] = [];

  for (const guesser of guessersOf(players, state.subjectSeat)) {
    const guess = state.guesses[guesser.seat];

    if (guess === undefined || guess !== state.answer) {
      streaks[guesser.seat] = 0;
      continue;
    }

    const streak = (streaks[guesser.seat] ?? 0) + 1;
    streaks[guesser.seat] = streak;
    scores[guesser.seat] = (scores[guesser.seat] ?? 0) + 1 + (streak >= STREAK_BONUS_AT ? 1 : 0);
    correctSeats.push(guesser.seat);
  }

  return {
    ...state,
    phase: "revealed",
    scores,
    streaks,
    lastResult: { answer: state.answer, correctSeats, voided: false },
  };
}

/** Whether everybody who can act has acted. */
function everybodyIn(state: State, players: PlayerSeat[]): boolean {
  if (state.answer === null) return false;
  return guessersOf(players, state.subjectSeat).every(
    (guesser) => state.guesses[guesser.seat] !== undefined,
  );
}

/* ========================================================================== */

export const whoKnowsMe: GameEngine<State, Move> = {
  key: "who-knows-me",

  createInitialState({ players, seed, config, now }: SetupContext): State {
    const random = mulberry32(seed);
    const totalRounds = roundsFor(players.length, config["laps"]);

    const questions = shuffled(QUESTIONS, random).slice(0, Math.min(totalRounds, QUESTIONS.length));

    // Enough rounds for the deck is not guaranteed for a long game, so it wraps.
    const rounds: Round[] = Array.from({ length: totalRounds }, (_, index) => {
      const question = questions[index % questions.length] ?? QUESTIONS[0]!;
      return {
        question,
        // Shuffled per round: an answer that is always third is not a secret.
        order: shuffled(
          question.options.map((_, optionIndex) => optionIndex),
          random,
        ),
      };
    });

    const rotation = shuffled(
      players.map((player) => player.seat),
      random,
    );

    return {
      rounds,
      round: 0,
      totalRounds,
      rotation,
      subjectSeat: rotation[0] ?? players[0]?.seat ?? 0,
      phase: "answering",
      deadline: now + ANSWER_SECONDS * 1000,
      answer: null,
      guesses: {},
      scores: zeroed(players),
      streaks: zeroed(players),
      lastResult: null,
    };
  },

  // Everybody acts at once — the subject deciding while the rest guess — so no
  // seat holds the turn. Which means this file, not the database, is what stops
  // a guesser answering as if they were the subject.
  initialTurnSeat: () => null,

  validateMove(payload: unknown): Move | null {
    if (typeof payload !== "object" || payload === null) return null;
    const value = payload as Record<string, unknown>;

    const option = value["option"];
    const isOption = typeof option === "number" && Number.isInteger(option) && option >= 0;

    switch (value["type"]) {
      case "answer":
        return isOption ? { type: "answer", option } : null;
      case "guess":
        return isOption ? { type: "guess", option } : null;
      case "reveal":
        return { type: "reveal" };
      case "next":
        return { type: "next" };
      default:
        return null;
    }
  },

  reduce(state: State, move: Move, { seat, players, now }: MoveContext): MoveResult<State> {
    const current = state.rounds[state.round];
    if (!current) return { ok: false, reason: "That round does not exist." };

    switch (move.type) {
      case "answer": {
        if (seat !== state.subjectSeat) {
          return { ok: false, reason: "Only the subject answers this one." };
        }
        if (state.phase !== "answering") return { ok: false, reason: "That round is over." };
        if (state.answer !== null) return { ok: false, reason: "You have already answered." };
        if (move.option >= current.question.options.length) {
          return { ok: false, reason: "That is not one of the options." };
        }
        if (now > state.deadline + DEADLINE_GRACE_MS) {
          return { ok: false, reason: "Time is up." };
        }

        const next: State = { ...state, answer: move.option };
        return {
          ok: true,
          state: everybodyIn(next, players) ? reveal(next, players) : next,
          turnSeat: null,
        };
      }

      case "guess": {
        if (seat === state.subjectSeat) {
          return { ok: false, reason: "You are the subject — you already know." };
        }
        if (state.phase !== "answering") return { ok: false, reason: "That round is over." };
        if (state.guesses[seat] !== undefined) {
          return { ok: false, reason: "You have already guessed." };
        }
        if (move.option >= current.question.options.length) {
          return { ok: false, reason: "That is not one of the options." };
        }
        if (now > state.deadline + DEADLINE_GRACE_MS) {
          return { ok: false, reason: "Time is up." };
        }

        const next: State = { ...state, guesses: { ...state.guesses, [seat]: move.option } };
        return {
          ok: true,
          state: everybodyIn(next, players) ? reveal(next, players) : next,
          turnSeat: null,
        };
      }

      case "reveal": {
        if (state.phase !== "answering") return { ok: false, reason: "Already revealed." };

        const subjectGone = !players.some((player) => player.seat === state.subjectSeat);

        // Three ways a round closes: everybody acted, the clock ran out, or the
        // subject walked away and nobody can answer for them.
        if (!everybodyIn(state, players) && now < state.deadline && !subjectGone) {
          return { ok: false, reason: "Still waiting." };
        }

        return { ok: true, state: reveal(state, players), turnSeat: null };
      }

      case "next": {
        if (state.phase !== "revealed") return { ok: false, reason: "The round is not finished." };

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
            subjectSeat: nextSubject(state, players),
            phase: "answering",
            deadline: now + ANSWER_SECONDS * 1000,
            answer: null,
            guesses: {},
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
   * The question, the options in this round's order, who is the subject, and who
   * has locked something in. Never the answer and never a guess — not even to
   * the subject, who gets no more than anybody else until the reveal.
   */
  publicView(state: State) {
    const current = state.rounds[state.round];
    const revealed = state.phase === "revealed";

    return {
      round: state.round,
      totalRounds: state.totalRounds,
      phase: state.phase,
      deadline: state.deadline,
      subjectSeat: state.subjectSeat,
      prompt: current?.question.prompt ?? null,
      // Presented in this round's order; indices below refer to positions here.
      options: current ? current.order.map((i) => current.question.options[i] ?? "") : [],
      answered: state.answer !== null,
      guessedSeats: Object.keys(state.guesses).map(Number).sort(),
      // Everything past this line is empty until the round closes.
      answerIndex: revealed ? displayIndex(current, state.lastResult?.answer ?? null) : null,
      guesses: revealed ? displayGuesses(current, state.guesses) : {},
      correctSeats: revealed ? (state.lastResult?.correctSeats ?? []) : [],
      voided: revealed ? (state.lastResult?.voided ?? false) : false,
      scores: state.scores,
      streaks: state.streaks,
    };
  },

  /** The room's view, plus whatever this seat itself committed. */
  viewFor(state: State, seat: number) {
    const current = state.rounds[state.round];

    return {
      ...(this.publicView(state) as Record<string, unknown>),
      mySeat: seat,
      amSubject: seat === state.subjectSeat,
      // One or the other, never both — you are the subject or you are guessing.
      myAnswer: seat === state.subjectSeat ? displayIndex(current, state.answer) : null,
      myGuess:
        seat === state.subjectSeat ? null : displayIndex(current, state.guesses[seat] ?? null),
    };
  },

  scores: (state: State) => state.scores,

  describe(state: State, { players }) {
    const subject = players.find((player) => player.seat === state.subjectSeat);
    return subject
      ? `Round ${state.round + 1}: ${subject.displayName}`
      : `Round ${state.round + 1}`;
  },
};

/**
 * Translates a stored option index into its position in this round's shuffle.
 *
 * State stores the canonical index so a question's answer means the same thing
 * whatever order it was shown in; the UI works in displayed positions. Doing the
 * conversion in one place is what keeps the two from ever disagreeing.
 */
function displayIndex(round: Round | undefined, canonical: number | null): number | null {
  if (!round || canonical === null) return null;
  const position = round.order.indexOf(canonical);
  return position === -1 ? null : position;
}

function displayGuesses(
  round: Round | undefined,
  guesses: Record<number, number>,
): Record<number, number> {
  const shown: Record<number, number> = {};

  for (const [seat, canonical] of Object.entries(guesses)) {
    const position = displayIndex(round, canonical);
    if (position !== null) shown[Number(seat)] = position;
  }

  return shown;
}

registerEngine(whoKnowsMe);

/* ========================================================================== */

/**
 * The questions.
 *
 * Written to be answerable about anybody, and to have no obviously correct
 * option — a question where three of the four are absurd is a question everybody
 * gets right, which tells you nothing about who knows whom.
 *
 * They read in the third person because the UI puts the subject's name in front
 * of them: "Ada would rather…" and so on.
 */
export const QUESTIONS: Question[] = [
  {
    prompt: "dream travel destination",
    options: ["Japan", "Iceland", "A Greek island", "Somewhere with no signal"],
  },
  {
    prompt: "would spend an unexpected free day",
    options: ["Asleep", "With people", "On a project", "Out of the city"],
  },
  {
    prompt: "worst habit, honestly",
    options: ["Always late", "Never replies", "Interrupts", "Cannot let things go"],
  },
  {
    prompt: "comfort food at 1am",
    options: ["Toast", "Leftovers", "Cereal", "Whatever is nearest"],
  },
  {
    prompt: "would be first to do in a crisis",
    options: ["Make a plan", "Make a joke", "Go quiet", "Call somebody"],
  },
  {
    prompt: "guilty pleasure television",
    options: ["Reality shows", "Old sitcoms", "True crime", "Cooking competitions"],
  },
  {
    prompt: "would rather give up",
    options: ["Coffee", "Their phone at weekends", "Going out", "Sleeping in"],
  },
  {
    prompt: "most likely to be doing at 7am",
    options: ["Still asleep", "Already out", "Scrolling", "Making a proper breakfast"],
  },
  {
    prompt: "would spend an unexpected £1,000 on",
    options: ["A trip", "Something for the flat", "Straight into savings", "Everyone else"],
  },
  {
    prompt: "argues about most",
    options: ["Politics", "Films", "Where to eat", "Nothing, they avoid it"],
  },
  {
    prompt: "would be worst at",
    options: ["Keeping a secret", "Camping", "Small talk", "Being on time"],
  },
  {
    prompt: "hypes themselves up with",
    options: ["Loud music", "A long walk", "A list", "Sheer panic"],
  },
  {
    prompt: "would pick as a superpower",
    options: ["Teleporting", "Reading minds", "Never needing sleep", "Perfect memory"],
  },
  {
    prompt: "is secretly very good at",
    options: ["Cooking", "Remembering birthdays", "Winning arguments", "Finding things"],
  },
  {
    prompt: "most-used app after messaging",
    options: ["Maps", "Music", "Camera", "Notes"],
  },
  {
    prompt: "would rather host",
    options: [
      "A dinner for six",
      "A big party",
      "Nothing, they'd come to yours",
      "A quiet film night",
    ],
  },
  {
    prompt: "in a group photo is",
    options: ["At the front", "Half out of frame", "Taking it", "Complaining about it"],
  },
  {
    prompt: "would break first without",
    options: ["Their morning routine", "Their headphones", "Their people", "A plan"],
  },
  {
    prompt: "reaction to a surprise party",
    options: ["Delighted", "Visibly furious", "Cries", "Pretends they knew"],
  },
  {
    prompt: "would win against everyone at",
    options: ["Trivia", "Anything physical", "Staying calm", "Talking their way out"],
  },
  {
    prompt: "way of dealing with a bad day",
    options: ["A long shower", "Complaining loudly", "Going for a walk", "Pretending it's fine"],
  },
  {
    prompt: "would keep if they lost everything else",
    options: ["Photos", "One person's number", "Their notebook", "Their playlist"],
  },
  {
    prompt: "unexpected talent",
    options: ["An accent", "Throwing things accurately", "Sleeping anywhere", "Parallel parking"],
  },
  {
    prompt: "would most like to be told",
    options: ["That they were right", "That they helped", "That they're funny", "Nothing, please"],
  },
  {
    prompt: "orders at a new restaurant",
    options: [
      "The safest thing",
      "The strangest thing",
      "Whatever's recommended",
      "The same as you",
    ],
  },
  {
    prompt: "would be the last to leave",
    options: ["Always", "Never", "Only if there's food", "Depends who's there"],
  },
  {
    prompt: "sings badly to",
    options: ["Nineties pop", "Musicals", "Something embarrassing", "Nothing, they can sing"],
  },
  {
    prompt: "biggest irrational fear",
    options: ["Deep water", "Phone calls", "Being late", "Heights"],
  },
  {
    prompt: "would fix about themselves first",
    options: ["Sleep", "Saying yes too much", "Their temper", "Nothing at all"],
  },
  {
    prompt: "most likely to text at 3am",
    options: ["A meme", "Something profound", "Nothing, asleep", "A question about tomorrow"],
  },
  {
    prompt: "would rather be described as",
    options: ["Reliable", "Interesting", "Kind", "Funny"],
  },
  {
    prompt: "packs for a weekend",
    options: [
      "Far too much",
      "One bag, perfectly",
      "Nothing until the morning",
      "Somebody else does it",
    ],
  },
];
