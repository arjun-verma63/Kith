import type { ComponentProps } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Badges.
 *
 * Two shapes, two jobs. A `Badge` is a word — a state, a role, a label. A
 * `CountBadge` is a number, set in Martian Mono with tabular figures so an
 * unread count does not shift width as it climbs from 9 to 10.
 *
 * Tones are tinted, not filled: a low-alpha wash of the tone colour with the
 * tone as the text and a hairline of the same hue. Solid pills at this size
 * shout, and everything ends up shouting at once.
 */

const TONE = {
  neutral: "text-fg-dim bg-[var(--wash-hover)] border-line",
  ember:
    "text-ember bg-[var(--wash-accent)] border-[color-mix(in_oklab,var(--ember)_35%,transparent)]",
  moss: "text-moss bg-[color-mix(in_oklab,var(--moss)_14%,transparent)] border-[color-mix(in_oklab,var(--moss)_35%,transparent)]",
  lantern:
    "text-lantern bg-[color-mix(in_oklab,var(--lantern)_14%,transparent)] border-[color-mix(in_oklab,var(--lantern)_35%,transparent)]",
  signal:
    "text-signal bg-[color-mix(in_oklab,var(--signal)_14%,transparent)] border-[color-mix(in_oklab,var(--signal)_35%,transparent)]",
  plum: "text-plum bg-[color-mix(in_oklab,var(--plum)_14%,transparent)] border-[color-mix(in_oklab,var(--plum)_35%,transparent)]",
  ice: "text-ice bg-[color-mix(in_oklab,var(--ice)_14%,transparent)] border-[color-mix(in_oklab,var(--ice)_35%,transparent)]",
} as const;

export type BadgeTone = keyof typeof TONE;

export interface BadgeProps extends ComponentProps<"span"> {
  tone?: BadgeTone;
  /** Renders the label in the all-caps 11px style. Good for states, not names. */
  caps?: boolean;
}

export function Badge({ tone = "neutral", caps = false, className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
        caps ? "label" : "font-ui text-2xs font-medium",
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

export interface CountBadgeProps extends ComponentProps<"span"> {
  count: number;
  /** Anything above this renders as `max+`. */
  max?: number;
  tone?: Extract<BadgeTone, "ember" | "neutral" | "signal">;
  /** Accessible description, e.g. "unread messages". */
  label?: string;
}

export function CountBadge({
  count,
  max = 99,
  tone = "ember",
  label = "unread",
  className,
  ...props
}: CountBadgeProps) {
  if (count <= 0) return null;

  const display = count > max ? `${max}+` : String(count);
  const filled =
    tone === "ember"
      ? "bg-ember text-on-accent"
      : tone === "signal"
        ? "bg-signal text-on-accent"
        : "bg-raised text-fg-dim border border-line";

  return (
    <span
      className={cn(
        "numeric inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center",
        "rounded-full px-1 text-[0.625rem] leading-none font-medium",
        filled,
        className,
      )}
      {...props}
    >
      <span aria-hidden="true">{display}</span>
      <span className="sr-only">
        {count} {label}
      </span>
    </span>
  );
}

/**
 * An unlabelled marker for "something changed here".
 *
 * Never the only signal — it always accompanies text, because a bare coloured
 * dot means nothing to a screen reader and little to anyone in greyscale.
 */
export function BadgeDot({
  tone = "ember",
  className,
  ...props
}: ComponentProps<"span"> & { tone?: "ember" | "moss" | "signal" | "lantern" }) {
  const color = {
    ember: "bg-ember",
    moss: "bg-moss",
    signal: "bg-signal",
    lantern: "bg-lantern",
  }[tone];

  return (
    <span aria-hidden="true" className={cn("size-1.5 rounded-full", color, className)} {...props} />
  );
}
