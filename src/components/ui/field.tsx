"use client";

import { useId, type ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils/cn";

/**
 * Label, control, help text and error, wired together correctly.
 *
 * The wiring is the point. `Field` generates the ids and hands back
 * `id`, `aria-describedby` and `aria-invalid` through a render prop, so a
 * control can never end up unlabelled or with an error that a screen reader
 * cannot reach. Doing this by hand at every call site is how forms rot.
 *
 * The error replaces the hint rather than stacking beneath it — two lines of
 * small text under a field is noise, and the error is the one that matters.
 */

export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": boolean | undefined;
}

export interface FieldProps {
  label: string;
  /** Hidden visually but still announced. For search boxes and dense toolbars. */
  hideLabel?: boolean;
  hint?: string;
  error?: string | undefined;
  /** Marks the field required and shows the marker. */
  required?: boolean;
  /** Right-aligned against the label: a character counter, a "forgot?" link. */
  action?: ReactNode;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}

export function Field({
  label,
  hideLabel = false,
  hint,
  error,
  required = false,
  action,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className={cn("flex items-baseline justify-between gap-3", hideLabel && "sr-only")}>
        <label htmlFor={id} className="label text-fg-dim">
          {label}
          {required ? (
            <span aria-hidden="true" className="ml-1 text-ember">
              *
            </span>
          ) : null}
        </label>
        {action ? <span className="text-2xs text-fg-faint">{action}</span> : null}
      </div>

      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}

      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-xs text-signal">
          <Icon name="alert" size={14} className="mt-px" />
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-fg-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
