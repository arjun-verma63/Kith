"use client";

import { channels } from "@/lib/supabase/realtime";
import { subscribeToTopic } from "@/lib/supabase/shared-channel";

/**
 * The personal bus, `user:{id}`.
 *
 * Incoming calls, notifications, and each player's private half of a game's
 * state all arrive here. Several components listen at once, which is why the
 * subscription is shared rather than one channel each — see `shared-channel.ts`
 * for why that matters.
 *
 * Read-only from a browser: things are delivered TO you here, and nobody —
 * including you — broadcasts into it (migration 0009). Hence no `send`.
 */
export function subscribeToUserEvents(
  userId: string,
  listeners: Record<string, (payload: unknown) => void>,
): () => void {
  const subscription = subscribeToTopic(channels.user(userId), listeners);
  return subscription.unsubscribe;
}
