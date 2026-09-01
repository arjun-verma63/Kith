"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { Route } from "next";

import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils/cn";

/**
 * The seven sections.
 *
 * ── Two layouts, one list ────────────────────────────────────────────────────
 *
 * A rail on the left from `lg` up, where there is room for it and the sections
 * stay in peripheral vision while you read one. Below that, a horizontal strip
 * that scrolls — seven items do not fit across a phone, and stacking them turns
 * the top of every settings page into a menu you have to scroll past.
 *
 * Rendered once and restyled, rather than twice behind breakpoints: two copies
 * would be two lists to keep in step, and a screen reader would read seven
 * duplicate links.
 *
 * ── Why a client component ───────────────────────────────────────────────────
 *
 * Only to mark the current section. `usePathname` is the honest way to know it —
 * passing the active key down from each page means every new page has to
 * remember to say which one it is, and the one that forgets looks broken.
 */

/*
 * `Route` rather than `string`: `typedRoutes` checks these against the routes
 * that actually exist, so renaming a settings folder without renaming it here is
 * a build error rather than a dead tab.
 */
const SECTIONS: { href: Route; label: string; icon: IconName }[] = [
  { href: "/settings/profile", label: "Profile", icon: "friends" },
  { href: "/settings/account", label: "Account", icon: "key" },
  { href: "/settings/security", label: "Security", icon: "shield" },
  { href: "/settings/privacy", label: "Privacy", icon: "eye" },
  { href: "/settings/notifications", label: "Notifications", icon: "bell" },
  { href: "/settings/appearance", label: "Appearance", icon: "settings" },
  { href: "/settings/blocked", label: "Blocked", icon: "block" },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className="lg:sticky lg:top-6">
      {/* The scroll affordance on a phone: the strip bleeds to both edges so a
          half-cut item at the right tells you there is more, and the padding
          keeps the first and last from touching the screen. */}
      <ul
        className={cn(
          "-mx-5 flex gap-1 overflow-x-auto px-5 pb-px sm:-mx-10 sm:px-10",
          "border-b border-line",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "lg:mx-0 lg:flex-col lg:overflow-visible lg:border-b-0 lg:px-0",
        )}
      >
        {SECTIONS.map((section) => {
          const active = pathname === section.href;

          return (
            <li key={section.href} className="shrink-0 lg:w-full">
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "control-focus flex items-center gap-2 text-sm whitespace-nowrap",
                  "transition-colors duration-[var(--t-quick)]",
                  // Small: an underlined tab.
                  "-mb-px rounded-t-inset border-b-2 px-3 py-2.5",
                  // Large: a filled row in a rail.
                  "lg:mb-0 lg:rounded-inset lg:border-b-0 lg:border-l-2 lg:py-2",
                  active
                    ? "border-ember text-fg-loud lg:bg-[var(--wash-accent)]"
                    : cn(
                        "border-transparent text-fg-dim",
                        "hover:text-fg-loud lg:hover:bg-[var(--wash-hover)]",
                      ),
                )}
              >
                <Icon
                  name={section.icon}
                  size={15}
                  className={cn("shrink-0", active ? "text-ember" : "text-fg-faint")}
                />
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
