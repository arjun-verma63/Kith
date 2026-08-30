import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabasePublicEnv, isSupabaseConfigured } from "@/lib/env/client";
import type { Database } from "@/types/database";
import type { User } from "@supabase/supabase-js";

/**
 * Session refresh.
 *
 * Supabase access tokens are short-lived. Something has to exchange the refresh
 * token for a new one and write the rotated cookies back to the browser, and in
 * the App Router that something has to be middleware: Server Components are not
 * allowed to set cookies, so they can read a session but can never renew one.
 * Without this file, everybody gets silently signed out roughly every hour.
 *
 * Two details here are easy to get wrong and expensive to debug:
 *
 * 1. **The response object must be carried through.** Cookies are written onto
 *    `response`; constructing a fresh `NextResponse` afterwards discards them and
 *    the refreshed session never reaches the browser. Callers must return the
 *    response this function hands back (or copy its cookies onto a redirect).
 *
 * 2. **`getUser()`, never `getSession()`.** `getSession()` decodes the cookie and
 *    believes it. `getUser()` revalidates the token against the Auth server. In
 *    middleware the cookie is attacker-controlled input, so the difference is the
 *    difference between a check and a formality. Calling it is also what triggers
 *    the refresh.
 */
export async function updateSession(request: NextRequest): Promise<{
  response: NextResponse;
  user: User | null;
}> {
  let response = NextResponse.next({ request });

  // The landing page has no database in it. Until a Supabase project is wired
  // up, middleware should pass traffic through rather than 500 the whole site.
  if (!isSupabaseConfigured()) {
    return { response, user: null };
  }

  const env = getSupabasePublicEnv();

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write to the request so anything downstream in this same pass sees
          // the new tokens, then rebuild the response around it and write them
          // to the browser as well.
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          response = NextResponse.next({ request });

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // A network failure here must not take the whole site down. If Supabase is
  // unreachable, treat the request as signed out: a signed-in user gets bounced
  // to /login during an outage, which is annoying but recoverable, whereas an
  // unhandled rejection in middleware turns every route — including the landing
  // page — into a 500. Row Level Security is still what protects the data, so
  // failing closed here costs nothing but a redirect.
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    return { response, user };
  } catch (error) {
    console.error("[kith:auth] session refresh failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return { response, user: null };
  }
}
