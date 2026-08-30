import Link from "next/link";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Surfaces.
 *
 * Panels are architectural: near-square corners, because this is the room
 * rather than something you press. Elevation is expressed as light — one step
 * lighter, a hairline catching light along the top edge, a tight occlusion
 * beneath — never as a diffuse grey blur.
 *
 * `Card` is the interactive counterpart and gets the soft radius. It is
 * deliberately the exception: a wall of rounded cards is the template look this
 * system exists to avoid, so reach for `Panel` first and justify the `Card`.
 */

const TONE = {
  /** Default. Sits flush in the room. */
  flat: "panel",
  /** One step forward: sidebars, stage panels, grouped settings. */
  raised: "panel panel-raised",
  /** Came to you: menus, dialogs, toasts. Rarely used directly. */
  overlay: "panel panel-overlay",
  /** Recessed: wells, code, quoted content, anything you type into. */
  sunken: "panel panel-sunken",
} as const;

const PAD = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
} as const;

export interface PanelProps extends ComponentProps<"div"> {
  tone?: keyof typeof TONE;
  padding?: keyof typeof PAD;
}

export function Panel({ tone = "flat", padding = "md", className, ...props }: PanelProps) {
  return <div className={cn(TONE[tone], PAD[padding], className)} {...props} />;
}

/** Optional header strip for a Panel, separated by a hairline rather than a gap. */
export function PanelHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-line px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

export function PanelFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-line px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

export interface CardProps extends ComponentProps<"button"> {
  padding?: keyof typeof PAD;
}

/** An interactive surface that performs an action. */
export function Card({ padding = "md", className, type = "button", ...props }: CardProps) {
  return (
    <button
      type={type}
      className={cn("card control-focus cursor-pointer", PAD[padding], className)}
      {...props}
    />
  );
}

export interface CardLinkProps extends ComponentProps<typeof Link> {
  padding?: keyof typeof PAD;
}

/** An interactive surface that navigates. */
export function CardLink({ padding = "md", className, ...props }: CardLinkProps) {
  return <Link className={cn("card control-focus block", PAD[padding], className)} {...props} />;
}
