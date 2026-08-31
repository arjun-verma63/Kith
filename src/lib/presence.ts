/**
 * Presence, as pure functions.
 *
 * Lives in `lib/` rather than in a feature because three features need it —
 * friends, profile, and messages next — and a feature importing another feature
 * is how a dependency graph turns into a knot. Everything here is a pure
 * function of its arguments with no I/O, so it runs identically in a server
 * component, a client component and a test.
 *
 * The realtime layer sits on top of this in `features/presence/`. This file
 * answers "what does this data mean"; that one answers "who is connected right
 * now".
 */

/**
 * The three states the whole product speaks in.
 *
 * Named for the design system's central motif rather than for network status,
 * because that is what they encode: presence is light. `cooling` covers both
 * "idle" and "deliberately away" — the distinction matters to the person
 * setting it, not to the person reading it.
 */
export type PresenceState = "lit" | "cooling" | "dark";

/** The durable statuses a person can choose. Mirrors the presence_status enum. */
export type DeclaredStatus = "auto" | "active" | "away" | "busy" | "invisible";

/** Seen within this window and you are lit. */
const LIT_WINDOW_MS = 2 * 60 * 1000;

/** Beyond LIT and within this, the light is cooling. */
const COOLING_WINDOW_MS = 15 * 60 * 1000;

export interface PresenceInput {
  status: DeclaredStatus;
  lastSeenAt: string | Date | null;
  /** Injectable so tests are not at the mercy of the wall clock. */
  now?: Date;
}

/**
 * Presence from stored data alone.
 *
 * This is the FALLBACK path: what to show when there is no live connection —
 * during server rendering, before the socket opens, and while it is down. When
 * the realtime layer has an answer, it wins, because "is this person connected"
 * is a question a heartbeat can only approximate.
 *
 * Two inputs, and the order between them is the design:
 *
 *   `status` is what someone DECLARED. A deliberate statement.
 *   `lastSeenAt` is what was OBSERVED. A throttled heartbeat the client cannot
 *   write for itself.
 *
 * The declaration wins. `invisible` in particular must be absolute — a derived
 * "but the heartbeat says they are here" would make the setting a lie, and a
 * privacy control that leaks is worse than none because people rely on it.
 */
export function derivePresence({
  status,
  lastSeenAt,
  now = new Date(),
}: PresenceInput): PresenceState {
  if (status === "invisible") return "dark";
  if (status === "away" || status === "busy") return "cooling";
  if (lastSeenAt === null) return "dark";

  const seen = typeof lastSeenAt === "string" ? new Date(lastSeenAt) : lastSeenAt;
  const elapsed = now.getTime() - seen.getTime();

  if (Number.isNaN(elapsed)) return "dark";
  if (elapsed < LIT_WINDOW_MS) return "lit";
  if (elapsed < COOLING_WINDOW_MS) return "cooling";

  // `active` is a declaration too, but a stale one. Somebody who set "active"
  // and closed their laptop three days ago is not active, and saying otherwise
  // would make every light in the room meaningless.
  return "dark";
}

/**
 * "Online", "5 minutes ago", "Yesterday".
 *
 * Deliberately coarse. Presence is a signal about whether it is worth saying
 * hello, not a log of somebody's evening, and a to-the-second record of when a
 * friend last opened the app is more than the feature needs.
 */
export function describeLastSeen(input: PresenceInput): string {
  const presence = derivePresence(input);
  if (presence === "lit") return "Online";
  if (input.status === "invisible") return "Offline";
  if (input.status === "busy") return "Busy";
  if (input.status === "away") return "Away";
  if (input.lastSeenAt === null) return "Offline";

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
