"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { blockUserAction, unblockUserAction } from "@/features/safety/actions";
import { ReportDialog } from "@/features/safety/components/report-dialog";
import { BLOCK_CONSEQUENCES, BLOCK_REASON_MAX, UNBLOCK_CAVEAT } from "@/features/safety/reasons";

/**
 * Block and report, on somebody's profile.
 *
 * ── Quiet, and last ──────────────────────────────────────────────────────────
 *
 * Two ghost buttons at the bottom of the page. This is the rarest thing anybody
 * does on a profile and it should not compete with the rest of it — but it also
 * has to be findable without a search, because the moment somebody needs it they
 * are not in the mood to hunt.
 *
 * ── The confirmation lists what actually happens ─────────────────────────────
 *
 * Blocking severs a friendship, a pending request and a couple, and people do
 * not expect the last two. Finding out afterwards that blocking somebody ended
 * your couple is a bad way to find out, so the dialog says so first — and says
 * plainly that unblocking does not put any of it back.
 */

export function SafetyMenu({
  userId,
  displayName,
  blocked,
}: {
  userId: string;
  displayName: string;
  /** Server-rendered, so the first paint is right rather than flickering. */
  blocked: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const firstName = displayName.split(" ")[0] ?? displayName;

  const unblock = () => {
    setError(null);
    startTransition(async () => {
      const result = await unblockUserAction(userId);
      if (!result.ok) setError(result.reason);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {blocked ? (
          <Button variant="quiet" size="sm" loading={pending} onClick={unblock}>
            Unblock {firstName}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Block
          </Button>
        )}

        <Button variant="ghost" size="sm" onClick={() => setReporting(true)}>
          Report
        </Button>
      </div>

      {blocked ? (
        <p className="max-w-prose text-2xs leading-body text-fg-faint">{UNBLOCK_CAVEAT}</p>
      ) : null}

      {error ? (
        <p role="status" className="text-sm text-signal">
          {error}
        </p>
      ) : null}

      {confirming ? (
        <BlockDialog
          userId={userId}
          displayName={displayName}
          onClose={() => setConfirming(false)}
        />
      ) : null}

      {reporting ? (
        <ReportDialog
          userId={userId}
          displayName={displayName}
          alreadyBlocked={blocked}
          onClose={() => setReporting(false)}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function BlockDialog({
  userId,
  displayName,
  onClose,
}: {
  userId: string;
  displayName: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const block = () => {
    setError(null);
    startTransition(async () => {
      const result = await blockUserAction(userId, reason || undefined);
      if (result.ok) onClose();
      else setError(result.reason);
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Block ${displayName}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="lit" size="sm" loading={pending} onClick={block}>
            Block them
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-1.5">
          {BLOCK_CONSEQUENCES.map((line) => (
            <li key={line} className="flex items-start gap-2 text-sm leading-body text-fg-dim">
              <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-fg-faint" />
              <span>{line}</span>
            </li>
          ))}
        </ul>

        <p className="text-2xs leading-body text-fg-faint">{UNBLOCK_CAVEAT}</p>

        {/*
          A note to yourself, not to them. Nobody else can read it — the row is
          only selectable by the person who created it — and in six months "why
          did I block this person" is a genuinely hard question.
        */}
        <Field label="A note, for you" hint="Optional. Only you will ever see it.">
          {(props) => (
            <Input
              {...props}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={BLOCK_REASON_MAX}
              placeholder="Why, in a few words"
            />
          )}
        </Field>

        {error ? (
          <p role="status" className="text-sm text-signal">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
