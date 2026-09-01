import "server-only";

import { headers } from "next/headers";

import {
  deriveMfaState,
  type AssuranceLevel,
  type MfaFactor,
  type MfaState,
} from "@/features/auth/mfa";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";

/**
 * Reading two-factor state, and writing what happened to it.
 *
 * `server-only`, because both halves would be a mistake in a browser: the audit
 * write goes through the service role, and the read is about the caller's own
 * session, which a client component has no business asking about directly.
 */

/* ------------------------------------------------------------------ status */

/**
 * Everything the settings page and the sign-in path need to know.
 *
 * Two calls, one round trip's worth of work: `listFactors` and
 * `getAuthenticatorAssuranceLevel` both resolve against the same cached user
 * record, and the second decodes the `aal` claim locally.
 *
 * `listFactors().all` is used rather than `.totp` on purpose — the typed buckets
 * hold only verified factors, and an abandoned enrolment still occupies a slot.
 * `deriveMfaState` is what separates the two, in one place, testably.
 */
export async function getMfaStatus(): Promise<MfaState | null> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const [{ data: factors }, { data: assurance }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);

  const mapped: MfaFactor[] = (factors?.all ?? [])
    .filter((factor) => factor.factor_type === "totp")
    .map((factor) => ({
      id: factor.id,
      friendlyName: factor.friendly_name ?? null,
      status: factor.status === "verified" ? "verified" : "unverified",
      createdAt: factor.created_at,
    }));

  return deriveMfaState({
    factors: mapped,
    currentLevel: (assurance?.currentLevel as AssuranceLevel | null) ?? null,
  });
}

/* ------------------------------------------------------------------- audit */

/**
 * The events this app writes. A closed set, so the log stays greppable and the
 * settings page can be sure it has a label for everything it will be handed.
 *
 * Failures are recorded as well as successes, and that is most of the point: a
 * rejected code or a wrong password is the signal that somebody else has half of
 * what they need.
 */
export type SecurityEvent =
  | "mfa.enroll_started"
  | "mfa.enroll_cancelled"
  | "mfa.enabled"
  | "mfa.factor_removed"
  | "mfa.disabled"
  | "mfa.challenge_failed"
  | "mfa.challenge_passed"
  | "password.changed"
  | "password.change_failed"
  | "email.change_requested"
  | "email.change_failed"
  | "sessions.revoked_others"
  | "account.deleted"
  | "account.delete_failed";

export interface SecurityEventRow {
  id: string;
  event: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/**
 * Records something that changed, or tried to change, the account's security.
 *
 * Through the **service role**, because `security_events` is append-only and
 * closed to `authenticated` by policy — deliberately. A log the account holder
 * can write to is a log an attacker with that account can write to, and the
 * value of this table is that its contents were put there by the server.
 *
 * Never throws. An audit write failing must not take down the action it is
 * describing: refusing to disable somebody's two-factor because the log was
 * unavailable is worse than a gap in the log.
 *
 * The IP and user agent come from the request headers, which are proxy-supplied
 * and therefore a hint rather than evidence. They are here because "signed in
 * from somewhere I do not recognise" is the thing this log exists to answer, and
 * an approximate answer beats none.
 */
export async function recordSecurityEvent(
  userId: string,
  event: SecurityEvent,
  metadata: Record<string, Json> = {},
): Promise<void> {
  try {
    const headerList = await headers();
    const forwarded = headerList.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim() || headerList.get("x-real-ip") || null;

    const admin = getSupabaseAdminClient();

    await admin.from("security_events").insert({
      user_id: userId,
      event,
      // `inet` rejects a malformed value and would fail the whole insert, so an
      // unparseable header becomes null rather than an exception.
      ip: ip && /^[0-9a-fA-F.:]+$/.test(ip) ? ip : null,
      user_agent: headerList.get("user-agent")?.slice(0, 500) ?? null,
      metadata,
    });
  } catch (error) {
    console.error("[kith:auth] security event not recorded", {
      event,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * The account's own security history, newest first.
 *
 * Read with the caller's client, so the `security_events_select_own` policy is
 * what limits it to their rows rather than a `where` clause we could forget.
 *
 * Unfiltered by prefix: the table is closed to the API for writes and only this
 * application appends to it, so everything in it is something the account holder
 * should see. Filtering to `mfa.%` was right when that was all there was.
 */
export async function listSecurityEvents(limit = 10): Promise<SecurityEventRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("security_events")
    .select("id, event, created_at, metadata")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    event: row.event,
    createdAt: row.created_at,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }));
}
