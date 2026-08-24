"use client";

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
  function toggle() {
    const root = document.documentElement;
    const next = root.dataset["theme"] === "daylight" ? "dusk" : "daylight";
    root.dataset["theme"] = next;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private browsing / storage disabled — the choice just won't persist.
    }
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
