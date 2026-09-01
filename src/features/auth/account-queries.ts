import "server-only";

import { coarsenIp, describeDevice, type SessionSummary } from "@/features/auth/account";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Reads for the Security page.
 *
 * Everything here is scoped to the caller **in SQL** — by `auth.uid()` inside a
 * SECURITY DEFINER function, or by an RLS policy — never by a `where` clause in
 * this file that a refactor could drop.
 */

/* ---------------------------------------------------------------- sessions */

export interface SessionList {
  sessions: SessionSummary[];
  /**
   * False when the list could not be produced at all.
   *
   * Distinguished from "no sessions" on purpose: an empty list would mean you
   * are not signed in anywhere, which is never true while you are reading the
   * page. The UI says so rather than showing a confident blank.
   */
  supported: boolean;
}

/**
 * Where you are signed in.
 *
 * Supabase's client library has no method for this — `signOut` takes a scope and
 * that is the whole supported surface — so `list_my_sessions` reads GoTrue's own
 * `auth.sessions`. That is the one place KITH touches a table it does not own,
 * and the function is written to return nothing rather than raise if a Supabase
 * upgrade changes it. See migration 0025.
 *
 * The current session is identified by the `session_id` claim on the access
 * token, read through `getClaims()` — which verifies the JWT rather than
 * decoding it, so "this is you" is not decided by an unverified cookie.
 */
export async function listSessions(): Promise<SessionList> {
  const supabase = await createSupabaseServerClient();

  const [{ data, error }, { data: claims }] = await Promise.all([
    supabase.rpc("list_my_sessions"),
    supabase.auth.getClaims(),
  ]);

  if (error) {
    console.error("[kith:auth] list_my_sessions failed", { message: error.message });
    return { sessions: [], supported: false };
  }

  if (!data) return { sessions: [], supported: false };

  const currentId = claims?.claims?.session_id ?? null;

  const sessions: SessionSummary[] = data.map((row, index) => ({
    key: `s${index}`,
    device: describeDevice(row.user_agent),
    location: coarsenIp(row.ip),
    startedAt: row.created_at ?? new Date().toISOString(),
    lastSeenAt: row.refreshed_at ?? row.created_at ?? new Date().toISOString(),
    isCurrent: currentId !== null && row.id === currentId,
    strong: row.aal === "aal2",
  }));

  return { sessions, supported: true };
}
