import type { GameEngine } from "@/features/games/engine/types";

/**
 * The engines that exist.
 *
 * A registry rather than a switch statement, so adding a game is adding a file
 * and one `registerEngine` call — no edit to the lobby, the session screen, the
 * move route, or anything else that already works.
 *
 * ── Nothing is registered yet ────────────────────────────────────────────────
 *
 * That is deliberate, and the app is honest about it. The `games` catalogue in
 * the database ships with five rows and `enabled = false` on every one, so the
 * shelf is visible and nothing on it can be started. A game becomes playable
 * when both are true: an engine is registered here, and its catalogue row is
 * enabled.
 *
 * Requiring both is worth the small redundancy. The flag is a kill switch that
 * takes a broken game off the shelf without a deploy; the registry is what makes
 * the rules exist at all. Either alone would let a game be half-available.
 */

const engines = new Map<string, GameEngine>();

export function registerEngine<TState, TMove>(engine: GameEngine<TState, TMove>): void {
  if (engines.has(engine.key)) {
    throw new Error(`Two engines claim the game key "${engine.key}".`);
  }
  engines.set(engine.key, engine as GameEngine);
}

/** The engine for a game, or null when that game has no rules yet. */
export function getEngine(key: string): GameEngine | null {
  return engines.get(key) ?? null;
}

export function registeredKeys(): string[] {
  return [...engines.keys()].sort();
}

/** Test seam. Never called by the application. */
export function clearEngines(): void {
  engines.clear();
}
