import { Panel } from "@/components/ui/panel";
import type { SecurityEventRow } from "@/features/auth/mfa-queries";

/**
 * What has happened to this account's security, newest first.
 *
 * Server-rendered and read-only. It exists because the useful question after
 * "is two-factor on" is "did anybody else try", and a failed challenge is the
 * one signal that somebody has your password. Written by the server through the
 * service role and closed to the API, so a compromised account cannot tidy up
 * after itself — see `recordSecurityEvent`.
 */

const LABELS: Record<string, string> = {
  "mfa.enroll_started": "Started setting up an authenticator",
  "mfa.enroll_cancelled": "Abandoned setting up an authenticator",
  "mfa.enabled": "Turned on two-factor authentication",
  "mfa.factor_removed": "Removed an authenticator",
  "mfa.disabled": "Turned off two-factor authentication",
  "mfa.challenge_failed": "A code was rejected",
  "mfa.challenge_passed": "Signed in with a code",
  "password.changed": "Changed the password",
  "password.change_failed": "A password change was refused",
  "password.reset": "Reset the password from a link sent by email",
  "email.change_requested": "Asked to change the email address",
  "email.change_failed": "An email change was refused",
  "sessions.revoked_others": "Signed out every other device",
  "account.deleted": "Deleted the account",
  "account.delete_failed": "An account deletion was refused",
};

/**
 * The ones worth a second look.
 *
 * Every entry here is a failed attempt or a reduction in security — the two
 * shapes of "somebody may have half of what they need". Successes stay quiet so
 * that the coloured lines mean something.
 */
const ALARMING = new Set([
  "mfa.challenge_failed",
  "mfa.disabled",
  "password.change_failed",
  "email.change_failed",
  "account.delete_failed",
]);

export function SecurityLog({ events }: { events: SecurityEventRow[] }) {
  if (events.length === 0) return null;

  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <header className="border-b border-line px-4 py-3">
        <span className="label text-fg-faint">Recent security activity</span>
      </header>

      <ul className="flex flex-col">
        {events.map((event) => (
          <li
            key={event.id}
            className="flex items-baseline gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
          >
            <span
              className={
                ALARMING.has(event.event)
                  ? "min-w-0 flex-1 text-sm text-signal"
                  : "min-w-0 flex-1 text-sm text-fg"
              }
            >
              {LABELS[event.event] ?? event.event}
            </span>
            <time
              dateTime={event.createdAt}
              className="numeric shrink-0 text-2xs text-fg-faint tabular-nums"
            >
              {new Date(event.createdAt).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
