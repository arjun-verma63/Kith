import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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
 */
export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}
