import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getSupabasePublicEnv } from "@/lib/env/client";
import { getSupabaseSecretEnv } from "@/lib/env/server";
import type { KithSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  SERVICE ROLE. THIS CLIENT BYPASSES ROW LEVEL SECURITY ENTIRELY.         │
 * │                                                                          │
 * │  It can read and write every row in the database, for every user, with   │
 * │  no policy applied. There is no safety net behind it.                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The `server-only` import above is a build-time guard, not a convention: if any
 * client component pulls this in through any chain of imports, the build fails
 * rather than shipping the key to a browser.
 *
 * **Before using this, check whether the operation belongs in an RLS policy
 * instead.** It almost always does. The legitimate cases are narrow, and each
 * one gets a comment at the call site saying why the user-scoped client cannot
 * do the job:
 *
 *   - redeeming an invite code, where the caller has no account yet
 *   - resolving an authoritative game move, where the server owns hidden state
 *   - a scheduled job with no user session at all (expiring stale calls)
 *   - reading another user's row during moderation, deliberately and audited
 *
 * "It was easier than writing the policy" is not on that list. Every use of this
 * client is a place where a bug in our code becomes a data breach instead of an
 * empty result set.
 */

let adminClient: KithSupabaseClient | undefined;

export function getSupabaseAdminClient(): KithSupabaseClient {
  if (adminClient) return adminClient;

  const { NEXT_PUBLIC_SUPABASE_URL } = getSupabasePublicEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = getSupabaseSecretEnv();

  adminClient = createClient<Database>(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // There is no user here and there must never appear to be one. Persisting
      // or refreshing a session on a service-role client is how it accidentally
      // starts being treated as "the current user".
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return adminClient;
}
