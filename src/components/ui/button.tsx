"use client";

import type { ComponentProps } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * The one button.
 *
 * Radius is intentionally `soft` rather than the `edge` used by panels: rounded
 * reads as "you touch this", near-square reads as structure. Press feedback is a
 * CSS scale at --t-tap; per the motion policy, a button hover never involves a
 * JavaScript animation library.
 */

const VARIANT = {
  /** The single most important action on a surface. Never two on one screen. */
  primary: "bg-ember text-on-accent border border-transparent hover:bg-ember-soft shadow-raised",
  /** Default action. Sits on the surface rather than shouting from it. */
  quiet:
    "bg-raised text-fg border border-line hover:border-line-lit hover:text-fg-loud shadow-raised",
  /** Tertiary. Chrome, toolbars, dismissals. */
  ghost: "bg-transparent text-fg-dim border border-transparent hover:text-fg hover:bg-surface",
  /** Destructive and irreversible. */
  danger: "bg-transparent text-signal border border-signal/40 hover:bg-signal hover:text-on-accent",
} as const;

const SIZE = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-base gap-2",
} as const;

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
}

export function Button({
  variant = "quiet",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center rounded-soft font-ui font-medium",
        "transition-[background-color,border-color,color,transform] duration-[var(--t-quick)] ease-move",
        "active:scale-[0.97] active:duration-[var(--t-tap)]",
        "disabled:pointer-events-none disabled:opacity-40",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...props}
    />
  );
}
