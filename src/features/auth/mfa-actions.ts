"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  canPerformSensitiveAction,
  DEFAULT_FACTOR_NAME,
  factorNameSchema,
  MAX_FACTORS,
  totpCodeSchema,
  type MfaState,
} from "@/features/auth/mfa";
import { getMfaStatus, recordSecurityEvent } from "@/features/auth/mfa-queries";
import { DEFAULT_SIGNED_IN_ROUTE, safeRedirect } from "@/features/auth/redirects";
import type { FormState } from "@/lib/forms";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { KithSupabaseClient } from "@/lib/supabase/client";

/**
 * Two-factor server actions.
 *
 * Rules that hold everywhere in this file:
 *
 *   NO SECRET EVER TOUCHES OUR STORAGE. The TOTP secret exists in exactly two
 *   places — Supabase Auth, and the authenticator app it was scanned into. It
 *   passes through `beginEnrollment` on its way to a QR code and is not written
 *   down, cached, logged, or put in a cookie. There is no table for it and there
 *   must never be one.
 *
 *   NO CODE IS EVER LOGGED. Not on success, not on failure. A TOTP code is
 *   short-lived, but it is short-lived credentials rather than harmless data,
 *   and a log line containing one is a log line worth stealing.
 *
 *   THE SESSION MUST ALREADY BE STRONG ENOUGH. Anything that weakens the account
 *   — removing a factor, adding a new one — first checks that this session has
 *   met the bar the account already sets. Otherwise a stolen password alone
 *   could switch off the thing protecting the password.
 *
 *   FAILURES DO NOT EXPLAIN THEMSELVES. "That code is not right" covers a wrong
 *   code, an expired challenge, a clock that has drifted too far, and a factor
 *   that no longer exists. Distinguishing them tells somebody guessing which
 *   part of their guess was close.
 */

function fieldError(fieldErrors: Record<string, string[]>): FormState {
  return { status: "error", message: "Check the highlighted fields.", fieldErrors };
}

const WRONG_CODE = "That code is not right. Codes change every 30 seconds — try the current one.";

/**
 * Accepts a code from any of the account's verified authenticators.
 *
 * Supabase verifies against one factor at a time, but "enter a code from your
 * authenticator" should not mean "and we will decide which of your three it had
 * better be" — removing a lost phone using the tablet you still have is the
 * whole reason a second factor is allowed.
 *
 * So the factors are tried in order and the first acceptance wins. At most
 * MAX_FACTORS attempts, which matters because GoTrue rate-limits verification:
 * the cap is what keeps one wrong code from spending the whole budget.
 *
 * On success the session is upgraded to aal2 by Supabase, and new cookies are
 * written by the client's `setAll`.
 */
async function verifyAgainstAnyFactor(
  supabase: KithSupabaseClient,
  state: MfaState,
  code: string,
): Promise<{ ok: true; factorId: string } | { ok: false }> {
  for (const factor of state.factors.slice(0, MAX_FACTORS)) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code,
    });

    if (!error) return { ok: true, factorId: factor.id };
  }

  return { ok: false };
}

/* ========================================================================== */
/*  Enrolment                                                                 */
/* ========================================================================== */

export interface EnrollmentStart {
  factorId: string;
  /** An SVG data URI, rendered by Supabase. We do not draw QR codes. */
  qrCode: string;
  /** The same secret in base32, for typing in by hand when a camera will not do. */
  secret: string;
  uri: string;
}

export type EnrollmentResult =
  { ok: true; enrollment: EnrollmentStart } | { ok: false; reason: string };

/**
 * Starts an enrolment and hands back a QR code.
 *
 * The factor is created `unverified` and stays that way until a code from it is
 * accepted, which is what stops opening this screen from locking the account
 * (see `mfa_satisfied` in migration 0024 and `deriveMfaState`).
 *
 * Abandoned enrolments are swept first. Somebody who opens this page three times
 * without finishing would otherwise fill every slot with factors that protect
 * nothing, and then be told they cannot enrol.
 */
export async function beginEnrollmentAction(name?: string): Promise<EnrollmentResult> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false, reason: "Sign in again." };

  const state = await getMfaStatus();
  if (!state) return { ok: false, reason: "Sign in again." };

  // Adding a second key to the door is a change to the account's security.
  if (!canPerformSensitiveAction(state)) {
    return { ok: false, reason: "Confirm your current code first." };
  }

  const { data: existing } = await supabase.auth.mfa.listFactors();

  for (const factor of existing?.all ?? []) {
    if (factor.status !== "verified") {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }

  if (state.factors.length >= MAX_FACTORS) {
    return {
      ok: false,
      reason: `You already have ${MAX_FACTORS} authenticators. Remove one to add another.`,
    };
  }

  const parsedName = factorNameSchema.safeParse(name ?? "");
  const base = parsedName.success ? parsedName.data : DEFAULT_FACTOR_NAME;

  /*
   * Supabase requires friendly names to be unique per user and rejects a
   * duplicate with an error about a name nobody chose.
   *
   * Suffixing with the factor COUNT is not enough: enrol two, remove the first,
   * enrol again, and the count is back to one while "Authenticator 2" is still
   * taken. So the next free suffix is found by looking rather than by counting.
   */
  const taken = new Set(state.factors.map((factor) => factor.friendlyName));

  let friendlyName = base;
  for (let suffix = 2; taken.has(friendlyName); suffix += 1) {
    friendlyName = `${base} ${suffix}`;
  }

  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName });

  if (error || !data) {
    console.error("[kith:auth] mfa enroll failed", { status: error?.status });
    return { ok: false, reason: "Could not start setup. Try again in a moment." };
  }

  await recordSecurityEvent(user.id, "mfa.enroll_started", { factorId: data.id });

  return {
    ok: true,
    enrollment: {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    },
  };
}

/** Throws away an enrolment that was started and not finished. */
export async function cancelEnrollmentAction(factorId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const target = factors?.all?.find((factor) => factor.id === factorId);

  // Only ever an unverified one. Cancelling an enrolment must not be a way to
  // delete a working factor without proving anything.
  if (!target || target.status === "verified") return;

  await supabase.auth.mfa.unenroll({ factorId });
  await recordSecurityEvent(user.id, "mfa.enroll_cancelled", { factorId });

  revalidatePath("/settings/security");
}

/**
 * Finishes enrolment: the first accepted code turns the factor on.
 *
 * Verified against the factor being enrolled specifically, not "any factor" —
 * the point of this step is to prove that the authenticator now holds the right
 * secret, and accepting a code from a different device would prove nothing about
 * the one just scanned.
 *
 * Supabase upgrades the session to aal2 as part of accepting the code, so the
 * person is not locked out by the protection they have just switched on.
 */
export async function confirmEnrollmentAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const factorId = String(formData.get("factorId") ?? "");
  const parsed = totpCodeSchema.safeParse(formData.get("code") ?? "");

  if (!parsed.success) return fieldError({ code: [parsed.error.issues[0]?.message ?? WRONG_CODE] });
  if (!factorId) return { status: "error", message: "Start setup again." };

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { status: "error", message: "Sign in again." };

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: parsed.data,
  });

  if (error) {
    await recordSecurityEvent(user.id, "mfa.challenge_failed", { stage: "enrollment" });
    if (error.status === 429) {
      return { status: "error", message: "Too many attempts. Wait a minute before trying again." };
    }
    return fieldError({ code: [WRONG_CODE] });
  }

  await recordSecurityEvent(user.id, "mfa.enabled", { factorId });

  revalidatePath("/settings/security");
  return {
    status: "success",
    message: "Two-factor authentication is on. You will be asked for a code when you sign in.",
  };
}

/* ========================================================================== */
/*  Removal                                                                   */
/* ========================================================================== */

/**
 * Removes one authenticator, after proving the session may.
 *
 * A current code is required even though the session is already at aal2. That is
 * not belt-and-braces: an aal2 session lasts as long as the token does, and this
 * is the action that makes every future login easier. Asking again costs six
 * digits and closes the window where a borrowed laptop can switch the protection
 * off.
 *
 * Removing the last factor is what "disable two-factor" means — there is no
 * separate switch, because a switch that turns it off without removing the
 * factors would leave the account in a state nobody can reason about.
 */
export async function removeFactorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const factorId = String(formData.get("factorId") ?? "");
  const parsed = totpCodeSchema.safeParse(formData.get("code") ?? "");

  if (!parsed.success) return fieldError({ code: [parsed.error.issues[0]?.message ?? WRONG_CODE] });

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { status: "error", message: "Sign in again." };

  const state = await getMfaStatus();
  if (!state?.enabled) return { status: "error", message: "Two-factor is not on." };

  const target = state.factors.find((factor) => factor.id === factorId);
  if (!target) return { status: "error", message: "That authenticator is already gone." };

  const verified = await verifyAgainstAnyFactor(supabase, state, parsed.data);

  if (!verified.ok) {
    await recordSecurityEvent(user.id, "mfa.challenge_failed", { stage: "removal" });
    return fieldError({ code: [WRONG_CODE] });
  }

  const { error } = await supabase.auth.mfa.unenroll({ factorId });

  if (error) {
    console.error("[kith:auth] mfa unenroll failed", { status: error.status });
    return { status: "error", message: "Could not remove it. Try again in a moment." };
  }

  const last = state.factors.length === 1;

  await recordSecurityEvent(user.id, last ? "mfa.disabled" : "mfa.factor_removed", {
    factorId,
    remaining: state.factors.length - 1,
  });

  revalidatePath("/settings/security");

  return {
    status: "success",
    message: last
      ? "Two-factor authentication is off. Your password is all that stands in the way now."
      : "That authenticator has been removed.",
  };
}

/* ========================================================================== */
/*  The sign-in challenge                                                     */
/* ========================================================================== */

/**
 * The second half of signing in.
 *
 * The session already exists at this point and is real — this does not create
 * one, it raises the one that is there from aal1 to aal2. Which is exactly why
 * the database gate in migration 0024 has to exist: between the password and
 * this code, there is a working access token that must be able to read nothing.
 */
export async function verifyChallengeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = totpCodeSchema.safeParse(formData.get("code") ?? "");
  const next = safeRedirect(String(formData.get("next") ?? "") || null);

  if (!parsed.success) return fieldError({ code: [parsed.error.issues[0]?.message ?? WRONG_CODE] });

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const state = await getMfaStatus();

  // Nothing to prove — enrolment was removed on another device mid-challenge.
  if (!state?.challengeRequired) redirect(next ?? DEFAULT_SIGNED_IN_ROUTE);

  const verified = await verifyAgainstAnyFactor(supabase, state, parsed.data);

  if (!verified.ok) {
    await recordSecurityEvent(user.id, "mfa.challenge_failed", { stage: "sign_in" });
    return fieldError({ code: [WRONG_CODE] });
  }

  await recordSecurityEvent(user.id, "mfa.challenge_passed", { factorId: verified.factorId });

  redirect(next ?? DEFAULT_SIGNED_IN_ROUTE);
}
