"use server";

import { createHash } from "node:crypto";

import { redirect } from "next/navigation";

import { clientEnv } from "@/lib/env/client";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { fromAuthError } from "@/lib/supabase/errors";
import { callRpc } from "@/lib/supabase/rpc";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  toFieldErrors,
  type AuthFormState,
} from "@/features/auth/schema";
import { safeRedirect } from "@/features/auth/redirects";

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

function fieldError(fieldErrors: Record<string, string[]>): AuthFormState {
  return {
    status: "error",
    message: "Check the highlighted fields.",
    fieldErrors,
  };
}

/* ========================================================================== */
/*  Sign up                                                                   */
/* ========================================================================== */

export async function signUpAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
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
  const { data: consumed, error: inviteError } = await callRpc(admin, "consume_invite", {
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
  const { data: available } = await callRpc(admin, "is_username_available", {
    p_username: username,
  });

  if (available === false) {
    if (claimedInviteId) await callRpc(admin, "release_invite", { p_invite_id: claimedInviteId });
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
    if (claimedInviteId) await callRpc(admin, "release_invite", { p_invite_id: claimedInviteId });
    return { ...fromAuthError(error, "signUp").error, status: "error" } as AuthFormState;
  }

  if (data.user && claimedInviteId) {
    await callRpc(admin, "record_invite_redemption", {
      p_invite_id: claimedInviteId,
      p_user_id: data.user.id,
    });
  }

  redirect("/verify-email?sent=1");
}

/* ========================================================================== */
/*  Sign in                                                                   */
/* ========================================================================== */

export async function signInAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
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
    // One message for every failure. "That email is not registered" would tell a
    // stranger exactly who is a member of a private room.
    if (error.status === 400 || error.status === 401) {
      return {
        status: "error",
        message: "That email and password do not match. Check them and try again.",
      };
    }
    return { ...fromAuthError(error, "signIn").error, status: "error" } as AuthFormState;
  }

  if (!data.user?.email_confirmed_at) {
    redirect("/verify-email");
  }

  redirect(safeRedirect(parsed.data.redirectTo ?? null) ?? "/");
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
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
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

export async function resetPasswordAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
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
    return { ...fromAuthError(error, "updatePassword").error, status: "error" } as AuthFormState;
  }

  redirect("/login?reset=1");
}

/* ========================================================================== */
/*  Resend verification                                                       */
/* ========================================================================== */

export async function resendVerificationAction(
  _prev: AuthFormState,
  _formData: FormData,
): Promise<AuthFormState> {
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
    return { ...fromAuthError(error, "resend").error, status: "error" } as AuthFormState;
  }

  return { status: "success", message: "Sent. Check your inbox — and your spam folder." };
}
