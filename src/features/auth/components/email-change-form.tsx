"use client";

import { useActionState } from "react";

import { Field } from "@/components/ui/field";
import { FormBanner, FormFields, SubmitButton } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { changeEmailAction } from "@/features/auth/account-actions";
import { PasswordField } from "@/features/auth/components/password-field";
import { fieldError, idleFormState } from "@/lib/forms";

/**
 * The address the account signs in with.
 *
 * Shown before it can be changed, because "what is my email on this account" is
 * the question people actually arrive with — the form underneath is the rarer
 * half.
 *
 * Nothing happens on submit except an email to the NEW address. That is the
 * property worth having: somebody with thirty seconds at an unlocked laptop
 * cannot move the account to an inbox they control, because they would have to
 * open that inbox too. The copy says so, so nobody thinks it silently failed.
 */
export function EmailChangeForm({ current }: { current: string }) {
  const [state, formAction] = useActionState(changeEmailAction, idleFormState);

  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <header className="flex flex-col gap-1 border-b border-line px-4 py-3 sm:px-5">
        <span className="label text-fg-faint">Email address</span>
        <p className="text-2xs leading-body text-fg-dim">
          Where sign-in links and confirmations go.
        </p>
      </header>

      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <p className="text-sm text-fg-loud">{current}</p>

        <FormBanner state={state} />

        <form action={formAction} noValidate>
          <FormFields>
            <Field label="New address" error={fieldError(state, "email")}>
              {(props) => (
                <Input
                  {...props}
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
              )}
            </Field>

            <PasswordField
              id="email-password"
              name="password"
              label="Your password"
              autoComplete="current-password"
              error={fieldError(state, "password")}
              invalid={Boolean(fieldError(state, "password"))}
            />

            <p className="text-2xs leading-body text-fg-faint">
              We send a link to the new address. Your email does not change until you follow it, so
              a typo costs you nothing.
            </p>

            <SubmitButton idleLabel="Send the confirmation" />
          </FormFields>
        </form>
      </div>
    </Panel>
  );
}
