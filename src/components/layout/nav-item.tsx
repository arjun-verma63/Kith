"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentProps, ReactNode } from "react";

import { CountBadge } from "@/components/ui/badge";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils/cn";

/**
 * A navigation destination.
 *
 * The active state is a **bar of light along the leading edge**, not a filled
 * pill. Filled pills on a vertical nav is the single most recognisable pattern
 * in this category, and we are not building that product. Light is also how
 * KITH signals everything else — presence, focus, elevation — so navigation
 * speaks the same language as the rest of the interface for free.
 *
 * Destinations that do not exist yet render as `pending`: visibly present,
 * clearly not available, and not a link. The architecture calls for a designed
 * "not built yet" state rather than a route that 404s or a button that lies.
 */

export type NavHref = ComponentProps<typeof Link>["href"];

export interface NavItemProps {
  icon: IconName;
  label: string;
  /** Omit to render the pending state. */
  href?: NavHref;
  /** Overrides pathname matching. */
  active?: boolean;
  /** Unread or waiting count. */
  count?: number;
  /** Horizontal for the mobile bar, vertical for the rail. */
  orientation?: "rail" | "bar";
  className?: string;
}

export function NavItem({
  icon,
  label,
  href,
  active,
  count,
  orientation = "rail",
  className,
}: NavItemProps) {
  const pathname = usePathname();
  const isRail = orientation === "rail";

  const resolved =
    active ??
    (typeof href === "string" && href !== undefined
      ? href === "/"
        ? pathname === "/"
        : pathname.startsWith(href)
      : false);

  const shell = cn(
    "lit-edge control-focus group relative flex items-center rounded-soft",
    "transition-colors duration-[var(--t-quick)] ease-move",
    isRail
      ? "lit-edge-left w-full gap-3 py-2.5 pr-3 pl-4 text-sm"
      : "lit-edge-bottom flex-1 flex-col gap-1 px-2 pt-2 pb-1.5 text-2xs",
    resolved ? "text-fg-loud" : "text-fg-dim hover:bg-[var(--wash-hover)] hover:text-fg",
    className,
  );

  const body: ReactNode = (
    <>
      <span className="relative inline-flex">
        <Icon
          name={icon}
          size={isRail ? 18 : 20}
          className={cn("transition-colors duration-[var(--t-quick)]", resolved && "text-ember")}
        />
        {/* On the compact bar there is no room beside the label, so the count
            docks to the icon instead. */}
        {!isRail && count ? (
          <CountBadge count={count} className="absolute -top-1.5 -right-2.5" />
        ) : null}
      </span>

      <span className={cn("truncate", isRail ? "flex-1" : "leading-none")}>{label}</span>

      {isRail && count ? <CountBadge count={count} /> : null}
    </>
  );

  if (!href) {
    return (
      <span
        aria-disabled="true"
        data-active="false"
        title={`${label} — not available yet`}
        className={cn(shell, "cursor-not-allowed opacity-40 hover:bg-transparent")}
      >
        {body}
      </span>
    );
  }

  return (
    <Link
      href={href}
      data-active={resolved}
      aria-current={resolved ? "page" : undefined}
      className={shell}
    >
      {body}
    </Link>
  );
}
