"use client";

import { WouldYouRatherBoard } from "@/features/games/components/boards/would-you-rather-board";

/**
 * What each game draws.
 *
 * The client-side counterpart to the engine registry: engines hold rules and
 * never reach a browser, boards hold pixels and only ever run in one. Two maps
 * rather than one is what stops importing a board from dragging that game's
 * rules — and the hidden state they operate on — into the bundle.
 *
 * ── Why a switch and not a lookup table ──────────────────────────────────────
 *
 * A `Record<string, ComponentType>` read during render is indistinguishable, to
 * React and to the linter, from a component defined during render — the sort
 * that silently resets its state on every parent update. The values here happen
 * to be stable module references, but "happens to be" is not something to rely
 * on for a board holding a half-typed answer.
 *
 * A switch returning static JSX cannot have that problem. Adding a game is one
 * more case, which is the same amount of friction as one more map entry.
 */

export interface BoardProps {
  /** The engine's `publicView`. Never carries anybody else's secrets. */
  publicState: unknown;
  /** The engine's `viewFor(mySeat)`. Null when watching rather than playing. */
  privateState: unknown;
  mySeat: number | null;
  players: { seat: number; displayName: string; avatarUrl: string | null; userId: string }[];
  /** Submits a move. Resolves to a reason, or null when it landed. */
  submit: (move: unknown) => Promise<string | null>;
  /** True while a move is in flight, so a board can refuse a double press. */
  busy: boolean;
}

/** Games with a board. The rest render the "not built yet" panel. */
const WITH_BOARDS = new Set(["would-you-rather"]);

export function hasBoard(gameKey: string): boolean {
  return WITH_BOARDS.has(gameKey);
}

export function GameBoard({ gameKey, ...props }: BoardProps & { gameKey: string }) {
  switch (gameKey) {
    case "would-you-rather":
      return <WouldYouRatherBoard {...props} />;
    default:
      return null;
  }
}
