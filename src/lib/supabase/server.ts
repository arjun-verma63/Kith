import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

import { getSupabasePublicEnv } from "@/lib/env/client";
import type { KithSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

/**
 * The cookie-bound server client.
 *
 * Uses the **anon key**, not the service role, so it authenticates as whoever
 * owns the session cookie and every query it makes is still filtered by Row
 * Level Security. This is the client that should be reached for in Server
 * Components, Server Actions and Route Handlers — effectively always.
 *
 * A new instance per request is correct and required. The client closes over
 * this request's cookie store; caching one across requests would hand one user's
 * session to another, which is the worst bug available in this file.
 */
export async function createSupabaseServerClient(): Promise<KithSupabaseClient> {
  const env = getSupabasePublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot write cookies. This is expected and
            // harmless: the middleware refreshes the session on every request,
            // so the rotated tokens are already on their way to the browser.
            // Swallowing it here is the documented Supabase SSR pattern — but it
            // only stays safe because `src/middleware.ts` exists. If the
            // middleware is ever removed, sessions will silently stop refreshing.
          }
        },
      },
    },
  );
}

/**
 * The signed-in user, or `null`.
 *
 * Always `getUser()`, never `getSession()`. `getSession()` reads the cookie and
 * trusts it; `getUser()` revalidates the JWT with the Auth server. On the server
 * the difference matters, because a cookie is attacker-supplied data.
 *
 * Authorization still does not rest on this. It is for rendering decisions —
 * the database decides who can read what.
 *
 * ── Cached for the request, and why that matters ─────────────────────────────
 *
 * `getUser()` is a NETWORK CALL. It is the whole reason this function exists
 * rather than `getSession()` — the token goes to the Auth server to be checked —
 * and every call gets a freshly constructed client, so nothing was deduplicating
 * them.
 *
 * A single render asks two or three times: the shell through `getOwnProfile`,
 * the page directly, sometimes a query underneath it. Those were two or three
 * sequential round trips to Supabase Auth to answer the same question, on every
 * navigation.
 *
 * `cache()` scopes one answer to one request, which is exactly the lifetime the
 * answer is valid for. It does not cache across requests and must never be made
 * to: a stale session is the one thing this function exists to prevent.
 */
export const getCurrentUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
});
