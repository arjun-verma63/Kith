"use client";

import { useActionState } from "react";

import { Field } from "@/components/ui/field";
import { FormBanner, FormFields, SubmitButton } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/features/auth/actions";
import { TOTP_DIGITS } from "@/features/auth/mfa";
import { verifyChallengeAction } from "@/features/auth/mfa-actions";
import { fieldError, idleFormState } from "@/lib/forms";

/**
 * The second half of signing in.
 *
 * A session already exists by the time this renders — the password was correct.
 * What it lacks is `aal2`, which is why the sign-out button matters: this is a
 * real session that can do nothing, and somebody who cannot produce a code needs
 * a way out of it that is not closing the tab.
 *
 * `autoComplete="one-time-code"` is what makes iOS and Android offer the code
 * from the clipboard, which is most of the difference between this screen being
 * two taps and being a chore.
 */
export function MfaChallengeForm({ next }: { next?: string | undefined }) {
  const [state, formAction] = useActionState(verifyChallengeAction, idleFormState);

  return (
    <>
      <FormBanner state={state} />

      <form action={formAction} noValidate>
        {next ? <input type="hidden" name="next" value={next} /> : null}

        <FormFields>
          <Field label="Authentication code" error={fieldError(state, "code")}>
            {(props) => (
              <Input
                {...props}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={TOTP_DIGITS + 2}
                required
                autoFocus
                className="numeric text-md tracking-[0.4em]"
              />
            )}
          </Field>

          <SubmitButton idleLabel="Continue" />
        </FormFields>
      </form>

      {/* A plain div, not the shared aside: that one renders a <p>, and a
          <form> inside a paragraph is invalid HTML — the browser closes the
          paragraph early and the layout comes apart. */}
      <div className="mt-7 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-fg-dim">
        <span>Lost your authenticator?</span>
        <form action={signOutAction}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </div>
    </>
  );
}
