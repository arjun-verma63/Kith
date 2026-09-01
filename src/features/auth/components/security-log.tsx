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
};

/** Only the ones worth noticing get colour. */
const ALARMING = new Set(["mfa.challenge_failed", "mfa.disabled"]);

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
