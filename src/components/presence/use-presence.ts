"use client";

import { usePresenceContext } from "@/components/presence/provider";
import {
  derivePresence,
  describeLastSeen,
  type DeclaredStatus,
  type PresenceState,
} from "@/lib/presence";

/**
 * The one place live presence and stored presence are reconciled.
 *
 * Resolution order, and every step of it matters:
 *
 *   1. A DECLARED status wins outright. `invisible` reads as offline even to a
 *      client that can see the person on the channel, and `away`/`busy` read as
 *      cooling however active they are. A privacy control a fast socket can
 *      override is not a control.
 *
 *   2. If there IS a live map, it is authoritative — INCLUDING absence. Somebody
 *      not in the presence set is offline, full stop. This is what makes the
 *      feature honest: with a live connection we know, and we do not soften the
 *      answer with a heartbeat from four minutes ago.
 *
 *   3. If there is NO live map (`null`), fall back to `last_seen_at`. That is
 *      server rendering, a dropped socket, or Supabase being unreachable — a
 *      best guess, clearly labelled as one by the timestamp it comes from.
 *
 * Steps 2 and 3 differ precisely on what absence means, which is why the
 * provider distinguishes an empty map from a null one.
 */

export interface PresenceSubject {
  userId: string;
  status: DeclaredStatus;
  lastSeenAt: string | null;
}

export function usePresence({ userId, status, lastSeenAt }: PresenceSubject): PresenceState {
  const { live } = usePresenceContext();

  if (status === "invisible") return "dark";
  if (status === "away" || status === "busy") return "cooling";

  if (live !== null) {
    const activity = live[userId];
    if (activity === "online") return "lit";
    if (activity === "idle") return "cooling";
    return "dark";
  }

  return derivePresence({ status, lastSeenAt });
}

/** The words beside the light. Same resolution order, same guarantees. */
export function usePresenceLabel(subject: PresenceSubject): string {
  const { live } = usePresenceContext();
  const state = usePresence(subject);

  if (subject.status === "invisible") return "Offline";
  if (subject.status === "busy") return "Busy";
  if (subject.status === "away") return "Away";

  if (live !== null) {
    if (state === "lit") return "Online";
    if (state === "cooling") return "Idle";
    // Live connection, and they are not on it. `last_seen_at` still says WHEN,
    // even though the presence set has already settled WHETHER.
    return describeLastSeen({ status: subject.status, lastSeenAt: subject.lastSeenAt });
  }

  return describeLastSeen({ status: subject.status, lastSeenAt: subject.lastSeenAt });
}

/** How many of a given set of people are currently connected. */
export function useOnlineCount(userIds: readonly string[]): { online: number; known: boolean } {
  const { live } = usePresenceContext();

  if (live === null) return { online: 0, known: false };

  return {
    online: userIds.filter((id) => live[id] === "online" || live[id] === "idle").length,
    known: true,
  };
}
