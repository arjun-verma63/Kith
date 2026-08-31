"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { channels, PRIVATE_CHANNEL } from "@/lib/supabase/realtime";

/**
 * One shared subscription to `user:{id}`, the personal bus.
 *
 * Two things now listen on it — the notification bell and the call provider —
 * and more will. Each opening its own channel would mean two Phoenix joins on
 * the same topic over the same socket, which is at best wasteful and at worst
 * the second join being refused. Neither is a failure you would notice in
 * development; you would notice it as "notifications stopped working sometimes".
 *
 * So the channel is opened once, reference-counted, and torn down when the last
 * listener goes away. A single `event: "*"` binding receives everything and this
 * module fans it out, which also means a listener added after the channel is
 * live does not depend on late bindings behaving.
 *
 * Authorization is unchanged: `user:{id}` is read-only from a browser and
 * readable only by that user (migration 0009). Nothing is broadcast from here.
 */

type Handler = (payload: unknown) => void;

interface Entry {
  channel: ReturnType<ReturnType<typeof getSupabaseBrowserClient>["channel"]>;
  handlers: Map<string, Set<Handler>>;
  refs: number;
}

const entries = new Map<string, Entry>();

function open(userId: string): Entry {
  const existing = entries.get(userId);
  if (existing) return existing;

  const supabase = getSupabaseBrowserClient();
  const channel = supabase.channel(channels.user(userId), PRIVATE_CHANNEL);
  const handlers = new Map<string, Set<Handler>>();

  channel
    .on("broadcast", { event: "*" }, (message: { event?: string; payload?: unknown }) => {
      const listeners = handlers.get(message.event ?? "");
      if (!listeners) return;
      for (const listener of listeners) listener(message.payload);
    })
    .subscribe();

  const entry: Entry = { channel, handlers, refs: 0 };
  entries.set(userId, entry);
  return entry;
}

/**
 * Listens for events on this user's personal channel.
 *
 * Returns an unsubscribe function. The channel closes once every listener has
 * unsubscribed.
 */
export function subscribeToUserEvents(
  userId: string,
  listeners: Record<string, Handler>,
): () => void {
  const entry = open(userId);
  entry.refs += 1;

  for (const [event, handler] of Object.entries(listeners)) {
    const set = entry.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    entry.handlers.set(event, set);
  }

  let released = false;

  return () => {
    if (released) return;
    released = true;

    for (const [event, handler] of Object.entries(listeners)) {
      entry.handlers.get(event)?.delete(handler);
    }

    entry.refs -= 1;
    if (entry.refs > 0) return;

    entries.delete(userId);
    void getSupabaseBrowserClient().removeChannel(entry.channel);
  };
}
