"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { channels, PRIVATE_CHANNEL } from "@/lib/supabase/realtime";
import type { DeclaredStatus } from "@/lib/presence";

/**
 * Realtime presence.
 *
 * One channel, `presence:lobby`, for the whole room — affordable precisely
 * because the room is six people. Supabase Realtime Presence keeps the set of
 * connected clients in the server's memory and broadcasts a diff on every join
 * and leave, so there are no database writes at all and no polling.
 *
 * ── The requirement that shapes everything here ───────────────────────────────
 *
 * "Do not falsely show users as online indefinitely."
 *
 * Three separate things can go wrong, and each needs its own answer:
 *
 *   1. THEY disconnect. Phoenix removes a client when its socket closes and
 *      broadcasts a leave, so this is handled for us — including the unclean
 *      case, where the server's heartbeat timeout notices within about a minute.
 *
 *   2. WE disconnect. This is the dangerous one. Our last snapshot said five
 *      people were online, and if we keep rendering it we show five lit embers
 *      forever while knowing nothing. So on any non-subscribed channel state the
 *      map is set to `null` — an explicit "we do not know" that makes every
 *      consumer fall back to `last_seen_at`.
 *
 *   3. We never connect at all: server rendering, a blocked socket, Supabase
 *      down. Same `null`, same fallback. Absence of evidence is never rendered
 *      as evidence of presence.
 *
 * `null` versus `{}` is the whole safety property: an empty map means "nobody is
 * online", `null` means "ask the database instead".
 *
 * Lives in `components/` rather than `features/` because every feature consumes
 * it and none owns it — the same reason the theme toggle does.
 */

/** What a client publishes about itself. Deliberately tiny: it is broadcast. */
interface PresenceMeta {
  userId: string;
  /** `online` while the tab is visible and in use; `idle` otherwise. */
  activity: "online" | "idle";
  at: string;
}

export type LivePresenceMap = Record<string, PresenceMeta["activity"]>;

interface PresenceContextValue {
  /** `null` means no live connection. Consumers must fall back to last_seen_at. */
  live: LivePresenceMap | null;
  connected: boolean;
}

const PresenceContext = createContext<PresenceContextValue>({ live: null, connected: false });

export function usePresenceContext(): PresenceContextValue {
  return useContext(PresenceContext);
}

/** No pointer or key for this long and the tab counts as idle. */
const IDLE_AFTER_MS = 5 * 60 * 1000;

export interface PresenceProviderProps {
  userId: string;
  status: DeclaredStatus;
  children: ReactNode;
}

export function PresenceProvider({ userId, status, children }: PresenceProviderProps) {
  const [live, setLive] = useState<LivePresenceMap | null>(null);
  const [connected, setConnected] = useState(false);

  // Held in a ref so the idle timer can re-track without re-running the effect
  // and tearing the channel down.
  const activityRef = useRef<PresenceMeta["activity"]>("online");

  useEffect(() => {
    /*
     * Somebody who has chosen to be invisible never joins the channel.
     *
     * Not "joins and is filtered out on render" — the meta never leaves this
     * browser. A privacy setting enforced by the RECEIVING client is not a
     * privacy setting, because the data was still sent.
     */
    if (status === "invisible") return;

    const supabase = getSupabaseBrowserClient();
    const channel = supabase.channel(channels.presence(), PRIVATE_CHANNEL);

    let cancelled = false;
    let idleTimer = 0;

    const readState = () => {
      if (cancelled) return;

      const state = channel.presenceState<PresenceMeta>();
      const map: LivePresenceMap = {};

      for (const entries of Object.values(state)) {
        for (const entry of entries) {
          if (!entry.userId) continue;
          // Somebody with two tabs open appears twice. Online beats idle: a
          // laptop in the background and a phone in hand is "here".
          if (map[entry.userId] !== "online") map[entry.userId] = entry.activity;
        }
      }

      setLive(map);
    };

    const track = (activity: PresenceMeta["activity"]) => {
      activityRef.current = activity;
      void channel.track({
        userId,
        activity,
        at: new Date().toISOString(),
      } satisfies PresenceMeta);
    };

    const goIdle = () => {
      if (activityRef.current !== "idle") track("idle");
    };

    const goActive = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(goIdle, IDLE_AFTER_MS);
      if (activityRef.current !== "online") track("online");
    };

    const onVisibility = () => {
      // A hidden tab is idle immediately. Waiting five minutes to say so is how
      // a row of lit embers stops meaning anything.
      if (document.visibilityState === "hidden") goIdle();
      else goActive();
    };

    channel
      .on("presence", { event: "sync" }, readState)
      .on("presence", { event: "join" }, readState)
      .on("presence", { event: "leave" }, readState)
      .subscribe((channelStatus) => {
        if (cancelled) return;

        if (channelStatus === "SUBSCRIBED") {
          setConnected(true);
          track(document.visibilityState === "hidden" ? "idle" : "online");
          return;
        }

        // CHANNEL_ERROR, TIMED_OUT, CLOSED. Anything that is not a live
        // subscription means the snapshot is no longer trustworthy — and a stale
        // snapshot IS the "online indefinitely" failure.
        setConnected(false);
        setLive(null);
      });

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointerdown", goActive, { passive: true });
    window.addEventListener("keydown", goActive);

    // A clean leave on unload. The server would notice eventually through its
    // heartbeat timeout, but eventually is up to a minute of showing somebody as
    // present after they closed the tab.
    const onUnload = () => {
      void channel.untrack();
    };
    window.addEventListener("pagehide", onUnload);

    idleTimer = window.setTimeout(goIdle, IDLE_AFTER_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(idleTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointerdown", goActive);
      window.removeEventListener("keydown", goActive);
      window.removeEventListener("pagehide", onUnload);

      void channel.untrack().then(() => supabase.removeChannel(channel));
    };
  }, [userId, status]);

  /*
   * Invisibility is applied here rather than by clearing state inside the
   * effect: the effect simply never connects, and the context reports "no live
   * data" by derivation. Setting state to express something already knowable
   * from props costs an extra render and leaves a stale frame in between.
   */
  const value = useMemo<PresenceContextValue>(
    () => (status === "invisible" ? { live: null, connected: false } : { live, connected }),
    [live, connected, status],
  );

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}
