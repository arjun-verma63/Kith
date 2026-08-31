import "server-only";

import { HISTORY_PAGE_SIZE } from "@/features/calls/constants";
import { BUCKETS, SIGNED_URL_TTL_SECONDS } from "@/lib/supabase/storage";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/**
 * Call reads.
 *
 * Both of these go through RPCs whose bodies filter on `auth.uid()`, so there is
 * no `where user_id = me` anywhere in this file and there must not be. The
 * database decides whose calls these are.
 */

type Fn = Database["public"]["Functions"];

export type ActiveCallRow = Fn["get_active_call"]["Returns"][number];
export type CallRow = Fn["list_calls"]["Returns"][number];

async function signAvatar(path: string | null): Promise<string | null> {
  if (!path) return null;

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.storage
    .from(BUCKETS.avatars)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  return data?.signedUrl ?? null;
}

async function signAvatars(paths: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))];
  if (unique.length === 0) return new Map();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(BUCKETS.avatars)
    .createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);

  const signed = new Map<string, string>();
  if (error || !data) return signed;

  for (const entry of data) {
    if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
  }
  return signed;
}

export interface CallPeer {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ActiveCall {
  id: string;
  conversationId: string;
  status: "ringing" | "active";
  kind: "audio" | "video";
  isInitiator: boolean;
  startedAt: string;
  answeredAt: string | null;
  joinedAt: string | null;
  peer: CallPeer | null;
  participantCount: number;
}

/**
 * The call this person is on, if any.
 *
 * Read on every app page load, which is what makes a mid-call refresh survivable
 * — the browser comes back, finds the call still live, and rejoins it rather
 * than silently abandoning the other person.
 */
export async function getActiveCall(): Promise<ActiveCall | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_active_call");

  if (error || !data || data.length === 0) return null;

  const row = data[0];
  // `RETURNS TABLE` columns are nullable in the generated types — Postgres has no
  // way to say otherwise — so the two that genuinely cannot be null are checked
  // rather than asserted. A row without an id is not a call.
  if (!row?.id || !row.conversation_id) return null;

  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status === "active" ? "active" : "ringing",
    kind: row.kind ?? "audio",
    isInitiator: row.is_initiator ?? false,
    startedAt: row.started_at ?? new Date().toISOString(),
    answeredAt: row.answered_at,
    joinedAt: row.joined_at,
    participantCount: row.participant_count ?? 2,
    peer: row.other_user_id
      ? {
          id: row.other_user_id,
          username: row.other_username ?? "",
          displayName: row.other_display_name ?? "",
          avatarUrl: await signAvatar(row.other_avatar_path),
        }
      : null,
  };
}

export interface CallHistoryEntry {
  id: string;
  conversationId: string;
  kind: "audio" | "video";
  status: "ringing" | "active" | "ended" | "missed" | "declined";
  endReason: string | null;
  isInitiator: boolean;
  startedAt: string;
  durationSeconds: number | null;
  peer: CallPeer | null;
  participantCount: number;
}

export async function listCallHistory(before?: string): Promise<CallHistoryEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_calls", {
    p_limit: HISTORY_PAGE_SIZE,
    p_before: before ?? null,
  });

  if (error || !data) return [];

  const signed = await signAvatars(data.map((row) => row.other_avatar_path));

  return data.flatMap((row) => {
    if (!row.id || !row.conversation_id || !row.started_at) return [];

    return [
      {
        id: row.id,
        conversationId: row.conversation_id,
        kind: row.kind ?? "audio",
        status: row.status ?? "ended",
        endReason: row.end_reason,
        isInitiator: row.is_initiator ?? false,
        startedAt: row.started_at,
        durationSeconds: row.duration_seconds,
        participantCount: row.participant_count ?? 2,
        peer: row.other_user_id
          ? {
              id: row.other_user_id,
              username: row.other_username ?? "",
              displayName: row.other_display_name ?? "",
              avatarUrl: row.other_avatar_path ? (signed.get(row.other_avatar_path) ?? null) : null,
            }
          : null,
      },
    ];
  });
}
