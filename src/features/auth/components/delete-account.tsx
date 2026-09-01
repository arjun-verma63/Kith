"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { FormBanner, FormFields, SubmitButton } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { confirmsDeletion } from "@/features/auth/account";
import { deleteAccountAction } from "@/features/auth/account-actions";
import { PasswordField } from "@/features/auth/components/password-field";
import { TOTP_DIGITS } from "@/features/auth/mfa";
import { fieldError, idleFormState } from "@/lib/forms";

/**
 * Leaving.
 *
 * ── Three gates, and the third one is the interesting one ────────────────────
 *
 * The password, because a session is a borrowed laptop. A current code when
 * two-factor is on, because this is irreversible and an aal2 session lasts as
 * long as its token does. And the username, typed.
 *
 * The typed confirmation is the only one that cannot be satisfied by muscle
 * memory. "Type DELETE" is a phrase people have typed in a dozen other apps and
 * will type here without reading; their own username has to be found on the
 * screen first, and that pause is the entire point of the field. The submit
 * button stays disabled until it matches, so the confirmation is a gate rather
 * than a form error discovered afterwards.
 *
 * ── What the copy has to be honest about ─────────────────────────────────────
 *
 * It does not say "everything you have written will be erased", because that is
 * not what happens and promising it would be worse than the truth. Messages
 * already sent stay in other people's conversations, unattributed — deleting
 * them would be deleting half of five other people's history. Everything that is
 * about *you* goes.
 */

export function DeleteAccount({ username }: { username: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Panel
      tone="flat"
      padding="none"
      className="rounded-soft border-[color-mix(in_oklab,var(--signal)_35%,var(--line))]"
    >
      <header className="border-b border-[color-mix(in_oklab,var(--signal)_25%,var(--line))] px-4 py-3">
        <span className="label text-signal">Delete your account</span>
      </header>

      <div className="flex flex-col gap-3 p-4">
        <p className="max-w-prose text-sm leading-body text-fg-dim">
          Your profile, your photo, your friendships and your settings are removed, and you will not
          be able to sign in again. This cannot be undone.
        </p>

        <p className="max-w-prose text-2xs leading-body text-fg-faint">
          Messages you have already sent stay in the conversations they were part of, shown as from
          a deleted account. They are half of somebody else&rsquo;s thread, and removing them would
          delete other people&rsquo;s history along with yours.
        </p>

        <div>
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            Delete account
          </Button>
        </div>
      </div>

      {open ? <DeleteDialog username={username} onClose={() => setOpen(false)} /> : null}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

function DeleteDialog({ username, onClose }: { username: string; onClose: () => void }) {
  const [state, formAction] = useActionState(deleteAccountAction, idleFormState);
  const [typed, setTyped] = useState("");
  const [hasCode, setHasCode] = useState(false);

  const confirmed = confirmsDeletion(typed, username);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Delete your account"
      description="This is permanent. There is no undo and no export."
      size="sm"
      // Escape and the backdrop still work — a confirmation you cannot back out
      // of is a trap, and the disabled button is what makes this deliberate.
      dismissible
    >
      <FormBanner state={state} />

      <form action={formAction} noValidate>
        <FormFields>
          <Field
            label={`Type ${username} to confirm`}
            error={fieldError(state, "confirm")}
            hint="Your username, exactly."
          >
            {(props) => (
              <Input
                {...props}
                name="confirm"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                autoFocus
              />
            )}
          </Field>

          <PasswordField
            id="delete-password"
            name="password"
            label="Your password"
            autoComplete="current-password"
            error={fieldError(state, "password")}
            invalid={Boolean(fieldError(state, "password"))}
          />

          {/*
            Shown for everybody rather than only for accounts with two-factor on.
            Whether somebody has it enrolled is knowable from this page anyway,
            and a field that appears conditionally is a field that makes the
            dialog jump. The action ignores it when there is no factor.
          */}
          <Field
            label="Authenticator code"
            error={fieldError(state, "code")}
            hint="Only if you have two-factor authentication on."
          >
            {(props) => (
              <Input
                {...props}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={TOTP_DIGITS + 2}
                onChange={(event) => setHasCode(event.target.value.length > 0)}
                className="numeric tracking-[0.3em]"
              />
            )}
          </Field>

          <SubmitButton
            disabled={!confirmed}
            idleLabel={confirmed ? "Delete my account" : "Type your username first"}
          />
        </FormFields>
      </form>

      <p className="mt-4 text-2xs leading-body text-fg-faint">
        {hasCode
          ? "The code is checked against every authenticator on the account."
          : "You will be signed out of every device."}
      </p>
    </Dialog>
  );
}
