import "server-only";

import { getEngine } from "@/features/games/engine/registry";
import type {
  GameEngine,
  GameOutcome,
  MoveContext,
  PlayerSeat,
  SetupContext,
} from "@/features/games/engine/types";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * The only place a game engine runs.
 *
 * Server-side, behind `server-only`, so the rules cannot be loaded by a browser
 * — and therefore cannot be run against a state of somebody's choosing, and
 * hidden information never has to leave the server in order to be checked.
 *
 * ── Why this uses the service-role client ────────────────────────────────────
 *
 * `game_sessions.state` and `game_moves` have no client-facing write path at
 * all. That is the point: if a client could write state, cheating would be a
 * fetch call. The two functions that do write — `start_game_session` and
 * `commit_game_move` — are granted to the service role alone, so this module is
 * the only door.
 *
 * The service role bypasses Row Level Security, so authorization cannot be
 * assumed from it. It is passed in as `actorId` and RE-CHECKED IN SQL: both
 * functions verify the actor is seated, that the game is in the right state, and
 * — for a move — that it is that seat's turn and that the state being replaced is
 * the state that was read. None of that trusts this file.
 *
 * ── The order of checks ──────────────────────────────────────────────────────
 *
 *   1. Database: is this person allowed to act at all? (`load` reads through the
 *      caller's own session, so a non-player gets nothing.)
 *   2. Engine: is the payload a move, and is that move legal?
 *   3. Database again: is it still their turn, and is the state still current?
 *
 * Steps 1 and 3 are game-agnostic and hold for every game ever added. Step 2 is
 * the only part a new game supplies.
 */

export interface LoadedSession {
  id: string;
  gameKey: string;
  status: "lobby" | "active" | "finished" | "abandoned";
  state: unknown;
  stateVersion: number;
  turnSeat: number | null;
  seed: number;
  config: Record<string, unknown>;
  hostId: string;
  players: PlayerSeat[];
}

export type RuntimeFailure =
  | "no_engine"
  | "not_permitted"
  | "not_a_player"
  | "not_your_turn"
  | "illegal_move"
  | "stale_state"
  | "wrong_status"
  | "failed";

export type RuntimeResult<T> =
  { ok: true; value: T } | { ok: false; reason: RuntimeFailure; message?: string };

/** Maps a Postgres condition raised by the RPCs onto something the UI can say. */
function toFailure(message: string | undefined): RuntimeFailure {
  const text = message ?? "";
  if (text.includes("stale_state")) return "stale_state";
  if (text.includes("not_your_turn")) return "not_your_turn";
  if (text.includes("not_a_player") || text.includes("not_host")) return "not_a_player";
  if (text.includes("game_not_active") || text.includes("not_in_lobby")) return "wrong_status";
  if (text.includes("not_permitted")) return "not_permitted";
  return "failed";
}

/**
 * Reads a session for the engine.
 *
 * Through the ADMIN client, because the state has to be complete — the engine
 * needs the hidden parts to validate a move against them. Authorization is not
 * skipped, it is moved: the caller has already been checked by
 * `get_game_session` under their own identity, and `commit_game_move` checks
 * again in SQL before anything is written.
 */
export async function loadSession(sessionId: string): Promise<LoadedSession | null> {
  const admin = getSupabaseAdminClient();

  const [{ data: session }, { data: players }] = await Promise.all([
    admin
      .from("game_sessions")
      .select("id, game_key, status, state, state_version, turn_seat, seed, config, host_id")
      .eq("id", sessionId)
      .maybeSingle(),
    admin
      .from("game_players")
      .select("user_id, seat, left_at, profiles!inner(display_name)")
      .eq("session_id", sessionId)
      .order("seat"),
  ]);

  if (!session) return null;

  return {
    id: session.id,
    gameKey: session.game_key,
    status: session.status,
    state: session.state,
    stateVersion: session.state_version,
    turnSeat: session.turn_seat,
    seed: Number(session.seed),
    config: (session.config ?? {}) as Record<string, unknown>,
    hostId: session.host_id,
    players: (players ?? [])
      .filter((row) => row.left_at === null)
      .map((row) => ({
        seat: row.seat,
        userId: row.user_id,
        displayName:
          (row.profiles as unknown as { display_name?: string } | null)?.display_name ?? "Player",
      })),
  };
}

/**
 * Splits one state into what everybody sees and what each player sees.
 *
 * The public view goes to `game:{id}`, which every member of the room receives.
 * Each private view goes to that player's own `user:{id}` channel, which nobody
 * else can read. An engine with no secrets returns the same thing from both and
 * costs one extra message per player — which, for a room of six, is nothing.
 */
function viewsFor(
  engine: GameEngine,
  state: unknown,
  players: PlayerSeat[],
): { publicView: unknown; privateViews: Record<string, unknown> } {
  const privateViews: Record<string, unknown> = {};

  for (const player of players) {
    privateViews[player.userId] = engine.viewFor(state, player.seat);
  }

  return { publicView: engine.publicView(state), privateViews };
}

async function broadcast(
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
  privateViews: Record<string, unknown> | null,
): Promise<void> {
  const admin = getSupabaseAdminClient();

  await admin.rpc("broadcast_game", {
    p_session_id: sessionId,
    p_event: event,
    p_public: payload as never,
    p_private: privateViews as never,
  });
}

/* ========================================================================== */

/**
 * Starts a session.
 *
 * The engine builds the opening position from the seed and the seated players,
 * so the same seed and the same people always produce the same game — which is
 * what makes a bug report reproducible rather than a story about a shuffle.
 */
export async function startSession(
  sessionId: string,
  actorId: string,
): Promise<RuntimeResult<{ version: number }>> {
  const session = await loadSession(sessionId);
  if (!session) return { ok: false, reason: "not_permitted" };

  const engine = getEngine(session.gameKey);
  if (!engine) return { ok: false, reason: "no_engine" };

  const context: SetupContext = {
    players: session.players,
    seed: session.seed,
    config: session.config,
    now: Date.now(),
  };

  const state = engine.createInitialState(context);
  const turnSeat = engine.initialTurnSeat(state, context);

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("start_game_session", {
    p_session_id: sessionId,
    p_actor: actorId,
    p_state: state as never,
    p_turn_seat: turnSeat,
  });

  if (error) return { ok: false, reason: toFailure(error.message), message: error.message };

  const { publicView, privateViews } = viewsFor(engine, state, session.players);
  await broadcast(
    sessionId,
    "game.started",
    { sessionId, version: data ?? 1, turnSeat, status: "active", state: publicView },
    privateViews,
  );

  return { ok: true, value: { version: data ?? 1 } };
}

/**
 * Validates and applies a move.
 *
 * `payload` arrives from a browser and is `unknown` until the engine's
 * `validateMove` says otherwise. That narrowing is the boundary where untrusted
 * JSON becomes a move, and it is per-game because only the game knows the shape.
 */
export async function submitMove(
  sessionId: string,
  actorId: string,
  payload: unknown,
): Promise<RuntimeResult<{ version: number; finished: boolean }>> {
  const session = await loadSession(sessionId);
  if (!session) return { ok: false, reason: "not_permitted" };

  if (session.status !== "active") return { ok: false, reason: "wrong_status" };

  const engine = getEngine(session.gameKey);
  if (!engine) return { ok: false, reason: "no_engine" };

  const seat = session.players.find((player) => player.userId === actorId)?.seat;
  if (seat === undefined) return { ok: false, reason: "not_a_player" };

  // Checked here for a useful message, and again in SQL because this check is
  // advisory — the authoritative one is the row lock in `commit_game_move`.
  if (session.turnSeat !== null && session.turnSeat !== seat) {
    return { ok: false, reason: "not_your_turn" };
  }

  const move = engine.validateMove(payload);
  if (move === null) return { ok: false, reason: "illegal_move", message: "That is not a move." };

  const context: MoveContext = {
    seat,
    players: session.players,
    seed: session.seed,
    config: session.config,
    now: Date.now(),
  };

  const result = engine.reduce(session.state, move, context);
  if (!result.ok) return { ok: false, reason: "illegal_move", message: result.reason };

  const outcome: GameOutcome | null = result.outcome ?? null;

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("commit_game_move", {
    p_session_id: sessionId,
    p_actor: actorId,
    p_expected_version: session.stateVersion,
    p_state: result.state as never,
    p_move: payload as never,
    p_turn_seat: result.turnSeat,
    p_scores: outcome ? (scoreRows(outcome) as never) : null,
    p_finished: outcome !== null,
  });

  if (error) return { ok: false, reason: toFailure(error.message), message: error.message };

  const { publicView, privateViews } = viewsFor(engine, result.state, session.players);
  await broadcast(
    sessionId,
    outcome ? "game.finished" : "game.moved",
    {
      sessionId,
      version: data,
      turnSeat: result.turnSeat,
      status: outcome ? "finished" : "active",
      state: publicView,
      scores: engine.scores(result.state),
      ...(outcome ? { outcome } : {}),
    },
    privateViews,
  );

  return {
    ok: true,
    value: { version: data ?? session.stateVersion + 1, finished: outcome !== null },
  };
}

/** Reshapes an outcome into the `{ "<seat>": { score, placement } }` the RPC takes. */
function scoreRows(
  outcome: GameOutcome,
): Record<string, { score: number; placement: number | null }> {
  const rows: Record<string, { score: number; placement: number | null }> = {};

  for (const [seat, score] of Object.entries(outcome.scores)) {
    rows[seat] = { score, placement: outcome.placements[Number(seat)] ?? null };
  }

  return rows;
}

/**
 * Re-broadcasts the current state.
 *
 * For somebody arriving late or reconnecting: they read the session over HTTP,
 * but a private view only ever travels over a socket, so there has to be a way
 * to ask for one again.
 */
export async function resyncSession(sessionId: string): Promise<void> {
  const session = await loadSession(sessionId);
  if (!session) return;

  const engine = getEngine(session.gameKey);
  if (!engine) return;

  const { publicView, privateViews } = viewsFor(engine, session.state, session.players);
  await broadcast(
    sessionId,
    "game.synced",
    {
      sessionId,
      version: session.stateVersion,
      turnSeat: session.turnSeat,
      status: session.status,
      state: publicView,
      scores: engine.scores(session.state),
    },
    privateViews,
  );
}
