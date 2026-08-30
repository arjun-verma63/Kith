"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { resendVerificationAction, signOutAction } from "@/features/auth/actions";
import { FormBanner } from "@/features/auth/components/auth-form";
import { idleFormState } from "@/features/auth/schema";

export function VerifyEmailActions({ email }: { email: string }) {
  const [state, resendAction] = useActionState(resendVerificationAction, idleFormState);

  return (
    <div className="flex flex-col gap-5">
      <FormBanner state={state} />

      <p className="text-sm leading-body text-fg-dim">
        We sent a confirmation link to <span className="text-fg-loud">{email}</span>. Open it and
        you are in.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <form action={resendAction}>
          <ResendButton />
        </form>

        <form action={signOutAction}>
          <SignOutButton />
        </form>
      </div>

      <p className="text-xs leading-body text-fg-faint">
        Nothing arrived? Check your spam folder first. Confirmation mail is sent by our provider and
        can take a minute.
      </p>
    </div>
  );
}

function ResendButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="quiet" size="md" icon="mail" loading={pending}>
      Resend the link
    </Button>
  );
}

function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" size="md" loading={pending}>
      Sign out
    </Button>
  );
}
