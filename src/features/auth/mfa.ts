import { z } from "zod";

/**
 * Two-factor authentication — the parts that are ours.
 *
 * Supabase Auth owns everything cryptographic: it generates the TOTP secret,
 * renders the QR code, checks codes against a time window, and mints a new
 * access token carrying `aal2` when one is accepted. **Nothing in KITH stores a
 * secret, and nothing in KITH verifies a code.** If this file ever grows a
 * `base32` import, something has gone wrong.
 *
 * What is left over is a small state machine, and it is worth having in one pure
 * place because three layers ask the same question and must not disagree about
 * it: the middleware deciding where to send a request, the settings page drawing
 * a status, and the sign-in action deciding whether a password was enough.
 *
 * ── Assurance levels, in one paragraph ───────────────────────────────────────
 *
 * `aal1` is a session that proved one thing — a password. `aal2` is one that
 * proved two. Supabase puts the level in the access token as the `aal` claim,
 * and it is a property of THE SESSION, not of the account: enrolling does not
 * retroactively upgrade the session you enrolled from, and signing in tomorrow
 * starts at aal1 again until a code is entered.
 *
 * So there are two levels to compare, always:
 *
 *   current   what this session has proved
 *   required  what this account demands — aal2 once a factor is verified
 *
 * Every question anybody asks is one of those two, or the gap between them.
 */

/* -------------------------------------------------------------------------- */

export type AssuranceLevel = "aal1" | "aal2";

/** An enrolled authenticator. Never carries the secret — see the note above. */
export interface MfaFactor {
  id: string;
  friendlyName: string | null;
  /** `unverified` is a factor mid-enrolment: created, never yet proved. */
  status: "verified" | "unverified";
  createdAt: string;
}

export interface MfaState {
  /** Verified factors only. An unverified one is an abandoned enrolment. */
  factors: MfaFactor[];
  /** Two-factor is on for this account. */
  enabled: boolean;
  currentLevel: AssuranceLevel;
  requiredLevel: AssuranceLevel;
  /**
   * Enrolled, but this session has not proved it. The one flag the router cares
   * about, and the condition the database enforces independently.
   */
  challengeRequired: boolean;
  /** Room for another authenticator — see MAX_FACTORS. */
  canEnroll: boolean;
}

/**
 * How many authenticators one account may hold.
 *
 * More than one on purpose, and it is the only self-service recovery there is:
 * TOTP has no "forgot my phone" link, because the whole point of the scheme is
 * that the server cannot produce a code on your behalf. A second authenticator
 * — a tablet, a desktop app, a partner's phone — is the difference between
 * losing a device and losing the account.
 *
 * Capped rather than unlimited because each one is another key to the same door,
 * and an account with nine enrolled factors is an account nobody can audit. See
 * docs/MFA.md for what happens when all of them are gone.
 */
export const MAX_FACTORS = 3;

/** RFC 6238 with the parameters every authenticator app defaults to. */
export const TOTP_DIGITS = 6;

/** What we ask Supabase to label the factor, when the person does not. */
export const DEFAULT_FACTOR_NAME = "Authenticator";

/* -------------------------------------------------------------------------- */

/**
 * A code as typed by a human.
 *
 * Authenticator apps display `123 456`, people paste with a trailing newline,
 * and some keyboards insert a non-breaking space. Every one of those is the
 * right code entered correctly, and rejecting them as malformed is a support
 * ticket about a bug that does not exist. So: strip everything that is not a
 * digit, then require exactly six.
 *
 * Stripping happens BEFORE validation rather than after, so the length message
 * describes the digits the person typed rather than the characters they pasted.
 */
export const totpCodeSchema = z
  .string()
  .transform((value) => value.replace(/\D/g, ""))
  .pipe(
    z
      .string()
      .length(TOTP_DIGITS, `Enter the ${TOTP_DIGITS}-digit code from your authenticator app.`),
  );

export const factorNameSchema = z
  .string()
  .trim()
  .max(40, "Keep the name under 40 characters.")
  .transform((value) => value || DEFAULT_FACTOR_NAME);

/* -------------------------------------------------------------------------- */

export interface AssuranceReading {
  /** Every factor Supabase knows about, verified or not. */
  factors: MfaFactor[];
  /** From the `aal` claim on this session's access token. */
  currentLevel: AssuranceLevel | null;
}

/**
 * The whole state machine.
 *
 * Pure, so the routing rules and the settings page cannot drift apart, and so
 * the awkward cases can be asserted without a running Auth server — which is
 * exactly where the awkward cases are:
 *
 *   MID-ENROLMENT. A factor exists but is unverified. The account is NOT yet
 *   protected, and must not be treated as though it is — otherwise opening the
 *   enrolment screen locks you out of the app before you can finish enrolling.
 *
 *   JUST VERIFIED. Supabase upgrades the session as part of accepting the first
 *   code, so `enabled` and `currentLevel: aal2` arrive together and no challenge
 *   is owed.
 *
 *   JUST DISABLED. The last verified factor is gone, so nothing is required —
 *   but the session stays at aal2, which is above the bar rather than below it.
 */
export function deriveMfaState({ factors, currentLevel }: AssuranceReading): MfaState {
  const verified = factors.filter((factor) => factor.status === "verified");
  const enabled = verified.length > 0;

  const current: AssuranceLevel = currentLevel === "aal2" ? "aal2" : "aal1";
  const required: AssuranceLevel = enabled ? "aal2" : "aal1";

  return {
    factors: verified,
    enabled,
    currentLevel: current,
    requiredLevel: required,
    challengeRequired: required === "aal2" && current !== "aal2",
    // Counted against every factor, not just the verified ones: an abandoned
    // enrolment still occupies a slot until it is cleaned up, and pretending
    // otherwise means the enrol button fails with a server error.
    canEnroll: factors.length < MAX_FACTORS,
  };
}

/**
 * Whether an action that changes the account's security may proceed.
 *
 * Disabling two-factor, adding a second authenticator, setting a new password:
 * all of them hand somebody a durable way back in, so all of them need the
 * session to be at the level the account demands. A password alone must not be
 * able to switch off the thing protecting the password.
 *
 * The rule reads as "the session is at least as strong as the account requires",
 * which for an account with no factor is trivially true — there is nothing
 * stronger to ask for yet.
 */
export function canPerformSensitiveAction(state: MfaState): boolean {
  return !state.challengeRequired;
}
