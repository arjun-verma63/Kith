/**
 * The signalling contract.
 *
 * Signalling is how two peers agree on how to talk. It carries session
 * descriptions and network candidates, and it stops the moment the connection is
 * up — after that, media flows peer to peer and this layer is idle.
 *
 * ── Why this is an interface and not "the Supabase one" ──────────────────────
 *
 * `peer.ts` knows nothing about Supabase. It takes a `SignalingTransport` and
 * sends objects down it. Three things follow, and the third is the reason:
 *
 *   1. The peer logic is testable without a network — the suite wires two peers
 *      through an in-memory transport and watches them negotiate for real.
 *   2. Supabase Realtime is a hard dependency for calls (there is no other
 *      channel), so keeping it behind one seam means an outage is one module to
 *      route around rather than a rewrite.
 *   3. Nothing on this wire is ever persisted. The messages below are worthless
 *      a second after they arrive, and writing them to a table would mean a row
 *      per ICE candidate per call for data with a two-second shelf life. See
 *      docs/ARCHITECTURE.md §7 — the `calls` table stores metadata, never this.
 *
 * MEDIA NEVER TRAVELS HERE. Audio and video go directly between browsers over
 * SRTP. This transport carries a few kilobytes of text at the start of a call
 * and then nothing.
 */

/** Every message that can cross the wire. */
export type SignalMessage =
  | {
      type: "sdp";
      from: string;
      to: string;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "ice";
      from: string;
      to: string;
      /** Batched. See ICE_BATCH_MS. */
      candidates: RTCIceCandidateInit[];
    }
  | {
      type: "media";
      from: string;
      to: string;
      state: MediaState;
    }
  | {
      type: "bye";
      from: string;
      to: string;
      reason: HangupReason;
    };

/**
 * What each side is currently sending.
 *
 * Broadcast explicitly rather than inferred from track state. A muted track
 * still arrives — it is just silent — so a receiver cannot tell "muted" from
 * "quiet room" by looking at the stream, and an icon that guesses is an icon
 * that is sometimes wrong.
 */
export interface MediaState {
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
}

export const DEFAULT_MEDIA_STATE: MediaState = {
  micEnabled: true,
  cameraEnabled: false,
  screenSharing: false,
};

export type HangupReason = "hung_up" | "declined" | "failed" | "cancelled";

/**
 * A two-way channel between exactly two peers.
 *
 * Implementations must:
 *   - deliver messages to the OTHER peer only, never echo back to the sender
 *   - tolerate messages arriving out of order (the peer layer does not assume
 *     ordering, and ICE candidates genuinely can overtake an SDP)
 *   - be safe to `close()` twice
 */
export interface SignalingTransport {
  send(message: SignalMessage): void | Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(handler: (message: SignalMessage) => void): () => void;
  close(): void | Promise<void>;
}

/**
 * Politeness, for perfect negotiation.
 *
 * When both peers offer at the same moment ("glare"), somebody has to give way.
 * The polite peer rolls back its own offer and accepts the other; the impolite
 * peer ignores the incoming one and presses on. Without a rule, both roll back,
 * both re-offer, and the connection never settles.
 *
 * Comparing ids is deterministic and needs no coordination — both sides compute
 * the same answer from information they already have, with no extra round trip
 * and no chance of disagreeing.
 */
export function isPolite(selfId: string, peerId: string): boolean {
  return selfId > peerId;
}

/** An in-memory transport pair, for tests. Not used in the application. */
export function createLoopbackTransports(
  aId: string,
  bId: string,
): [SignalingTransport, SignalingTransport] {
  const handlers = new Map<string, Set<(message: SignalMessage) => void>>([
    [aId, new Set()],
    [bId, new Set()],
  ]);

  const make = (self: string, other: string): SignalingTransport => ({
    send(message) {
      // Delivered asynchronously on purpose. A synchronous hand-off would let
      // the negotiation complete in a single tick and hide every ordering bug
      // that a real network makes routine.
      // Round-tripped through JSON because the real transport is a socket. A
      // message that cannot survive serialisation must fail here, in a test,
      // rather than in a call.
      const wire = JSON.stringify(message);
      queueMicrotask(() => {
        const delivered = JSON.parse(wire) as SignalMessage;
        for (const handler of handlers.get(other) ?? []) handler(delivered);
      });
    },
    subscribe(handler) {
      handlers.get(self)?.add(handler);
      return () => {
        handlers.get(self)?.delete(handler);
      };
    },
    close() {
      handlers.get(self)?.clear();
    },
  });

  return [make(aId, bId), make(bId, aId)];
}
