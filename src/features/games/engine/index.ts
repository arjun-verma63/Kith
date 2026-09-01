/**
 * Where games are plugged in.
 *
 * Importing this module registers every engine KITH knows about. It is imported
 * once, by the server-side move resolver, so a game's rules are loaded exactly
 * where they are allowed to run and nowhere else.
 *
 * Adding a game:
 *
 *   1. Write `src/features/games/engine/games/<key>.ts` implementing GameEngine.
 *   2. Import it below.
 *   3. Enable its row in the `games` catalogue (a migration).
 *
 * Nothing else changes. The lobby, seating, readiness, turn enforcement,
 * scoring, the winner screen and rematch already work for it.
 */

import "@/features/games/engine/games/draw-guess";
import "@/features/games/engine/games/guess-my-answer";
import "@/features/games/engine/games/how-well";
import "@/features/games/engine/games/who-knows-me";
import "@/features/games/engine/games/would-you-rather";

export { getEngine, registerEngine, registeredKeys } from "@/features/games/engine/registry";
export type * from "@/features/games/engine/types";
