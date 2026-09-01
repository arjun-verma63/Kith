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
 * Draw & Guess.
 *
 * One person gets a word and draws it. Everybody else types guesses into the
 * game's chat. Correct guesses score by how quickly they arrive, the drawer
 * scores by how many people got there, and the pencil passes on.
 *
 * ── The drawing is not in here ───────────────────────────────────────────────
 *
 * Deliberately, and it is the most important decision in the game. A hand moving
 * across a canvas makes dozens of points a second; running each through the move
 * pipeline would mean a row in an append-only log, a rewrite of the state blob
 * and a version bump per point, for data that is worthless when the round ends.
 *
 * Strokes are broadcast client to client on `game:{id}` and never stored — the
 * same class of thing as a typing indicator. `features/games/canvas.ts` is the
 * protocol; this engine never sees a coordinate.
 *
 * What IS in here is everything that decides an outcome: the word, the guesses,
 * who was right, and when. Those go through the engine exactly like every other
 * game, because they are the things somebody would want to cheat at.
 *
 * ── Guessing is chat, and chat is a move ─────────────────────────────────────
 *
 * A guess is a few per player per round, so the cost is nothing and the benefit
 * is that correctness is decided server-side. A client that judged its own
 * guesses would be a client that always guessed correctly.
 *
 * A correct guess is never echoed to the room. Publishing it would hand the
 * answer to everybody still guessing, so the chat shows "Ada got it" and the
 * word stays hidden until the reveal.
 */

/* ========================================================================== */

const ROUND_SECONDS = 75;
const MINIMUM_ROUNDS = 4;
/** Enough chat to see the last minute of a round, and no more. */
const CHAT_LIMIT = 40;
const MAX_GUESS_LENGTH = 48;

export interface ChatLine {
  seat: number;
  /** Omitted when the guess was correct — publishing it would give the word away. */
  text: string | null;
  kind: "guess" | "correct" | "close";
}

interface RoundSetup {
  word: string;
  drawerSeat: number;
}

interface State {
  rounds: RoundSetup[];
  round: number;
  totalRounds: number;
  phase: "drawing" | "revealed";
  deadline: number;
  /** How long this round was given, so a share of time remaining can be scored. */
  roundMs: number;

  /** SECRET. Only ever leaves the server inside the drawer's own view. */
  word: string;
  drawerSeat: number;

  /** Seat to the time they got it, so scoring can reward being quick. */
  solved: Record<number, number>;
  chat: ChatLine[];

  scores: Record<number, number>;
  lastResult: { word: string; solvedSeats: number[]; drawerPoints: number } | null;
}

export type Move = { type: "guess"; text: string } | { type: "reveal" } | { type: "next" };

/* ========================================================================== */

/**
 * Reduces a guess to something comparable.
 *
 * Lower case, accents stripped, punctuation and spaces removed. "Ice-cream",
 * "ice cream" and "Icecream" are the same answer, and a game that says otherwise
 * is a game about typing.
 */
export function normalise(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Levenshtein distance, capped.
 *
 * Only used to tell somebody they are close, so anything past two is "no" and
 * the loop can stop early. Full distance on arbitrary strings would be wasted
 * work on every wrong guess.
 */
export function editDistance(a: string, b: string, cap = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current[j] = value;
      if (value < best) best = value;
    }

    // Every path through this row is already too expensive.
    if (best > cap) return cap + 1;
    previous = current;
  }

  return previous[b.length] ?? cap + 1;
}

/**
 * The word as the guessers see it.
 *
 * Underscores for letters, real characters for spaces and hyphens — the shape of
 * a phrase is a fair clue, and hiding it just makes two-word answers impossible.
 * Letters are revealed as time runs out so a round cannot end with nobody having
 * a chance.
 */
export function maskWord(word: string, revealCount: number): string {
  const letters = [...word];
  // Deterministic: the same word and count always reveal the same positions, so
  // every client draws the same hint without being told which ones.
  const positions = letters
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => /[a-z]/i.test(character))
    .map(({ index }) => index);

  const revealed = new Set(positions.filter((_, i) => i % 2 === 0).slice(0, revealCount));

  return letters
    .map((character, index) => {
      if (!/[a-z0-9]/i.test(character)) return character;
      return revealed.has(index) ? character : "_";
    })
    .join(" ");
}

/** How many letters are showing, given how much of the round has gone. */
function revealCountFor(state: State, now: number): number {
  if (state.phase === "revealed") return Number.MAX_SAFE_INTEGER;

  const elapsed = state.roundMs - Math.max(0, state.deadline - now);
  const fraction = state.roundMs > 0 ? elapsed / state.roundMs : 0;

  if (fraction < 0.5) return 0;
  if (fraction < 0.75) return 1;
  return 2;
}

/** Appends a line and keeps the transcript bounded. */
function appendChat(chat: ChatLine[], line: ChatLine): ChatLine[] {
  return [...chat, line].slice(-CHAT_LIMIT);
}

function guessersOf(players: PlayerSeat[], drawerSeat: number): PlayerSeat[] {
  return players.filter((player) => player.seat !== drawerSeat);
}

/**
 * Points for getting it, by how much time was left.
 *
 * Five for an immediate answer down to two for one that scrapes in. Rewarding
 * speed is what stops everybody sitting on an answer until the last second, and
 * the floor of two means a late correct guess is still worth making.
 */
function guessPoints(remainingFraction: number): number {
  return 2 + Math.round(3 * Math.max(0, Math.min(1, remainingFraction)));
}

function reveal(state: State, players: PlayerSeat[]): State {
  const solvedSeats = Object.keys(state.solved).map(Number);
  const drawerHere = players.some((player) => player.seat === state.drawerSeat);

  const scores = { ...state.scores };

  // Two points a head for the drawer. Drawing well is worth something, and
  // making it proportional means a clear drawing beats a clever one.
  const drawerPoints = drawerHere ? solvedSeats.length * 2 : 0;
  if (drawerPoints > 0) {
    scores[state.drawerSeat] = (scores[state.drawerSeat] ?? 0) + drawerPoints;
  }

  return {
    ...state,
    phase: "revealed",
    scores,
    lastResult: { word: state.word, solvedSeats, drawerPoints },
  };
}

/** True when every guesser still present has already got it. */
function everybodySolved(state: State, players: PlayerSeat[]): boolean {
  const guessers = guessersOf(players, state.drawerSeat);
  return guessers.length > 0 && guessers.every((g) => state.solved[g.seat] !== undefined);
}

function nextDrawer(state: State, players: PlayerSeat[], round: number): number {
  const present = new Set(players.map((player) => player.seat));
  const planned = state.rounds[round]?.drawerSeat;
  if (planned !== undefined && present.has(planned)) return planned;

  // The person whose turn it was has gone. Take the next one who is still here
  // rather than skipping the round entirely.
  const order = state.rounds.map((r) => r.drawerSeat);
  for (let step = 0; step < order.length; step += 1) {
    const seat = order[(round + step) % order.length];
    if (seat !== undefined && present.has(seat)) return seat;
  }

  return players[0]?.seat ?? state.drawerSeat;
}

/* ========================================================================== */

export const drawGuess: GameEngine<State, Move> = {
  key: "draw-guess",

  createInitialState({ players, seed, config, now }: SetupContext): State {
    const random = mulberry32(seed);

    const laps = Number(config["laps"]);
    const chosenLaps =
      Number.isInteger(laps) && laps >= 1 && laps <= 4
        ? laps
        : Math.max(1, Math.ceil(MINIMUM_ROUNDS / Math.max(players.length, 1)));

    const totalRounds = players.length * chosenLaps;

    const words = shuffled(WORDS, random);
    // Everybody draws the same number of times, so the rotation is a shuffled
    // seat order repeated. Drawing is the part that scores least reliably, so an
    // uneven number of turns at it would be a real advantage.
    const rotation = shuffled(
      players.map((player) => player.seat),
      random,
    );

    const rounds: RoundSetup[] = Array.from({ length: totalRounds }, (_, index) => ({
      word: words[index % words.length] ?? WORDS[0]!,
      drawerSeat: rotation[index % rotation.length] ?? players[0]?.seat ?? 0,
    }));

    const first = rounds[0]!;

    return {
      rounds,
      round: 0,
      totalRounds,
      phase: "drawing",
      deadline: now + ROUND_SECONDS * 1000,
      roundMs: ROUND_SECONDS * 1000,
      word: first.word,
      drawerSeat: first.drawerSeat,
      solved: {},
      chat: [],
      scores: Object.fromEntries(players.map((player) => [player.seat, 0])),
      lastResult: null,
    };
  },

  // Everybody guesses at once while one person draws, so no seat holds the turn.
  initialTurnSeat: () => null,

  validateMove(payload: unknown): Move | null {
    if (typeof payload !== "object" || payload === null) return null;
    const value = payload as Record<string, unknown>;

    switch (value["type"]) {
      case "guess": {
        const text = value["text"];
        if (typeof text !== "string") return null;
        const trimmed = text.trim().slice(0, MAX_GUESS_LENGTH);
        return trimmed.length > 0 ? { type: "guess", text: trimmed } : null;
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
    switch (move.type) {
      case "guess": {
        if (state.phase !== "drawing") return { ok: false, reason: "That round is over." };

        // The drawer knows the word. Letting them type is letting them say it.
        if (seat === state.drawerSeat) {
          return { ok: false, reason: "You are drawing — no guessing." };
        }
        if (state.solved[seat] !== undefined) {
          return { ok: false, reason: "You have already got it." };
        }
        if (now > state.deadline + DEADLINE_GRACE_MS) {
          return { ok: false, reason: "Time is up." };
        }

        const guess = normalise(move.text);
        const target = normalise(state.word);

        if (guess === target) {
          const remaining = Math.max(0, state.deadline - now);
          const fraction = state.roundMs > 0 ? remaining / state.roundMs : 0;

          const next: State = {
            ...state,
            solved: { ...state.solved, [seat]: now },
            scores: {
              ...state.scores,
              [seat]: (state.scores[seat] ?? 0) + guessPoints(fraction),
            },
            // The word itself is withheld. Everybody else is still guessing.
            chat: appendChat(state.chat, { seat, text: null, kind: "correct" }),
          };

          return {
            ok: true,
            state: everybodySolved(next, players) ? reveal(next, players) : next,
            turnSeat: null,
          };
        }

        // Near misses are told to the guesser and nobody else — announcing that
        // somebody is one letter away is most of a hint.
        const close = editDistance(guess, target) <= 1;

        return {
          ok: true,
          state: {
            ...state,
            chat: appendChat(state.chat, {
              seat,
              text: move.text,
              kind: close ? "close" : "guess",
            }),
          },
          turnSeat: null,
        };
      }

      case "reveal": {
        if (state.phase !== "drawing") return { ok: false, reason: "Already revealed." };

        const drawerGone = !players.some((player) => player.seat === state.drawerSeat);

        if (!everybodySolved(state, players) && now < state.deadline && !drawerGone) {
          return { ok: false, reason: "Still drawing." };
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

        const setup = state.rounds[round]!;

        return {
          ok: true,
          state: {
            ...state,
            round,
            phase: "drawing",
            deadline: now + ROUND_SECONDS * 1000,
            word: setup.word,
            drawerSeat: nextDrawer(state, players, round),
            solved: {},
            chat: [],
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
   * A masked word, the chat with correct guesses redacted, and who has got it.
   * The word itself appears only after the reveal.
   *
   * `now` is not available here — `publicView` takes only state — so the hint is
   * computed from the deadline against the state's own clock. Every client
   * receives the same mask because the mask is derived, not chosen.
   */
  publicView(state: State) {
    const revealed = state.phase === "revealed";
    // A view is rendered at broadcast time, which is close enough to "now" for a
    // hint that changes twice a round.
    const reveals = revealCountFor(state, Date.now());

    return {
      round: state.round,
      totalRounds: state.totalRounds,
      phase: state.phase,
      deadline: state.deadline,
      roundMs: state.roundMs,
      drawerSeat: state.drawerSeat,
      wordLength: state.word.length,
      hint: revealed ? state.word : maskWord(state.word, reveals),
      word: revealed ? state.word : null,
      solvedSeats: Object.keys(state.solved).map(Number).sort(),
      chat: state.chat,
      scores: state.scores,
      drawerPoints: revealed ? (state.lastResult?.drawerPoints ?? 0) : 0,
    };
  },

  /** The room's view, plus the word if this seat is the one drawing it. */
  viewFor(state: State, seat: number) {
    return {
      ...(this.publicView(state) as Record<string, unknown>),
      mySeat: seat,
      amDrawer: seat === state.drawerSeat,
      // The single line that makes this a game rather than a quiz everybody
      // passes.
      secretWord: seat === state.drawerSeat ? state.word : null,
      hasSolved: state.solved[seat] !== undefined,
    };
  },

  scores: (state: State) => state.scores,

  describe(state: State, { players }) {
    const drawer = players.find((player) => player.seat === state.drawerSeat);
    return drawer
      ? `Round ${state.round + 1}: ${drawer.displayName} draws`
      : `Round ${state.round + 1}`;
  },
};

registerEngine(drawGuess);

/* ========================================================================== */

/**
 * The words.
 *
 * Chosen to be drawable in a minute by somebody who cannot draw — a concrete
 * noun with a recognisable silhouette beats a clever one every time. A word
 * nobody can draw is a round nobody enjoys.
 */
export const WORDS: string[] = [
  "lighthouse",
  "umbrella",
  "octopus",
  "bicycle",
  "volcano",
  "sandwich",
  "telescope",
  "hedgehog",
  "windmill",
  "pineapple",
  "campfire",
  "submarine",
  "kettle",
  "parachute",
  "snowman",
  "guitar",
  "jellyfish",
  "castle",
  "rollercoaster",
  "toaster",
  "penguin",
  "cactus",
  "helicopter",
  "mushroom",
  "waterfall",
  "scarecrow",
  "lantern",
  "dinosaur",
  "hammock",
  "compass",
  "beehive",
  "typewriter",
  "igloo",
  "flamingo",
  "treehouse",
  "anchor",
  "wheelbarrow",
  "chandelier",
  "fireworks",
  "porcupine",
  "sunflower",
  "violin",
  "skateboard",
  "birdcage",
  "moustache",
  "tornado",
  "koala",
  "trampoline",
  "microscope",
  "seahorse",
  "windsock",
  "acorn",
  "bagpipes",
  "iceberg",
  "spaceship",
  "haystack",
  "crocodile",
  "pyramid",
  "yo-yo",
  "wristwatch",
  "ferris wheel",
  "hot air balloon",
  "ice cream",
  "traffic light",
  "shopping trolley",
  "message in a bottle",
  "rubber duck",
  "paper aeroplane",
];
