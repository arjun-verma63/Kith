"use client";

import Link from "next/link";
import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Avatar } from "@/components/ui/avatar";
import { Button, type ButtonProps } from "@/components/ui/button";
import { derivePresence, describeLastSeen } from "@/features/profile/presence";
import type { ProfileStatus } from "@/features/profile/schema";
import type { PersonCard } from "@/features/friends/queries";
import { idleFormState, type AuthFormState } from "@/features/auth/schema";
import { cn } from "@/lib/utils/cn";

/**
 * One person, in a row.
 *
 * A row rather than a card, and a list rather than a grid. Six people in a
 * three-column grid of rounded cards is the layout this design system exists to
 * avoid — and rows scan faster, hold a name and a status and two actions without
 * wrapping, and reflow to a phone without becoming one column of tall boxes.
 *
 * Presence is derived here from the same pure function the profile page uses, so
 * the light beside a name means exactly what it means everywhere else.
 */
export function PersonRow({
  person,
  meta,
  actions,
}: {
  person: PersonCard;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  const status = person.status as ProfileStatus;
  const presence = person.lastSeenAt
    ? derivePresence({ status, lastSeenAt: person.lastSeenAt })
    : "dark";
  const lastSeen = person.lastSeenAt
    ? describeLastSeen({ status, lastSeenAt: person.lastSeenAt })
    : "Offline";

  return (
    <li className="row-lit flex items-center gap-4 border-b border-line py-4 pl-4 last:border-b-0">
      <Link
        href={`/u/${person.username}`}
        className="control-focus flex min-w-0 flex-1 items-center gap-4 rounded-soft"
      >
        <Avatar
          name={person.displayName}
          seed={person.id}
          size="md"
          src={person.avatarUrl}
          presence={presence}
        />

        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm text-fg-loud">{person.displayName}</span>
            {person.pronouns ? (
              <span className="hidden shrink-0 text-2xs text-fg-faint sm:inline">
                {person.pronouns}
              </span>
            ) : null}
          </span>

          <span className="flex items-center gap-2 text-2xs">
            <span className="numeric truncate text-fg-faint">@{person.username}</span>
            <span aria-hidden="true" className="text-fg-faint">
              &middot;
            </span>
            <span className={cn(presence === "lit" ? "text-moss" : "text-fg-dim")}>
              {person.statusText ?? lastSeen}
            </span>
          </span>

          {meta ? <span className="mt-0.5 text-2xs text-fg-faint">{meta}</span> : null}
        </span>
      </Link>

      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </li>
  );
}

/**
 * A one-button form wired to a server action.
 *
 * A form rather than an onClick: the action runs on the server either way, and
 * a form keeps working before hydration. `useFormStatus` gives the button its
 * own pending state, so two actions in the same row cannot both spin.
 */
export function ActionForm({
  action,
  fields,
  children,
  ...button
}: {
  action: (prev: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  fields: Record<string, string>;
  children: ReactNode;
} & Omit<ButtonProps, "type" | "children">) {
  const [state, formAction] = useActionState(action, idleFormState);

  return (
    <form action={formAction} className="contents">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <PendingButton {...button}>{children}</PendingButton>

      {/* Failures are announced rather than swallowed. A button that silently
          does nothing is indistinguishable from a broken one. */}
      {state.status === "error" ? (
        <span role="alert" className="text-2xs text-signal">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

function PendingButton({ children, ...props }: Omit<ButtonProps, "type">) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...props}>
      {children}
    </Button>
  );
}
