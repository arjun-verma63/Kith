"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resyncSession, startSession, submitMove } from "@/features/games/engine/runtime";
import { getGameSession, type GameSession } from "@/features/games/queries";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * Game mutations.
 *
 * Two shapes, and the difference is the whole architecture:
 *
 *   LOBBY ACTIONS — create, join, ready, leave, rematch — are thin wrappers over
 *   SECURITY DEFINER RPCs called with the user's own client. They are entirely
 *   game-agnostic: seating and readiness work the same for every game that will
 *   ever exist, so none of this needs an engine.
 *
 *   PLAY ACTIONS — start and move — go through the runtime, because they need
 *   the rules. The runtime is `server-only` and writes with the service role,
 *   which is what makes "the client cannot author game state" true rather than
 *   merely intended.
 *
 * No action here decides whether a move is legal, and none of them writes state.
 * The first is the engine's job and the second is the database's.
 */

const uuid = z.uuid();
const gameKey = z.string().regex(/^[a-z0-9-]{2,32}$/);

export type GameActionResult =
  { ok: true; sessionId?: string; session?: GameSession | null } | { ok: false; reason: string };

/** Turns a raised Postgres condition into something worth reading. */
function explain(message: string | undefined): string {
  const text = message ?? "";

  if (text.includes("game_full")) return "That game is full.";
  if (text.includes("game_in_progress")) return "That game has already started.";
  if (text.includes("game_unavailable")) return "That game is not available yet.";
  if (text.includes("players_not_ready")) return "Everybody has to be ready first.";
  if (text.includes("wrong_player_count")) return "There are not enough players for that game.";
  if (text.includes("not_in_lobby")) return "That game is not in its lobby any more.";
  if (text.includes("not_a_player")) return "You are not in that game.";
  if (text.includes("not_host")) return "Only the host can start the game.";
  if (text.includes("not_permitted")) return "You cannot do that.";
  return "Something went wrong.";
}

/* ------------------------------------------------------------------- lobby */

export async function createGameAction(
  conversationId: string,
  key: string,
  rematchOf?: string,
): Promise<GameActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const conversation = uuid.safeParse(conversationId);
  const parsedKey = gameKey.safeParse(key);
  if (!conversation.success || !parsedKey.success) {
    return { ok: false, reason: "That game could not be started." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_game_session", {
    p_conversation_id: conversation.data,
    p_game_key: parsedKey.data,
    p_config: {},
    p_rematch_of: rematchOf && uuid.safeParse(rematchOf).success ? rematchOf : null,
  });

  if (error || !data) return { ok: false, reason: explain(error?.message) };

  revalidatePath("/games");
  return { ok: true, sessionId: data };
}

export async function joinGameAction(sessionId: string): Promise<GameActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(sessionId);
  if (!parsed.success) return { ok: false, reason: "That game could not be found." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("join_game_session", { p_session_id: parsed.data });

  if (error) return { ok: false, reason: explain(error.message) };

  return { ok: true, sessionId: parsed.data, session: await getGameSession(parsed.data) };
}

export async function setReadyAction(sessionId: string, ready: boolean): Promise<GameActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(sessionId);
  if (!parsed.success) return { ok: false, reason: "That game could not be found." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_game_ready", {
    p_session_id: parsed.data,
    p_ready: ready,
  });

  if (error) return { ok: false, reason: explain(error.message) };

  return { ok: true, session: await getGameSession(parsed.data) };
}

export async function leaveGameAction(sessionId: string): Promise<GameActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(sessionId);
  if (!parsed.success) return { ok: false, reason: "That game could not be found." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("leave_game_session", { p_session_id: parsed.data });

  if (error) return { ok: false, reason: explain(error.message) };

  revalidatePath("/games");
  return { ok: true };
}

/**
 * Play it again.
 *
 * A new session rather than a reset of the old one. The finished game keeps its
 * scores and its move log — a rematch is the next game, not the same game with
 * its memory wiped — and `rematch_of` is what threads them together.
 */
export async function rematchAction(sessionId: string): Promise<GameActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(sessionId);
  if (!parsed.success) return { ok: false, reason: "That game could not be found." };

  const previous = await getGameSession(parsed.data);
  if (!previous?.conversationId) return { ok: false, reason: "That game cannot be replayed." };
  if (previous.mySeat === null) return { ok: false, reason: "You were not in that game." };

  return createGameAction(previous.conversationId, previous.gameKey, previous.id);
}

/* -------------------------------------------------------------------- play */

/**
 * Starts the game.
 *
 * The engine builds the opening position, which is why this cannot be an RPC the
 * browser calls directly. `start_game_session` re-checks that the caller is the
 * host, that everybody is ready, and that the player count fits — none of which
 * is taken on this action's word.
 */
export async function startGameAction(sessionId: string): Promise<GameActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(sessionId);
  if (!parsed.success) return { ok: false, reason: "That game could not be found." };

  // Read through the caller's own client first: a person who cannot see the
  // session must not reach the runtime, which reads with the service role.
  const visible = await getGameSession(parsed.data);
  if (!visible) return { ok: false, reason: "That game could not be found." };

  const result = await startSession(parsed.data, user.id);

  if (!result.ok) {
    if (result.reason === "no_engine") {
      return { ok: false, reason: "That game has no rules yet — nothing to play." };
    }
    return { ok: false, reason: explain(result.message) };
  }

  return { ok: true, session: await getGameSession(parsed.data) };
}

/**
 * Submits a move.
 *
 * `payload` is `unknown` all the way to the engine's `validateMove`, which is
 * the boundary where arbitrary JSON from a browser becomes a move. Nothing
 * before that point assumes a shape.
 */
export async function submitMoveAction(
  sessionId: string,
  payload: unknown,
): Promise<GameActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(sessionId);
  if (!parsed.success) return { ok: false, reason: "That game could not be found." };

  const visible = await getGameSession(parsed.data);
  if (!visible) return { ok: false, reason: "That game could not be found." };

  const result = await submitMove(parsed.data, user.id, payload);

  if (!result.ok) {
    switch (result.reason) {
      case "no_engine":
        return { ok: false, reason: "That game has no rules yet." };
      case "not_your_turn":
        return { ok: false, reason: "It is not your turn." };
      case "illegal_move":
        return { ok: false, reason: result.message ?? "That move is not allowed." };
      case "stale_state":
        // Two people moved at once. Normal, not exceptional — the client resyncs
        // and the person tries again against what is now true.
        return { ok: false, reason: "The game moved on. Try again." };
      default:
        return { ok: false, reason: explain(result.message) };
    }
  }

  return { ok: true };
}

/**
 * Asks the server to re-send the current state.
 *
 * Public state can be fetched over HTTP, but a private view only ever travels
 * over a socket — so somebody who reconnects, or arrives late, needs a way to
 * ask for theirs again.
 */
export async function resyncGameAction(sessionId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;

  const parsed = uuid.safeParse(sessionId);
  if (!parsed.success) return;

  // Same rule as everywhere else: check visibility with the caller's identity
  // before touching anything that runs with the service role.
  const visible = await getGameSession(parsed.data);
  if (!visible) return;

  await resyncSession(parsed.data);
}

export async function refreshGameAction(sessionId: string): Promise<GameSession | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const parsed = uuid.safeParse(sessionId);
  if (!parsed.success) return null;

  return getGameSession(parsed.data);
}
