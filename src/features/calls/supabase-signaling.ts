"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { channels, PRIVATE_CHANNEL } from "@/lib/supabase/realtime";
import type { SignalingTransport, SignalMessage } from "@/lib/webrtc/signaling";

/**
 * `SignalingTransport` over Supabase Realtime.
 *
 * This is the only place in the codebase that knows calls are signalled over
 * Supabase. `peer.ts` sees an interface; swapping this out for a plain WebSocket
 * later would touch this file and nothing else.
 *
 * ── Authorization ────────────────────────────────────────────────────────────
 *
 * The `call:{callId}` channel is private, and subscription is checked against
 * `realtime.messages` policies using `is_call_participant()` (migration 0009).
 * A conversation member who was not rung cannot open the channel at all — not
 * "can open it but sees nothing", cannot open it. Nothing in this file checks
 * permissions, because by the time a message arrives here the database has
 * already decided the subscriber belongs on the call.
 *
 * That also means `from` on an incoming message is not something a client can
 * usefully forge to a stranger: only participants can broadcast, and `peer.ts`
 * drops anything whose `from`/`to` do not match the pair it was constructed for.
 * The worst a participant can do is send nonsense to another participant on a
 * call they are already on.
 *
 * ── What crosses this wire ───────────────────────────────────────────────────
 *
 * SDP, ICE candidates, media state, hangup. Kilobytes, at the start of a call.
 * Audio and video go directly between browsers over SRTP and never reach
 * Supabase — not the socket, and certainly not the database. Nothing sent here is
 * persisted; `realtime.messages` is a delivery mechanism, not a table we write
 * to.
 *
 * ── Ordering ─────────────────────────────────────────────────────────────────
 *
 * Broadcast is not ordered end to end, and ICE candidates genuinely can arrive
 * before the SDP they belong to. `peer.ts` tolerates that (a candidate applied
 * with no remote description is caught and, during a deliberately ignored offer,
 * dropped), so this layer does not attempt resequencing — a reorder buffer here
 * would add latency to fix a problem the layer above already handles.
 */

/** One broadcast event carries every message type; the union discriminates. */
const SIGNAL_EVENT = "signal";

export interface SupabaseSignalingOptions {
  callId: string;
  selfId: string;
  /** Fires once the channel is live, so the caller can stop showing "connecting". */
  onSubscribed?: (ok: boolean) => void;
}

/**
 * Narrows an untrusted broadcast payload.
 *
 * Realtime payloads are `any` as far as the type system is concerned — they came
 * off a socket. Anything that does not match the union is dropped rather than
 * handed to `setRemoteDescription`, where a malformed value would surface as an
 * opaque WebRTC error instead of an ignored message.
 */
function parseSignal(payload: unknown): SignalMessage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;

  if (typeof value["from"] !== "string" || typeof value["to"] !== "string") return null;

  switch (value["type"]) {
    case "sdp":
      return typeof value["description"] === "object" && value["description"] !== null
        ? (value as unknown as SignalMessage)
        : null;
    case "ice":
      return Array.isArray(value["candidates"]) ? (value as unknown as SignalMessage) : null;
    case "media":
      return typeof value["state"] === "object" && value["state"] !== null
        ? (value as unknown as SignalMessage)
        : null;
    case "bye":
      return typeof value["reason"] === "string" ? (value as unknown as SignalMessage) : null;
    default:
      return null;
  }
}

export function createSupabaseSignaling(options: SupabaseSignalingOptions): SignalingTransport {
  const { callId, selfId, onSubscribed } = options;

  const supabase = getSupabaseBrowserClient();
  const channel = supabase.channel(channels.call(callId), PRIVATE_CHANNEL);

  const handlers = new Set<(message: SignalMessage) => void>();
  let closed = false;

  // Broadcast echoes to the sender unless `self: false` is configured, and
  // Supabase's default differs between versions. Filtering on `from` here is one
  // line and does not depend on which default we got — a peer must never
  // process its own offer.
  channel
    .on("broadcast", { event: SIGNAL_EVENT }, ({ payload }: { payload: unknown }) => {
      const message = parseSignal(payload);
      if (!message || message.from === selfId) return;
      for (const handler of handlers) handler(message);
    })
    .subscribe((status) => {
      onSubscribed?.(status === "SUBSCRIBED");
    });

  return {
    send(message) {
      if (closed) return;
      // Fire and forget. A dropped SDP is recovered by renegotiation and a
      // dropped candidate by the ones that follow; awaiting each send would
      // serialise trickle ICE for no benefit.
      void channel.send({ type: "broadcast", event: SIGNAL_EVENT, payload: message });
    },

    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      void supabase.removeChannel(channel);
    },
  };
}
