import { z } from "zod";

import { displayNameSchema, usernameSchema } from "@/lib/validation";

/**
 * Profile validation.
 *
 * Reuses the username and display-name rules from the auth schema rather than
 * restating them. Two definitions of "what is a valid username" is one
 * definition too many: the signup form and the settings form would drift, and
 * the database constraint would end up refereeing.
 */

export const ACCENTS = ["ember", "lantern", "moss", "signal", "plum", "ice"] as const;
export const STATUSES = ["auto", "active", "away", "busy", "invisible"] as const;

export type Accent = (typeof ACCENTS)[number];
export type ProfileStatus = (typeof STATUSES)[number];

export const bioSchema = z
  .string()
  .trim()
  .max(280, "280 characters at most — this is a room, not a résumé.");

export const pronounsSchema = z.string().trim().max(24, "24 characters at most.");

export const statusTextSchema = z.string().trim().max(60, "60 characters at most.");

/**
 * Birthday as three separate fields rather than one `<input type="date">`.
 *
 * A native date input renders in the browser's locale, which means the same
 * form reads DD/MM to one person and MM/DD to another with nothing on screen to
 * say which. For a value nobody can sanity-check by looking at it, that is a
 * real source of wrong data.
 */
export const birthdaySchema = z
  .object({
    day: z.coerce.number().int().min(1).max(31),
    month: z.coerce.number().int().min(1).max(12),
    year: z.coerce.number().int().min(1900).max(new Date().getUTCFullYear()),
  })
  .refine(
    ({ day, month, year }) => {
      // Rejects 31 February and friends: JavaScript rolls them over rather than
      // failing, so the only reliable check is whether it came back unchanged.
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    },
    { message: "That date does not exist." },
  )
  .refine(({ day, month, year }) => Date.UTC(year, month - 1, day) <= Date.now(), {
    message: "A birthday cannot be in the future.",
  });

export const profileSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  bio: bioSchema,
  pronouns: pronounsSchema,
  accent: z.enum(ACCENTS),
  status: z.enum(STATUSES),
  statusText: statusTextSchema,
  birthday: z.union([birthdaySchema, z.null()]),
});

export type ProfileInput = z.infer<typeof profileSchema>;

/** Parses the three birthday inputs, treating "all blank" as "not given". */
export function parseBirthdayFields(
  day: FormDataEntryValue | null,
  month: FormDataEntryValue | null,
  year: FormDataEntryValue | null,
): { ok: true; value: { day: number; month: number; year: number } | null } | { ok: false } {
  const raw = [day, month, year].map((v) => (typeof v === "string" ? v.trim() : ""));

  if (raw.every((v) => v === "")) return { ok: true, value: null };
  if (raw.some((v) => v === "")) return { ok: false };

  const parsed = birthdaySchema.safeParse({ day: raw[0], month: raw[1], year: raw[2] });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/** `YYYY-MM-DD`, which is what a Postgres `date` column wants. */
export function toDateString(birthday: { day: number; month: number; year: number }): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${birthday.year}-${pad(birthday.month)}-${pad(birthday.day)}`;
}

/* -------------------------------------------------------------------------- */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MAX_EDGE = 512;
export const AVATAR_ACCEPT = ["image/webp", "image/jpeg", "image/png"] as const;

/**
 * Storage paths are `<userId>/<file>` and the storage policies key on that first
 * segment. The server re-derives it from the session rather than trusting the
 * path a client sends — a client-supplied path is a request to write into
 * somebody else's folder waiting to be granted.
 */
export function isOwnAvatarPath(path: string, userId: string): boolean {
  if (path.includes("..") || path.startsWith("/")) return false;
  const [prefix, file, ...rest] = path.split("/");
  if (rest.length > 0) return false;
  if (prefix !== userId) return false;
  return Boolean(file) && /^[A-Za-z0-9._-]+$/.test(file ?? "");
}
