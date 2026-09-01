import { registerEngine } from "@/features/games/engine/registry";
import { DEADLINE_GRACE_MS, mulberry32, shuffled } from "@/features/games/engine/support";
import type {
  GameEngine,
  MoveContext,
  MoveResult,
  PlayerSeat,
  SetupContext,
} from "@/features/games/engine/types";
import {
  GUESS_MY_ANSWER_CATEGORIES,
  GUESS_MY_ANSWER_CATEGORY_KEYS,
  type GuessMyAnswerCategory,
} from "@/lib/games/config";

/**
 * Guess My Answer.
 *
 * A question goes to both of you at once. Each says what they would pick, and
 * each predicts what the other will pick. Four answers land, nothing is visible
 * until all four are in, and then the round opens as a two-by-two: what you
 * said, what they thought you would say, and the same in reverse.
 *
 * ── How this differs from How Well Do You Know Me? ───────────────────────────
 *
 * Honestly: not by much, at the level of "somebody answers and somebody
 * guesses". The two things that make it a different game to play are both
 * deliberate rather than decorative.
 *
 * SYMMETRY. How Well has a subject each round; one person answers about
 * themselves and the other guesses. Here BOTH do BOTH, every round. That doubles
 * what a round is worth, removes the sense of taking turns being examined, and —
 * the part that actually changes the feel — means the reveal is a comparison
 * rather than a verdict. You find out who read whom, in the same moment, about
 * the same question.
 *
 * It also makes per-person scores fair, which they are not in How Well: there,
 * only one of you is guessing in a given round, so a personal total would be
 * measuring who happened to draw the easier questions. Here the two of you face
 * exactly the same task, so the numbers mean something.
 *
 * CATEGORIES. The pair choose what they are in the mood for before they start,
 * and the choice is load-bearing rather than a label: `petty` and `tender` are
 * different games in practice, and picking one is part of deciding what kind of
 * evening this is.
 *
 * ── Still no winner ──────────────────────────────────────────────────────────
 *
 * Both totals are shown, because they are comparable and it is interesting. The
 * headline is the pair's combined score and the outcome names both of them, for
 * the same reason as the other couple game: an app that tells one half of a
 * couple they lost is an app doing something nobody asked it to.
 */

/* ========================================================================== */

const ANSWER_SECONDS = 45;
const DEFAULT_ROUNDS = 8;

/**
 * The categories live in `lib/` because the picker is on the couple page and a
 * feature may not import another feature. See `src/lib/games/config.ts`.
 */
type Category = GuessMyAnswerCategory;

export interface Question {
  category: Category;
  /** Reads as a question to both of them at once. */
  text: string;
  options: string[];
}

interface Round {
  question: Question;
  /** Shuffled per round, so a position never carries information. */
  order: number[];
}

/** One person's two submissions for a round. */
interface Submission {
  /** What they would pick. */
  own: number | null;
  /** What they think the other will pick. */
  predict: number | null;
}

interface State {
  rounds: Round[];
  round: number;
  totalRounds: number;
  categories: Category[];
  phase: "answering" | "revealed";
  deadline: number;

  /** SECRET until all four are in. Seat to their pair of choices. */
  submissions: Record<number, Submission>;

  /** Per seat: how many of THEIR predictions were right. */
  scores: Record<number, number>;
  /**
   * How many predictions there were actually to get right.
   *
   * Not `round × 2`: a round that nobody finished — ran out of time, partner
   * closed the tab — produced nothing to be judged on, and counting it in the
   * denominator would turn an interruption into a bad score.
   */
  judged: number;
  lastResult: {
    /** Seat to what that person actually picked. */
    own: Record<number, number | null>;
    /** Seat to what that person predicted of the other. */
    predict: Record<number, number | null>;
    /** Seats whose prediction landed. */
    correct: number[];
  } | null;
}

export type Move =
  { type: "submit"; own: number; predict: number } | { type: "reveal" } | { type: "next" };

/* ========================================================================== */

const EMPTY: Submission = { own: null, predict: null };

function submissionOf(state: State, seat: number): Submission {
  return state.submissions[seat] ?? EMPTY;
}

function complete(submission: Submission): boolean {
  return submission.own !== null && submission.predict !== null;
}

/** Everybody still here has sent both of their choices. */
function everybodyIn(state: State, players: PlayerSeat[]): boolean {
  return players.length > 0 && players.every((p) => complete(submissionOf(state, p.seat)));
}

function reveal(state: State, players: PlayerSeat[]): State {
  const own: Record<number, number | null> = {};
  const predict: Record<number, number | null> = {};
  const correct: number[] = [];
  const scores = { ...state.scores };
  let judged = state.judged;

  for (const player of players) {
    const submission = submissionOf(state, player.seat);
    own[player.seat] = submission.own;
    predict[player.seat] = submission.predict;
  }

  for (const player of players) {
    // Exactly two seats, but written as a lookup rather than `1 - seat` so that
    // a session missing a partner — one of them left mid-round — falls out here
    // instead of scoring against a ghost.
    const other = players.find((p) => p.seat !== player.seat);
    if (!other) continue;

    const guess = predict[player.seat] ?? null;
    const truth = own[other.seat] ?? null;

    // An unfinished round is not a round anybody got wrong. Ran out of time,
    // closed the tab, partner walked off — none of those are a miss, and
    // counting them as one would punish the interruption rather than the guess.
    if (guess === null || truth === null) continue;

    judged += 1;

    if (guess === truth) {
      correct.push(player.seat);
      scores[player.seat] = (scores[player.seat] ?? 0) + 1;
    }
  }

  return { ...state, phase: "revealed", scores, judged, lastResult: { own, predict, correct } };
}

function displayIndex(
  round: Round | undefined,
  canonical: number | null | undefined,
): number | null {
  if (!round || canonical === null || canonical === undefined) return null;
  const position = round.order.indexOf(canonical);
  return position === -1 ? null : position;
}

function displayMap(
  round: Round | undefined,
  source: Record<number, number | null>,
): Record<number, number | null> {
  const shown: Record<number, number | null> = {};
  for (const [seat, canonical] of Object.entries(source)) {
    shown[Number(seat)] = displayIndex(round, canonical);
  }
  return shown;
}

/**
 * The closing line, such as it is.
 *
 * Bands with a joke attached rather than a percentage with a verdict — the same
 * rule as the other couple game, for the same reason. This is a quiz about
 * biscuits and it has not earned anybody's belief.
 */
export function describeTogether(score: number, total: number): { title: string; line: string } {
  if (total === 0) return { title: "Nothing to report", line: "You did not finish a round." };

  const share = score / total;

  if (share === 1) {
    return { title: "Word for word", line: "Every single one. Somebody is peeking." };
  }
  if (share >= 0.75) {
    return { title: "Reading each other", line: "You finish each other's multiple choice." };
  }
  if (share >= 0.5) {
    return {
      title: "Mostly there",
      line: "You got the ones that matter and missed the odd biscuit.",
    };
  }
  if (share >= 0.25) {
    return { title: "Some surprises", line: "Which is the good outcome, if you think about it." };
  }
  return {
    title: "Complete strangers",
    line: "Wonderful. There is an entire person here you have not met yet.",
  };
}

/* ========================================================================== */

export const guessMyAnswer: GameEngine<State, Move> = {
  key: "guess-my-answer",

  createInitialState({ seed, config, now }: SetupContext): State {
    const random = mulberry32(seed);

    const requested = Number(config["rounds"]);
    const totalRounds =
      Number.isInteger(requested) && requested >= 2 && requested <= 20 ? requested : DEFAULT_ROUNDS;

    // The pair's choice, filtered to what actually exists. An empty or unknown
    // selection means everything, which is the sensible reading of "surprise us".
    const asked = Array.isArray(config["categories"]) ? (config["categories"] as unknown[]) : [];
    const chosen = asked.filter((value): value is Category =>
      GUESS_MY_ANSWER_CATEGORY_KEYS.some((key) => key === value),
    );
    const categories: Category[] = chosen.length > 0 ? chosen : [...GUESS_MY_ANSWER_CATEGORY_KEYS];

    const pool = shuffled(
      QUESTIONS.filter((question) => categories.includes(question.category)),
      random,
    );

    const rounds: Round[] = Array.from({ length: totalRounds }, (_, index) => {
      const question = pool[index % Math.max(pool.length, 1)] ?? QUESTIONS[0]!;
      return {
        question,
        order: shuffled(
          question.options.map((_, optionIndex) => optionIndex),
          random,
        ),
      };
    });

    return {
      rounds,
      round: 0,
      totalRounds,
      categories,
      phase: "answering",
      deadline: now + ANSWER_SECONDS * 1000,
      submissions: {},
      scores: { 0: 0, 1: 0 },
      judged: 0,
      lastResult: null,
    };
  },

  // Both act at once, so no seat holds the turn.
  initialTurnSeat: () => null,

  validateMove(payload: unknown): Move | null {
    if (typeof payload !== "object" || payload === null) return null;
    const value = payload as Record<string, unknown>;

    switch (value["type"]) {
      case "submit": {
        const own = value["own"];
        const predict = value["predict"];
        const valid = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
        // Both halves at once. A partial submission would mean a state where
        // somebody had committed to one and could still see the round move
        // around the other.
        return valid(own) && valid(predict)
          ? { type: "submit", own: own as number, predict: predict as number }
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
      case "submit": {
        if (state.phase !== "answering") return { ok: false, reason: "That round is over." };

        const count = current.question.options.length;
        if (move.own >= count || move.predict >= count) {
          return { ok: false, reason: "That is not one of the options." };
        }
        if (complete(submissionOf(state, seat))) {
          return { ok: false, reason: "You have already answered." };
        }
        if (now > state.deadline + DEADLINE_GRACE_MS) {
          return { ok: false, reason: "Time is up." };
        }

        const next: State = {
          ...state,
          submissions: {
            ...state.submissions,
            [seat]: { own: move.own, predict: move.predict },
          },
        };

        return {
          ok: true,
          state: everybodyIn(next, players) ? reveal(next, players) : next,
          turnSeat: null,
        };
      }

      case "reveal": {
        if (state.phase !== "answering") return { ok: false, reason: "Already revealed." };
        if (!everybodyIn(state, players) && now < state.deadline) {
          return { ok: false, reason: "Still waiting." };
        }
        return { ok: true, state: reveal(state, players), turnSeat: null };
      }

      case "next": {
        if (state.phase !== "revealed") return { ok: false, reason: "The round is not finished." };

        const round = state.round + 1;

        if (round >= state.totalRounds) {
          /*
           * What gets written down is the pair's number.
           *
           * The two individual counts are real and interesting, and the result
           * panel shows them — but they live in the game state, where they are a
           * detail of this game's screen. What leaves the engine, into
           * `game_players.score`, the shared scoreboard and the couple's game
           * history, is one figure carried on both seats.
           *
           * That is not squeamishness, it is what the surrounding machinery does
           * with a per-seat number: the scoreboard sorts by it, the history takes
           * the largest one and calls it "our score", and a rematch shows it back
           * to them later. Every one of those turns two numbers into a ranking
           * eventually, and this game does not have one — so it hands up the only
           * total that is true of both of them.
           */
          const together = players.reduce((sum, p) => sum + (state.scores[p.seat] ?? 0), 0);

          return {
            ok: true,
            state: { ...state, round },
            turnSeat: null,
            outcome: {
              scores: Object.fromEntries(players.map((p) => [p.seat, together])),
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
            submissions: {},
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
   * The question, the category, and who has finished — never anybody's choices
   * until all four are in. There is no spectator: a couple session has exactly
   * two people and both are playing.
   */
  publicView(state: State) {
    const current = state.rounds[state.round];
    const revealed = state.phase === "revealed";

    return {
      round: state.round,
      totalRounds: state.totalRounds,
      phase: state.phase,
      deadline: state.deadline,
      category: current?.question.category ?? null,
      question: current?.question.text ?? null,
      options: current ? current.order.map((i) => current.question.options[i] ?? "") : [],
      // Enough to draw "one of you is still deciding" and nothing more.
      submittedSeats: Object.entries(state.submissions)
        .filter(([, submission]) => complete(submission))
        .map(([seat]) => Number(seat))
        .sort(),
      own: revealed ? displayMap(current, state.lastResult?.own ?? {}) : {},
      predict: revealed ? displayMap(current, state.lastResult?.predict ?? {}) : {},
      correct: revealed ? (state.lastResult?.correct ?? []) : [],
      scores: state.scores,
      together: (state.scores[0] ?? 0) + (state.scores[1] ?? 0),
      // The denominator for the ending: predictions that could be judged, not
      // rounds that were scheduled.
      played: state.judged,
    };
  },

  /** The pair's view, plus this person's own two choices. */
  viewFor(state: State, seat: number) {
    const current = state.rounds[state.round];
    const mine = submissionOf(state, seat);

    return {
      ...(this.publicView(state) as Record<string, unknown>),
      mySeat: seat,
      myOwn: displayIndex(current, mine.own),
      myPredict: displayIndex(current, mine.predict),
    };
  },

  /**
   * The shared scoreboard's number, which is the pair's — the same one on both
   * seats, and the same figure the ending writes down, so nothing jumps when the
   * game finishes. The individual split is in `publicView().scores`, for the
   * board that knows what to do with it.
   */
  scores(state: State) {
    const together = (state.scores[0] ?? 0) + (state.scores[1] ?? 0);
    return { 0: together, 1: together };
  },

  describe(state: State) {
    const category = state.rounds[state.round]?.question.category;
    const name = GUESS_MY_ANSWER_CATEGORIES.find((c) => c.key === category)?.name;
    return name ? `${name} · round ${state.round + 1}` : `Round ${state.round + 1}`;
  },
};

registerEngine(guessMyAnswer);

/* ========================================================================== */

/**
 * The questions.
 *
 * Written so both people can answer the same one about themselves — "what would
 * you do", not "what would they do". A question only one of you can answer is a
 * question that breaks the symmetry the game is built on.
 *
 * The categories genuinely play differently, which is the point of offering
 * them. `petty` produces arguments and `tender` produces quiet, and a couple
 * knows which one they want on a given evening.
 */
export const QUESTIONS: Question[] = [
  /* --- tender ------------------------------------------------------------ */
  {
    category: "tender",
    text: "What would you want on a bad day?",
    options: ["Company, quietly", "To be left alone", "To be taken out", "To be told it's fine"],
  },
  {
    category: "tender",
    text: "Which of these means the most?",
    options: ["Being remembered", "Being defended", "Being surprised", "Being left to it"],
  },
  {
    category: "tender",
    text: "What's the best sound in a home?",
    options: ["Somebody cooking", "Music from another room", "Rain", "Nothing at all"],
  },
  {
    category: "tender",
    text: "How would you rather be woken up?",
    options: ["Coffee", "Slowly, no words", "Not at all", "With news"],
  },
  {
    category: "tender",
    text: "What would you keep from this year?",
    options: ["One conversation", "One trip", "One ordinary evening", "One thing you finished"],
  },
  {
    category: "tender",
    text: "What's the kindest thing to be told?",
    options: ["I noticed", "I'm proud of you", "Take your time", "I'd do it again"],
  },

  /* --- petty ------------------------------------------------------------- */
  {
    category: "petty",
    text: "What's the most annoying household crime?",
    options: [
      "Leaving the light on",
      "Wet towel on the bed",
      "Empty milk back in the fridge",
      "Loud chewing",
    ],
  },
  {
    category: "petty",
    text: "Which is worse?",
    options: ["Being late", "Being rushed", "Being interrupted", "Being managed"],
  },
  {
    category: "petty",
    text: "Correct way to load a dishwasher?",
    options: [
      "A system, obviously",
      "Whatever fits",
      "Rinse everything first",
      "That's what hands are for",
    ],
  },
  {
    category: "petty",
    text: "Which noise is unbearable?",
    options: ["Phone on speaker", "Cutlery on a plate", "Somebody else's alarm", "Sniffing"],
  },
  {
    category: "petty",
    text: "The correct thermostat setting is",
    options: ["Colder than that", "Warmer than that", "Fine as it is", "Not a conversation"],
  },
  {
    category: "petty",
    text: "Which is the bigger betrayal?",
    options: [
      "Finishing the good snack",
      "Watching an episode ahead",
      "Telling the story wrong",
      "Being late for the film",
    ],
  },

  /* --- wild -------------------------------------------------------------- */
  {
    category: "wild",
    text: "You have to fight something. Pick.",
    options: ["A goose", "Three cats", "One large child", "Your own reflection"],
  },
  {
    category: "wild",
    text: "You get one useless superpower.",
    options: [
      "Always know the time",
      "Perfect parallel parking",
      "Never spill",
      "Understand seagulls",
    ],
  },
  {
    category: "wild",
    text: "You must live in one forever.",
    options: ["A lighthouse", "A very good hotel", "A boat", "A castle with no heating"],
  },
  {
    category: "wild",
    text: "One food, for the rest of your life.",
    options: ["Bread", "Rice", "Potatoes", "Cheese, and consequences"],
  },
  {
    category: "wild",
    text: "You are given a small mysterious box.",
    options: ["Open it immediately", "Never open it", "Ask somebody first", "Sell it"],
  },
  {
    category: "wild",
    text: "Your enemy is chosen for you.",
    options: [
      "A pigeon with a grudge",
      "The council",
      "Someone from school",
      "A very polite ghost",
    ],
  },

  /* --- past -------------------------------------------------------------- */
  {
    category: "past",
    text: "What was the best decision you made together?",
    options: [
      "Where you live",
      "Saying yes to something",
      "Saying no to something",
      "Getting the thing",
    ],
  },
  {
    category: "past",
    text: "Which was the funniest disaster?",
    options: ["A journey", "A meal", "A gift", "A conversation with somebody's parents"],
  },
  {
    category: "past",
    text: "What did you get most wrong about each other at first?",
    options: ["How shy", "How stubborn", "How funny", "How much of a planner"],
  },
  {
    category: "past",
    text: "The best place you've been together?",
    options: ["Somewhere far", "Somewhere near", "Somewhere accidental", "The kitchen, honestly"],
  },
  {
    category: "past",
    text: "What would past-you find hardest to believe?",
    options: ["Where you live", "What you do", "How calm it is", "That it worked"],
  },
  {
    category: "past",
    text: "Which one should you do again?",
    options: [
      "The long drive",
      "The bad film",
      "The early morning",
      "The argument, properly this time",
    ],
  },
];
