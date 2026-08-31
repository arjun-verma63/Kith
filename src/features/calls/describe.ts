import type { CallHistoryEntry } from "@/features/calls/queries";

/**
 * Turning a call row into something a person would say.
 *
 * Separate from the components so the log and the overlay cannot drift into
 * describing the same call two different ways, and so adding an end reason is a
 * compile error here rather than a blank row in the history.
 */

/** mm:ss, or h:mm:ss once a call runs long. Monospace-friendly. */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;

  const pad = (n: number) => n.toString().padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export type CallTone = "moss" | "signal" | "fg-faint";

export interface DescribedCall {
  /** "Outgoing", "Missed", … */
  label: string;
  /** "4:21", "No answer", … */
  detail: string;
  direction: "in" | "out";
  tone: CallTone;
}

export function describeCall(call: CallHistoryEntry): DescribedCall {
  const direction = call.isInitiator ? "out" : "in";

  switch (call.status) {
    case "ended":
      return {
        label: call.isInitiator ? "Outgoing" : "Incoming",
        detail: call.durationSeconds === null ? "Ended" : formatDuration(call.durationSeconds),
        direction,
        tone: "moss",
      };

    case "missed":
      // A call the initiator abandoned reads differently from one that rang out,
      // and only one of them is the other person's fault.
      return {
        label: call.isInitiator ? "No answer" : "Missed",
        detail: call.endReason === "cancelled" ? "Cancelled" : "Rang out",
        direction,
        tone: call.isInitiator ? "fg-faint" : "signal",
      };

    case "declined":
      return {
        label: call.isInitiator ? "Declined" : "You declined",
        detail: "Declined",
        direction,
        tone: "fg-faint",
      };

    case "ringing":
    case "active":
      return { label: "In progress", detail: "Live", direction, tone: "moss" };

    default: {
      const exhaustive: never = call.status;
      return { label: String(exhaustive), detail: "", direction, tone: "fg-faint" };
    }
  }
}

/** "Today", "Yesterday", "14 Mar" — the day heading in the log. */
export function formatCallDay(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-GB", { weekday: "long" });

  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function formatCallTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** What the overlay says under the name while a call is coming together. */
export function describeConnection(
  state: "new" | "connecting" | "connected" | "reconnecting" | "failed" | "closed",
): string {
  switch (state) {
    case "connecting":
    case "new":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "failed":
      return "Connection lost";
    case "closed":
      return "Call ended";
    case "connected":
      return "";
    default: {
      const exhaustive: never = state;
      return String(exhaustive);
    }
  }
}
