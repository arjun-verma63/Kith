"use client";

import type { ComponentProps, ReactNode } from "react";

import { Icon, type IconName } from "@/components/ui/icon";
import { Pulse } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/cn";

/**
 * The one button.
 *
 * Radius is `soft` rather than the `edge` used by panels: rounded reads as
 * "you touch this", near-square reads as structure. Press feedback is a CSS
 * scale at --t-tap; per the motion policy a button hover never involves an
 * animation library.
 *
 * `primary` carries a 1px inset highlight along its top edge — the same
 * "elevation is light" idea as the panels, at control scale. It is what makes
 * the ember fill read as a lit key rather than a coloured rectangle.
 */

const VARIANT = {
  /** The single most important action on a surface. Never two on one screen. */
  primary:
    "bg-ember text-on-accent border border-transparent shadow-raised hover:bg-ember-soft " +
    "[box-shadow:inset_0_1px_0_0_rgb(255_255_255/0.18),var(--elev-raised)]",
  /** The default. Sits on the surface rather than shouting from it. */
  quiet:
    "bg-raised text-fg border border-line shadow-raised hover:border-line-lit hover:text-fg-loud",
  /** Tertiary. Chrome, toolbars, dismissals. */
  ghost:
    "bg-transparent text-fg-dim border border-transparent hover:bg-[var(--wash-hover)] hover:text-fg",
  /** Secondary call to action: accent, without the weight of a fill. */
  lit: "bg-transparent text-ember border border-[color-mix(in_oklab,var(--ember)_45%,transparent)] hover:bg-[var(--wash-accent)] hover:border-ember",
  /** Destructive and irreversible. */
  danger:
    "bg-transparent text-signal border border-[color-mix(in_oklab,var(--signal)_40%,transparent)] hover:bg-signal hover:text-on-accent hover:border-signal",
} as const;

const SIZE = {
  sm: "h-[var(--control-sm)] px-3 text-xs gap-1.5",
  md: "h-[var(--control-md)] px-4 text-sm gap-2",
  lg: "h-[var(--control-lg)] px-6 text-base gap-2",
} as const;

const ICON_SIZE = {
  sm: "size-[var(--control-sm)] px-0",
  md: "size-[var(--control-md)] px-0",
  lg: "size-[var(--control-lg)] px-0",
} as const;

export interface ButtonProps extends Omit<ComponentProps<"button">, "children"> {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
  /** Renders a square control. Requires `aria-label`, since there is no text. */
  iconOnly?: boolean;
  /** Leading icon, before the label. */
  icon?: IconName;
  /** Trailing icon — chevrons, arrows. Ignored when `iconOnly`. */
  trailingIcon?: IconName;
  /** Swaps the label for the ember pulse and blocks input. Width is preserved. */
  loading?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "quiet",
  size = "md",
  iconOnly = false,
  icon,
  trailingIcon,
  loading = false,
  fullWidth = false,
  className,
  type = "button",
  disabled,
  children,
  ...props
}: ButtonProps) {
  const iconPx = size === "lg" ? 20 : 16;

  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "control-focus relative inline-flex cursor-pointer items-center justify-center",
        "rounded-soft font-ui font-medium whitespace-nowrap",
        "transition-[background-color,border-color,color,transform,box-shadow]",
        "duration-[var(--t-quick)] ease-move",
        "active:scale-[0.97] active:duration-[var(--t-tap)]",
        "disabled:pointer-events-none disabled:opacity-40",
        VARIANT[variant],
        iconOnly ? ICON_SIZE[size] : SIZE[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    >
      {/* The label keeps its space while loading, so the button does not resize
          underneath the pointer that just pressed it. */}
      <span className={cn("inline-flex items-center gap-[inherit]", loading && "invisible")}>
        {icon ? <Icon name={icon} size={iconPx} /> : null}
        {iconOnly ? null : children}
        {trailingIcon && !iconOnly ? <Icon name={trailingIcon} size={iconPx} /> : null}
      </span>

      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Pulse />
        </span>
      ) : null}
    </button>
  );
}
