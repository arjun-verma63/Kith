"use client";

import { useEffect, useState } from "react";

import { ThemeToggle } from "@/components/layout/theme-toggle";
import { KithMark } from "@/components/ui/icon";
import { AuthCta } from "@/features/landing/components/auth-cta";
import { NAV_LINKS } from "@/features/landing/copy";
import { cn } from "@/lib/utils/cn";

/**
 * Landing navigation.
 *
 * Transparent over the hero and only takes on a surface once you have scrolled
 * past it — so the first screen is the product, not a chrome bar. The hairline
 * appears with it, because a border floating over the hero would cut the
 * composition in half.
 *
 * The scroll listener is passive and only ever flips one boolean, so it cannot
 * become a scroll-jank source no matter how long the page gets.
 */
export function LandingNav() {
  const [lifted, setLifted] = useState(false);

  useEffect(() => {
    const onScroll = () => setLifted(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-[var(--z-sticky)]",
        "transition-[background-color,border-color,backdrop-filter] duration-[var(--t-base)] ease-move",
        lifted
          ? "border-b border-line bg-[color-mix(in_oklab,var(--ground)_82%,transparent)] backdrop-blur-md"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-6 sm:px-10 lg:px-16">
        <a
          href="#top"
          className="control-focus flex items-center gap-2.5 rounded-edge"
          aria-label="KITH — top of page"
        >
          <KithMark size={17} className="text-ember" />
          <span className="display-wonk text-md text-fg-loud">KITH</span>
        </a>

        <nav aria-label="Sections" className="hidden items-center gap-7 lg:flex">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="link-grow text-sm text-fg-dim">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <ThemeToggle className="hidden sm:inline-flex" />
          <AuthCta intent="sign-in" variant="ghost" size="sm" className="hidden sm:inline-flex">
            Sign in
          </AuthCta>
          <AuthCta intent="request-invite" variant="primary" size="sm">
            Request an invite
          </AuthCta>
        </div>
      </div>
    </header>
  );
}
