"use client";

import { useActionState } from "react";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { forgotPasswordAction } from "@/features/auth/actions";
import { AuthAside, AuthLink } from "@/features/auth/components/auth-form";
import { FormBanner, FormFields, SubmitButton } from "@/components/ui/form";
import { fieldError } from "@/lib/forms";
import { idleFormState } from "@/lib/forms";

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(forgotPasswordAction, idleFormState);

  // On success the form is replaced rather than left below a green banner.
  // Resubmitting achieves nothing and only burns the rate limit.
  if (state.status === "success") {
    return (
      <>
        <FormBanner state={state} />
        <p className="text-sm leading-body text-fg-dim">
          The link is good for one hour. If nothing arrives, check your spam folder before asking
          for another.
        </p>
        <AuthAside>
          <AuthLink href="/login">Back to sign in</AuthLink>
        </AuthAside>
      </>
    );
  }

  return (
    <>
      <FormBanner state={state} />

      <form action={formAction} noValidate>
        <FormFields>
          <Field label="Email" error={fieldError(state, "email")}>
            {(props) => (
              <Input
                {...props}
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                autoFocus
                icon="mail"
              />
            )}
          </Field>

          <SubmitButton idleLabel="Send reset link" />
        </FormFields>
      </form>

      <AuthAside>
        Remembered it? <AuthLink href="/login">Sign in</AuthLink>
      </AuthAside>
    </>
  );
}
