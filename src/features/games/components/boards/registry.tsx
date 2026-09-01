"use client";

import { DrawGuessBoard } from "@/features/games/components/boards/draw-guess-board";
import { HowWellBoard, HowWellResult } from "@/features/games/components/boards/how-well-board";
import { WhoKnowsMeBoard } from "@/features/games/components/boards/who-knows-me-board";
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
  /**
   * The session, for a board that needs the `game:{id}` topic for its own
   * traffic. Draw & Guess broadcasts strokes on it; the others do not need it.
   */
  sessionId: string;
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
const WITH_BOARDS = new Set(["would-you-rather", "who-knows-me", "draw-guess", "how-well"]);

export function hasBoard(gameKey: string): boolean {
  return WITH_BOARDS.has(gameKey);
}

export function GameBoard({ gameKey, ...props }: BoardProps & { gameKey: string }) {
  switch (gameKey) {
    case "would-you-rather":
      return <WouldYouRatherBoard {...props} />;
    case "who-knows-me":
      return <WhoKnowsMeBoard {...props} />;
    case "draw-guess":
      return <DrawGuessBoard {...props} />;
    case "how-well":
      return <HowWellBoard {...props} />;
    default:
      return null;
  }
}

/**
 * A game that ends its own way.
 *
 * The generic winner panel names whoever came first, which is right for the
 * three competitive games and wrong for a co-operative one — How Well Do You
 * Know Me? would announce that both people won, which is technically true and
 * completely the wrong tone.
 *
 * A game with its own result renders it instead. Everything else keeps the
 * shared panel.
 */
const WITH_RESULTS = new Set(["how-well"]);

export function hasOwnResult(gameKey: string): boolean {
  return WITH_RESULTS.has(gameKey);
}

export function GameResult({ gameKey, publicState }: { gameKey: string; publicState: unknown }) {
  const state = publicState as { score?: number; played?: number; totalRounds?: number } | null;

  switch (gameKey) {
    case "how-well":
      return (
        <HowWellResult score={state?.score ?? 0} total={state?.played ?? state?.totalRounds ?? 0} />
      );
    default:
      return null;
  }
}
