"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { useMotionAllowed } from "@/lib/hooks/use-motion-preference";
import { isNavigationClick } from "@/lib/navigation-intent";
import { cn } from "@/lib/utils/cn";

/**
 * The answer to "did my click do anything".
 *
 * Forms already say so: `SubmitButton` reads `useFormStatus`, and every action
 * button carries its own pending state. Navigation said nothing at all. Click a
 * conversation, a game, a settings section, and the app sat silent — no spinner,
 * no skeleton, no `loading.tsx` anywhere — until the new page simply appeared.
 * On a fast connection that reads as instant; on a slow one it reads as broken,
 * and the reflex is to click again.
 *
 * ── Why a click listener rather than useLinkStatus ───────────────────────────
 *
 * Next 16 has `useLinkStatus`, which is exact and framework-native, and has to
 * be rendered INSIDE a `<Link>`. Twenty files render one directly, so covering
 * them would mean touching all twenty and still missing any added afterwards.
 * One listener on the document catches every anchor whoever wrote it — and for
 * a signal this cosmetic that is the better trade, because a progress bar that
 * is wrong about one link is worse than no progress bar at all.
 *
 * ── Why it starts late and lingers ───────────────────────────────────────────
 *
 * A bar that flashes on every click is noise, and noise is what people learn to
 * ignore. Nothing appears for `APPEAR_AFTER_MS`, so a fast navigation stays
 * invisible; once it does appear it stays for `MINIMUM_VISIBLE_MS`, because a
 * bar that blinks in and out reads as a glitch rather than as progress.
 *
 * ── What it deliberately does not cover ──────────────────────────────────────
 *
 * `router.push` from inside an action — starting a game, opening a new session.
 * Those already show pending state on the control that was pressed, which is
 * closer to the click and therefore better feedback than a line at the top of
 * the screen. Nothing here would improve them.
 */

/** Below this, a navigation is "instant" and showing anything is noise. */
const APPEAR_AFTER_MS = 140;

/** Once visible, stay visible this long. Shorter reads as a flicker. */
const MINIMUM_VISIBLE_MS = 260;

/** How long the completed bar takes to fade. */
const FADE_MS = 220;

/**
 * A navigation that never commits must not leave the bar stuck.
 *
 * It happens: a middleware redirect back to the same URL, a route that throws,
 * a link that turns out to be a download. The bar is a promise that something
 * is happening, and an unkept one is worse than silence.
 */
const GIVE_UP_AFTER_MS = 10_000;

/** Where the trickle stalls. Never 100% — that would be a lie about arrival. */
const CEILING = 92;

/*
 * `| undefined` on each, explicitly: `exactOptionalPropertyTypes` is on, so an
 * optional property does not accept being assigned `undefined` — and clearing a
 * timer by assignment is exactly what this does.
 */
interface Timers {
  appear?: number | undefined;
  trickle?: number | undefined;
  giveUp?: number | undefined;
  fade?: number | undefined;
}

export function RouteProgress() {
  const pathname = usePathname();
  const motionAllowed = useMotionAllowed();

  const [progress, setProgress] = useState<number | null>(null);

  // In a ref so a re-render can never orphan a running timer.
  const timers = useRef<Timers>({});
  const shownAt = useRef(0);

  const stopTimers = useCallback((keys: (keyof Timers)[]) => {
    for (const key of keys) {
      window.clearTimeout(timers.current[key]);
      window.clearInterval(timers.current[key]);
      timers.current[key] = undefined;
    }
  }, []);

  /*
   * `begin` schedules a give-up call to `finish`, and `finish` is declared after
   * it. A ref breaks the cycle without reordering them into something that reads
   * backwards — the same pattern `use-conversation-channel.ts` uses to keep a
   * handler current without re-subscribing.
   */
  const finishRef = useRef<() => void>(() => {});

  const begin = useCallback(() => {
    // Already running: a second click during a slow navigation must not restart
    // the bar from zero, which would look like going backwards.
    if (timers.current.appear !== undefined || timers.current.trickle !== undefined) return;

    stopTimers(["appear", "trickle", "giveUp", "fade"]);

    timers.current.appear = window.setTimeout(() => {
      timers.current.appear = undefined;
      shownAt.current = Date.now();
      setProgress(8);

      /*
       * Asymptotic, not linear. The bar has no idea how long the navigation
       * will take, so it slows as it advances — which reads as "still working"
       * rather than as a countdown it cannot honour.
       */
      timers.current.trickle = window.setInterval(() => {
        setProgress((current) =>
          current === null ? current : current + Math.max(0.4, (CEILING - current) * 0.08),
        );
      }, 160);
    }, APPEAR_AFTER_MS);

    timers.current.giveUp = window.setTimeout(() => finishRef.current(), GIVE_UP_AFTER_MS);
  }, [stopTimers]);

  const finish = useCallback(() => {
    // Never appeared — the navigation beat the delay, so there is nothing to
    // hide and nothing to explain.
    if (timers.current.appear !== undefined) {
      stopTimers(["appear", "trickle", "giveUp"]);
      setProgress(null);
      return;
    }

    if (timers.current.trickle === undefined) return; // nothing running

    stopTimers(["trickle", "giveUp"]);

    const held = Date.now() - shownAt.current;
    window.setTimeout(
      () => {
        setProgress(100);
        timers.current.fade = window.setTimeout(() => setProgress(null), FADE_MS);
      },
      Math.max(0, MINIMUM_VISIBLE_MS - held),
    );
  }, [stopTimers]);

  useEffect(() => {
    finishRef.current = finish;
  });

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      // The decision itself is `lib/navigation-intent.ts`, pure and tested —
      // every branch of it is a way a click can look like navigation and not be
      // one, and this is where getting it wrong strands the bar.
      const navigating = isNavigationClick(
        {
          defaultPrevented: event.defaultPrevented,
          button: event.button,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        },
        {
          href: anchor.href,
          rawHref: anchor.getAttribute("href"),
          target: anchor.target || null,
          download: anchor.hasAttribute("download"),
        },
        window.location.href,
      );

      if (navigating) begin();
    };

    // Capture, so a handler calling stopPropagation cannot hide the click.
    document.addEventListener("click", onClick, { capture: true });
    // Back and forward are navigations too, and are often the slowest.
    window.addEventListener("popstate", begin);

    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("popstate", begin);
      stopTimers(["appear", "trickle", "giveUp", "fade"]);
    };
  }, [begin, stopTimers]);

  /*
   * Arrival.
   *
   * `usePathname` changes when a navigation COMMITS — after the server has
   * answered — so it marks the arrival rather than the departure. Skipping the
   * first run matters: this effect fires on mount, and finishing a navigation
   * nobody started would clear a bar belonging to whatever mounted it.
   */
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (settled.current === null || settled.current === pathname) {
      settled.current = pathname;
      return;
    }
    settled.current = pathname;
    finishRef.current();
  }, [pathname]);

  if (progress === null) return null;

  return (
    <div
      /*
       * Not a `role="progressbar"`. The value is invented — it describes how
       * long we have been waiting, not how much is done — and announcing a
       * percentage that means nothing is worse than announcing nothing. Next's
       * own route announcer already tells a screen reader that the page
       * changed, which is the true and useful version of this.
       */
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[var(--z-progress)] h-[2px]"
    >
      <div
        className={cn(
          "h-full bg-ember shadow-[0_0_8px_0_var(--ember)]",
          // Reduced motion keeps the information and drops the animation: the
          // bar still advances, it just does not slide there.
          motionAllowed && "ease-out transition-[width,opacity]",
        )}
        style={{
          width: `${Math.min(progress, 100)}%`,
          opacity: progress >= 100 ? 0 : 1,
          ...(motionAllowed
            ? { transitionDuration: progress >= 100 ? `${FADE_MS}ms` : "200ms" }
            : {}),
        }}
      />
    </div>
  );
}
