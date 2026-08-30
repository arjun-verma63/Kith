"use client";

import { useEffect } from "react";

import { touchLastSeenAction } from "@/features/profile/actions";

/**
 * Keeps `last_seen_at` fresh while a tab is open and visible.
 *
 * Renders nothing. Mounted once in the app shell, so there is exactly one
 * heartbeat per tab no matter how many components care about presence.
 *
 * Three deliberate details:
 *
 *   Only beats while the tab is VISIBLE. A background tab left open for a week
 *   should not report its owner as around — that is the difference between
 *   presence and an uptime monitor.
 *
 *   Beats on `visibilitychange`, so coming back to the tab lights you up
 *   immediately rather than up to a minute later.
 *
 *   The interval is 60s but the database only writes if the value is already
 *   45s stale, so the real write rate is bounded server-side. A bug here costs
 *   requests, never a write storm.
 *
 * This is the durable half of presence. Realtime Presence makes "who is online
 * right now" instant without any writes at all, and lands with the app shell.
 */
export function PresenceHeartbeat() {
  useEffect(() => {
    let stopped = false;

    const beat = () => {
      if (stopped || document.visibilityState !== "visible") return;
      void touchLastSeenAction();
    };

    beat();
    const interval = window.setInterval(beat, 60_000);
    document.addEventListener("visibilitychange", beat);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", beat);
    };
  }, []);

  return null;
}
