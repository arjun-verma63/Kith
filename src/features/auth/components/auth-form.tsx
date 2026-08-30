"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon, KithMark } from "@/components/ui/icon";
import { PresenceEmber } from "@/components/ui/presence-ember";
import type { AuthFormState } from "@/features/auth/schema";
import { cn } from "@/lib/utils/cn";

/**
 * The shared furniture for every authentication page.
 *
 * Split composition rather than a centred card: the form sits on an optical
 * spine on the left and the room sits on the right, so signing in looks like the
 * rest of KITH instead of like a generic auth template. Below `lg` the right
 * panel is dropped entirely — it is atmosphere, and atmosphere is the first
 * thing to go when there is no room for it.
 */

export function AuthShell({
  title,
  lead,
  children,
  footer,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1fr_38%]">
      <div className="flex flex-col justify-between px-6 py-8 sm:px-12 sm:py-10 lg:px-16">
        <Link
          href="/"
          className="control-focus inline-flex w-fit items-center gap-2.5 rounded-edge"
        >
          <KithMark size={17} className="text-ember" />
          <span className="display-wonk text-md text-fg-loud">KITH</span>
        </Link>

        <div className="w-full max-w-[26rem] py-14">
          <h1 className="display text-d-xs text-fg-loud sm:text-d-sm">{title}</h1>
          {lead ? <p className="mt-3 text-sm leading-body text-fg-dim">{lead}</p> : null}
          <div className="mt-9">{children}</div>
        </div>

        <div className="flex items-center gap-4 text-2xs text-fg-faint">
          {footer ?? <span className="label">Private &middot; Invitation only</span>}
        </div>
      </div>

      <aside
        aria-hidden="true"
        className="relative hidden border-l border-line bg-surface lg:flex lg:flex-col lg:justify-end"
      >
        <div className="p-12">
          <div className="mb-8 flex items-center gap-2.5">
            <PresenceEmber state="lit" size="lg" />
            <PresenceEmber state="lit" size="lg" />
            <PresenceEmber state="cooling" size="lg" />
            <PresenceEmber state="lit" size="lg" />
            <PresenceEmber state="dark" size="lg" />
            <PresenceEmber state="dark" size="lg" />
          </div>
          <p className="display max-w-[14ch] text-d-xs text-fg-loud">Your people. Your space.</p>
          <p className="mt-4 max-w-[34ch] text-sm leading-body text-fg-dim">
            Six people, one room. No feed, no algorithm, no strangers.
          </p>
        </div>
      </aside>
    </main>
  );
}

/**
 * Form-level result banner.
 *
 * `role="alert"` so a failure is announced rather than only shown — a
 * screen-reader user who submits and gets silence has no idea anything happened.
 * The banner is also the focus target for form-level errors that belong to no
 * particular field.
 */
export function FormBanner({ state }: { state: AuthFormState }) {
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
 * `useFormStatus` reads it from the enclosing form, which means the button
 * cannot get out of sync with the submission — and it keeps working if
 * JavaScript is slow to arrive, because the form posts to the action either way.
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

export function AuthAside({ children }: { children: ReactNode }) {
  return <p className="mt-7 text-center text-sm text-fg-dim">{children}</p>;
}

export function AuthLink({
  href,
  children,
}: {
  href: ComponentProps<typeof Link>["href"];
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="control-focus rounded-edge font-medium text-ember underline-offset-4 hover:underline"
    >
      {children}
    </Link>
  );
}
