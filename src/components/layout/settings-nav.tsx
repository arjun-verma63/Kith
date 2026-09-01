"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils/cn";

/**
 * Settings tabs.
 *
 * A client component only because the current section has to be marked, and
 * `usePathname` is the honest way to know it — passing the active tab down from
 * each page would mean every new page has to remember to say which one it is.
 */

const SECTIONS = [
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/safety", label: "Safety" },
] as const;

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 border-b border-line" aria-label="Settings sections">
      {SECTIONS.map((section) => {
        const active = pathname === section.href;

        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "control-focus -mb-px rounded-t-inset border-b-2 px-3 py-2 text-sm",
              "transition-colors duration-[var(--t-quick)]",
              active
                ? "border-ember text-fg-loud"
                : "border-transparent text-fg-dim hover:text-fg-loud",
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
