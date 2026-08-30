"use client";

import { useEffect, useState } from "react";

/**
 * The single source of truth for whether motion is allowed, for JavaScript.
 *
 * CSS already reads the three-tier policy (`full` / `reduced` / `off`) straight
 * off the `data-motion` attribute on `<html>`. This is the same fact for the
 * animation layer, so CSS and JS can never disagree about it — which is exactly
 * how a reduced-motion setting ends up half-respected.
 *
 * Returns `false` during the first render on the client so nothing can animate
 * before we know the user's preference. Server output and first paint match.
 */
export function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");

    const read = () => {
      const setting = document.documentElement.dataset["motion"];
      if (setting === "off") return setAllowed(false);
      if (setting === "full") return setAllowed(true);
      setAllowed(!query.matches);
    };

    read();
    query.addEventListener("change", read);

    // The setting is user-changeable at runtime (Settings -> Appearance, Phase 3).
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });

    return () => {
      query.removeEventListener("change", read);
      observer.disconnect();
    };
  }, []);

  return allowed;
}
