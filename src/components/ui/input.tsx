"use client";

import type { ComponentProps, ReactNode } from "react";

import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils/cn";

/**
 * Text inputs.
 *
 * An input is a *sunken* surface — recessed into the panel, with an inner
 * occlusion rather than a border-only outline. It is the one place in the system
 * where light goes away from you, which is what makes a field read as somewhere
 * to put something.
 *
 * Focus is an ember hairline plus a soft ember halo. Never the browser default,
 * never blue: a blue ring on a warm palette is the fastest way to look
 * unfinished.
 *
 * Validation state lives on `aria-invalid`, so the styling and the accessibility
 * signal are the same fact and cannot drift apart.
 */

const SIZE = {
  sm: "h-[var(--control-sm)] px-2.5 text-xs",
  md: "h-[var(--control-md)] px-3 text-sm",
  lg: "h-[var(--control-lg)] px-4 text-base",
} as const;

export interface InputProps extends Omit<ComponentProps<"input">, "size"> {
  inputSize?: keyof typeof SIZE;
  /** Leading icon inside the field. Decorative — label the field properly. */
  icon?: IconName;
  /** Trailing content: a unit, a counter, a clear button. */
  suffix?: ReactNode;
}

export function Input({ inputSize = "md", icon, suffix, className, ...props }: InputProps) {
  const field = (
    <input
      className={cn("input", SIZE[inputSize], icon && "pl-9", suffix && "pr-10", className)}
      {...props}
    />
  );

  if (!icon && !suffix) return field;

  return (
    <div className="relative flex w-full items-center">
      {icon ? (
        <Icon name={icon} size={16} className="pointer-events-none absolute left-3 text-fg-faint" />
      ) : null}
      {field}
      {suffix ? (
        <div className="absolute right-3 flex items-center text-fg-faint">{suffix}</div>
      ) : null}
    </div>
  );
}

export type TextareaProps = ComponentProps<"textarea">;

export function Textarea({ className, rows = 4, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      className={cn("input resize-y px-3 py-2.5 text-sm leading-body", className)}
      {...props}
    />
  );
}
