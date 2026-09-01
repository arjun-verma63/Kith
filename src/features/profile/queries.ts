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
 * Through `get_profile` rather than a table select, because one field on a
 * profile now has its own audience: `show_birthday` decides whether the birthday
 * comes back, and `profiles_select` is a ROW policy with no way to hide one
 * column of a row from one viewer. Redacting it here instead would put the rule
 * in the one place this file says rules must not live.
 *
 * The function applies the same block rule the policy did, plus the birthday
 * scope and the deleted-account rule. Returns null for "no such person", for
 * "blocked", and for "deleted" — deliberately indistinguishable, since a
 * different response for any of them would confirm the account exists.
 */
export const getProfileByUsername = cache(async (username: string): Promise<ProfileView | null> => {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser();

  const { data, error } = await supabase.rpc("get_profile", { p_username: username });

  const row = data?.[0];
  if (error || !row?.id) return null;

  /*
   * Built field by field rather than spread.
   *
   * `get_profile` returns a subset of `profiles`, and every column of a
   * `returns table` is nullable as far as the generated types are concerned. A
   * spread would need a cast to paper over that, and a cast here is how a
   * redacted birthday quietly becomes a non-null type that the UI then trusts.
   */
  return {
    id: row.id,
    username: row.username ?? "",
    display_name: row.display_name ?? "",
    avatar_path: row.avatar_path,
    bio: row.bio,
    pronouns: row.pronouns,
    accent: row.accent ?? "ember",
    status: row.status ?? "auto",
    status_text: row.status_text,
    status_expires_at: row.status_expires_at,
    birthday: row.birthday,
    last_seen_at: row.last_seen_at ?? new Date(0).toISOString(),
    created_at: row.created_at ?? new Date(0).toISOString(),
    // Never read from another person's profile, and not returned by the
    // function. Mirrored from created_at so the shape still satisfies the row
    // type the rest of the app passes around.
    updated_at: row.created_at ?? new Date(0).toISOString(),
    deleted_at: row.deleted_at,
    // Nobody else's business — it exists to rate-limit your own renames.
    username_changed_at: null,
    avatarUrl: await signAvatar(row.avatar_path),
    isOwn: row.id === user?.id,
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
