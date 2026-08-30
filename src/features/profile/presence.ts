import type { PresenceState } from "@/components/ui/presence-ember";
import type { ProfileStatus } from "@/features/profile/schema";

/**
 * Deriving online state.
 *
 * Two inputs, and the order between them is the whole design:
 *
 *   `status` is what someone has DECLARED. Away, busy, invisible — a deliberate
 *   statement about how they want to be seen.
 *
 *   `last_seen_at` is what was OBSERVED. A throttled heartbeat, written by the
 *   database and not settable by the client.
 *
 * The declaration wins, because presence is a courtesy to other people rather
 * than surveillance of them. `invisible` in particular must be absolute: a
 * derived "but the heartbeat says they are here" would make the setting a lie,
 * and a privacy control that leaks is worse than none because people rely on it.
 *
 * A pure function of two values with no I/O, so it can be used in a server
 * component, a client component, or a test without ceremony.
 */

/** Seen within this window and you are lit. */
const LIT_WINDOW_MS = 2 * 60 * 1000;

/** Beyond LIT and within this, the light is cooling. */
const COOLING_WINDOW_MS = 15 * 60 * 1000;

export interface PresenceInput {
  status: ProfileStatus;
  lastSeenAt: string | Date;
  /** Injectable so tests are not at the mercy of the wall clock. */
  now?: Date;
}

export function derivePresence({
  status,
  lastSeenAt,
  now = new Date(),
}: PresenceInput): PresenceState {
  // Declared states short-circuit. Nothing observed overrides them.
  if (status === "invisible") return "dark";
  if (status === "away" || status === "busy") return "cooling";

  const seen = typeof lastSeenAt === "string" ? new Date(lastSeenAt) : lastSeenAt;
  const elapsed = now.getTime() - seen.getTime();

  // A clock skewed into the future should not read as offline.
  if (Number.isNaN(elapsed)) return "dark";
  if (elapsed < LIT_WINDOW_MS) return "lit";
  if (elapsed < COOLING_WINDOW_MS) return "cooling";

  // `active` is a declaration too, but a stale one. Somebody who set "active"
  // and closed their laptop three days ago is not active, and saying otherwise
  // would make every light in the rail meaningless.
  return "dark";
}

/**
 * "Online", "5 minutes ago", "Tuesday".
 *
 * Deliberately coarse. Presence is a signal about whether it is worth saying
 * hello, not a log of somebody's evening, and a to-the-second timestamp of when
 * a friend last opened the app is more information than the feature needs.
 */
export function describeLastSeen(input: PresenceInput): string {
  const presence = derivePresence(input);
  if (presence === "lit") return "Online";
  if (input.status === "invisible") return "Offline";
  if (input.status === "busy") return "Busy";
  if (input.status === "away") return "Away";

  const now = input.now ?? new Date();
  const seen = typeof input.lastSeenAt === "string" ? new Date(input.lastSeenAt) : input.lastSeenAt;
  const minutes = Math.floor((now.getTime() - seen.getTime()) / 60000);

  if (Number.isNaN(minutes)) return "Offline";
  if (minutes < 60) return `${Math.max(minutes, 1)} minutes ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "An hour ago" : `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return "A while ago";
}

/** Day and month only. The year is stored but never rendered. */
export function formatBirthday(birthday: string | null): string | null {
  if (!birthday) return null;
  const [, month, day] = birthday.split("-").map(Number);
  if (!month || !day) return null;

  // A fixed reference year keeps this from depending on the current date.
  return new Date(Date.UTC(2000, month - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** "Since March 2026" — the join date, at the granularity anyone cares about. */
export function formatJoined(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
