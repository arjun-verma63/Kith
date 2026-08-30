"use client";

import { useActionState } from "react";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { signUpAction } from "@/features/auth/actions";
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

export function SignupForm({ inviteCode }: { inviteCode?: string | undefined }) {
  const [state, formAction] = useActionState(signUpAction, idleFormState);

  return (
    <>
      <FormBanner state={state} />

      <form action={formAction} noValidate>
        <FormFields>
          <Field
            label="Invitation code"
            hint="From someone already inside. Leave blank only if you are the first person here."
            error={fieldError(state, "inviteCode")}
          >
            {(props) => (
              <Input
                {...props}
                name="inviteCode"
                autoComplete="off"
                spellCheck={false}
                placeholder="kith-xxxxxx"
                defaultValue={inviteCode ?? ""}
                icon="key"
              />
            )}
          </Field>

          <Field
            label="Display name"
            hint="What your people will see."
            error={fieldError(state, "displayName")}
          >
            {(props) => (
              <Input {...props} name="displayName" autoComplete="name" required maxLength={40} />
            )}
          </Field>

          <Field
            label="Username"
            hint="Letters, numbers and underscores. This is how people find you."
            error={fieldError(state, "username")}
          >
            {(props) => (
              <Input
                {...props}
                name="username"
                autoComplete="username"
                spellCheck={false}
                required
                minLength={3}
                maxLength={20}
              />
            )}
          </Field>

          <Field label="Email" error={fieldError(state, "email")}>
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
            id="signup-password"
            name="password"
            label="Password"
            autoComplete="new-password"
            hint="At least 12 characters. Length beats symbols, so a short phrase works well."
            error={fieldError(state, "password")}
            invalid={Boolean(fieldError(state, "password"))}
          />

          <SubmitButton idleLabel="Create account" />
        </FormFields>
      </form>

      <AuthAside>
        Already have an account? <AuthLink href="/login">Sign in</AuthLink>
      </AuthAside>
    </>
  );
}
