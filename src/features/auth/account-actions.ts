"use server";

import { createClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { changePasswordSchema, confirmsDeletion } from "@/features/auth/account";
import { emailSchema } from "@/features/auth/schema";
import { totpCodeSchema } from "@/features/auth/mfa";
import { getMfaStatus, recordSecurityEvent } from "@/features/auth/mfa-queries";
import { BUCKETS } from "@/lib/supabase/storage";
import { clientEnv, getSupabasePublicEnv } from "@/lib/env/client";
import { toFieldErrors, type FormState } from "@/lib/forms";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/**
 * Account and security mutations.
 *
 * Rules that hold everywhere in this file, in addition to the ones in
 * `mfa-actions.ts` (no secrets logged, failures do not explain themselves):
 *
 *   REAUTHENTICATION IS A PASSWORD, NOT A SESSION. Changing a password and
 *   deleting an account both hand somebody durable control of the account, so
 *   both require the current password to be typed again — a session cookie is
 *   something a borrowed laptop already has.
 *
 *   THE DESTRUCTIVE RPC IS NOT REACHABLE FROM A BROWSER. `anonymise_account` has
 *   execute revoked from `authenticated` entirely and runs through the service
 *   role from here, after every check has passed. An irreversible RPC an access
 *   token can call on its own is a one-request account wipe.
 */

function fieldError(fieldErrors: Record<string, string[]>): FormState {
  return { status: "error", message: "Check the highlighted fields.", fieldErrors };
}

/* ========================================================================== */
/*  Reauthentication                                                          */
/* ========================================================================== */

/**
 * Confirms the password by using it, on a client that keeps nothing.
 *
 * GoTrue has no "is this password correct" endpoint, so the only honest check is
 * a sign-in. Doing that on the request-bound client would be a bug rather than a
 * check: it rotates the session cookie and, because a password sign-in starts at
 * `aal1`, it would silently **downgrade a two-factor session** and bounce the
 * person to the challenge screen in the middle of changing their password.
 *
 * So it happens on a throwaway client with `persistSession: false`, which writes
 * no cookies and touches nothing the browser holds. The session it creates
 * server-side is real, so it is signed out again immediately rather than left to
 * expire — otherwise every password change would litter `auth.sessions` with a
 * live session nobody is using.
 *
 * The password is read into a local, passed to Supabase, and dropped. It is
 * never logged, never attached to an error, and never returned.
 */
async function passwordIsCorrect(email: string, password: string): Promise<boolean> {
  const env = getSupabasePublicEnv();

  const probe = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );

  const { data, error } = await probe.auth.signInWithPassword({ email, password });

  if (error || !data.session) return false;

  // Clean up after ourselves. 'local' is this throwaway client only — 'global'
  // would sign the person out of every real device as a side effect of typing
  // their own password correctly.
  await probe.auth.signOut({ scope: "local" });

  return true;
}

/* ========================================================================== */
/*  Password                                                                  */
/* ========================================================================== */

/**
 * Changes the password, then signs every other device out.
 *
 * The sign-out is not optional and not a checkbox. The common reason to change a
 * password is believing somebody else has it, and leaving their session running
 * afterwards makes the change ceremonial. The form says so before it is
 * submitted, so it is not a surprise.
 *
 * `scope: 'others'` rather than `'global'`: signing the person out of the device
 * they are currently using, as a reward for improving their security, is a
 * needlessly punitive way to end an otherwise successful interaction.
 */
export async function changePasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) return fieldError(toFieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) return { status: "error", message: "Sign in again." };

  if (!(await passwordIsCorrect(user.email, parsed.data.currentPassword))) {
    await recordSecurityEvent(user.id, "password.change_failed");
    return fieldError({ currentPassword: ["That is not your current password."] });
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.newPassword });

  if (error) {
    if (error.status === 422) {
      return fieldError({
        newPassword: ["That password was rejected. Try a longer or less common one."],
      });
    }
    console.error("[kith:auth] password change failed", { status: error.status });
    return { status: "error", message: "Something went wrong. Try again in a moment." };
  }

  const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });

  await recordSecurityEvent(user.id, "password.changed", {
    othersSignedOut: !signOutError,
  });

  revalidatePath("/settings/security");

  return {
    status: "success",
    message: signOutError
      ? "Password changed. Your other devices could not be signed out — do it from the sessions list."
      : "Password changed, and every other device has been signed out.",
  };
}

/* ========================================================================== */
/*  Email                                                                     */
/* ========================================================================== */

/**
 * Changes the address the account signs in with.
 *
 * Nothing happens immediately. Supabase sends a confirmation to the NEW address
 * and the change lands only when that link is followed — which is the important
 * property: somebody who gets thirty seconds at an unlocked laptop cannot move
 * the account to an inbox they control, because they would need to open that
 * inbox too.
 *
 * The current password is still required. The confirmation is what stops the
 * change completing; the password is what stops it being started, so the real
 * owner does not get an email saying their account is being moved.
 */
export async function changeEmailAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  const password = String(formData.get("password") ?? "");

  if (!parsed.success) {
    return fieldError({ email: [parsed.error.issues[0]?.message ?? "That is not an address."] });
  }
  if (!password) return fieldError({ password: ["Enter your password."] });

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) return { status: "error", message: "Sign in again." };

  if (parsed.data === user.email.toLowerCase()) {
    return fieldError({ email: ["That is already your address."] });
  }

  if (!(await passwordIsCorrect(user.email, password))) {
    await recordSecurityEvent(user.id, "email.change_failed");
    return fieldError({ password: ["That is not your password."] });
  }

  const { error } = await supabase.auth.updateUser(
    { email: parsed.data },
    { emailRedirectTo: `${clientEnv.NEXT_PUBLIC_SITE_URL}/auth/confirm` },
  );

  if (error) {
    // Rate limiting is worth saying. "That address is already in use" is not —
    // on an invitation-only app it would confirm who is a member.
    if (error.status === 429) {
      return { status: "error", message: "Too many attempts. Wait a minute and try again." };
    }
    console.error("[kith:auth] email change failed", { status: error.status });
    return {
      status: "success",
      message:
        "Check the new address for a confirmation link. Nothing changes until you follow it.",
    };
  }

  await recordSecurityEvent(user.id, "email.change_requested");
  revalidatePath("/settings/account");

  return {
    status: "success",
    message: "Check the new address for a confirmation link. Nothing changes until you follow it.",
  };
}

/* ========================================================================== */
/*  Sessions                                                                  */
/* ========================================================================== */

/**
 * Ends every session except this one.
 *
 * Not password-gated, deliberately. It only ever *reduces* access, the person
 * reaching for it usually believes somebody else is signed in, and putting a
 * password prompt in front of the panic button is how the panic button goes
 * unused.
 *
 * There is no per-session revoke. GoTrue exposes scopes, not session handles,
 * and deleting the row out of `auth.sessions` to fake one would mean writing to
 * a schema Supabase owns — reads there are a calculated risk, writes are not.
 */
export async function signOutOthersAction(): Promise<FormState> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { status: "error", message: "Sign in again." };

  const { error } = await supabase.auth.signOut({ scope: "others" });

  if (error) {
    console.error("[kith:auth] sign out others failed", { status: error.status });
    return { status: "error", message: "Could not sign out the other devices. Try again." };
  }

  await recordSecurityEvent(user.id, "sessions.revoked_others");
  revalidatePath("/settings/security");

  return { status: "success", message: "Every other device has been signed out." };
}

/* ========================================================================== */
/*  Deletion                                                                  */
/* ========================================================================== */

/**
 * Leaves, permanently.
 *
 * ── Three gates, and why each one is there ───────────────────────────────────
 *
 *   THE PASSWORD, because the session alone is a borrowed laptop.
 *   A CURRENT CODE when two-factor is on, because this is irreversible and the
 *     aal2 session it would otherwise rely on lasts as long as its token does.
 *   THE TYPED USERNAME, because the first two can both be satisfied by muscle
 *     memory and this one cannot — it has to be read off the screen.
 *
 * ── What actually happens ────────────────────────────────────────────────────
 *
 * The profile is scrubbed in place and the auth account is disabled. It is not a
 * row delete, and the reason is in migration 0025: `profiles.id` cascades from
 * `auth.users`, and two of the onward edges — hosted game sessions, and the
 * couple record with both partners' answers in it — are other people's data. One
 * person leaving a six-person room should not delete five other people's
 * evenings.
 *
 * So: everything identifying goes, the shell stays so old conversations still
 * render a name, and the account is banned and soft-deleted so nobody can sign
 * in to it again.
 */
export async function deleteAccountAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const password = String(formData.get("password") ?? "");
  const typed = String(formData.get("confirm") ?? "");
  const rawCode = String(formData.get("code") ?? "");

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) return { status: "error", message: "Sign in again." };

  // The avatar path is read here, before the scrub nulls it — afterwards there
  // is nothing left to say which file in the bucket was theirs.
  const { data: profile } = await supabase
    .from("profiles")
    .select("username, avatar_path")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.username) return { status: "error", message: "Sign in again." };

  if (!confirmsDeletion(typed, profile.username)) {
    return fieldError({ confirm: [`Type ${profile.username} exactly to confirm.`] });
  }

  if (!password) return fieldError({ password: ["Enter your password."] });

  const status = await getMfaStatus();

  if (status?.enabled) {
    const code = totpCodeSchema.safeParse(rawCode);
    if (!code.success) {
      return fieldError({ code: ["Enter the code from your authenticator app."] });
    }

    // Any of their authenticators. Same rule as removing a factor.
    let accepted = false;
    for (const factor of status.factors) {
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId: factor.id,
        code: code.data,
      });
      if (!error) {
        accepted = true;
        break;
      }
    }

    if (!accepted) {
      await recordSecurityEvent(user.id, "mfa.challenge_failed", { stage: "deletion" });
      return fieldError({ code: ["That code is not right."] });
    }
  }

  if (!(await passwordIsCorrect(user.email, password))) {
    await recordSecurityEvent(user.id, "account.delete_failed");
    return fieldError({ password: ["That is not your password."] });
  }

  const admin = getSupabaseAdminClient();

  // Recorded BEFORE the scrub, so the event is written while `user_id` still
  // points at a live account. `security_events.user_id` is `on delete set null`,
  // and the row survives the account either way.
  await recordSecurityEvent(user.id, "account.deleted");

  const { error: scrubError } = await admin.rpc("anonymise_account", { p_user_id: user.id });

  if (scrubError) {
    console.error("[kith:auth] anonymise_account failed", { message: scrubError.message });
    return { status: "error", message: "Something went wrong. Nothing has been deleted." };
  }

  // The avatar is a file in a bucket, not a row, so SQL could not reach it.
  if (profile.avatar_path) {
    const { error: fileError } = await admin.storage
      .from(BUCKETS.avatars)
      .remove([profile.avatar_path]);

    if (fileError) {
      console.error("[kith:auth] avatar not removed", { message: fileError.message });
    }
  }

  /*
   * Now the auth account.
   *
   * Three steps because each covers a different failure of the next: the email
   * is replaced so no personal data is left in `auth.users`, the ban is what
   * definitely blocks a sign-in, and the soft delete is what marks the account
   * as gone. Soft rather than hard — a hard delete would cascade into
   * `profiles` and undo everything the scrub just protected.
   *
   * Failures here are logged and not surfaced: the profile is already
   * anonymised, so the person's data is gone even if their dormant auth row is
   * not, and telling them "half deleted" helps nobody.
   */
  const gone = `deleted-${user.id}@deleted.invalid`;

  const { error: emailError } = await admin.auth.admin.updateUserById(user.id, {
    email: gone,
    ban_duration: "876000h",
    user_metadata: {},
  });
  if (emailError) {
    console.error("[kith:auth] could not scrub auth user", { status: emailError.status });
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, true);
  if (deleteError) {
    console.error("[kith:auth] soft delete failed", { status: deleteError.status });
  }

  // 'global' rather than 'others': every device, including this one. There is
  // no account left for any of them to be signed in to.
  await supabase.auth.signOut({ scope: "global" });

  redirect("/login?deleted=1");
}
