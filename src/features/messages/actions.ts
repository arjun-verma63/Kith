"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { listMessages, type MessagePage } from "@/features/messages/queries";
import type { FormState } from "@/lib/forms";
import { normaliseMessage } from "@/lib/text";
import { fromPostgrestError } from "@/lib/supabase/errors";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * Message mutations.
 *
 * The cookie-bound client throughout, never the admin client. Read the policies
 * in migration 0004 alongside this file — `messages_insert_member` already
 * requires membership, a matching `sender_id`, and the absence of a block in
 * either direction, and `messages_update_own` already pins edits to the sender.
 * Nothing here re-implements any of that; the database refuses first.
 *
 * There is no delete action that deletes. `deleted_at` is the delete: a hard
 * delete would break every reply anchored to the message and leave a hole in the
 * thread. The row survives, the text does not.
 */

const uuid = z.uuid("That conversation could not be found.");

function fail(message: string): FormState {
  return { status: "error", message };
}

/* ========================================================================== */

export async function sendMessageAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in again to send a message.");

  const conversation = uuid.safeParse(formData.get("conversationId"));
  if (!conversation.success) return fail("That conversation could not be found.");

  // Normalisation is server-side and unconditional. The composer applies the
  // same rules for feedback, but a server action must assume the form was never
  // rendered — and this is where invisible characters and bidi overrides are
  // stripped, before anything is stored rather than after.
  const normalised = normaliseMessage(formData.get("body"));

  if (!normalised.ok) {
    return fail(
      normalised.reason === "too_long"
        ? "That message is too long. 4000 characters at most."
        : "Write something first.",
    );
  }

  const replyTo = formData.get("replyToId");
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.from("messages").insert({
    conversation_id: conversation.data,
    sender_id: user.id,
    body: normalised.value,
    ...(typeof replyTo === "string" && replyTo !== "" ? { reply_to_id: replyTo } : {}),
  });

  if (error) {
    // 42501 covers both "not a member" and "blocked by a member". Not
    // distinguished: telling somebody which one applies is telling them
    // something about a person who does not want to hear from them.
    if (error.code === "42501") return fail("That message could not be sent.");
    return { ...fromPostgrestError(error, "sendMessage").error, status: "error" } as FormState;
  }

  // The thread updates over the realtime channel, so there is nothing to
  // revalidate there. The conversation LIST is server-rendered and shows a
  // preview and an unread count, which have both just changed.
  revalidatePath("/messages");

  return { status: "success", message: "" };
}

/**
 * Soft delete, by the sender only.
 *
 * `messages_update_own` restricts this to the sender. The explicit `sender_id`
 * filter below is not the enforcement — it is what turns "no rows matched" into
 * a message somebody can act on.
 */
export async function deleteMessageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in again to delete that.");

  const message = uuid.safeParse(formData.get("messageId"));
  if (!message.success) return fail("That message could not be found.");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("messages")
    .update({ deleted_at: new Date().toISOString(), body: null })
    .eq("id", message.data)
    .eq("sender_id", user.id)
    .is("deleted_at", null)
    .select("id");

  if (error) {
    return { ...fromPostgrestError(error, "deleteMessage").error, status: "error" } as FormState;
  }

  if (!data || data.length === 0) return fail("That message is not yours to delete.");

  revalidatePath("/messages");
  return { status: "success", message: "Deleted." };
}

/** Adds or removes your reaction. The database decides which. */
export async function toggleReactionAction(
  messageId: string,
  emoji: string,
): Promise<{ ok: boolean; added?: boolean }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false };

  const parsed = uuid.safeParse(messageId);
  if (!parsed.success) return { ok: false };

  // A short allowlist rather than "any string up to 16 characters". The column
  // would accept an arbitrary 16-character label, which is a way to write text
  // into somebody else's message.
  if (!REACTIONS.includes(emoji as (typeof REACTIONS)[number])) return { ok: false };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("toggle_reaction", {
    p_message_id: parsed.data,
    p_emoji: emoji,
  });

  if (error) return { ok: false };
  return { ok: true, added: data === true };
}

export const REACTIONS = ["🔥", "😂", "❤️", "👀", "✅", "😭"] as const;

/** Moves the read cursor to now. Forward only — enforced in SQL. */
export async function markReadAction(conversationId: string): Promise<void> {
  const parsed = uuid.safeParse(conversationId);
  if (!parsed.success) return;

  const supabase = await createSupabaseServerClient();
  await supabase.rpc("mark_conversation_read", { p_conversation_id: parsed.data });
  revalidatePath("/messages");
}

/** Re-reads the newest page. Used after a reaction or a delete changes a row. */
export async function refreshMessagesAction(conversationId: string): Promise<MessagePage> {
  const user = await getCurrentUser();
  if (!user) return { messages: [], cursor: null };

  const parsed = uuid.safeParse(conversationId);
  if (!parsed.success) return { messages: [], cursor: null };

  return listMessages(parsed.data);
}

/** Fetches an older page. Called by the thread when it scrolls to the top. */
export async function loadOlderMessagesAction(
  conversationId: string,
  cursor: { createdAt: string; id: string },
): Promise<MessagePage> {
  const user = await getCurrentUser();
  if (!user) return { messages: [], cursor: null };

  const parsed = uuid.safeParse(conversationId);
  if (!parsed.success) return { messages: [], cursor: null };

  // No membership check here: `list_messages` is SECURITY INVOKER and
  // `messages_select_member` filters it. A non-member gets an empty page, which
  // is the same thing they would get from an empty conversation — and revealing
  // nothing is the point.
  return listMessages(parsed.data, cursor);
}

/* ========================================================================== */

export async function startDirectMessageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in again to start a conversation.");

  const target = uuid.safeParse(formData.get("userId"));
  if (!target.success) return fail("That person could not be found.");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("start_dm", { other_user: target.data });

  if (error) {
    if (/not_permitted/.test(error.message)) {
      return fail("They are not accepting messages from you.");
    }
    return { ...fromPostgrestError(error, "startDm").error, status: "error" } as FormState;
  }

  revalidatePath("/messages");
  return { status: "success", message: String(data ?? "") };
}

export async function startGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in again to start a conversation.");

  const title = String(formData.get("title") ?? "").trim();
  if (title.length === 0 || title.length > 60) {
    return fail("Give the group a name, 60 characters at most.");
  }

  const ids = formData.getAll("memberIds").map(String);
  const parsed = z.array(uuid).min(1, "Pick at least one person.").safeParse(ids);
  if (!parsed.success) return fail("Pick at least one person to add.");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("start_group", {
    p_title: title,
    p_member_ids: parsed.data,
  });

  if (error) {
    if (/not_permitted/.test(error.message)) {
      return fail("One of those people is not accepting messages from you.");
    }
    return { ...fromPostgrestError(error, "startGroup").error, status: "error" } as FormState;
  }

  revalidatePath("/messages");
  return { status: "success", message: String(data ?? "") };
}
