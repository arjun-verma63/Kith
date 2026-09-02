import type { Route } from "next";

/**
 * Where a request should go, given who is making it.
 *
 * Deliberately a pure function with no Supabase, no Next.js and no I/O, for two
 * reasons. It is the single place the rules live, so middleware and pages cannot
 * disagree about them — and it is the piece of authentication that can be
 * exhaustively tested without a running database, which is exactly the piece
 * most likely to be wrong.
 */

/** Routes that require a session. Prefix match. */
export const PROTECTED_PREFIXES = [
  "/home",
  "/u",
  "/friends",
  "/messages",
  "/calls",
  "/games",
  "/couple",
  "/settings",
] as const;

/** Routes that only make sense when signed out. */
export const AUTH_ROUTES = ["/login", "/signup", "/forgot-password"] as const;

/** Reachable with no session and no redirect, whatever the auth state. */
export const ALWAYS_OPEN = ["/", "/auth/confirm", "/api/health", "/verify-email"] as const;

/** Where a session that has not yet proved its second factor is held. */
export const MFA_CHALLENGE_ROUTE = "/verify-2fa";

/** Where a signed-in, verified user lands when they have nowhere better to be. */
export const DEFAULT_SIGNED_IN_ROUTE = "/";

export interface RedirectContext {
  pathname: string;
  /** Null when there is no session. */
  userId: string | null;
  /** Supabase sets this only once the address has been confirmed. */
  emailVerified: boolean;
  /**
   * True only while a password-recovery session is active. `/reset-password`
   * needs a session — the recovery link creates one — but that session must not
   * be treated as a normal sign-in.
   */
  isRecovery?: boolean;
  /**
   * The account has a verified second factor and this session has not proved it.
   *
   * A password login produces a real, usable session at `aal1` before any code
   * is entered, so this is not "nearly signed in" — it is signed in, at half
   * strength. Routing keeps such a session at the challenge; Row Level Security
   * is what actually stops it reading anything (migration 0024).
   */
  mfaChallengeRequired?: boolean;
}

export interface RedirectDecision {
  to: string;
  reason:
    | "unauthenticated"
    | "email_unverified"
    | "already_authenticated"
    | "no_recovery_session"
    | "mfa_required";
}

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Returns where to send this request, or null to let it through.
 *
 * Order matters and is not arbitrary:
 *
 *   1. A signed-out user on a protected route goes to /login, carrying where
 *      they were trying to go so they land there afterwards.
 *   2. A session owing a second factor is held at /verify-2fa. This sits above
 *      almost everything, because such a session has proved half of what the
 *      account asks for.
 *   3. An unverified user is held at /verify-email. This check sits *above* the
 *      "already signed in" rule, so confirming your address cannot be skipped by
 *      navigating to /login.
 *   4. A signed-in user on /login or /signup is sent home — but only once
 *      verified, or rule 3 would bounce them straight back.
 *   5. /reset-password requires a recovery session, so the page cannot be opened
 *      cold by someone who simply knows the URL — and, if the account has a
 *      second factor, a proved one.
 *
 * None of this is the security boundary. A redirect decides where a browser
 * goes; it has no opinion about what an access token can fetch from PostgREST
 * directly. Migration 0024 is the part that cannot be walked around.
 */
export function decideRedirect(context: RedirectContext): RedirectDecision | null {
  const {
    pathname,
    userId,
    emailVerified,
    isRecovery = false,
    mfaChallengeRequired = false,
  } = context;
  const signedIn = userId !== null;

  if (pathname === "/reset-password") {
    // A recovery link signs you in; without that session there is nothing to reset.
    if (!signedIn) return { to: "/forgot-password", reason: "no_recovery_session" };

    /*
     * And a recovery session is still only aal1.
     *
     * Without this, two-factor is bypassable by anybody who can read the inbox:
     * request a reset, follow the link, set a new password, sign in. The factor
     * is never asked for, and the second factor turns out to protect nothing
     * that email access did not already unlock.
     */
    if (mfaChallengeRequired) {
      return { to: MFA_CHALLENGE_ROUTE, reason: "mfa_required" };
    }
    return null;
  }

  if (pathname === MFA_CHALLENGE_ROUTE) {
    if (!signedIn) return { to: "/login", reason: "unauthenticated" };
    // Nothing owed: the page has nothing to ask and would be a dead end.
    return mfaChallengeRequired
      ? null
      : { to: DEFAULT_SIGNED_IN_ROUTE, reason: "already_authenticated" };
  }

  if (!signedIn) {
    if (matchesPrefix(pathname, PROTECTED_PREFIXES)) {
      return { to: `/login?next=${encodeURIComponent(pathname)}`, reason: "unauthenticated" };
    }
    if (pathname === "/verify-email") {
      return { to: "/login", reason: "unauthenticated" };
    }
    return null;
  }

  // Signed in from here down.

  /*
   * Half-authenticated.
   *
   * Above the email check because "prove who you are" outranks "finish setting
   * up", and above the auth-route rule so the challenge cannot be skipped by
   * navigating to /login and back.
   *
   * `/` is deliberately not held: it is the public landing page, reads nothing,
   * and is where DEFAULT_SIGNED_IN_ROUTE points. The sign-in action sends a
   * half-authenticated session straight to the challenge instead, so nobody
   * reaches the landing page with a code outstanding by the normal route.
   */
  if (mfaChallengeRequired) {
    if (matchesPrefix(pathname, PROTECTED_PREFIXES) || matchesPrefix(pathname, AUTH_ROUTES)) {
      return {
        to: `${MFA_CHALLENGE_ROUTE}?next=${encodeURIComponent(pathname)}`,
        reason: "mfa_required",
      };
    }
    if (pathname === "/verify-email") {
      return { to: MFA_CHALLENGE_ROUTE, reason: "mfa_required" };
    }
    return null;
  }

  if (!emailVerified && !isRecovery) {
    if (pathname === "/verify-email") return null;
    if (matchesPrefix(pathname, AUTH_ROUTES) || matchesPrefix(pathname, PROTECTED_PREFIXES)) {
      return { to: "/verify-email", reason: "email_unverified" };
    }
    return null;
  }

  if (matchesPrefix(pathname, AUTH_ROUTES)) {
    return { to: DEFAULT_SIGNED_IN_ROUTE, reason: "already_authenticated" };
  }

  if (pathname === "/verify-email") {
    return { to: DEFAULT_SIGNED_IN_ROUTE, reason: "already_authenticated" };
  }

  return null;
}

/**
 * Sanitises a `?next=` parameter.
 *
 * An open redirect is the classic way to make a phishing link look legitimate:
 * `kith.app/login?next=https://evil.example` sends somebody to an attacker's
 * page from a URL that starts with your own domain, after a genuine sign-in.
 *
 * Only same-origin, single-slash, non-auth paths survive. `//evil.example` is
 * rejected explicitly because browsers read it as protocol-relative and it would
 * otherwise pass a naive "starts with /" check.
 */
export function safeRedirect(next: string | null | undefined): Route | null {
  if (!next) return null;
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//")) return null;
  if (next.includes("\\")) return null;
  if (matchesPrefix(next, AUTH_ROUTES)) return null;
  if (next === "/verify-email" || next === "/reset-password") return null;
  // Bouncing back to the challenge after passing it is a loop.
  if (next === MFA_CHALLENGE_ROUTE) return null;

  // `typedRoutes` cannot check a path that only exists at runtime, and this
  // value arrives from a query string or an email link. The checks above are
  // what make the assertion sound: same-origin, single-slash, not an auth route.
  // A path that no longer exists renders the 404, which is the correct outcome.
  return next as Route;
}
