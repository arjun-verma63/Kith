"use client";

import { useActionState } from "react";

import { resetPasswordAction } from "@/features/auth/actions";
import {
  AuthAside,
  AuthLink,
  FormBanner,
  FormFields,
  SubmitButton,
} from "@/features/auth/components/auth-form";
import { fieldError } from "@/features/auth/components/field-error";
import { PasswordField } from "@/features/auth/components/password-field";
import { idleFormState } from "@/features/auth/schema";

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(resetPasswordAction, idleFormState);

  return (
    <>
      <FormBanner state={state} />

      <form action={formAction} noValidate>
        <FormFields>
          <PasswordField
            id="reset-password"
            name="password"
            label="New password"
            autoComplete="new-password"
            hint="At least 12 characters."
            error={fieldError(state, "password")}
            invalid={Boolean(fieldError(state, "password"))}
          />

          <PasswordField
            id="reset-password-confirm"
            name="confirmPassword"
            label="Confirm new password"
            autoComplete="new-password"
            error={fieldError(state, "confirmPassword")}
            invalid={Boolean(fieldError(state, "confirmPassword"))}
          />

          <SubmitButton idleLabel="Set new password" />
        </FormFields>
      </form>

      <AuthAside>
        <AuthLink href="/forgot-password">Request a new link</AuthLink>
      </AuthAside>
    </>
  );
}
