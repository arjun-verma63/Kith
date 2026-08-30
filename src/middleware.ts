import { NextResponse, type NextRequest } from "next/server";

import { decideRedirect } from "@/features/auth/redirects";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Runs on every navigation that is not a static asset.
 *
 * Two jobs, in this order:
 *
 *   1. Refresh the Supabase session. Server Components cannot write cookies, so
 *      token rotation happens here or not at all. Without it everybody is signed
 *      out roughly hourly, intermittently, in a way that looks like a Supabase bug.
 *
 *   2. Apply the routing rules. The rules themselves live in
 *      `features/auth/redirects.ts` as a pure function, so they are testable
 *      without a database and there is exactly one copy of them.
 *
 * The critical detail, and the reason the redirect is built the way it is below:
 * **the cookies written by `updateSession` must survive.** Returning a fresh
 * `NextResponse.redirect(...)` throws away the rotated tokens, and the next
 * request arrives with a stale session. So the cookies are copied across
 * explicitly.
 *
 * This is a convenience layer, not the security boundary. Middleware decides
 * where to *send* somebody; Row Level Security decides what they can *read*. A
 * bug here is a bad redirect, not a data leak.
 */
export async function middleware(request: NextRequest) {
  const { response, user } = await updateSession(request);

  const decision = decideRedirect({
    pathname: request.nextUrl.pathname,
    userId: user?.id ?? null,
    emailVerified: Boolean(user?.email_confirmed_at),
  });

  if (!decision) return response;

  const url = request.nextUrl.clone();
  const [pathname, query] = decision.to.split("?");
  url.pathname = pathname ?? "/";
  url.search = query ? `?${query}` : "";

  const redirectResponse = NextResponse.redirect(url);

  // Carry the refreshed session across. Miss this and signing in appears to work
  // and then immediately does not.
  for (const cookie of response.cookies.getAll()) {
    redirectResponse.cookies.set(cookie);
  }

  return redirectResponse;
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   - Next.js internals and the image optimiser
     *   - /auth/* , which performs its own session work and must not be
     *     redirected before it can consume a one-time token
     *   - the health endpoint, which is a keepalive ping and needs no session
     *   - static asset extensions
     */
    "/((?!_next/static|_next/image|auth/|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf)$).*)",
  ],
};
