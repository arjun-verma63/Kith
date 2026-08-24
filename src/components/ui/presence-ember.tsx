import { cn } from "@/lib/utils/cn";

/**
 * Presence, rendered as light.
 *
 * KITH's central motif: a person is visible because they are lit. This primitive
 * is the one place that mapping is defined — the nav rail, the friends board and
 * the chat header all use it, so presence reads identically everywhere.
 *
 * Accessibility: state is carried by fill/ring shape as well as colour, and every
 * ember exposes a text label, so the meaning survives greyscale, colour blindness
 * and motion-off.
 */

export type PresenceState = "lit" | "cooling" | "dark";

const STATE_LABEL: Record<PresenceState, string> = {
  lit: "Online",
  cooling: "Away",
  dark: "Offline",
};

const SIZE_CLASS = {
  sm: "size-1.5",
  md: "size-2",
  lg: "size-3",
} as const;

export interface PresenceEmberProps {
  state: PresenceState;
  size?: keyof typeof SIZE_CLASS;
  /** Prefix for the accessible label, e.g. a display name. */
  name?: string;
  className?: string;
}

export function PresenceEmber({ state, size = "md", name, className }: PresenceEmberProps) {
  const label = name ? `${name} — ${STATE_LABEL[state]}` : STATE_LABEL[state];

  return (
    <span
      role="img"
      aria-label={label}
      data-state={state}
      className={cn("ember-dot", SIZE_CLASS[size], className)}
    />
  );
}
