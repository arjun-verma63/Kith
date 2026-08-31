/**
 * ICE configuration.
 *
 * STUN only, for now. A STUN server does one thing: it tells a peer what its
 * public address looks like from outside its NAT, so the two sides can try to
 * reach each other directly. It never carries media.
 *
 * ── Why TURN is not here yet, and why that matters ───────────────────────────
 *
 * STUN is not sufficient for a product that claims to work. A meaningful share
 * of real-world pairs cannot connect with STUN alone:
 *
 *   - symmetric NAT, where the mapping differs per destination, so the address
 *     STUN reports is not the one the other peer would reach
 *   - carrier-grade NAT, which most mobile networks use
 *   - restrictive corporate firewalls, where UDP is simply gone
 *
 * For those, a TURN server relays the (still encrypted) media. It is the one
 * component in KITH that is neither free nor serverless, and it is a deliberate
 * decision rather than an oversight — see docs/ARCHITECTURE.md §7.
 *
 * The shape below is already correct for TURN: `iceServers` takes the relay
 * entries alongside the STUN ones, and `getIceServers()` is async precisely
 * because TURN credentials must be FETCHED per call. They are minted server-side
 * with a short expiry, never embedded in client code — a static TURN password in
 * a browser bundle is an open bandwidth relay for the internet.
 */

/**
 * Public STUN. Two entries from different operators, because a single STUN
 * server being unreachable should degrade the connection, not prevent it.
 */
const STUN_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: ["stun:stun.cloudflare.com:3478"] },
];

export interface IceOptions {
  /**
   * Relay entries, fetched from `/api/rtc/ice` when TURN lands. Passing them
   * here rather than importing them keeps this module free of network calls and
   * therefore trivially testable.
   */
  turnServers?: RTCIceServer[];
  /**
   * Forces every candidate through a relay. Useful for verifying that TURN
   * actually works — without it a developer on an open network will always
   * connect peer-to-peer and never exercise the relay path at all.
   */
  forceRelay?: boolean;
}

export function buildIceConfiguration(options: IceOptions = {}): RTCConfiguration {
  const iceServers = [...STUN_SERVERS, ...(options.turnServers ?? [])];

  return {
    iceServers,
    // Gather from every interface. The alternative trades connection reliability
    // for hiding local IPs, which matters for a public site and not for six
    // people who already know each other.
    iceTransportPolicy: options.forceRelay ? "relay" : "all",
    // One pre-warmed candidate pair. Shaves a round trip off connection setup at
    // the cost of a single unused socket if the call never happens.
    iceCandidatePoolSize: 1,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  };
}

/**
 * How long ICE candidates are held before being sent as a batch.
 *
 * Trickle ICE produces a burst of candidates in the first second of a call. One
 * broadcast each is the single easiest way to exhaust a monthly realtime message
 * allowance; batching turns roughly twenty messages into two, and 200ms is far
 * below the point where a human notices connection setup taking longer.
 */
export const ICE_BATCH_MS = 200;

/**
 * How long to wait in `disconnected` before attempting an ICE restart.
 *
 * `disconnected` is routinely transient — a wifi handover produces it and clears
 * on its own — so acting immediately would restart connections that were about
 * to recover by themselves.
 */
export const RECONNECT_GRACE_MS = 4000;

/**
 * How long a connection may stay in `reconnecting` before it is called failed.
 *
 * Without this, a peer whose partner has closed their laptop shows
 * "Reconnecting…" forever: the polite side never restarts ICE by design, and a
 * restart that nobody answers never fails on its own. An honest error after
 * twenty seconds is better than a spinner that means nothing — the same rule
 * presence follows for stale online lights.
 */
export const RECONNECT_TIMEOUT_MS = 20_000;
