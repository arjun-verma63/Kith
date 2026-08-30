import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { safeRedirect } from "@/features/auth/redirects";
import type { EmailOtpType } from "@/lib/supabase/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Where every email link lands: confirmation, password recovery, email change.
 *
 * Supabase sends a `token_hash` and a `type`, and this route exchanges them for
 * a session. It has to be a route handler rather than a page because setting the
 * session means writing cookies, which a Server Component cannot do.
 *
 * Three things here are deliberate:
 *
 *   The token is consumed server-side and never reaches the browser. A
 *   client-side exchange puts a single-use credential in the URL bar, in
 *   `history`, and in the `Referer` header of the next request the page makes.
 *
 *   The redirect target goes through `safeRedirect`. `next` arrives from a link
 *   in an email — the least trustworthy input in the system — and an open
 *   redirect here would let somebody send a genuine KITH confirmation link that
 *   deposits the recipient on a page they control.
 *
 *   `redirect()` is called outside the try/catch. Next.js implements it by
 *   throwing, so catching indiscriminately around it swallows the navigation and
 *   leaves the user staring at a blank response.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = safeRedirect(searchParams.get("next"));

  // Supabase reports failures by redirecting back with these, e.g. an expired link.
  const errorCode = searchParams.get("error_code") ?? searchParams.get("error");
  if (errorCode) {
    redirect(type === "recovery" ? "/forgot-password?expired=1" : "/login?error=link_expired");
  }

  const supabase = await createSupabaseServerClient();
  let verified = false;

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    verified = !error;
    if (error) {
      console.error("[kith:auth] verifyOtp failed", { type, status: error.status });
    }
  } else if (code) {
    // PKCE exchange. Not used by email/password today, but the parameter is what
    // arrives if magic links or a provider are ever turned on.
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    verified = !error;
    if (error) {
      console.error("[kith:auth] exchangeCodeForSession failed", { status: error.status });
    }
  }

  if (!verified) {
    redirect(type === "recovery" ? "/forgot-password?expired=1" : "/login?error=link_expired");
  }

  // A recovery link signs the user in specifically so they can set a new
  // password. Sending them anywhere else would leave a live session behind a
  // link that was meant for one purpose.
  if (type === "recovery") {
    redirect("/reset-password");
  }

  redirect(next ?? "/?welcome=1");
}
