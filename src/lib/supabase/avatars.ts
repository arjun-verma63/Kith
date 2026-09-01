import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { BUCKETS, SIGNED_URL_TTL_SECONDS } from "@/lib/supabase/storage";

/**
 * Signing avatar URLs, once per request.
 *
 * ── The problem this replaces ────────────────────────────────────────────────
 *
 * Seven feature modules had their own private copy of this function. Each one
 * batched correctly — `createSignedUrls` takes a set, so no copy was an N+1 on
 * its own — but they had no idea the others existed, so one render of
 * `/messages/<id>` made a separate round trip to Supabase Storage for each of
 * them:
 *
 *   the layout      listFriends, listNotifications, getOwnProfile,
 *                   getActiveCall, getMyCouple
 *   the page        listMessages, listConversationMembers
 *
 * Five to seven sequential calls to sign a few dozen paths, most of them the
 * same paths — the six people in the room appear in the friends list, in the
 * notification feed and as the senders of the messages.
 *
 * ── What this does instead ───────────────────────────────────────────────────
 *
 * One path→URL map per request. A caller asks for a batch, this signs only the
 * paths nobody has asked for yet, and everything already known comes back for
 * free. The friends list pays for the six people; the message thread that
 * follows it pays for nothing.
 *
 * `cache()` with no arguments is what makes the map request-scoped: React
 * returns the same value for the life of one request and a fresh one for the
 * next. It is not a cross-request cache and must not become one by accident.
 *
 * ── Why not cache across requests ────────────────────────────────────────────
 *
 * It would help. A signed URL changes every second the clock ticks, so the same
 * avatar is a new URL on every page load and the browser downloads it again —
 * holding URLs for half their lifetime would make image caching work.
 *
 * Not done, because it means handing one person a token minted for another.
 * Everybody who receives an avatar path is already entitled to the file, so the
 * argument is winnable — but it is an argument, and it belongs in a change made
 * on purpose with a measurement behind it rather than folded into a cleanup.
 * The round trips are the measurable problem; this fixes those.
 */

/** The request-scoped store. Same object for one request, fresh for the next. */
const urlsForThisRequest = cache((): Map<string, string> => new Map());

/**
 * Signs what is not already signed, and returns URLs for everything asked for.
 *
 * Null and duplicate paths are filtered out, so callers can hand this a raw
 * column straight off a row set without tidying it first.
 */
export async function signAvatars(
  paths: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const store = urlsForThisRequest();

  const wanted = [...new Set(paths.filter((path): path is string => Boolean(path)))];
  const missing = wanted.filter((path) => !store.has(path));

  if (missing.length > 0) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.storage
      .from(BUCKETS.avatars)
      .createSignedUrls(missing, SIGNED_URL_TTL_SECONDS);

    if (error) {
      // A failed signature is a missing picture, not a failed page — the avatar
      // falls back to initials, which is a designed state rather than a broken
      // one. Logged rather than thrown for that reason.
      console.warn("[kith:storage] could not sign avatars", { message: error.message });
    }

    for (const entry of data ?? []) {
      // Storage reports per-object failures inside a successful batch: a path
      // that no longer exists comes back with a null URL rather than throwing.
      if (entry.path && entry.signedUrl) store.set(entry.path, entry.signedUrl);
    }
  }

  const result = new Map<string, string>();
  for (const path of wanted) {
    const url = store.get(path);
    if (url) result.set(path, url);
  }
  return result;
}

/** One path. The same store, so it costs nothing if a batch already covered it. */
export async function signAvatar(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const signed = await signAvatars([path]);
  return signed.get(path) ?? null;
}
