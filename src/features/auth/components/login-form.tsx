"use client";

import { useActionState } from "react";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { signInAction } from "@/features/auth/actions";
import {
  AuthAside,
  AuthLink,
  FormBanner,
  FormFields,
  SubmitButton,
} from "@/features/auth/components/auth-form";
import { PasswordField } from "@/features/auth/components/password-field";
import { fieldError } from "@/features/auth/components/field-error";
import { idleFormState } from "@/features/auth/schema";

export function LoginForm({ next }: { next?: string | undefined }) {
  const [state, formAction] = useActionState(signInAction, idleFormState);

  return (
    <>
      <FormBanner state={state} />

      <form action={formAction} noValidate>
        {/* Carried through the sign-in so the person lands where they were
            heading. Sanitised server-side by safeRedirect — a `next` parameter
            is attacker-controlled and an open redirect is how a phishing link
            gets to wear your domain. */}
        {next ? <input type="hidden" name="redirectTo" value={next} /> : null}

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
              />
            )}
          </Field>

          <PasswordField
            id="login-password"
            name="password"
            label="Password"
            autoComplete="current-password"
            error={fieldError(state, "password")}
            invalid={Boolean(fieldError(state, "password"))}
            action={
              <AuthLink href="/forgot-password">
                <span className="text-2xs">Forgot?</span>
              </AuthLink>
            }
          />

          <SubmitButton idleLabel="Sign in" />
        </FormFields>
      </form>

      <AuthAside>
        Have an invitation? <AuthLink href="/signup">Create your account</AuthLink>
      </AuthAside>
    </>
  );
}
