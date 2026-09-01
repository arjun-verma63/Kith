import { registerEngine } from "@/features/games/engine/registry";
import { DEADLINE_GRACE_MS, mulberry32, shuffled } from "@/features/games/engine/support";
import type {
  GameEngine,
  MoveContext,
  MoveResult,
  PlayerSeat,
  SetupContext,
} from "@/features/games/engine/types";

/**
 * How Well Do You Know Me?
 *
 * Each round asks about one of you. That person answers honestly; the other
 * guesses what they said. Both submit at the same time, neither sees the other
 * until both are in, and then the two answers appear side by side. Next round it
 * is about the other one.
 *
 * ── There is no winner, and that is the design ───────────────────────────────
 *
 * Every other game in KITH ranks its players. This one must not. Two people who
 * are together, playing a game that ends by telling one of them they know the
 * other better than they are known, is a subtly hostile object — and the thing
 * they actually want to find out is a fact about the pair, not about either of
 * them.
 *
 * So THE SCORE IS SHARED. A matched round scores one point for the couple. Both
 * seats carry the same number all the way through, both are listed as winners,
 * and the result is a single figure with both their names on it.
 *
 * ── And it is not a measurement ──────────────────────────────────────────────
 *
 * The brief was explicit: playful, not a psychological instrument. So the result
 * bands are jokes with a range attached rather than a percentage with a verdict,
 * and `describeResult` is deliberately the least serious code in the repository.
 * A number that looks scientific invites people to believe it, and a
 * multiple-choice quiz about ideal holidays has not earned that.
 *
 * ── Both of you act, every round ─────────────────────────────────────────────
 *
 * Which is the difference between this and Who Knows Me Better, where the
 * subject sits out. With exactly two people, somebody sitting out is half the
 * room doing nothing.
 */

/* ========================================================================== */

const ANSWER_SECONDS = 40;
const DEFAULT_ROUNDS = 10;

export interface Question {
  /** Reads after a name: "Ada's …". */
  subject: string;
  options: string[];
}

interface Round {
  question: Question;
  /** Shuffled per round, so a position never carries information. */
  order: number[];
  subjectSeat: number;
}

interface State {
  rounds: Round[];
  round: number;
  totalRounds: number;
  phase: "answering" | "revealed";
  deadline: number;

  /** SECRET until both are in. The subject's own answer. */
  truth: number | null;
  /** SECRET until both are in. What the other one thinks. */
  guess: number | null;

  /** Shared. One number for the pair, not one each. */
  score: number;
  matched: boolean[];
  lastResult: { truth: number | null; guess: number | null; matched: boolean } | null;
}

export type Move = { type: "answer"; option: number } | { type: "reveal" } | { type: "next" };

/* ========================================================================== */

function subjectOf(state: State): number {
  return state.rounds[state.round]?.subjectSeat ?? 0;
}

function bothIn(state: State): boolean {
  return state.truth !== null && state.guess !== null;
}

function reveal(state: State, players: PlayerSeat[]): State {
  const subject = subjectOf(state);
  const subjectHere = players.some((player) => player.seat === subject);

  // Nothing to compare. Not a miss — a round that did not happen, which must not
  // count against a couple who were simply interrupted.
  if (state.truth === null || state.guess === null || !subjectHere) {
    return {
      ...state,
      phase: "revealed",
      lastResult: { truth: state.truth, guess: state.guess, matched: false },
    };
  }

  const matched = state.truth === state.guess;

  return {
    ...state,
    phase: "revealed",
    score: state.score + (matched ? 1 : 0),
    matched: [...state.matched, matched],
    lastResult: { truth: state.truth, guess: state.guess, matched },
  };
}

/** Positions in this round's shuffle, which is what the UI works in. */
function displayIndex(round: Round | undefined, canonical: number | null): number | null {
  if (!round || canonical === null) return null;
  const position = round.order.indexOf(canonical);
  return position === -1 ? null : position;
}

/**
 * The verdict, such as it is.
 *
 * Bands rather than a percentage with an interpretation. Every line is written
 * to be read out loud and laughed at, because the alternative — "78% compatible"
 * — is a number people take seriously, and this is a multiple-choice quiz about
 * holidays.
 */
export function describeResult(score: number, total: number): { title: string; line: string } {
  if (total === 0) return { title: "Nothing to report", line: "You did not play a round." };

  const share = score / total;

  if (share === 1) {
    return {
      title: "Suspiciously perfect",
      line: "Either you know each other completely or somebody was reading over a shoulder.",
    };
  }
  if (share >= 0.8) {
    return {
      title: "Frighteningly good",
      line: "You could order for each other. You probably do.",
    };
  }
  if (share >= 0.6) {
    return { title: "Solid", line: "You know the important things and guessed the rest well." };
  }
  if (share >= 0.4) {
    return { title: "Some gaps", line: "Encouraging, and there is clearly more to find out." };
  }
  if (share >= 0.2) {
    return {
      title: "Room to grow",
      line: "Good news: there is a lot left to learn about each other.",
    };
  }
  return {
    title: "Have you two met?",
    line: "Genuinely impressive in its own way. Try the questions out loud instead.",
  };
}

/* ========================================================================== */

export const howWell: GameEngine<State, Move> = {
  key: "how-well",

  createInitialState({ seed, config, now }: SetupContext): State {
    const random = mulberry32(seed);

    const requested = Number(config["rounds"]);
    const totalRounds =
      Number.isInteger(requested) && requested >= 2 && requested <= 20 ? requested : DEFAULT_ROUNDS;

    const questions = shuffled(QUESTIONS, random);
    // Whose turn to be asked about, alternating. An even round count means both
    // are the subject the same number of times, which matters because being
    // asked about and doing the guessing are different jobs.
    const first = random() < 0.5 ? 0 : 1;

    const rounds: Round[] = Array.from({ length: totalRounds }, (_, index) => {
      const question = questions[index % questions.length] ?? QUESTIONS[0]!;
      return {
        question,
        order: shuffled(
          question.options.map((_, optionIndex) => optionIndex),
          random,
        ),
        subjectSeat: (first + index) % 2,
      };
    });

    return {
      rounds,
      round: 0,
      totalRounds,
      phase: "answering",
      deadline: now + ANSWER_SECONDS * 1000,
      truth: null,
      guess: null,
      score: 0,
      matched: [],
      lastResult: null,
    };
  },

  // Both answer at once. No seat holds the turn, so this file is what stops one
  // of them answering in the other's place.
  initialTurnSeat: () => null,

  validateMove(payload: unknown): Move | null {
    if (typeof payload !== "object" || payload === null) return null;
    const value = payload as Record<string, unknown>;

    switch (value["type"]) {
      case "answer": {
        const option = value["option"];
        return typeof option === "number" && Number.isInteger(option) && option >= 0
          ? { type: "answer", option }
          : null;
      }
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
        if (state.phase !== "answering") return { ok: false, reason: "That round is over." };
        if (move.option >= current.question.options.length) {
          return { ok: false, reason: "That is not one of the options." };
        }
        if (now > state.deadline + DEADLINE_GRACE_MS) {
          return { ok: false, reason: "Time is up." };
        }

        const amSubject = seat === current.subjectSeat;
        const already = amSubject ? state.truth : state.guess;

        // Locked in, both ways. Changing after the other has committed is the
        // one thing that would make the comparison meaningless.
        if (already !== null) return { ok: false, reason: "You have already answered." };

        const next: State = amSubject
          ? { ...state, truth: move.option }
          : { ...state, guess: move.option };

        // Both in closes the round at once — nobody should sit watching a timer
        // they have already beaten.
        return {
          ok: true,
          state: bothIn(next) ? reveal(next, players) : next,
          turnSeat: null,
        };
      }

      case "reveal": {
        if (state.phase !== "revealed") {
          const subjectGone = !players.some((p) => p.seat === current.subjectSeat);
          if (!bothIn(state) && now < state.deadline && !subjectGone) {
            return { ok: false, reason: "Still waiting." };
          }
          return { ok: true, state: reveal(state, players), turnSeat: null };
        }
        return { ok: false, reason: "Already revealed." };
      }

      case "next": {
        if (state.phase !== "revealed") return { ok: false, reason: "The round is not finished." };

        const round = state.round + 1;

        if (round >= state.totalRounds) {
          /*
           * One score, on both seats.
           *
           * The generic scoreboard reads per-seat numbers, so a shared score is
           * expressed as the same number twice rather than as a special case in
           * the machinery. Both are winners for the same reason: a couple game
           * that names one of them is a couple game somebody loses.
           */
          const shared = Object.fromEntries(players.map((p) => [p.seat, state.score]));

          return {
            ok: true,
            state: { ...state, round },
            turnSeat: null,
            outcome: {
              scores: shared,
              placements: Object.fromEntries(players.map((p) => [p.seat, 1])),
              winnerSeats: players.map((p) => p.seat),
            },
          };
        }

        return {
          ok: true,
          state: {
            ...state,
            round,
            phase: "answering",
            deadline: now + ANSWER_SECONDS * 1000,
            truth: null,
            guess: null,
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
   * What the pair sees.
   *
   * Who is being asked about, the options, and whether each of them has
   * committed — never what either committed to, until the round closes. There is
   * no spectator here: a couple session has exactly two people in it and both
   * are playing.
   */
  publicView(state: State) {
    const current = state.rounds[state.round];
    const revealed = state.phase === "revealed";

    return {
      round: state.round,
      totalRounds: state.totalRounds,
      phase: state.phase,
      deadline: state.deadline,
      subjectSeat: current?.subjectSeat ?? 0,
      subject: current?.question.subject ?? null,
      options: current ? current.order.map((i) => current.question.options[i] ?? "") : [],
      truthIn: state.truth !== null,
      guessIn: state.guess !== null,
      // Empty until both are in.
      truthIndex: revealed ? displayIndex(current, state.lastResult?.truth ?? null) : null,
      guessIndex: revealed ? displayIndex(current, state.lastResult?.guess ?? null) : null,
      matched: revealed ? (state.lastResult?.matched ?? false) : false,
      score: state.score,
      played: state.matched.length,
    };
  },

  /** The pair's view, plus whichever answer this person themselves gave. */
  viewFor(state: State, seat: number) {
    const current = state.rounds[state.round];
    const amSubject = seat === (current?.subjectSeat ?? 0);

    return {
      ...(this.publicView(state) as Record<string, unknown>),
      mySeat: seat,
      amSubject,
      myAnswer: displayIndex(current, amSubject ? state.truth : state.guess),
    };
  },

  /** The same number for both, because it is one number. */
  scores: (state: State) => ({ 0: state.score, 1: state.score }),

  describe(state: State) {
    return `Round ${state.round + 1} of ${state.totalRounds}`;
  },
};

registerEngine(howWell);

/* ========================================================================== */

/**
 * The questions.
 *
 * Every one is about a preference rather than a fact, because a fact is
 * something you either remember or do not and a preference is something you
 * either understand about somebody or do not. "What is their sister called" is
 * a memory test; "what would they do with a free evening" is the game.
 *
 * They read after a name: "Ada's ideal holiday".
 */
export const QUESTIONS: Question[] = [
  {
    subject: "ideal holiday",
    options: [
      "A city with good food",
      "Somewhere with no signal",
      "A beach and nothing else",
      "Walking, properly",
    ],
  },
  {
    subject: "perfect Friday night",
    options: [
      "Out late",
      "Dinner with two friends",
      "Nobody, a film, bed by ten",
      "Whatever is happening",
    ],
  },
  {
    subject: "worst way to spend a day",
    options: ["Admin", "Small talk", "Waiting for something", "Being rushed"],
  },
  {
    subject: "comfort meal",
    options: ["Something from childhood", "A roast", "Noodles", "Toast, honestly"],
  },
  {
    subject: "biggest indulgence",
    options: ["Good coffee", "Taxis", "Books they will not read", "Nice sheets"],
  },
  {
    subject: "way of handling bad news",
    options: ["Talk it out immediately", "Go quiet for a day", "Get busy", "Make a joke about it"],
  },
  {
    subject: "dream way to earn a living",
    options: ["Making something", "Teaching", "Travelling for it", "Not having to"],
  },
  {
    subject: "most-loved possession",
    options: ["Something inherited", "A photo", "An instrument", "Nothing, really"],
  },
  {
    subject: "idea of being looked after",
    options: ["Being fed", "Being left alone", "Being listened to", "Being taken somewhere"],
  },
  {
    subject: "worst habit",
    options: ["Never on time", "Never says no", "Cannot let it go", "Disappears when stressed"],
  },
  {
    subject: "favourite thing about where they live",
    options: ["The people", "Being able to leave easily", "One specific place", "Nothing much"],
  },
  {
    subject: "ideal Sunday morning",
    options: ["Still asleep", "Out early", "Cooking something slow", "Somewhere with a paper"],
  },
  {
    subject: "way they show they care",
    options: ["Doing things", "Saying it", "Being there", "Buying things"],
  },
  {
    subject: "thing they would change about themselves",
    options: ["More patient", "Less anxious", "Fitter", "Nothing at all"],
  },
  {
    subject: "reaction to a big surprise",
    options: ["Delighted", "Suspicious", "Overwhelmed", "Immediately practical"],
  },
  {
    subject: "guilty pleasure",
    options: [
      "Terrible television",
      "Going to bed early",
      "Reading the comments",
      "Expensive snacks",
    ],
  },
  {
    subject: "idea of a good argument",
    options: ["Loud and over quickly", "Slow and written down", "Avoided entirely", "With snacks"],
  },
  {
    subject: "what they would do with a free afternoon",
    options: ["Sleep", "Something outdoors", "A project", "See somebody"],
  },
  {
    subject: "first thing they would buy with real money",
    options: ["A home", "Time off", "Something for somebody else", "Nothing, save it"],
  },
  {
    subject: "the thing they are quietly proud of",
    options: ["Their work", "A friendship", "Getting through something", "Their taste"],
  },
  {
    subject: "how they would want a birthday to go",
    options: ["A big fuss", "Dinner with a few", "Ignored completely", "Away somewhere"],
  },
  {
    subject: "what they reach for when tired",
    options: ["Their phone", "A walk", "Something sweet", "Company"],
  },
  {
    subject: "ideal place to live one day",
    options: ["Near the sea", "A proper city", "Somewhere green", "Wherever the people are"],
  },
  {
    subject: "thing they would never get rid of",
    options: ["A jumper", "A box of letters", "A piece of music", "A habit"],
  },
];
