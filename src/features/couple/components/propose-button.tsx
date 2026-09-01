"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { proposeCoupleAction } from "@/features/couple/actions";

/**
 * The only way into couple mode.
 *
 * Deliberately small, deliberately last, and deliberately only on the profile of
 * somebody who is already a friend. There is no search for it, no suggestion of
 * it, and no prompt to do it — the server renders this only when
 * `can_propose_to` says yes, so most profiles never show it at all.
 *
 * A confirmation step for a two-word button is usually overkill. Here it is not:
 * this is a message to a friend about a relationship, an accidental tap is
 * genuinely awkward, and the dialog is also the only honest place to say what
 * actually happens next.
 */
export function ProposeButton({ userId, displayName }: { userId: string; displayName: string }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (sent) {
    return (
      <p className="text-2xs text-fg-faint">
        Asked. It&rsquo;s up to {displayName.split(" ")[0]} now.
      </p>
    );
  }

  return (
    <>
      <Button variant="ghost" size="sm" icon="couple" onClick={() => setOpen(true)}>
        Ask to pair
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Ask ${displayName} to pair?`}
        description="Couple mode is a private space for two — a daily question and somewhere for the two of you. It stays hidden from everybody unless you both change that, and either of you can end it at any time."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Not now
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await proposeCoupleAction(userId);
                  if (result.ok) {
                    setSent(true);
                    setOpen(false);
                  } else {
                    setError(result.reason);
                  }
                })
              }
            >
              Ask them
            </Button>
          </>
        }
      >
        {error ? (
          <p role="status" className="text-sm text-signal">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
