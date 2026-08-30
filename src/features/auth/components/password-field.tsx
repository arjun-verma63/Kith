"use client";

import { useId, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils/cn";

/**
 * Password input with a visibility toggle.
 *
 * Accessibility details that are easy to miss and matter here:
 *
 *   - The toggle is a real `<button type="button">`. Inside a form, a button
 *     without an explicit type submits it, so revealing your password would post
 *     the form.
 *   - `aria-pressed` communicates the toggle state, and the accessible name says
 *     what the button will *do*, not what it currently is.
 *   - `aria-live="polite"` on a visually hidden region announces the change,
 *     because a sighted user sees the characters appear and a screen-reader user
 *     otherwise gets nothing.
 *   - The input keeps its name and value across the toggle, so switching type
 *     never clears what was typed.
 *
 * The value lives in the DOM and is read from `FormData` on submit. It is never
 * put into React state, never lifted, and never logged.
 */

export interface PasswordFieldProps {
  id: string;
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  hint?: string;
  error?: string | undefined;
  action?: React.ReactNode;
  required?: boolean;
  defaultValue?: string;
}

export function PasswordField({
  id,
  name,
  label,
  autoComplete,
  describedBy,
  invalid,
  hint,
  error,
  action,
  required = true,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const announcementId = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const described = [describedBy, error ? errorId : hint ? hintId : undefined]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label text-fg-dim">
          {label}
          {required ? (
            <span aria-hidden="true" className="ml-1 text-ember">
              *
            </span>
          ) : null}
        </label>
        {action}
      </div>

      <div className="relative flex items-center">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={described || undefined}
          className={cn("input h-[var(--control-md)] pr-11 pl-3 text-sm")}
        />

        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-pressed={visible}
          aria-controls={id}
          aria-label={visible ? "Hide password" : "Show password"}
          className={cn(
            "control-focus absolute right-1 grid size-9 cursor-pointer place-items-center",
            "rounded-inset text-fg-faint transition-colors duration-[var(--t-quick)]",
            "hover:text-fg",
          )}
        >
          <Icon name={visible ? "eyeOff" : "eye"} size={16} />
        </button>
      </div>

      <span id={announcementId} aria-live="polite" className="sr-only">
        {visible ? "Password is visible" : "Password is hidden"}
      </span>

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
