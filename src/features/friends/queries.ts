import "server-only";

import { cache } from "react";

import { BUCKETS, SIGNED_URL_TTL_SECONDS } from "@/lib/supabase/storage";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/**
 * Friend reads.
 *
 * Every list comes back from one database function rather than a query plus a
 * client-side merge. A friendship is stored once in canonical `(low, high)`
 * order, so "the other person" is a conditional join — expressible in SQL,
 * not in PostgREST.
 */

type Fn = Database["public"]["Functions"];

export type FriendRow = Fn["list_friends"]["Returns"][number];
export type RequestRow = Fn["list_friend_requests"]["Returns"][number];
export type SearchRow = Fn["search_profiles"]["Returns"][number];

/** A person, with the avatar already signed and presence already derived. */
export interface PersonCard {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  pronouns: string | null;
  status: string;
  statusText: string | null;
  lastSeenAt: string | null;
}

/**
 * Signs a batch of avatar paths in one round trip.
 *
 * Signing them one at a time is the classic N+1: a friends list of six is six
 * sequential network calls before the page can render. `createSignedUrls` takes
 * the whole set.
 */
async function signAvatars(paths: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))];
  if (unique.length === 0) return new Map();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(BUCKETS.avatars)
    .createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);

  if (error || !data) return new Map();

  const signed = new Map<string, string>();
  for (const entry of data) {
    // Storage reports per-object failures inside a successful batch — a path
    // that no longer exists comes back with a null URL rather than throwing.
    if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
  }

  return signed;
}

function toCard(
  row: {
    id: string | null;
    username: string | null;
    display_name: string | null;
    avatar_path: string | null;
    bio?: string | null;
    pronouns: string | null;
    status: string | null;
    status_text?: string | null;
    last_seen_at: string | null;
  },
  signed: Map<string, string>,
): PersonCard {
  return {
    id: row.id ?? "",
    username: row.username ?? "",
    displayName: row.display_name ?? "",
    avatarUrl: row.avatar_path ? (signed.get(row.avatar_path) ?? null) : null,
    bio: row.bio ?? null,
    pronouns: row.pronouns ?? null,
    status: row.status ?? "auto",
    statusText: row.status_text ?? null,
    lastSeenAt: row.last_seen_at,
  };
}

export interface Friend extends PersonCard {
  friendsSince: string | null;
}

export const listFriends = cache(async (): Promise<Friend[]> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_friends");

  if (error || !data) return [];

  const signed = await signAvatars(data.map((row) => row.avatar_path));
  return data.map((row) => ({ ...toCard(row, signed), friendsSince: row.friends_since }));
});

export interface FriendRequest extends PersonCard {
  requestId: string;
  createdAt: string | null;
  message: string | null;
}

async function listRequests(direction: "incoming" | "outgoing"): Promise<FriendRequest[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_friend_requests", {
    p_direction: direction,
  });

  if (error || !data) return [];

  const signed = await signAvatars(data.map((row) => row.avatar_path));
  return data.map((row) => ({
    ...toCard({ ...row, bio: null, status_text: null }, signed),
    requestId: row.request_id ?? "",
    createdAt: row.created_at,
    message: row.message,
  }));
}

export const listIncomingRequests = cache(() => listRequests("incoming"));
export const listOutgoingRequests = cache(() => listRequests("outgoing"));

export type Relationship = "friend" | "incoming" | "outgoing" | "none";

export interface SearchResult extends PersonCard {
  relationship: Relationship;
}

/**
 * Member search.
 *
 * A blank query returns an empty list without touching the database — the SQL
 * function refuses it too, but there is no reason to spend a round trip
 * confirming that. An empty search must never list everybody: on an
 * invitation-only app that turns the search box into a member directory.
 */
export async function searchProfiles(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_profiles", { p_query: trimmed });

  if (error || !data) return [];

  const signed = await signAvatars(data.map((row) => row.avatar_path));
  return data.map((row) => ({
    ...toCard(row, signed),
    relationship: (row.relationship ?? "none") as Relationship,
  }));
}
