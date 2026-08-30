import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

/**
 * Runs on every navigation that is not a static asset.
 *
 * Its one job today is keeping the Supabase session alive: Server Components
 * cannot write cookies, so token rotation has to happen here or not at all.
 *
 * Route protection lands in Phase 3, alongside authentication. It goes directly
 * below, and it needs three things that do not exist yet — a `/sign-in` route to
 * send people to, an email-verification state to check, and an AAL2 step-up for
 * the sensitive settings routes. Writing the redirect now would mean redirecting
 * to a 404, so the guard waits for the routes it guards.
 *
 * The rule when it is added: **return the response `updateSession` produced**,
 * or copy its cookies onto whatever redirect replaces it. A fresh `NextResponse`
 * drops the rotated tokens and signs everyone out an hour later, intermittently,
 * in a way that looks like a Supabase bug.
 */
export async function middleware(request: NextRequest) {
  const { response } = await updateSession(request);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   - Next.js internals and the image optimiser
     *   - the health endpoint, which is a keepalive ping and needs no session
     *   - static asset extensions
     */
    "/((?!_next/static|_next/image|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf)$).*)",
  ],
};
