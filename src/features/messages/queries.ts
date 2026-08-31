import "server-only";

import { cache } from "react";

import { BUCKETS, SIGNED_URL_TTL_SECONDS } from "@/lib/supabase/storage";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/**
 * Message reads.
 *
 * Everything goes through the cookie-bound client, so Row Level Security filters
 * it. There is no `where conversation_id in (my conversations)` anywhere in this
 * file and there must not be: `is_conversation_member()` already decides, and a
 * second copy of the rule in application code is a second copy that can be wrong.
 */

type Fn = Database["public"]["Functions"];

export type ConversationRow = Fn["list_conversations"]["Returns"][number];
export type MessageRow = Fn["list_messages"]["Returns"][number];

/** How many messages a page holds. Small enough to render instantly. */
export const PAGE_SIZE = 30;

async function signAvatars(paths: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))];
  if (unique.length === 0) return new Map();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(BUCKETS.avatars)
    .createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);

  const signed = new Map<string, string>();
  if (error || !data) return signed;

  for (const entry of data) {
    if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
  }
  return signed;
}

export interface ConversationSummary {
  id: string;
  kind: "dm" | "group";
  title: string | null;
  lastMessageAt: string | null;
  lastMessageBody: string | null;
  lastMessageSenderId: string | null;
  unreadCount: number;
  memberCount: number;
  other: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    status: string;
    lastSeenAt: string | null;
  } | null;
}

export const listConversations = cache(async (): Promise<ConversationSummary[]> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_conversations");

  if (error || !data) return [];

  const signed = await signAvatars(data.map((row) => row.other_avatar_path));

  return data.map((row) => ({
    id: row.conversation_id ?? "",
    kind: (row.kind ?? "dm") as "dm" | "group",
    title: row.title,
    lastMessageAt: row.last_message_at,
    lastMessageBody: row.last_message_body,
    lastMessageSenderId: row.last_message_sender_id,
    unreadCount: row.unread_count ?? 0,
    memberCount: row.member_count ?? 0,
    other: row.other_user_id
      ? {
          id: row.other_user_id,
          username: row.other_username ?? "",
          displayName: row.other_display_name ?? "",
          avatarUrl: row.other_avatar_path ? (signed.get(row.other_avatar_path) ?? null) : null,
          status: row.other_status ?? "auto",
          lastSeenAt: row.other_last_seen_at,
        }
      : null,
  }));
});

export interface Reaction {
  emoji: string;
  userIds: string[];
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string | null;
  body: string | null;
  replyToId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  senderUsername: string | null;
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
  reactions: Reaction[];
}

export interface MessagePage {
  messages: Message[];
  /** Cursor for the next (older) page. Null when the thread is exhausted. */
  cursor: { createdAt: string; id: string } | null;
}

/**
 * One page of a conversation, newest first.
 *
 * Keyset pagination: the cursor is a specific message, not a row offset. A
 * message arriving while somebody scrolls therefore cannot shift the window and
 * make a page repeat or skip — which is the bug offset pagination guarantees in
 * a feed that grows from the end you are reading.
 */
export async function listMessages(
  conversationId: string,
  cursor?: { createdAt: string; id: string },
): Promise<MessagePage> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc("list_messages", {
    p_conversation_id: conversationId,
    // Null, not undefined: the SQL default IS null and means "the newest page".
    // `exactOptionalPropertyTypes` is right to insist on the difference.
    p_before_created_at: cursor?.createdAt ?? null,
    p_before_id: cursor?.id ?? null,
    p_limit: PAGE_SIZE,
  });

  if (error || !data) return { messages: [], cursor: null };

  const signed = await signAvatars(data.map((row) => row.sender_avatar_path));

  const messages: Message[] = data.map((row) => ({
    id: row.id ?? "",
    conversationId: row.conversation_id ?? conversationId,
    senderId: row.sender_id,
    body: row.body,
    replyToId: row.reply_to_id,
    createdAt: row.created_at ?? new Date().toISOString(),
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    senderUsername: row.sender_username,
    senderDisplayName: row.sender_display_name,
    senderAvatarUrl: row.sender_avatar_path ? (signed.get(row.sender_avatar_path) ?? null) : null,
    reactions: parseReactions(row.reactions),
  }));

  // A full page means there is probably another. A short page means the thread
  // ended, and asking again would return nothing.
  const last = messages[messages.length - 1];
  const nextCursor =
    messages.length === PAGE_SIZE && last ? { createdAt: last.createdAt, id: last.id } : null;

  return { messages, cursor: nextCursor };
}

function parseReactions(value: unknown): Reaction[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const emoji = (entry as { emoji?: unknown }).emoji;
    const userIds = (entry as { user_ids?: unknown }).user_ids;
    if (typeof emoji !== "string" || !Array.isArray(userIds)) return [];
    return [{ emoji, userIds: userIds.filter((id): id is string => typeof id === "string") }];
  });
}

/** Conversation header data. Returns null when you are not a member. */
export const getConversation = cache(
  async (conversationId: string): Promise<ConversationSummary | null> => {
    const conversations = await listConversations();
    return conversations.find((c) => c.id === conversationId) ?? null;
  },
);
