import "server-only";

import { signAvatar, signAvatars } from "@/lib/supabase/avatars";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/**
 * Couple reads.
 *
 * Through the cookie-bound client throughout, and one of them for a reason that
 * matters: `list_couple_prompts` is a SECURITY INVOKER function, so the policy
 * that hides a partner's answer until you have written your own applies to the
 * caller. Reading it any other way — the admin client, a DEFINER function —
 * would return both answers and quietly turn the mechanic into a decoration.
 */

type Fn = Database["public"]["Functions"];

export type CoupleRow = Fn["get_my_couple"]["Returns"][number];
export type InvitationRow = Fn["list_couple_invitations"]["Returns"][number];
export type PromptRow = Fn["list_couple_prompts"]["Returns"][number];

export interface Couple {
  id: string;
  partner: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    status: string;
    lastSeenAt: string | null;
  };
  visibility: "private" | "friends";
  anniversary: string | null;
  startedAt: string;
  promptCount: number;
}

export async function getMyCouple(): Promise<Couple | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_couple");

  const row = data?.[0];
  if (error || !row?.id || !row.partner_id) return null;

  return {
    id: row.id,
    partner: {
      id: row.partner_id,
      username: row.partner_username ?? "",
      displayName: row.partner_display_name ?? "",
      avatarUrl: await signAvatar(row.partner_avatar_path),
      status: row.partner_status ?? "offline",
      lastSeenAt: row.partner_last_seen_at,
    },
    visibility: row.visibility ?? "private",
    anniversary: row.anniversary,
    startedAt: row.started_at ?? new Date().toISOString(),
    promptCount: row.prompt_count ?? 0,
  };
}

export interface CoupleInvitation {
  id: string;
  direction: "incoming" | "outgoing";
  other: { id: string; username: string; displayName: string; avatarUrl: string | null };
  createdAt: string;
}

export async function listInvitations(): Promise<CoupleInvitation[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_couple_invitations");

  if (error || !data) return [];

  const signed = await signAvatars(data.map((row) => row.other_avatar_path));

  return data.flatMap((row) =>
    row.id && row.other_id
      ? [
          {
            id: row.id,
            direction: row.direction === "outgoing" ? ("outgoing" as const) : ("incoming" as const),
            other: {
              id: row.other_id,
              username: row.other_username ?? "",
              displayName: row.other_display_name ?? "",
              avatarUrl: row.other_avatar_path ? (signed.get(row.other_avatar_path) ?? null) : null,
            },
            createdAt: row.created_at ?? new Date().toISOString(),
          },
        ]
      : [],
  );
}

export interface CouplePrompt {
  id: string;
  date: string;
  question: string;
  /** Your own answer. Always readable. */
  myAnswer: string | null;
  /**
   * Theirs — null until you have written yours.
   *
   * Not filtered here. The row does not come back from the database at all,
   * which is the difference between a mechanic and a decoration.
   */
  partnerAnswer: string | null;
  /** Whether they have written something. Knowing that is not knowing what. */
  partnerHasAnswered: boolean;
}

export async function listPrompts(coupleId: string, limit = 30): Promise<CouplePrompt[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_couple_prompts", {
    p_couple_id: coupleId,
    p_limit: limit,
  });

  if (error || !data) return [];

  return data.flatMap((row) =>
    row.id
      ? [
          {
            id: row.id,
            date: row.prompt_date ?? "",
            question: row.question ?? "",
            myAnswer: row.my_answer,
            partnerAnswer: row.partner_answer,
            partnerHasAnswered: row.partner_has_answered ?? false,
          },
        ]
      : [],
  );
}

/**
 * Whether a proposal is even possible.
 *
 * Read before drawing the control, because a button that the database then
 * refuses is worse than no button. Friendship is required and no setting can
 * widen that.
 */
export async function canProposeTo(userId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("can_propose_to", { other_user: userId });
  return !error && data === true;
}

export interface CoupleMarker {
  partnerId: string;
  partnerUsername: string;
  partnerDisplayName: string;
  anniversary: string | null;
}

/**
 * What somebody else may see on a profile.
 *
 * Null for almost everybody, because private is the default. Visible only when
 * the couple has chosen `friends` and the viewer is one.
 */
export async function coupleMarkerFor(userId: string): Promise<CoupleMarker | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("couple_marker", { target_user: userId });

  const row = data?.[0];
  if (error || !row?.partner_id) return null;

  return {
    partnerId: row.partner_id,
    partnerUsername: row.partner_username ?? "",
    partnerDisplayName: row.partner_display_name ?? "",
    anniversary: row.anniversary,
  };
}

/**
 * Whether this person is open to being asked.
 *
 * Read here rather than borrowed from the profile slice: a feature that reaches
 * into another one for a single column is how the boundary between them stops
 * meaning anything, and ESLint would refuse it anyway.
 *
 * `everyone` is normalised to `friends`, because a proposal from a stranger is
 * the behaviour this feature is defined against and the database treats the two
 * identically.
 */
export async function getWhoCanPropose(): Promise<"friends" | "nobody"> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("user_settings").select("who_can_propose").maybeSingle();

  return data?.who_can_propose === "nobody" ? "nobody" : "friends";
}

export interface CoupleGame {
  key: string;
  name: string;
  tagline: string | null;
}

/** The games a couple may play. Audience `couple`, and actually enabled. */
export async function listCoupleGames(): Promise<CoupleGame[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_games");

  if (error || !data) return [];

  return data.flatMap((row) =>
    row.key && row.enabled && row.audience === "couple"
      ? [{ key: row.key, name: row.name ?? row.key, tagline: row.tagline }]
      : [],
  );
}

export interface CoupleGameSession {
  id: string;
  gameKey: string;
  gameName: string;
  status: "lobby" | "active" | "finished" | "abandoned";
  ourScore: number;
  createdAt: string;
}

/** What the two of them have played. The history the brief asked for. */
export async function listCoupleGameHistory(coupleId: string): Promise<CoupleGameSession[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_couple_games", {
    p_couple_id: coupleId,
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
            status: row.status ?? "finished",
            ourScore: row.our_score ?? 0,
            createdAt: row.created_at ?? new Date().toISOString(),
          },
        ]
      : [],
  );
}
