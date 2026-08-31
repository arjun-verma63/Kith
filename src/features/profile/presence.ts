/**
 * Profile-specific formatting.
 *
 * The presence derivation itself moved to `lib/presence.ts` when a third
 * feature needed it. What stays here is the handful of formatters that are
 * genuinely about a profile.
 */

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
