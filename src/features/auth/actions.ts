"use server";

import { createHash } from "node:crypto";

import { redirect } from "next/navigation";

import { clientEnv } from "@/lib/env/client";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { fromAuthError } from "@/lib/supabase/errors";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
} from "@/features/auth/schema";
import { recordSecurityEvent } from "@/features/auth/mfa-queries";
import { toFieldErrors, type FormState } from "@/lib/forms";
import { DEFAULT_SIGNED_IN_ROUTE, safeRedirect } from "@/features/auth/redirects";

/**
 * Authentication server actions.
 *
 * Rules that hold everywhere in this file:
 *
 *   NOTHING LOGS A PASSWORD. Not on success, not on failure, not in a debug
 *   line somebody forgot to remove. `FormData` is never logged whole, never
 *   spread into an object that gets logged, and never attached to an error.
 *   Passwords are read into a local, passed to Supabase, and dropped.
 *
 *   THE SERVER RE-VALIDATES EVERYTHING. The client schemas are a courtesy; a
 *   server action must assume the form was never rendered.
 *
 *   ERRORS DO NOT CONFIRM WHO EXISTS. On an invitation-only app, "no account
 *   with that email" leaks membership — it tells a stranger who is inside. Every
 *   sign-in failure is the same sentence, and password reset always claims to
 *   have sent something.
 */

const EMAIL_REDIRECT = `${clientEnv.NEXT_PUBLIC_SITE_URL}/auth/confirm`;

function fieldError(fieldErrors: Record<string, string[]>): FormState {
  return {
    status: "error",
    message: "Check the highlighted fields.",
    fieldErrors,
  };
}

/* ========================================================================== */
/*  Sign up                                                                   */
/* ========================================================================== */

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    username: formData.get("username"),
    displayName: formData.get("displayName"),
    inviteCode: formData.get("inviteCode") ?? "",
  });

  if (!parsed.success) return fieldError(toFieldErrors(parsed.error));

  const { email, password, username, displayName, inviteCode } = parsed.data;

  // Codes are stored as digests, never in plaintext — so this is the only form
  // in which the database has ever seen one.
  const codeHash = inviteCode ? createHash("sha256").update(inviteCode.trim()).digest("hex") : "";

  const admin = getSupabaseAdminClient();

  // Claimed BEFORE the account is created. Creating an account for somebody
  // without a valid invitation is the failure that matters; a briefly consumed
  // use of a code is not, and it is handed back below if signup fails.
  let claimedInviteId: string | null = null;
  const { data: consumed, error: inviteError } = await admin.rpc("consume_invite", {
    p_code_hash: codeHash,
  });

  if (inviteError) {
    if (/invalid_invite|invite_required/.test(inviteError.message)) {
      return fieldError({
        inviteCode: ["That invitation is not valid, has expired, or has been used."],
      });
    }
    console.error("[kith:auth] consume_invite failed", { message: inviteError.message });
    return { status: "error", message: "Something went wrong. Try again in a moment." };
  }

  claimedInviteId = consumed;

  // Username uniqueness is enforced by the database, but the signup trigger
  // silently suffixes a clash rather than failing the whole account. Checking
  // here is what turns that into an error the person can act on.
  const { data: available } = await admin.rpc("is_username_available", { p_username: username });

  if (available === false) {
    if (claimedInviteId) await admin.rpc("release_invite", { p_invite_id: claimedInviteId });
    return fieldError({ username: ["That username is taken."] });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: EMAIL_REDIRECT,
      // Read by the handle_new_user trigger to build the profile row.
      data: { username, display_name: displayName },
    },
  });

  if (error) {
    if (claimedInviteId) await admin.rpc("release_invite", { p_invite_id: claimedInviteId });
    return { ...fromAuthError(error, "signUp").error, status: "error" } as FormState;
  }

  if (data.user && claimedInviteId) {
    await admin.rpc("record_invite_redemption", {
      p_invite_id: claimedInviteId,
      p_user_id: data.user.id,
    });
  }

  redirect("/verify-email?sent=1");
}

/* ========================================================================== */
/*  Sign in                                                                   */
/* ========================================================================== */

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    redirectTo: formData.get("redirectTo") ?? undefined,
  });

  if (!parsed.success) return fieldError(toFieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    /*
     * An unconfirmed address is NOT a credential failure, and must not be
     * reported as one.
     *
     * GoTrue validates the password first and only then checks confirmation, so
     * `email_not_confirmed` is returned to somebody who has already proved they
     * know the password. Saying so leaks nothing they did not already have —
     * whereas the generic message sends a person hunting for a password problem
     * they do not have, which is exactly what happened the first time anybody
     * signed up for this app with mail misconfigured.
     *
     * The anti-enumeration rule below still holds for the case it exists for:
     * "no account with that email" and "wrong password" stay indistinguishable.
     */
    if (error.code === "email_not_confirmed") {
      return {
        status: "error",
        message:
          "Your password is right, but this address has not been confirmed yet. Check your inbox for the link from when you signed up.",
      };
    }

    /*
     * Neither is a disabled provider.
     *
     * GoTrue answers a genuinely wrong password with 400 `invalid_credentials`.
     * A 422 from the token endpoint means the request never got as far as
     * checking one — email sign-in is switched off in the project, or signups
     * are. Reporting that as "those details are not valid" points the one person
     * who cannot fix it at the one thing that is not wrong, and the operator
     * never hears about it.
     *
     * Third instance of this shape found in a single afternoon of going live.
     */
    if (
      error.code === "email_provider_disabled" ||
      error.code === "provider_disabled" ||
      error.code === "signup_disabled"
    ) {
      return {
        status: "error",
        message:
          "Email sign-in is switched off for this app. Nothing is wrong with your details — whoever runs it needs to turn the email provider back on.",
      };
    }

    // One message for every genuine credential failure. "That email is not
    // registered" would tell a stranger exactly who is a member of a private room.
    if (error.status === 400 || error.status === 401) {
      return {
        status: "error",
        message: "That email and password do not match. Check them and try again.",
      };
    }
    return { ...fromAuthError(error, "signIn").error, status: "error" } as FormState;
  }

  if (!data.user?.email_confirmed_at) {
    redirect("/verify-email");
  }

  /*
   * A password is not the whole login when a second factor is enrolled.
   *
   * `signInWithPassword` has already created a real session at this point — it
   * is not a half-session or a pending one, it is a working access token that
   * happens to say `aal1`. Sending the browser to the challenge is the polite
   * half of what happens next; migration 0024 is the half that means the token
   * cannot be taken elsewhere and used.
   *
   * Read from the freshly returned user rather than a second round trip: the
   * factors are on the record we already have.
   */
  const enrolled = (data.user.factors ?? []).some((factor) => factor.status === "verified");

  if (enrolled) {
    const next = safeRedirect(parsed.data.redirectTo ?? null);
    redirect(next ? `/verify-2fa?next=${encodeURIComponent(next)}` : "/verify-2fa");
  }

  // DEFAULT_SIGNED_IN_ROUTE, not "/". A literal here was the bug that survived
  // changing the constant: signing in succeeded and dropped you on the public
  // marketing page, which looks exactly like signing in having failed.
  redirect(safeRedirect(parsed.data.redirectTo ?? null) ?? DEFAULT_SIGNED_IN_ROUTE);
}

/* ========================================================================== */
/*  Sign out                                                                  */
/* ========================================================================== */

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  // 'local' clears this browser only. 'global' would sign the user out of their
  // phone too, which is a surprise rather than a security feature.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login?signedout=1");
}

/* ========================================================================== */
/*  Forgot password                                                           */
/* ========================================================================== */

export async function forgotPasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get("email") });

  if (!parsed.success) return fieldError(toFieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${clientEnv.NEXT_PUBLIC_SITE_URL}/auth/confirm?next=/reset-password`,
  });

  // Rate limiting is the ONLY failure worth surfacing. Anything else — including
  // "no such account" — returns the same success message, because a different
  // response for a registered address turns this form into a membership oracle.
  if (error && error.status === 429) {
    return {
      status: "error",
      message: "Too many attempts. Wait a minute before trying again.",
    };
  }

  if (error) {
    console.error("[kith:auth] resetPasswordForEmail", { status: error.status });
  }

  return {
    status: "success",
    message: "If that address has an account, a reset link is on its way.",
  };
}

/* ========================================================================== */
/*  Reset password                                                            */
/* ========================================================================== */

/**
 * Sets a new password from a recovery link.
 *
 * ── Why this signs out EVERY session, including this one ─────────────────────
 *
 * `changePasswordAction` in `account-actions.ts` revokes `scope: 'others'` and
 * keeps the current browser, on the reasoning that signing somebody out of the
 * device they are using — as a reward for improving their security — is
 * needlessly punitive. That is right for a change made from Settings, where the
 * person is already signed in and has just typed their old password.
 *
 * A reset is not that. The only thing anybody proved here is that they can read
 * an inbox, and the reason people use this flow is that something has gone
 * wrong: a forgotten password, or the belief that somebody else has theirs. If
 * an attacker is holding a live session, `others` would end it and `nothing`
 * would leave it running — so this originally left the attacker signed in
 * through the one action taken specifically to lock them out.
 *
 * `global` is the honest scope. After a reset, nothing that authenticated before
 * it still counts, and the person signs in once with the password they just set.
 * `/login?reset=1` has always said "Password changed. Sign in with the new one."
 * — that message was simply unreachable, because the session survived and
 * middleware bounced a signed-in user off `/login`.
 */
export async function resetPasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) return fieldError(toFieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();

  // The recovery link created a session. No session means the link was never
  // followed, has expired, or somebody navigated here directly — and in all
  // three cases there is nothing to reset.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      status: "error",
      message: "That reset link has expired. Request a new one.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    if (error.status === 422) {
      return fieldError({
        password: ["That password was rejected. Try a longer or less common one."],
      });
    }
    return { ...fromAuthError(error, "updatePassword").error, status: "error" } as FormState;
  }

  // Before the sign-out, because the sign-out invalidates the session this runs
  // under. `recordSecurityEvent` writes through the service role and swallows
  // its own failures, so it cannot turn a successful reset into an error.
  await recordSecurityEvent(user.id, "password.reset");

  // See the note above: everything, not just the other devices. A failure here
  // is not surfaced — the password IS changed, and sending somebody back to a
  // form that says otherwise would be worse than a session outliving its reset.
  const { error: signOutError } = await supabase.auth.signOut({ scope: "global" });

  if (signOutError) {
    console.error("[kith:auth] reset sign-out failed", { status: signOutError.status });
  }

  redirect("/login?reset=1");
}

/* ========================================================================== */
/*  Resend verification                                                       */
/* ========================================================================== */

export async function resendVerificationAction(
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return { status: "error", message: "Sign in again to resend the confirmation." };
  }

  const { error } = await supabase.auth.resend({
    type: "signup",
    email: user.email,
    options: { emailRedirectTo: EMAIL_REDIRECT },
  });

  if (error) {
    if (error.status === 429) {
      return {
        status: "error",
        message: "Too many requests. Wait a minute before asking for another.",
      };
    }
    return { ...fromAuthError(error, "resend").error, status: "error" } as FormState;
  }

  return { status: "success", message: "Sent. Check your inbox — and your spam folder." };
}
