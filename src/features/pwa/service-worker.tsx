"use client";

import { useEffect } from "react";

/**
 * Registers the service worker.
 *
 * ── Production only ──────────────────────────────────────────────────────────
 *
 * In development the dev server rebuilds chunks on every save, and a worker
 * holding a cache-first policy over `/_next/static/` in front of that is a
 * source of "why is my change not showing" that costs more time than it saves.
 * The worker is a production concern, so it registers in production.
 *
 * ── After the page, not with it ──────────────────────────────────────────────
 *
 * Registration competes for bandwidth with whatever the page is still loading,
 * and nothing about the first visit depends on it — the worker only matters from
 * the second one. So it waits for `load`.
 *
 * ── What it does not do ──────────────────────────────────────────────────────
 *
 * It does not ask for notification permission, because there is nothing behind
 * that permission: KITH has no push. It does not prompt to install either —
 * `beforeinstallprompt` is deliberately left alone so the browser's own,
 * quieter affordance is what people see. An app that asks to be installed on the
 * first visit is asking before it has been any use.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
        // A failed registration is not a failed page. It costs the offline
        // fallback and the install prompt, and nothing else.
        console.warn("[kith:pwa] service worker not registered", {
          message: error instanceof Error ? error.message : "unknown",
        });
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}

/**
 * Tears the worker down, from the page.
 *
 * Not wired to anything, and exported on purpose. A service worker that has gone
 * wrong is close to impossible to talk somebody through clearing on a phone —
 * "open Settings, Safari, Advanced, Website Data" — and this is the one-liner to
 * paste into a console instead, or to put behind a button in Settings if it ever
 * turns out to be needed.
 *
 *     import("@/features/pwa/service-worker").then((m) => m.unregisterServiceWorker())
 */
export async function unregisterServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;

  const registration = await navigator.serviceWorker.getRegistration();
  registration?.active?.postMessage("kith:reset");

  // Belt and braces: the message handler unregisters itself, but a worker that
  // is broken enough to need this may be broken enough not to answer.
  await registration?.unregister();
}
