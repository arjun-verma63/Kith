import { z } from "zod";

import { passwordSchema } from "@/features/auth/schema";

/**
 * The Security page's vocabulary, and the rules about what it may show.
 *
 * Pure and client-safe on purpose: every decision here is about what a person is
 * allowed to see about their own account, and those decisions are worth being
 * able to test without a database in the way.
 *
 * ── What this page must not put on a screen ──────────────────────────────────
 *
 * A security page is the one place in an app where the useful information and
 * the dangerous information are the same information. The rules, and each one
 * exists because the obvious implementation breaks it:
 *
 *   NO TOKENS, EVER. Not the access token, not the refresh token, not a session
 *   id. `list_my_sessions` does not select them and there is nowhere in the UI
 *   they could be rendered. A session id is not a credential, but it is the
 *   handle to one, and there is no question on this page it helps answer.
 *
 *   NO RAW USER AGENT. It is a fingerprint written by the browser and it is
 *   ugly. `describeDevice` reduces it to the two facts a person actually uses to
 *   recognise a session — roughly what browser, roughly what kind of machine.
 *
 *   COARSE ADDRESSES ONLY. `coarsenIp` drops the last octet. That is enough to
 *   tell home from the office from somewhere you have never been, which is the
 *   whole question, and not enough to be worth harvesting out of a screenshot
 *   pasted into a support thread.
 *
 *   NO OTHER ACCOUNT, AT ALL. Everything here is scoped in SQL to `auth.uid()`,
 *   not filtered in TypeScript.
 */

/* --------------------------------------------------------------- sessions */

export interface SessionSummary {
  /** Stable within a render, for React keys. Never displayed. */
  key: string;
  device: string;
  /** Coarsened. Null when the address was absent or unparseable. */
  location: string | null;
  startedAt: string;
  lastSeenAt: string;
  /** This browser, right now. Matched on the `session_id` claim. */
  isCurrent: boolean;
  /** Whether this session ever produced a second factor. */
  strong: boolean;
}

/**
 * An address, blunted.
 *
 * IPv4 loses its last octet, IPv6 keeps the first three groups. The result is a
 * neighbourhood rather than a doorstep: `203.0.113.x` still answers "was that
 * me?" and no longer answers "where exactly is that person".
 *
 * Anything that is not recognisably an address becomes null rather than being
 * echoed. The value arrives from a proxy header, so it is attacker-influenced
 * text and must not be rendered on trust.
 */
export function coarsenIp(ip: string | null | undefined): string | null {
  if (!ip) return null;

  const value = ip.trim();

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const octets = [v4[1], v4[2], v4[3]].map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n > 255)) return null;
    return `${octets.join(".")}.x`;
  }

  if (value.includes(":") && /^[0-9a-fA-F:]+$/.test(value)) {
    const groups = value.split(":").filter(Boolean).slice(0, 3);
    return groups.length > 0 ? `${groups.join(":")}:…` : null;
  }

  return null;
}

/**
 * A user agent, reduced to what somebody would say out loud.
 *
 * "Chrome on Windows" is what people check against their memory of where they
 * signed in. The full string is a fingerprint and belongs in a log, not on a
 * page that exists to be scanned quickly.
 *
 * Deliberately a short list of substring checks rather than a UA-parsing
 * dependency: the failure mode of getting it slightly wrong is a slightly vague
 * label, which is a much smaller problem than a parser in the bundle.
 *
 * Order matters — Edge and Chrome both claim to be Safari, and Chrome claims to
 * be Safari too, so the most specific wins first.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";

  const ua = userAgent.toLowerCase();

  const browser =
    ua.includes("edg/") || ua.includes("edga/")
      ? "Edge"
      : ua.includes("opr/") || ua.includes("opera")
        ? "Opera"
        : ua.includes("firefox") || ua.includes("fxios")
          ? "Firefox"
          : ua.includes("crios") || ua.includes("chrome") || ua.includes("chromium")
            ? "Chrome"
            : ua.includes("safari")
              ? "Safari"
              : null;

  const platform = ua.includes("iphone")
    ? "iPhone"
    : ua.includes("ipad")
      ? "iPad"
      : ua.includes("android")
        ? "Android"
        : ua.includes("windows")
          ? "Windows"
          : ua.includes("mac os") || ua.includes("macintosh")
            ? "Mac"
            : ua.includes("cros")
              ? "ChromeOS"
              : ua.includes("linux")
                ? "Linux"
                : null;

  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return platform;
  return "Unknown device";
}

/* ---------------------------------------------------------------- deleting */

/**
 * Whether the typed confirmation matches.
 *
 * The username rather than a fixed phrase like "DELETE". A fixed phrase is
 * muscle memory after the second time somebody sees it in any app; their own
 * username has to be read off the screen, which is the pause the confirmation
 * exists to create.
 *
 * Trimmed and case-insensitive, because usernames are already
 * case-insensitively unique and failing somebody on a capital letter at this
 * point is spite rather than safety.
 */
export function confirmsDeletion(typed: string, username: string): boolean {
  return typed.trim().toLowerCase() === username.trim().toLowerCase();
}

/* ----------------------------------------------------------------- schemas */

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Those two passwords do not match.",
    path: ["confirmPassword"],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: "That is the password you already have.",
    path: ["newPassword"],
  });

/* ----------------------------------------------------------------- privacy */

export const PERMISSION_SCOPES = ["everyone", "friends", "nobody"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export interface PrivacySettings {
  discoverable: boolean;
  whoCanMessage: PermissionScope;
  whoCanCall: PermissionScope;
  whoCanPropose: PermissionScope;
}

const scope = z.enum(PERMISSION_SCOPES);

export const privacySchema = z.object({
  discoverable: z.boolean(),
  whoCanMessage: scope,
  whoCanCall: scope,
  whoCanPropose: scope,
});

/**
 * Every privacy control on the page, and the SQL that enforces each one.
 *
 * The table is here rather than in a comment because it is the check that keeps
 * this section honest: a control on this page with nothing in the `enforcedBy`
 * column would be a promise the database does not keep, which is worse than not
 * offering it. Three of these were already enforced; `who_can_call` was a column
 * nothing read until migration 0025 wired it into `start_call`.
 *
 * `read_receipts` and `typing_indicators` exist in `user_settings` and are
 * deliberately NOT here. Nothing reads them yet, and they are messaging
 * courtesies rather than access controls — they belong in a messaging settings
 * section, next to the code that would honour them.
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
    help: "Friends is the default. Nobody means existing threads keep working and no new ones open.",
    enforcedBy: "can_open_conversation_with",
  },
  {
    key: "whoCanCall",
    label: "Who can call you",
    help: "Applies to direct calls. In a group thread, anybody in it can start a call.",
    enforcedBy: "can_call_conversation",
  },
  {
    key: "whoCanPropose",
    label: "Who can ask you to be their partner",
    help: "Couple mode is optional. Nobody switches it off entirely.",
    enforcedBy: "can_propose_to",
  },
] as const satisfies readonly {
  key: keyof PrivacySettings;
  label: string;
  help: string;
  enforcedBy: string;
}[];
