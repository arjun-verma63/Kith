"use client";

import { useActionState } from "react";

import { FormBanner, FormFields, SubmitButton } from "@/components/ui/form";
import { Panel } from "@/components/ui/panel";
import { changePasswordAction } from "@/features/auth/account-actions";
import { PasswordField } from "@/features/auth/components/password-field";
import { fieldError, idleFormState } from "@/lib/forms";

/**
 * Changing the password.
 *
 * The current password is asked for even though the person is already signed in,
 * and that is the whole point of the field: a session cookie is something a
 * borrowed laptop already has, and a password change is the one action that
 * turns temporary access into permanent access.
 *
 * The consequence is stated above the button rather than discovered afterwards.
 * Signing the other devices out is not optional — the usual reason to change a
 * password is believing somebody else has it — so the only honest thing to do is
 * say so before the press, not apologise for it after.
 */
export function PasswordChangeForm() {
  const [state, formAction] = useActionState(changePasswordAction, idleFormState);

  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <header className="border-b border-line px-4 py-3">
        <span className="label text-fg-faint">Password</span>
      </header>

      <div className="p-4">
        <FormBanner state={state} />

        <form action={formAction} noValidate>
          <FormFields>
            <PasswordField
              id="current-password"
              name="currentPassword"
              label="Current password"
              autoComplete="current-password"
              error={fieldError(state, "currentPassword")}
              invalid={Boolean(fieldError(state, "currentPassword"))}
            />

            <PasswordField
              id="new-password"
              name="newPassword"
              label="New password"
              autoComplete="new-password"
              error={fieldError(state, "newPassword")}
              invalid={Boolean(fieldError(state, "newPassword"))}
            />

            <PasswordField
              id="confirm-password"
              name="confirmPassword"
              label="New password again"
              autoComplete="new-password"
              error={fieldError(state, "confirmPassword")}
              invalid={Boolean(fieldError(state, "confirmPassword"))}
            />

            <p className="text-2xs leading-body text-fg-faint">
              Changing your password signs out every other device. This one stays signed in.
            </p>

            <SubmitButton idleLabel="Change password" />
          </FormFields>
        </form>
      </div>
    </Panel>
  );
}
