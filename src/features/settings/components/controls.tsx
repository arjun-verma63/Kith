"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils/cn";

/**
 * The shapes every settings section is built from.
 *
 * Seven sections written independently would be seven slightly different ideas
 * about how a labelled control looks. Three components and they are one system —
 * which matters more here than anywhere else in KITH, because settings is the
 * one screen people scan rather than read.
 *
 * All three take a label and a help line, always, because a control whose
 * consequence is not written next to it is a control people leave alone.
 */

/** A titled card. The unit every section is a stack of. */
export function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <header className="flex flex-col gap-1 border-b border-line px-4 py-3 sm:px-5">
        <span className="label text-fg-faint">{title}</span>
        {description ? (
          <p className="max-w-prose text-2xs leading-body text-fg-dim">{description}</p>
        ) : null}
      </header>

      <div className="p-4 sm:p-5">{children}</div>

      {footer ? (
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3 sm:px-5">
          {footer}
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * A switch with its consequence written beside it.
 *
 * A real `<input type="checkbox">` rather than a styled div: it is focusable,
 * it announces its state, it submits with the form, and it works before the
 * JavaScript arrives. The whole row is the label, so the target is the row.
 */
export function ToggleRow({
  name,
  label,
  help,
  defaultChecked,
}: {
  name: string;
  label: string;
  help: string;
  defaultChecked: boolean;
}) {
  return (
    <label
      className={cn(
        "-mx-2 flex cursor-pointer items-start gap-3 rounded-inset px-2 py-2.5",
        "transition-colors duration-[var(--t-quick)] hover:bg-[var(--wash-hover)]",
        "has-[:focus-visible]:bg-[var(--wash-hover)]",
      )}
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="control-focus mt-0.5 size-4 shrink-0 rounded-edge accent-[var(--ember)]"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-fg-loud">{label}</span>
        <span className="text-2xs leading-body text-fg-faint">{help}</span>
      </span>
    </label>
  );
}

/**
 * A small set of mutually exclusive options, all visible.
 *
 * Radios rather than a select. Every one of these sets is three or four items
 * where each item matters — hiding two of them behind a click makes "Nobody"
 * feel like an advanced setting when it is the one somebody reaches for in a
 * hurry.
 *
 * On a narrow screen the row wraps rather than scrolling, so nothing is
 * reachable only by dragging.
 */
export function ChoiceRow<T extends string>({
  name,
  label,
  help,
  value,
  options,
}: {
  name: string;
  label: string;
  help: string;
  value: T;
  options: readonly { key: T; label: string; help?: string }[];
}) {
  return (
    <fieldset className="flex flex-col gap-2 py-2.5">
      <legend className="flex flex-col gap-0.5">
        <span className="text-sm text-fg-loud">{label}</span>
        <span className="text-2xs leading-body text-fg-faint">{help}</span>
      </legend>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label
            key={option.key}
            title={option.help ?? undefined}
            className={cn(
              "control-focus-within cursor-pointer rounded-edge border px-3 py-1.5 text-sm",
              "transition-colors duration-[var(--t-quick)]",
              "has-[:checked]:border-ember has-[:checked]:bg-[var(--wash-accent)]",
              "has-[:checked]:text-fg-loud",
              "border-line bg-raised text-fg-dim hover:border-line-lit",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.key}
              defaultChecked={value === option.key}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A hairline between rows in a stack of toggles. */
export function RowDivider() {
  return <hr className="my-1 border-0 border-t border-line" />;
}

/**
 * One save, at the end of the section.
 *
 * Not a button per card, because a section is one form writing one set of
 * columns and two buttons that do the same thing is a question the reader has to
 * answer. Not the full-width `SubmitButton` the auth flows use either — those
 * are one-thing-per-screen pages where the button IS the page, and a stack of
 * cards with a full-width primary button under it reads as an alarm.
 *
 * Sticky at the bottom of the viewport on a phone, where the form is taller than
 * the screen and scrolling back down to save is the difference between a setting
 * that gets changed and one that gets abandoned.
 */
export function SaveBar({ label = "Save changes" }: { label?: string }) {
  const { pending } = useFormStatus();

  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-3 px-4 py-3 sm:mx-0 sm:px-0",
        "border-t border-line bg-[var(--surface)]/85 backdrop-blur-sm sm:border-0 sm:bg-transparent",
        "sm:backdrop-blur-none",
      )}
    >
      <Button type="submit" variant="lit" size="sm" loading={pending}>
        {label}
      </Button>
    </div>
  );
}
