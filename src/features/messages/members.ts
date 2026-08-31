import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Display names for everybody in a conversation, keyed by id.
 *
 * Needed because a realtime broadcast carries the message, not the sender's
 * profile — so when a message arrives the client has an id and nothing to render
 * beside it. Fetching the whole (small) member list once is cheaper and calmer
 * than a lookup per arriving message.
 *
 * RLS does the filtering: `conversation_members_select` returns nothing for a
 * conversation you are not in, so this cannot be used to enumerate a thread you
 * have no business seeing.
 */
export const listConversationMembers = cache(
  async (conversationId: string): Promise<Record<string, string>> => {
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase
      .from("conversation_members")
      .select("user_id")
      .eq("conversation_id", conversationId)
      .is("left_at", null);

    if (error || !data || data.length === 0) return {};

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, display_name")
      .in(
        "id",
        data.map((row) => row.user_id),
      );

    const names: Record<string, string> = {};
    for (const profile of profiles ?? []) names[profile.id] = profile.display_name;
    return names;
  },
);
