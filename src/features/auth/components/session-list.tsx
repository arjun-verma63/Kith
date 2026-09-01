"use client";

import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Panel } from "@/components/ui/panel";
import { signOutAction } from "@/features/auth/actions";
import type { SessionSummary } from "@/features/auth/account";
import { signOutOthersAction } from "@/features/auth/account-actions";
import { cn } from "@/lib/utils/cn";

/**
 * Where you are signed in.
 *
 * ── What is shown, and what is withheld ──────────────────────────────────────
 *
 * A device summary, a coarsened address, and two timestamps. No session id, no
 * token, no raw user agent — see `account.ts` for the reasoning on each. The
 * question this list exists to answer is "is one of these not me", and none of
 * the omitted fields help answer it.
 *
 * ── One switch, not a list of switches ───────────────────────────────────────
 *
 * There is no per-session revoke button, because Supabase does not expose one:
 * `signOut` takes a scope, not a session handle. Faking it by deleting the row
 * out of `auth.sessions` would mean writing to a schema Supabase owns — reading
 * it to build this list is a calculated risk, writing to it is not.
 *
 * So the control is "sign out everywhere else", which is the action somebody
 * who has spotted a session they do not recognise actually wants. It is
 * confirmed but not password-gated: it only ever reduces access, and a password
 * prompt in front of the panic button is how the panic button goes unused.
 */

export function SessionList({
  sessions,
  supported,
}: {
  sessions: SessionSummary[];
  supported: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const others = sessions.filter((session) => !session.isCurrent).length;

  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <span className="label text-fg-faint">Where you are signed in</span>
        {supported && sessions.length > 0 ? (
          <span className="numeric text-2xs text-fg-faint tabular-nums">{sessions.length}</span>
        ) : null}
      </header>

      <div className="flex flex-col gap-4 p-4">
        {!supported ? (
          /*
           * Said plainly rather than shown as an empty list. "No sessions" would
           * be a confident lie — you are reading this in one.
           */
          <p className="max-w-prose text-sm leading-body text-fg-dim">
            This list is not available right now. You can still sign out of your other devices
            below, which works regardless.
          </p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-fg-dim">Only this device.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sessions.map((session) => (
              <SessionRow key={session.key} session={session} />
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button
            variant="quiet"
            size="sm"
            disabled={supported && others === 0}
            onClick={() => setConfirming(true)}
          >
            Sign out other devices
          </Button>

          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out of this one
            </Button>
          </form>
        </div>

        {supported && others === 0 && sessions.length > 0 ? (
          <p className="text-2xs text-fg-faint">There is nothing else signed in.</p>
        ) : null}

        {result ? (
          <p role="status" className="text-sm text-fg-dim">
            {result}
          </p>
        ) : null}
      </div>

      {confirming ? (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title="Sign out other devices"
          description="Every other browser and phone will have to sign in again. This one stays."
          size="sm"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="lit"
                size="sm"
                loading={pending}
                onClick={() =>
                  startTransition(async () => {
                    const outcome = await signOutOthersAction();
                    setResult(outcome.status === "idle" ? null : outcome.message);
                    setConfirming(false);
                  })
                }
              >
                Sign them out
              </Button>
            </>
          }
        >
          <p className="text-sm leading-body text-fg-dim">
            If you have two-factor authentication on, they will need a code as well as your
            password.
          </p>
        </Dialog>
      ) : null}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

function SessionRow({ session }: { session: SessionSummary }) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-inset border px-3 py-2.5",
        session.isCurrent ? "border-line-lit bg-[var(--wash-hover)]" : "border-line",
      )}
    >
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-full bg-raised text-fg-dim"
      >
        <Icon name="screen" size={14} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm text-fg-loud">{session.device}</span>
          {session.isCurrent ? (
            <Badge tone="moss" caps>
              This device
            </Badge>
          ) : null}
          {session.strong ? (
            <Badge tone="plum" caps>
              2FA
            </Badge>
          ) : null}
        </span>

        <span className="truncate text-2xs text-fg-faint">
          {session.location ? `${session.location} · ` : ""}
          last used{" "}
          {new Date(session.lastSeenAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </span>
    </li>
  );
}
