import "server-only";

import { signAvatars } from "@/lib/supabase/avatars";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/**
 * Game reads.
 *
 * Through the cookie-bound client throughout, so Row Level Security decides what
 * comes back.
 *
 * Nothing here returns game state, and nothing here can. SQL cannot run an
 * engine, so it cannot redact anything — a game with hidden information would
 * have none if the raw blob came back on this path. `viewsForRender` in the
 * runtime computes the same public/private split the socket sends; migration
 * 0018 removed the column from the RPC and from the client's table grant so
 * there is no way around it.
 */

type Fn = Database["public"]["Functions"];

export type GameRow = Fn["list_games"]["Returns"][number];
export type SessionRow = Fn["get_game_session"]["Returns"][number];
export type PlayerRow = Fn["list_game_players"]["Returns"][number];
export type SessionSummaryRow = Fn["list_game_sessions"]["Returns"][number];

export interface CatalogueGame {
  key: string;
  name: string;
  tagline: string | null;
  audience: "group" | "couple";
  pace: "turn_based" | "realtime";
  minPlayers: number;
  maxPlayers: number;
  /**
   * Whether it can actually be played.
   *
   * Two things have to be true — a registered engine and this flag — and the
   * catalogue only knows about the flag. A game shows on the shelf either way;
   * one that is off shows as coming rather than being hidden, because an empty
   * shelf tells nobody anything.
   */
  enabled: boolean;
}

export async function listGames(): Promise<CatalogueGame[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_games");

  if (error || !data) return [];

  return data.flatMap((row) =>
    row.key
      ? [
          {
            key: row.key,
            name: row.name ?? row.key,
            tagline: row.tagline,
            audience: row.audience ?? "group",
            pace: row.pace ?? "turn_based",
            minPlayers: row.min_players ?? 2,
            maxPlayers: row.max_players ?? 6,
            enabled: row.enabled ?? false,
          },
        ]
      : [],
  );
}

export interface GamePlayer {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  seat: number;
  isReady: boolean;
  score: number;
  placement: number | null;
  isHost: boolean;
  hasLeft: boolean;
}

export interface GameSession {
  id: string;
  gameKey: string;
  gameName: string;
  minPlayers: number;
  maxPlayers: number;
  pace: "turn_based" | "realtime";
  audience: "group" | "couple";
  conversationId: string | null;
  /** A couple session has this instead of a conversation. Exactly one is set. */
  coupleId: string | null;
  hostId: string;
  status: "lobby" | "active" | "finished" | "abandoned";
  stateVersion: number;
  turnSeat: number | null;
  config: Record<string, unknown>;
  rematchOf: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Null when watching rather than playing. */
  mySeat: number | null;
  canStart: boolean;
  players: GamePlayer[];
}

export async function getGameSession(sessionId: string): Promise<GameSession | null> {
  const supabase = await createSupabaseServerClient();

  const [{ data: sessions }, { data: players }] = await Promise.all([
    supabase.rpc("get_game_session", { p_session_id: sessionId }),
    supabase.rpc("list_game_players", { p_session_id: sessionId }),
  ]);

  const row = sessions?.[0];
  if (!row?.id) return null;

  const signed = await signAvatars((players ?? []).map((p) => p.avatar_path));

  return {
    id: row.id,
    gameKey: row.game_key ?? "",
    gameName: row.game_name ?? "",
    minPlayers: row.min_players ?? 2,
    maxPlayers: row.max_players ?? 6,
    pace: row.pace ?? "turn_based",
    audience: row.audience ?? "group",
    conversationId: row.conversation_id,
    coupleId: row.couple_id,
    hostId: row.host_id ?? "",
    status: row.status ?? "lobby",
    stateVersion: row.state_version ?? 0,
    turnSeat: row.turn_seat,
    config: (row.config ?? {}) as Record<string, unknown>,
    rematchOf: row.rematch_of,
    createdAt: row.created_at ?? new Date().toISOString(),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    mySeat: row.my_seat,
    canStart: row.can_start ?? false,
    players: (players ?? []).flatMap((p) =>
      p.user_id
        ? [
            {
              userId: p.user_id,
              username: p.username ?? "",
              displayName: p.display_name ?? "",
              avatarUrl: p.avatar_path ? (signed.get(p.avatar_path) ?? null) : null,
              seat: p.seat ?? 0,
              isReady: p.is_ready ?? false,
              score: p.score ?? 0,
              placement: p.placement,
              isHost: p.is_host ?? false,
              hasLeft: p.left_at !== null,
            },
          ]
        : [],
    ),
  };
}

export interface SessionSummary {
  id: string;
  gameKey: string;
  gameName: string;
  status: "lobby" | "active" | "finished" | "abandoned";
  playerCount: number;
  maxPlayers: number;
  amIIn: boolean;
  createdAt: string;
}

export async function listSessionsIn(conversationId: string): Promise<SessionSummary[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_game_sessions", {
    p_conversation_id: conversationId,
    p_limit: 20,
  });

  if (error || !data) return [];

  return data.flatMap((row) =>
    row.id
      ? [
          {
            id: row.id,
            gameKey: row.game_key ?? "",
            gameName: row.game_name ?? "",
            status: row.status ?? "lobby",
            playerCount: row.player_count ?? 0,
            maxPlayers: row.max_players ?? 6,
            amIIn: row.am_i_in ?? false,
            createdAt: row.created_at ?? new Date().toISOString(),
          },
        ]
      : [],
  );
}

export interface MySession {
  id: string;
  gameKey: string;
  gameName: string;
  status: "lobby" | "active" | "finished" | "abandoned";
  conversationId: string | null;
  conversationTitle: string | null;
  playerCount: number;
  maxPlayers: number;
  mySeat: number;
  myScore: number;
  myPlacement: number | null;
  createdAt: string;
  endedAt: string | null;
}

/**
 * Every game this person is in, across every conversation.
 *
 * The hub is a place you go, not something you find inside one thread, so this
 * is deliberately not scoped to a room. Live sessions come first.
 */
export async function listMySessions(): Promise<MySession[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_game_sessions", { p_limit: 20 });

  if (error || !data) return [];

  return data.flatMap((row) =>
    row.id
      ? [
          {
            id: row.id,
            gameKey: row.game_key ?? "",
            gameName: row.game_name ?? "",
            status: row.status ?? "lobby",
            conversationId: row.conversation_id,
            conversationTitle: row.conversation_title,
            playerCount: row.player_count ?? 0,
            maxPlayers: row.max_players ?? 6,
            mySeat: row.my_seat ?? 0,
            myScore: row.my_score ?? 0,
            myPlacement: row.my_placement,
            createdAt: row.created_at ?? new Date().toISOString(),
            endedAt: row.ended_at,
          },
        ]
      : [],
  );
}
