import "server-only";

import { cache } from "react";

import { BUCKETS, SIGNED_URL_TTL_SECONDS } from "@/lib/supabase/storage";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";
import type { Tables } from "@/types/supabase";

/**
 * Profile reads.
 *
 * Every query here goes through the cookie-bound client, so Row Level Security
 * filters it. There is no `where not blocked` in this file and there must not
 * be: the block rule lives in the `profiles_select` policy, and duplicating it
 * in application code creates a second copy that can disagree with the first.
 * A blocked profile simply does not come back.
 */

export type Profile = Tables<"profiles">;

/** A profile plus the derived bits the UI needs, with a usable avatar URL. */
export interface ProfileView extends Profile {
  avatarUrl: string | null;
  isOwn: boolean;
}

/**
 * Mints a short-lived URL for a private avatar object.
 *
 * The bucket is private, so there is no permanent URL to store — which is why
 * the column is `avatar_path`. Signing is a round trip, so it is done in a
 * batch where possible and `cache()`d per request.
 */
async function signAvatar(path: string | null): Promise<string | null> {
  if (!path) return null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(BUCKETS.avatars)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error) {
    // A missing object is not worth failing a page render over — the avatar
    // falls back to initials, which is a designed state rather than a broken one.
    console.warn("[kith:storage] could not sign avatar", { message: error.message });
    return null;
  }

  return data.signedUrl;
}

/**
 * The signed-in user's own profile.
 *
 * `cache()` deduplicates this across a single render: a layout, a page and three
 * components can each ask for it and the database is queried once.
 */
export const getOwnProfile = cache(async (): Promise<ProfileView | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data) return null;

  return { ...data, avatarUrl: await signAvatar(data.avatar_path), isOwn: true };
});

/**
 * Anyone's profile, by username.
 *
 * Matched case-insensitively so `/u/Ada` and `/u/ada` are the same person, which
 * is what the `lower(username)` unique index already guarantees. Returns null
 * for "no such person" AND for "blocked" — deliberately indistinguishable, since
 * a different response for the second would confirm the account exists.
 */
export const getProfileByUsername = cache(async (username: string): Promise<ProfileView | null> => {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser();

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .ilike("username", username)
    .maybeSingle();

  if (error || !data) return null;

  return {
    ...data,
    avatarUrl: await signAvatar(data.avatar_path),
    isOwn: data.id === user?.id,
  };
});

/**
 * Whether a username is free.
 *
 * Goes through the `is_username_available` function rather than querying
 * `profiles` directly, so an unauthenticated visitor on the signup form gets a
 * boolean instead of a row — and cannot use the check to enumerate members.
 */
export async function isUsernameAvailable(username: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("is_username_available", {
    p_username: username,
  });

  if (error) {
    console.error("[kith:profile] username check failed", { message: error.message });
    // Fail closed: reporting a name as free when the check broke means the
    // insert fails later with a worse message.
    return false;
  }

  return data === true;
}
