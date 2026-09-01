"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { blockReasonSchema, reportSchema } from "@/features/safety/reasons";
import { toFieldErrors, type FormState } from "@/lib/forms";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * Safety mutations.
 *
 * Every one of these is a thin wrapper over a SECURITY DEFINER function. Nothing
 * here decides who may block whom, whether a report is a duplicate, or what a
 * block severs — `block_user`, `unblock_user` and `report_user` do all of that in
 * SQL, and a second copy of those rules in TypeScript is a second copy that can
 * disagree.
 *
 * ── One rule specific to this file ───────────────────────────────────────────
 *
 * NOTHING CONFIRMS WHETHER SOMEBODY EXISTS. `blocked` and `no_such_account` come
 * back as the same sentence. On an invitation-only app, a distinct response for
 * a real account turns a block form into a membership oracle — the same reason
 * sign-in has one error message for everything.
 */

const uuid = z.uuid();

export type SafetyResult = { ok: true } | { ok: false; reason: string };

function explain(message: string | undefined): string {
  const text = message ?? "";

  if (text.includes("cannot_block_self")) return "You cannot block yourself.";
  if (text.includes("cannot_report_self")) return "You cannot report yourself.";
  if (text.includes("already_reported")) {
    return "You already have a report open about them. We have it.";
  }
  if (text.includes("too_many_reports")) {
    return "That is a lot of reports in one hour. Take a breath and try again shortly.";
  }
  if (text.includes("detail_required")) return "Tell us what happened.";
  if (text.includes("detail_too_long") || text.includes("reason_too_long")) {
    return "That is longer than the box allows.";
  }
  // Deliberately the same for "no such person" and anything unexpected.
  return "That could not be done.";
}

/**
 * Everything a block might have changed.
 *
 * Blocking severs a friendship, a couple, a live call and a game seat, so the
 * pages showing those are all now wrong. Cheaper to name them than to work out
 * which one the person is looking at.
 */
function revalidateEverything(): void {
  for (const path of ["/friends", "/messages", "/calls", "/games", "/couple", "/settings/safety"]) {
    revalidatePath(path);
  }
}

/* ------------------------------------------------------------------ blocking */

export async function blockUserAction(userId: string, reason?: string): Promise<SafetyResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const target = uuid.safeParse(userId);
  if (!target.success) return { ok: false, reason: "That could not be done." };

  const note = blockReasonSchema.safeParse(reason ?? undefined);
  if (!note.success) return { ok: false, reason: "That note is too long." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("block_user", {
    p_user_id: target.data,
    p_reason: note.data ?? null,
  });

  if (error) return { ok: false, reason: explain(error.message) };

  revalidateEverything();
  return { ok: true };
}

export async function unblockUserAction(userId: string): Promise<SafetyResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const target = uuid.safeParse(userId);
  if (!target.success) return { ok: false, reason: "That could not be done." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("unblock_user", { p_user_id: target.data });

  if (error) return { ok: false, reason: explain(error.message) };

  revalidateEverything();
  return { ok: true };
}

/* ----------------------------------------------------------------- reporting */

/**
 * Files a report, and usually blocks them at the same time.
 *
 * The two are separate operations in the database and separate decisions in
 * principle, but in practice somebody filling in this dialog wants the person
 * gone as well as recorded. So the checkbox defaults on, and the block runs
 * first: if the report fails its rate limit, having already been blocked is the
 * outcome the person actually needed.
 */
export async function reportUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const target = uuid.safeParse(formData.get("userId"));
  if (!target.success) return { status: "error", message: "That could not be done." };

  const parsed = reportSchema.safeParse({
    reason: formData.get("reason"),
    detail: String(formData.get("detail") ?? "").trim() || undefined,
    alsoBlock: formData.get("alsoBlock") === "on",
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      fieldErrors: toFieldErrors(parsed.error),
    };
  }

  const user = await getCurrentUser();
  if (!user) return { status: "error", message: "Sign in again." };

  const supabase = await createSupabaseServerClient();

  // The context, when the dialog was opened from a message rather than from a
  // profile. Both are validated against the reporter's own visibility inside
  // `report_user` and dropped if they cannot see them — a message id that is
  // accepted or refused on existence would be an oracle.
  const messageId = uuid.safeParse(formData.get("messageId") ?? "");
  const conversationId = uuid.safeParse(formData.get("conversationId") ?? "");

  let blocked = false;

  if (parsed.data.alsoBlock) {
    const result = await blockUserAction(target.data);
    blocked = result.ok;
  }

  const { error } = await supabase.rpc("report_user", {
    p_reported_id: target.data,
    p_reason: parsed.data.reason,
    p_detail: parsed.data.detail ?? null,
    p_message_id: messageId.success ? messageId.data : null,
    p_conversation_id: conversationId.success ? conversationId.data : null,
  });

  if (error) {
    const reason = explain(error.message);
    return {
      status: "error",
      // The block is the half that protects them, so if it landed it is worth
      // saying so even when the report did not.
      message: blocked ? `${reason} They are blocked either way.` : reason,
    };
  }

  revalidateEverything();

  return {
    status: "success",
    message: blocked
      ? "Reported and blocked. Thank you — somebody will look at this."
      : "Reported. Thank you — somebody will look at this.",
  };
}
