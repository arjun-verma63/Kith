"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getMyCouple, listPrompts, type CouplePrompt } from "@/features/couple/queries";
import { promptFor } from "@/features/couple/prompts";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * Couple mutations.
 *
 * Thin wrappers over the RPCs in migration 0021. Nothing here decides who may do
 * what — `can_propose_to`, `respond_to_couple` and the rest check in SQL, and a
 * second copy of the rules in application code is a second copy that can be
 * wrong.
 *
 * The one exception is answering a prompt, which is a plain insert through the
 * caller's own client. That is deliberate: `couple_answers` has the policies
 * that make the mechanic work, and routing the write through a SECURITY DEFINER
 * function would mean re-implementing in PL/pgSQL exactly what the policy says.
 */

const uuid = z.uuid();

const answerSchema = z
  .string()
  .trim()
  .min(1, "Write something first.")
  .max(1000, "That is longer than the box allows.");

export type CoupleResult = { ok: true } | { ok: false; reason: string };

function explain(message: string | undefined): string {
  const text = message ?? "";

  if (text.includes("already_pending")) return "There is already a question waiting between you.";
  if (text.includes("cannot_answer_own_proposal")) return "They have to answer, not you.";
  if (text.includes("not_pending")) return "That has already been answered.";
  if (text.includes("couples_one_active_violation")) {
    return "One of you is already in a couple.";
  }
  if (text.includes("anniversary_in_future")) return "That date has not happened yet.";
  if (text.includes("not_active")) return "That couple is not active.";
  if (text.includes("not_permitted")) return "You cannot do that.";
  return "Something went wrong.";
}

/* ----------------------------------------------------------------- proposing */

/**
 * Asks somebody.
 *
 * Only ever reachable from the profile of an existing friend. There is no
 * search, no suggestion and no directory — the database requires a friendship
 * and no setting can widen that, which is the line between this and a dating
 * app.
 */
export async function proposeCoupleAction(userId: string): Promise<CoupleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(userId);
  if (!parsed.success) return { ok: false, reason: "That person could not be found." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("propose_couple", { other_user: parsed.data });

  if (error) return { ok: false, reason: explain(error.message) };

  revalidatePath("/couple");
  return { ok: true };
}

export async function respondToCoupleAction(
  coupleId: string,
  accept: boolean,
): Promise<CoupleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(coupleId);
  if (!parsed.success) return { ok: false, reason: "That could not be found." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("respond_to_couple", {
    p_couple_id: parsed.data,
    p_accept: accept,
  });

  if (error) return { ok: false, reason: explain(error.message) };

  revalidatePath("/couple");
  return { ok: true };
}

/**
 * Ends it.
 *
 * Either partner, without the other's agreement — a relationship one person has
 * left is not one, and requiring consent to leave would be a way of trapping
 * somebody. Nothing written is deleted; the couple simply stops being active.
 */
export async function endCoupleAction(coupleId: string): Promise<CoupleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(coupleId);
  if (!parsed.success) return { ok: false, reason: "That could not be found." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("end_couple", { p_couple_id: parsed.data });

  if (error) return { ok: false, reason: explain(error.message) };

  revalidatePath("/couple");
  return { ok: true };
}

/* ------------------------------------------------------------------ settings */

export async function setCoupleDetailsAction(
  coupleId: string,
  details: { anniversary?: string | null; visibility?: "private" | "friends" },
): Promise<CoupleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(coupleId);
  if (!parsed.success) return { ok: false, reason: "That could not be found." };

  const anniversary = details.anniversary?.trim();
  if (anniversary && !/^\d{4}-\d{2}-\d{2}$/.test(anniversary)) {
    return { ok: false, reason: "That is not a date." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_couple_details", {
    p_couple_id: parsed.data,
    p_anniversary: anniversary || null,
    p_visibility: details.visibility ?? null,
  });

  if (error) return { ok: false, reason: explain(error.message) };

  revalidatePath("/couple");
  return { ok: true };
}

/** Whether this person may be asked at all. Off by default is not the default. */
export async function setWhoCanProposeAction(scope: "friends" | "nobody"): Promise<CoupleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("user_settings")
    .update({ who_can_propose: scope })
    .eq("user_id", user.id);

  if (error) return { ok: false, reason: "That could not be saved." };

  revalidatePath("/couple");
  return { ok: true };
}

/* ------------------------------------------------------------------- prompts */

/**
 * Opens today's question, creating it if this is the first visit of the day.
 *
 * The text is chosen here rather than in SQL because prompt copy is writing, not
 * data. Both partners compute the same one from the same seed, and the unique
 * constraint on (couple, day) makes the race harmless regardless.
 */
export async function openTodaysPromptAction(coupleId: string): Promise<CouplePrompt[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const parsed = uuid.safeParse(coupleId);
  if (!parsed.success) return [];

  const supabase = await createSupabaseServerClient();
  await supabase.rpc("open_couple_prompt", {
    p_couple_id: parsed.data,
    p_question: promptFor(parsed.data),
  });

  return listPrompts(parsed.data);
}

export async function answerPromptAction(promptId: string, body: string): Promise<CoupleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "Sign in again." };

  const parsed = uuid.safeParse(promptId);
  if (!parsed.success) return { ok: false, reason: "That question could not be found." };

  const text = answerSchema.safeParse(body);
  if (!text.success) {
    return { ok: false, reason: text.error.issues[0]?.message ?? "Write something first." };
  }

  const supabase = await createSupabaseServerClient();

  // Straight through the caller's own client, so the policies on
  // `couple_answers` are what decide. `upsert` because changing your mind before
  // your partner has read it is fine — and once they have, the row they saw is
  // the row that mattered.
  const { error } = await supabase
    .from("couple_answers")
    .upsert(
      { prompt_id: parsed.data, user_id: user.id, body: text.data },
      { onConflict: "prompt_id,user_id" },
    );

  if (error) return { ok: false, reason: "That could not be saved." };

  revalidatePath("/couple");
  return { ok: true };
}

/** Re-reads everything the couple page shows. */
export async function refreshCoupleAction(): Promise<{
  couple: Awaited<ReturnType<typeof getMyCouple>>;
  prompts: CouplePrompt[];
}> {
  const user = await getCurrentUser();
  if (!user) return { couple: null, prompts: [] };

  const couple = await getMyCouple();
  return { couple, prompts: couple ? await listPrompts(couple.id) : [] };
}
