"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { FormBanner, FormFields, SubmitButton } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { reportUserAction } from "@/features/safety/actions";
import { DETAIL_MAX, REASON_LABELS, type ReportReason } from "@/features/safety/reasons";
import { fieldError, idleFormState } from "@/lib/forms";
import { cn } from "@/lib/utils/cn";

/**
 * Reporting somebody.
 *
 * ── The block checkbox is on by default ──────────────────────────────────────
 *
 * Reporting and blocking are separate operations and separate decisions in
 * principle. In practice, somebody filling in this form wants the person to stop
 * being able to reach them, and making them do a second thing afterwards means
 * some of them will not. So the box is ticked, and it can be unticked — a
 * moderator asking "did you keep talking to them" is a real reason somebody
 * might want the report without the block.
 *
 * ── What the copy does not promise ───────────────────────────────────────────
 *
 * "Somebody will look at this" is true. It does not say when, and it does not
 * say what will happen, because there is no admin dashboard yet and inventing an
 * SLA on a settings page is how you get a second, angrier report.
 *
 * The `threats` option carries the only line on this page that matters more than
 * the app does: if it is urgent, this form is not the right thing to be using.
 */

export function ReportDialog({
  userId,
  displayName,
  alreadyBlocked = false,
  messageId,
  conversationId,
  onClose,
}: {
  userId: string;
  displayName: string;
  /** Hides the checkbox — there is nothing left to offer. */
  alreadyBlocked?: boolean;
  /** Context, when the report was opened from a message rather than a profile. */
  messageId?: string;
  conversationId?: string;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(reportUserAction, idleFormState);
  const [reason, setReason] = useState<ReportReason | null>(null);

  const done = state.status === "success";
  const detailRequired = reason === "other";

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Report ${displayName}`}
      size="sm"
      {...(done ? {} : { description: "This goes to whoever looks after this KITH." })}
      footer={
        done ? (
          <Button variant="lit" size="sm" onClick={onClose}>
            Done
          </Button>
        ) : undefined
      }
    >
      <FormBanner state={state} />

      {done ? null : (
        <form action={formAction}>
          <input type="hidden" name="userId" value={userId} />
          {messageId ? <input type="hidden" name="messageId" value={messageId} /> : null}
          {conversationId ? (
            <input type="hidden" name="conversationId" value={conversationId} />
          ) : null}

          <FormFields>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm text-fg-loud">What happened?</legend>

              <div className="mt-1 flex flex-col gap-1.5">
                {REASON_LABELS.map((option) => (
                  <label
                    key={option.key}
                    className={cn(
                      "control-focus-within cursor-pointer rounded-inset border px-3 py-2.5",
                      "transition-colors duration-[var(--t-quick)]",
                      "has-[:checked]:border-ember has-[:checked]:bg-[var(--wash-accent)]",
                      "border-line bg-raised hover:border-line-lit",
                    )}
                  >
                    <input
                      type="radio"
                      name="reason"
                      value={option.key}
                      required
                      onChange={() => setReason(option.key)}
                      className="sr-only"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm text-fg-loud">{option.label}</span>
                      <span className="text-2xs leading-body text-fg-faint">{option.help}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <Field
              label={detailRequired ? "What happened" : "Anything else"}
              error={fieldError(state, "detail")}
              hint={detailRequired ? "Required for this one." : "Optional."}
            >
              {(props) => (
                <Textarea
                  {...props}
                  name="detail"
                  rows={3}
                  maxLength={DETAIL_MAX}
                  required={detailRequired}
                  placeholder="Anything that would help somebody understand"
                />
              )}
            </Field>

            {alreadyBlocked ? (
              <p className="text-2xs text-fg-faint">They are already blocked.</p>
            ) : (
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  name="alsoBlock"
                  defaultChecked
                  className="control-focus mt-0.5 size-4 shrink-0 rounded-edge accent-[var(--ember)]"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm text-fg-loud">Block them as well</span>
                  <span className="text-2xs leading-body text-fg-faint">
                    Ends the friendship and stops them reaching you. You can undo the block later.
                  </span>
                </span>
              </label>
            )}

            <SubmitButton idleLabel="Send report" />
          </FormFields>
        </form>
      )}
    </Dialog>
  );
}
