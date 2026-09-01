import "server-only";

import { cache } from "react";

import { signAvatars } from "@/lib/supabase/avatars";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/**
 * Notification reads.
 *
 * `notifications_select_own` is what restricts these to your own feed, so there
 * is no `where user_id = me` in this file. One rule, in one place.
 */

export type NotificationKind = Database["public"]["Enums"]["notification_kind"];

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
  actor: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
}

/**
 * The panel's contents.
 *
 * Capped at thirty. A notification list is a thing you glance at, not an
 * archive — and the ones that matter are all at the top by construction.
 */
export const listNotifications = cache(async (): Promise<AppNotification[]> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_notifications", { p_limit: 30 });

  if (error || !data) return [];

  const signed = await signAvatars(data.map((row) => row.actor_avatar_path));

  return data.map((row) => ({
    id: row.id ?? "",
    kind: (row.kind ?? "system") as NotificationKind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    readAt: row.read_at,
    createdAt: row.created_at ?? new Date().toISOString(),
    actor: row.actor_id
      ? {
          id: row.actor_id,
          username: row.actor_username ?? "",
          displayName: row.actor_display_name ?? "Someone",
          avatarUrl: row.actor_avatar_path ? (signed.get(row.actor_avatar_path) ?? null) : null,
        }
      : null,
  }));
});

/**
 * The badge number.
 *
 * A count query rather than `listNotifications().filter(...)`: the badge is
 * rendered on every authenticated page and does not need thirty rows and their
 * avatars to say "3".
 */
export const countUnreadNotifications = cache(async (): Promise<number> => {
  const supabase = await createSupabaseServerClient();
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);

  if (error) return 0;
  return count ?? 0;
});
