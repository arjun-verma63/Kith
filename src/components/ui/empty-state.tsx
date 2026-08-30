import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Empty states.
 *
 * An empty room is the *first* thing most people will see in most parts of
 * KITH — no friends yet, no messages yet, no calls yet. Treating it as an error
 * condition with a grey box and a shrug wastes the highest-attention moment in
 * the product.
 *
 * So: a drawn figure in the system's own language, a headline in Fraunces, one
 * line of body copy, and exactly one action. Never two — an empty state with a
 * choice is an empty state that has not decided what it wants.
 */

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** A single action. */
  action?: ReactNode;
  /** Defaults to the unlit-room figure. Pass `null` for a bare, dense variant. */
  figure?: ReactNode | null;
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  figure = <EmptyRoomFigure />,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-5 px-6 py-16 text-center",
        className,
      )}
    >
      {figure}

      <div className="flex flex-col items-center gap-2">
        <h3 className="heading max-w-[20ch] text-lg text-fg-loud">{title}</h3>
        {description ? (
          <p className="max-w-[42ch] text-sm leading-body text-fg-dim">{description}</p>
        ) : null}
      </div>

      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/**
 * The room, unlit.
 *
 * Same construction as the icon set — 1.5px stroke, geometric, `currentColor` —
 * scaled up. One ember sits inside, dark, waiting. It is the whole product
 * metaphor in twelve lines of SVG, and it costs nothing to ship.
 */
export function EmptyRoomFigure({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      className={cn("h-[4.5rem] w-auto text-line-lit", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Floor and walls, drawn in one-point perspective. */}
      <path d="M6 78h108" />
      <path d="M24 78V30l36-18 36 18v48" />
      <path d="M24 30 60 48l36-18" />
      <path d="M60 48v30" opacity="0.5" />
      {/* The unlit ember, resting on the floor. */}
      <circle cx="60" cy="66" r="6" className="text-fg-faint" />
    </svg>
  );
}
