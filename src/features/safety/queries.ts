import "server-only";

import type { ReportReason } from "@/features/safety/reasons";
import { BUCKETS, SIGNED_URL_TTL_SECONDS } from "@/lib/supabase/storage";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Reads for the safety surfaces.
 *
 * Both lists are about the caller and only the caller, and both are scoped in
 * SQL rather than here — `list_blocked` filters on `auth.uid()`, and
 * `reports_select_own` is what limits the report list.
 */

export interface BlockedAccount {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** The private note, if one was left. Nobody but the blocker ever sees it. */
  reason: string | null;
  blockedAt: string;
}

/**
 * Who you have blocked.
 *
 * Through `list_blocked()` rather than a join, and the reason is a nice piece of
 * circularity: `profiles_select` hides a blocked profile in both directions, so
 * once you block somebody you can no longer read their name. A plain query would
 * return a column of uuids. The function is SECURITY DEFINER for exactly that,
 * and safe because it returns only rows the caller created.
 */
export async function listBlocked(): Promise<BlockedAccount[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc("list_blocked");

  if (error || !data) {
    if (error) console.error("[kith:safety] list_blocked failed", { message: error.message });
    return [];
  }

  const paths = [...new Set(data.flatMap((row) => (row.avatar_path ? [row.avatar_path] : [])))];
  const signed = new Map<string, string>();

  if (paths.length > 0) {
    const { data: urls } = await supabase.storage
      .from(BUCKETS.avatars)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);

    for (const entry of urls ?? []) {
      if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
    }
  }

  return data.flatMap((row) =>
    row.id
      ? [
          {
            id: row.id,
            username: row.username ?? "",
            displayName: row.display_name ?? "",
            avatarUrl: row.avatar_path ? (signed.get(row.avatar_path) ?? null) : null,
            reason: row.reason,
            blockedAt: row.blocked_at ?? new Date().toISOString(),
          },
        ]
      : [],
  );
}

export interface FiledReport {
  id: string;
  reason: ReportReason;
  detail: string | null;
  status: "open" | "reviewing" | "actioned" | "dismissed";
  createdAt: string;
}

/**
 * Reports you have filed.
 *
 * Deliberately without the subject's name. `reported_id` is on the row and the
 * reporter obviously knows who they reported, but resolving it here would mean
 * joining `profiles` — which, for the common case where the report came with a
 * block, returns nothing anyway. Showing the reason and the date is enough to
 * answer "did that go through", which is the only question this list has.
 */
export async function listMyReports(limit = 10): Promise<FiledReport[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("reports")
    .select("id, reason, detail, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/** Whether the caller has already blocked this person. Drives the profile menu. */
export async function hasBlocked(userId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();

  const { data } = await supabase
    .from("blocks")
    .select("blocked_id")
    .eq("blocked_id", userId)
    .maybeSingle();

  return data !== null;
}
