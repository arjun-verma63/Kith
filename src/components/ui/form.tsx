"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { FormState } from "@/lib/forms";
import { cn } from "@/lib/utils/cn";

/**
 * Form primitives.
 *
 * These lived in the auth slice until profile and friends both needed them,
 * which made two features depend on `auth` for a banner and a submit button.
 * Nothing about them is about authentication.
 */

/**
 * Form-level result banner.
 *
 * `role="alert"` so a failure is announced rather than only shown — a
 * screen-reader user who submits and gets silence has no idea anything happened.
 */
export function FormBanner({ state }: { state: FormState }) {
  if (state.status === "idle") return null;

  const isError = state.status === "error";

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={cn(
        "mb-5 flex items-start gap-2.5 rounded-soft border px-3.5 py-3 text-sm",
        isError
          ? "border-[color-mix(in_oklab,var(--signal)_35%,transparent)] bg-[color-mix(in_oklab,var(--signal)_10%,transparent)] text-signal"
          : "border-[color-mix(in_oklab,var(--moss)_35%,transparent)] bg-[color-mix(in_oklab,var(--moss)_10%,transparent)] text-moss",
      )}
    >
      <Icon name={isError ? "alert" : "check"} size={15} className="mt-0.5 shrink-0" />
      <span className="leading-body">{state.message}</span>
    </div>
  );
}

/**
 * Submit button wired to the form's own pending state.
 *
 * `useFormStatus` reads it from the enclosing form, so the button cannot get out
 * of sync with the submission — and it keeps working if JavaScript is slow to
 * arrive, because the form posts to the action either way.
 */
export function SubmitButton({ children, idleLabel }: { children?: ReactNode; idleLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
      {children ?? idleLabel}
    </Button>
  );
}

/** Disables every control in the form while it is in flight. */
export function FormFields({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();

  return (
    <fieldset disabled={pending} className="flex flex-col gap-5 disabled:opacity-60">
      {children}
    </fieldset>
  );
}
