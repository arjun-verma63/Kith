import type { GameOutcome, PlayerSeat } from "@/features/games/engine/types";

/**
 * The bits every game needs.
 *
 * Extracted when the second game wanted the same shuffle and the same placement
 * arithmetic as the first. Two copies of "who came second" is two places for a
 * tie to be handled differently, which is the sort of thing nobody notices until
 * a scoreboard says something impossible.
 *
 * Everything here is pure, for the same reason engines are: a session has to
 * replay identically from its move log.
 */

/**
 * A seeded pseudo-random generator.
 *
 * `Math.random` is banned in an engine. The same seed and the same moves must
 * produce the same game, or a bug report about a question is a story about a
 * shuffle. mulberry32 is small, fast and deterministic, which is the whole
 * specification.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, seeded. Every ordering equally likely, nothing repeated. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const deck = [...items];

  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = deck[i];
    const b = deck[j];
    if (a !== undefined && b !== undefined) {
      deck[i] = b;
      deck[j] = a;
    }
  }

  return deck;
}

/**
 * Final scores into places and winners.
 *
 * Ties share a place — two people on the same score are both second, and the
 * next person is fourth. And a game where everybody finished level is a DRAW,
 * not a six-way victory; declaring six winners is a way of declaring none.
 */
export function outcomeFrom(scores: Record<number, number>, players: PlayerSeat[]): GameOutcome {
  const final = Object.fromEntries(
    players.map((player) => [player.seat, scores[player.seat] ?? 0]),
  );

  const ordered = [...players].sort((x, y) => (final[y.seat] ?? 0) - (final[x.seat] ?? 0));

  const placements: Record<number, number> = {};
  let place = 0;
  let previous: number | null = null;

  ordered.forEach((player, index) => {
    const score = final[player.seat] ?? 0;
    if (score !== previous) {
      place = index + 1;
      previous = score;
    }
    placements[player.seat] = place;
  });

  const best = ordered.length > 0 ? (final[ordered[0]!.seat] ?? 0) : 0;
  const winners = ordered.filter((p) => (final[p.seat] ?? 0) === best).map((p) => p.seat);

  return {
    scores: final,
    placements,
    winnerSeats: winners.length === players.length && players.length > 1 ? [] : winners,
  };
}

/**
 * How much slack to allow past a deadline.
 *
 * A client's clock and the server's are not the same clock, and a round trip
 * takes time. Somebody who pressed a button with a second to spare should not be
 * told they were late because their laptop runs fast.
 */
export const DEADLINE_GRACE_MS = 2500;
