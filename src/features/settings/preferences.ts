import { z } from "zod";

/**
 * `user_settings`, as the settings pages see it.
 *
 * ── Why this is one slice ────────────────────────────────────────────────────
 *
 * `user_settings` had accumulated writers in three different features — couple
 * wrote `who_can_propose`, auth wrote the privacy scopes, and notifications
 * would have wanted `notification_prefs`. One table with three owners is a table
 * whose defaults drift and whose forms overwrite each other.
 *
 * So the whole row lives here, in one slice, with one read and three writes
 * grouped by the section that shows them.
 *
 * ── The rule this file exists to keep ────────────────────────────────────────
 *
 * EVERY CONTROL DOES SOMETHING. A settings page whose switches are decorative is
 * worse than no settings page, because it makes a promise the app does not keep.
 * Each group below names where it is honoured, and the suite asserts those
 * places exist.
 */

/* ------------------------------------------------------------------ privacy */

export const PERMISSION_SCOPES = ["everyone", "friends", "nobody"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export const SCOPE_LABELS: Record<PermissionScope, string> = {
  everyone: "Everyone",
  friends: "Friends",
  nobody: "Nobody",
};

export interface PrivacyPreferences {
  discoverable: boolean;
  whoCanMessage: PermissionScope;
  whoCanCall: PermissionScope;
  whoCanPropose: PermissionScope;
  showBirthday: PermissionScope;
  typingIndicators: boolean;
}

const scope = z.enum(PERMISSION_SCOPES);

export const privacySchema = z.object({
  discoverable: z.boolean(),
  whoCanMessage: scope,
  whoCanCall: scope,
  whoCanPropose: scope,
  showBirthday: scope,
  typingIndicators: z.boolean(),
});

/**
 * Every privacy control, and the thing that honours it.
 *
 * `enforcedBy` is not documentation — the suite looks each one up in `pg_proc`,
 * which is how a control could not ship pointing at a function that does not
 * exist. It caught a wrong name the first time it ran.
 *
 * `typingIndicators` is the exception and says so: it is honoured by the client
 * that would otherwise broadcast, because that is the only place it CAN be
 * honoured. You cannot stop somebody else's browser sending a keystroke event —
 * but this setting is about your own, and your own is exactly what the client
 * controls.
 */
export const PRIVACY_CONTROLS = [
  {
    key: "discoverable",
    label: "Findable in search",
    help: "When this is off, only people you are already friends with can find you.",
    enforcedBy: "search_profiles",
  },
  {
    key: "whoCanMessage",
    label: "Who can start a conversation",
    help: "Existing threads keep working whatever this says. It governs new ones.",
    enforcedBy: "can_open_conversation_with",
  },
  {
    key: "whoCanCall",
    label: "Who can call you",
    help: "Direct calls. In a group thread, anybody in it can start a call.",
    enforcedBy: "can_call_conversation",
  },
  {
    key: "whoCanPropose",
    label: "Who can ask you to be their partner",
    help: "Couple mode is optional. Nobody switches it off entirely.",
    enforcedBy: "can_propose_to",
  },
  {
    key: "showBirthday",
    label: "Who can see your birthday",
    help: "A full date of birth is the answer to a security question somewhere else.",
    enforcedBy: "get_profile",
  },
] as const satisfies readonly {
  key: keyof PrivacyPreferences;
  label: string;
  help: string;
  enforcedBy: string;
}[];

/* ------------------------------------------------------------ notifications */

/**
 * The kinds somebody can switch off.
 *
 * `system` is in the database enum and deliberately absent here: it is how the
 * app says something that is not about another person, and a preference that can
 * silence it is a preference that hides the one message somebody needs to see.
 * `notification_enabled` refuses to suppress it regardless of what is stored.
 */
export const NOTIFICATION_KINDS = [
  "message",
  "friend_request",
  "friend_accepted",
  "call_missed",
  "game_invite",
  "couple_request",
  "couple_prompt",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_LABELS: {
  key: NotificationKind;
  label: string;
  help: string;
}[] = [
  {
    key: "message",
    label: "Messages",
    help: "One per conversation until you have read it, not one per message.",
  },
  { key: "friend_request", label: "Friend requests", help: "When somebody asks." },
  { key: "friend_accepted", label: "Accepted requests", help: "When somebody says yes." },
  { key: "call_missed", label: "Missed calls", help: "Only the ones you did not answer." },
  {
    key: "game_invite",
    label: "Game invitations",
    help: "When somebody starts one with you in it.",
  },
  { key: "couple_request", label: "Couple invitations", help: "Only ever from a friend." },
  {
    key: "couple_prompt",
    label: "The daily question",
    help: "When today's couple question opens.",
  },
];

export type NotificationPreferences = Record<NotificationKind, boolean>;

export const notificationSchema = z.object(
  Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, z.boolean()])) as Record<
    NotificationKind,
    z.ZodBoolean
  >,
);

/**
 * Stored preferences, read with "absent means on".
 *
 * The column is `{}` for everybody who has never opened this page, so a missing
 * key cannot mean off — that would have shipped this feature by silently muting
 * every notification in the app. Mirrors `notification_enabled` in migration
 * 0027, which applies the same rule in SQL.
 */
export function readNotificationPrefs(raw: unknown): NotificationPreferences {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  return Object.fromEntries(
    NOTIFICATION_KINDS.map((kind) => [kind, stored[kind] !== false]),
  ) as NotificationPreferences;
}

/* -------------------------------------------------------------- appearance */

export const THEME_PREFERENCES = ["dusk", "daylight", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const MOTION_PREFERENCES = ["full", "reduced", "off"] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

export const THEME_OPTIONS: { key: ThemePreference; label: string; help: string }[] = [
  { key: "dusk", label: "Dusk", help: "The room at night. The default." },
  { key: "daylight", label: "Daylight", help: "The same room with the curtains open." },
  { key: "system", label: "Match my device", help: "Follow whatever the operating system says." },
];

/**
 * Three motion tiers, and what each honestly does.
 *
 * `full` does not override a system-level reduced-motion preference, and the
 * copy says so. An app setting that can switch an accessibility preference back
 * on is one that should not exist — somebody who has asked their operating
 * system for calm is not asking KITH to argue.
 */
export const MOTION_OPTIONS: { key: MotionPreference; label: string; help: string }[] = [
  {
    key: "full",
    label: "Full",
    help: "Everything animates — unless your device asks for reduced motion, which wins.",
  },
  {
    key: "reduced",
    label: "Reduced",
    help: "Things change without sliding. Ambient loops hold still.",
  },
  { key: "off", label: "None", help: "Nothing moves at all." },
];

export interface AppearancePreferences {
  theme: ThemePreference;
  motion: MotionPreference;
}

export const appearanceSchema = z.object({
  theme: z.enum(THEME_PREFERENCES),
  motion: z.enum(MOTION_PREFERENCES),
});

/* -------------------------------------------------------------------- all */

export interface Preferences extends PrivacyPreferences, AppearancePreferences {
  notifications: NotificationPreferences;
}

/**
 * What the browser should apply, given a stored theme.
 *
 * `system` is not an attribute value — the stylesheet only knows `dusk` and
 * `daylight` — so it resolves against `prefers-color-scheme` here. Kept pure and
 * shared so the inline bootstrap script and the settings form cannot disagree
 * about what "match my device" means.
 */
export function resolveTheme(theme: ThemePreference, prefersDark: boolean): "dusk" | "daylight" {
  if (theme === "dusk" || theme === "daylight") return theme;
  return prefersDark ? "dusk" : "daylight";
}
