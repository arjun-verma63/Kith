"use client";

import { useTransition } from "react";

import { setThemeAction } from "@/features/settings/actions";
import { THEME_STORAGE_KEY } from "@/lib/constants";
import { cn } from "@/lib/utils/cn";

/**
 * Dusk / Daylight switch.
 *
 * Which word shows is decided by CSS from the `data-theme` attribute on <html>,
 * not by React state. That means the button can never render the wrong label on
 * the server and then correct itself after hydration.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [, startTransition] = useTransition();

  function toggle() {
    const root = document.documentElement;
    const next = root.dataset["theme"] === "daylight" ? "dusk" : "daylight";
    root.dataset["theme"] = next;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private browsing / storage disabled — the pre-paint hint won't persist,
      // but the server copy below still will.
    }

    /*
     * Saved to the account as well, so the flip follows the person rather than
     * the browser. Deliberately not awaited: the attribute already changed, and
     * making a theme toggle feel like a network request would be a strange
     * thing to do to the fastest control in the app.
     */
    startTransition(async () => {
      await setThemeAction(next);
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Switch between Dusk and Daylight"
      className={cn(
        "label cursor-pointer text-fg-dim transition-colors duration-[var(--t-quick)]",
        "hover:text-fg-loud",
        className,
      )}
    >
      <span className="theme-label--to-daylight">Daylight</span>
      <span className="theme-label--to-dusk">Dusk</span>
    </button>
  );
}
