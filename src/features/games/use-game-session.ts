"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { refreshGameAction, resyncGameAction } from "@/features/games/actions";
import type { GameSession } from "@/features/games/queries";
import { channels } from "@/lib/supabase/realtime";
import { subscribeToTopic } from "@/lib/supabase/shared-channel";
import { subscribeToUserEvents } from "@/lib/supabase/user-channel";

/**
 * The live view of a game.
 *
 * ── The client does not own any of this ──────────────────────────────────────
 *
 * Everything below is a MIRROR. `session` comes from the server, `view` comes
 * off a socket, and neither is ever computed here. A browser cannot author game
 * state — it has no write path to `game_sessions.state`, and the rules that
 * would let it compute a next state are `server-only` and never shipped.
 *
 * The version number is what makes that safe rather than merely intended: every
 * broadcast carries one, out-of-order arrivals are dropped, and a move is
 * submitted against the version the server last confirmed. Two people acting at
 * once is resolved by the database, not by whoever's render happened last.
 *
 * ── Two channels, on purpose ─────────────────────────────────────────────────
 *
 *   game:{id}   the public view. Everybody who can see the room gets it, so
 *               nothing secret may travel here.
 *   user:{id}   this player's own view — their hand, their unrevealed answer.
 *               Only they can read it (migration 0009).
 *
 * A game with no secrets sends the same thing down both and nobody notices. A
 * game with secrets gets them kept without writing any transport code.
 */

export interface GameView {
  version: number;
  status: string;
  turnSeat: number | null;
  /** What everybody can see. */
  publicState: unknown;
  /** What only this player can see. Null until the first private broadcast. */
  privateState: unknown;
  scores: Record<number, number>;
  outcome: GameOutcomeView | null;
}

export interface GameOutcomeView {
  scores: Record<number, number>;
  placements: Record<number, number>;
  winnerSeats: number[];
}

interface StatePayload {
  sessionId?: string;
  version?: number;
  status?: string;
  turnSeat?: number | null;
  state?: unknown;
  scores?: Record<number, number>;
  outcome?: GameOutcomeView;
}

const EMPTY_VIEW: GameView = {
  version: 0,
  status: "lobby",
  turnSeat: null,
  publicState: null,
  privateState: null,
  scores: {},
  outcome: null,
};

/**
 * The first paint, computed server-side by the engine.
 *
 * Not read from the session row: SQL cannot redact per player, so the raw state
 * is not on the HTTP path at all (migration 0018). This is the same split the
 * socket sends, arriving early enough that a refresh mid-game shows the board
 * before any channel connects.
 */
export interface InitialViews {
  publicState: unknown;
  privateState: unknown;
  version: number;
  turnSeat: number | null;
  scores: Record<number, number>;
}

export function useGameSession(
  sessionId: string,
  userId: string,
  initial: GameSession,
  initialViews: InitialViews | null,
) {
  const [session, setSession] = useState<GameSession>(initial);
  const [view, setView] = useState<GameView>(() => ({
    ...EMPTY_VIEW,
    version: initialViews?.version ?? initial.stateVersion,
    status: initial.status,
    turnSeat: initialViews?.turnSeat ?? initial.turnSeat,
    publicState: initialViews?.publicState ?? null,
    privateState: initialViews?.privateState ?? null,
    scores: initialViews?.scores ?? {},
  }));
  const [connected, setConnected] = useState(false);

  // The last version applied, so a late broadcast cannot overwrite a newer one.
  // Broadcast delivery is not ordered end to end, and a stale board is worse
  // than a slightly delayed one.
  const appliedVersion = useRef(initialViews?.version ?? initial.stateVersion);

  const reload = useCallback(async () => {
    const fresh = await refreshGameAction(sessionId);
    if (fresh) setSession(fresh);
  }, [sessionId]);

  const applyPublic = useCallback((payload: StatePayload) => {
    const version = payload.version ?? 0;
    if (version < appliedVersion.current) return;
    appliedVersion.current = version;

    setView((current) => ({
      ...current,
      version,
      status: payload.status ?? current.status,
      turnSeat: payload.turnSeat ?? null,
      publicState: payload.state ?? current.publicState,
      scores: payload.scores ?? current.scores,
      outcome: payload.outcome ?? current.outcome,
    }));
  }, []);

  /* ------------------------------------------------------- the table's channel */

  useEffect(() => {
    const subscription = subscribeToTopic(
      channels.game(sessionId),
      {
        "game.started": (payload) => {
          applyPublic(payload as StatePayload);
          void reload();
        },
        "game.moved": (payload) => applyPublic(payload as StatePayload),
        "game.finished": (payload) => {
          applyPublic(payload as StatePayload);
          // Scores and placements land on `game_players`, which the socket payload
          // does not carry — the scoreboard reads them from the session.
          void reload();
        },
        "game.synced": (payload) => applyPublic(payload as StatePayload),
        // Somebody joined, readied, left, or the host changed. A nudge rather than
        // the data: everybody refetches through RLS, so a spectator cannot be sent
        // something a player can see.
        "game.lobby": () => void reload(),
      },
      // Shared, so a board needing the same topic for its own traffic — a canvas,
      // say — joins it once rather than opening a second Phoenix join.
      setConnected,
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [sessionId, applyPublic, reload]);

  /* -------------------------------------------------------- the private half */

  useEffect(() => {
    const handle = (payload: unknown) => {
      const message = payload as StatePayload;
      // Addressed by session, because the personal channel carries everything
      // else too — notifications, calls, and any other game this person is in.
      if (message.sessionId && message.sessionId !== sessionId) return;
      setView((current) => ({ ...current, privateState: message.state ?? message }));
    };

    return subscribeToUserEvents(userId, {
      "game.started": handle,
      "game.moved": handle,
      "game.finished": handle,
      "game.synced": handle,
    });
  }, [sessionId, userId]);

  /*
   * Ask for a private view on arrival.
   *
   * Public state is server-rendered, but a private one only ever travels over a
   * socket — so somebody who reloads mid-game, or joins late, has to ask. Runs
   * once the channel is up, so the answer is not broadcast into a void.
   */
  useEffect(() => {
    if (!connected || session.mySeat === null) return;
    if (session.status !== "active") return;

    void resyncGameAction(sessionId);
  }, [connected, sessionId, session.mySeat, session.status]);

  return { session, view, connected, reload };
}
