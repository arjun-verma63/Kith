import type { Route } from "next";

import type { AppNotification, NotificationKind } from "@/features/notifications/queries";

/**
 * Turning a notification row into a sentence and a destination.
 *
 * Kept out of the component so both are one lookup rather than two switch
 * statements that can disagree about which kinds exist — and so adding a kind is
 * a compile error here rather than a notification that renders as blank text
 * with no link.
 */

/** A `payload` field, only if it is actually a string. */
function field(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

export interface DescribedNotification {
  /** The bold half — usually who did it. */
  actor: string;
  /** The rest of the sentence. */
  action: string;
  /**
   * Where it goes, or null when the destination does not exist yet.
   *
   * Null renders a non-interactive row rather than a link to a 404. A
   * notification about a feature that has not shipped is still worth showing —
   * it just has nowhere to send you.
   *
   * Typed as `Route` because `typedRoutes` cannot check a path assembled from a
   * uuid at runtime. Every value below is either a literal route or one of those
   * literals with an id appended, so the assertion is sound; a conversation that
   * no longer exists renders the 404, which is the correct outcome.
   */
  href: Route | null;
}

export function describeNotification(notification: AppNotification): DescribedNotification {
  const actor = notification.actor?.displayName ?? "Someone";
  const payload = notification.payload;

  switch (notification.kind) {
    case "friend_request":
      return { actor, action: "wants to add you", href: "/friends" };

    case "friend_accepted":
      return { actor, action: "accepted your request", href: "/friends" };

    case "message": {
      const conversation = field(payload, "conversation_id");
      return {
        actor,
        action: "sent you a message",
        href: conversation ? (`/messages/${conversation}` as Route) : null,
      };
    }

    case "call_missed": {
      const conversation = field(payload, "conversation_id");
      return {
        actor,
        action: "called you",
        // Calls have no destination of their own yet, so this lands in the
        // conversation the call belonged to — which is where you would reply.
        href: conversation ? (`/messages/${conversation}` as Route) : null,
      };
    }

    case "game_invite": {
      const session = field(payload, "session_id");
      return {
        actor,
        action: "started a game",
        href: session ? (`/games/${session}` as Route) : "/games",
      };
    }

    case "couple_request":
      return {
        actor,
        action: payload["accepted"] === true ? "accepted your proposal" : "asked to pair with you",
        href: null,
      };

    case "couple_prompt":
      return { actor: "Today's question", action: "is waiting for you", href: null };

    case "system":
      return {
        actor: "KITH",
        action: field(payload, "body") ?? "has an update for you",
        href: null,
      };

    default: {
      // Exhaustiveness: adding a kind to the enum without handling it here is a
      // compile error, not a blank row in production.
      const exhaustive: never = notification.kind;
      return { actor: "KITH", action: String(exhaustive), href: null };
    }
  }
}

/** Coarse relative time. A notification list is not an audit log. */
export function describeAge(iso: string, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);

  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The ember colour a kind carries in the panel. */
export function toneFor(kind: NotificationKind): "ember" | "moss" | "signal" | "ice" | "plum" {
  switch (kind) {
    case "friend_accepted":
      return "moss";
    case "call_missed":
      return "signal";
    case "game_invite":
      return "ice";
    case "couple_request":
    case "couple_prompt":
      return "plum";
    default:
      return "ember";
  }
}
