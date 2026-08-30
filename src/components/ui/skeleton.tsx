import type { ComponentProps } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Loading states.
 *
 * KITH has no spinners in the shell. A spinner says "something is happening";
 * a skeleton says "this is what is about to be here", which is the more useful
 * sentence and stops the layout jumping when the data lands. The sheen is an
 * ember tint, so even waiting looks like the rest of the product.
 *
 * The rule: a skeleton must match the geometry of the content it stands in for.
 * A generic grey box that then becomes something a different shape is worse
 * than nothing.
 */

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden="true" className={cn("skeleton", className)} {...props} />;
}

export interface SkeletonTextProps extends ComponentProps<"div"> {
  lines?: number;
  /** Last line is short, the way a real paragraph ends. */
  lastLineWidth?: string;
}

export function SkeletonText({
  lines = 3,
  lastLineWidth = "62%",
  className,
  ...props
}: SkeletonTextProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="h-[0.8em] rounded-full"
          style={i === lines - 1 ? { width: lastLineWidth } : undefined}
        />
      ))}
    </div>
  );
}

const AVATAR_SKELETON_SIZE = {
  xs: "size-[var(--avatar-xs)]",
  sm: "size-[var(--avatar-sm)]",
  md: "size-[var(--avatar-md)]",
  lg: "size-[var(--avatar-lg)]",
} as const;

export function SkeletonAvatar({
  size = "md",
  className,
  ...props
}: ComponentProps<"div"> & { size?: keyof typeof AVATAR_SKELETON_SIZE }) {
  return (
    <Skeleton className={cn("rounded-full", AVATAR_SKELETON_SIZE[size], className)} {...props} />
  );
}

/**
 * The one "working" indicator: three embers breathing in sequence.
 *
 * Used inside a button that is submitting, or anywhere the wait is short enough
 * that a skeleton would be more disruptive than the wait itself.
 */
export function Pulse({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      role="status"
      aria-label="Working"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    >
      <span className="pulse-ember size-1 rounded-full bg-current" />
      <span className="pulse-ember size-1 rounded-full bg-current" />
      <span className="pulse-ember size-1 rounded-full bg-current" />
    </span>
  );
}
