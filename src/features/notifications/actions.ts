"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { listNotifications, type AppNotification } from "@/features/notifications/queries";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * Notification mutations.
 *
 * There is no "create" action, and there cannot be: `notifications` has no
 * INSERT policy. Everything in the table arrived from a SECURITY DEFINER
 * trigger, which is what stops one account writing into another's feed.
 *
 * Marking read is SECURITY INVOKER, so passing somebody else's notification id
 * matches no rows rather than marking it — the check is the policy, not the
 * absence of a way to try.
 */

const uuid = z.uuid();

export async function markNotificationsReadAction(ids?: string[]): Promise<number> {
  const user = await getCurrentUser();
  if (!user) return 0;

  const parsed = ids ? z.array(uuid).safeParse(ids) : null;
  if (ids && !parsed?.success) return 0;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("mark_notifications_read", {
    p_ids: parsed?.data ?? null,
  });

  if (error) return 0;

  // The badge is server-rendered in the app shell.
  revalidatePath("/", "layout");
  return typeof data === "number" ? data : 0;
}

export async function dismissNotificationAction(id: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;

  const parsed = uuid.safeParse(id);
  if (!parsed.success) return false;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("notifications").delete().eq("id", parsed.data);

  if (error) return false;

  revalidatePath("/", "layout");
  return true;
}

/** Re-reads the panel after a realtime arrival. */
export async function refreshNotificationsAction(): Promise<AppNotification[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  return listNotifications();
}
