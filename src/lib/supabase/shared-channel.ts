"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { PRIVATE_CHANNEL } from "@/lib/supabase/realtime";

/**
 * One subscription per topic, however many things are listening.
 *
 * A Phoenix socket may join a topic once. Two components each opening their own
 * channel for `game:{id}` is at best a wasted join and at worst a refused one —
 * and neither failure looks like a failure in development. You notice it later,
 * as "the canvas stops updating sometimes".
 *
 * So a topic is opened once, reference-counted, and torn down when the last
 * listener leaves. A single `event: "*"` binding receives everything and this
 * module fans it out, which also means a listener added after the channel is
 * live does not depend on late bindings behaving.
 *
 * ── Sending ──────────────────────────────────────────────────────────────────
 *
 * `send` is client-to-client broadcast, for things that are worthless a second
 * later and must never be stored: canvas strokes, typing dots, cursor
 * positions. Anything that has to survive a refresh is written to Postgres and
 * broadcast by a trigger instead — see docs/ARCHITECTURE.md §6.
 *
 * Authorization is the channel's, not this module's. Every KITH topic is private
 * and gated by a policy on `realtime.messages` (migration 0009), so who may
 * listen and who may broadcast is already decided before anything here runs.
 */

type Handler = (payload: unknown) => void;

type Channel = ReturnType<ReturnType<typeof getSupabaseBrowserClient>["channel"]>;

type StatusHandler = (connected: boolean) => void;

interface Entry {
  channel: Channel;
  handlers: Map<string, Set<Handler>>;
  status: Set<StatusHandler>;
  connected: boolean;
  refs: number;
}

const entries = new Map<string, Entry>();

function open(topic: string): Entry {
  const existing = entries.get(topic);
  if (existing) return existing;

  const supabase = getSupabaseBrowserClient();
  const channel = supabase.channel(topic, PRIVATE_CHANNEL);
  const handlers = new Map<string, Set<Handler>>();

  const entry: Entry = {
    channel,
    handlers,
    status: new Set<StatusHandler>(),
    connected: false,
    refs: 0,
  };

  channel
    .on("broadcast", { event: "*" }, (message: { event?: string; payload?: unknown }) => {
      const listeners = handlers.get(message.event ?? "");
      if (!listeners) return;
      for (const listener of listeners) listener(message.payload);
    })
    .subscribe((state) => {
      entry.connected = state === "SUBSCRIBED";
      for (const listener of entry.status) listener(entry.connected);
    });

  entries.set(topic, entry);
  return entry;
}

export interface Subscription {
  /** Drops these listeners. The channel closes when the last one goes. */
  unsubscribe: () => void;
  /**
   * Client-to-client broadcast. Never stored.
   *
   * Fire and forget: a dropped frame of a drawing is a dropped frame, and
   * awaiting each one would serialise the whole stream behind the network.
   */
  send: (event: string, payload: unknown) => void;
}

export function subscribeToTopic(
  topic: string,
  listeners: Record<string, Handler>,
  /**
   * Called when the channel connects or drops.
   *
   * A late subscriber joining an already-open channel is told immediately, but
   * on a microtask rather than synchronously — a caller wiring this up inside an
   * effect must not have its state set during that effect.
   */
  onStatus?: StatusHandler,
): Subscription {
  const entry = open(topic);
  entry.refs += 1;

  for (const [event, handler] of Object.entries(listeners)) {
    const set = entry.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    entry.handlers.set(event, set);
  }

  if (onStatus) {
    entry.status.add(onStatus);
    if (entry.connected) queueMicrotask(() => onStatus(true));
  }

  let released = false;

  return {
    send(event, payload) {
      if (released) return;
      void entry.channel.send({ type: "broadcast", event, payload });
    },

    unsubscribe() {
      if (released) return;
      released = true;

      for (const [event, handler] of Object.entries(listeners)) {
        entry.handlers.get(event)?.delete(handler);
      }
      if (onStatus) entry.status.delete(onStatus);

      entry.refs -= 1;
      if (entry.refs > 0) return;

      entries.delete(topic);
      void getSupabaseBrowserClient().removeChannel(entry.channel);
    },
  };
}
