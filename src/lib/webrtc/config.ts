/**
 * ICE configuration.
 *
 * ICE is how two browsers find a path to each other. It tries every route it can
 * think of, in parallel, and keeps the best one that works:
 *
 *   host    the local network. Free, instant, works between two laptops on the
 *           same wifi and nowhere else.
 *   srflx   the public address a STUN server reports. Works whenever both NATs
 *           are willing to accept a return packet from an address they have
 *           sent to — which is most home routers, most of the time.
 *   relay   a TURN server in the middle, forwarding packets both ways. Works
 *           when nothing else does, and costs bandwidth, so it is the fallback
 *           rather than the plan.
 *
 * ── Why relay is not optional ────────────────────────────────────────────────
 *
 * STUN alone fails for a real share of pairs, and the failures are not random —
 * they cluster on exactly the networks people are on when they most want to
 * call:
 *
 *   symmetric NAT      the mapping differs per destination, so the address STUN
 *                      reports is not the one the other peer would reach
 *   carrier-grade NAT  most mobile networks
 *   corporate firewall UDP simply absent, sometimes everything but 443 absent
 *
 * The last case is why TURN over TLS on 443 matters. To a firewall it is
 * indistinguishable from HTTPS, which is the point.
 *
 * ── This module holds no credentials ─────────────────────────────────────────
 *
 * Relay entries are PASSED IN. They are minted server-side, per user, with a
 * short expiry (`lib/server/turn.ts`), because a TURN credential in a browser
 * bundle is an open bandwidth relay for anybody who opens devtools. Keeping the
 * fetch out of this file also keeps it pure: everything below is a function of
 * its arguments, and the test suite can drive every branch without a network.
 */

/**
 * Public STUN. Two operators, because one being unreachable should slow a
 * connection down rather than prevent it.
 *
 * These are free public servers and are treated as best-effort: if both vanish,
 * host candidates still work on a local network and relay candidates still work
 * everywhere else. Nothing here is a secret — a STUN server learns your IP and
 * nothing more, which is the same thing every website you load learns.
 */
const STUN_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: ["stun:stun.cloudflare.com:3478"] },
];

export interface IceOptions {
  /**
   * Relay entries, fetched at call time. Never imported, never hardcoded.
   */
  turnServers?: RTCIceServer[];
  /**
   * Forces every candidate through a relay.
   *
   * The only reliable way to verify TURN actually works. Without it a developer
   * on an open network connects peer-to-peer every time and never exercises the
   * relay path at all — so a broken TURN configuration ships, and is discovered
   * by the one person on a corporate network who cannot call anybody.
   */
  forceRelay?: boolean;
}

export function buildIceConfiguration(options: IceOptions = {}): RTCConfiguration {
  const turnServers = options.turnServers ?? [];
  const iceServers = [...STUN_SERVERS, ...turnServers];

  return {
    iceServers,
    // Gather from every interface. The alternative trades connection reliability
    // for hiding local IPs, which matters for a public site and not for six
    // people who already know each other.
    iceTransportPolicy: options.forceRelay ? "relay" : "all",
    /*
     * Pre-gathering.
     *
     * One pre-warmed candidate shaves a round trip off setup — but with TURN
     * configured, pre-gathering ALLOCATES A RELAY on the TURN server before
     * anybody has called anybody. On a metered relay that is billable traffic
     * for a call that may never happen, and allocations that are never used
     * still hold a port until they time out.
     *
     * So it is on only while there is nothing to waste.
     */
    iceCandidatePoolSize: turnServers.length > 0 ? 0 : 1,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  };
}

/* ========================================================================== */
/*  Describing a configuration                                                */
/* ========================================================================== */

export type IceTransport = "stun" | "turn-udp" | "turn-tcp" | "turn-tls";

/**
 * What a single ICE URL actually provides.
 *
 * Parsed rather than pattern-matched loosely, because the difference between
 * `turn:` and `turns:` is the difference between "works in a coffee shop" and
 * "works in an office", and a typo in an environment variable is invisible
 * otherwise.
 *
 * The grammar (RFC 7064/7065) is `turn:host:port?transport=udp|tcp`, where the
 * default transport for `turn:` is UDP and for `turns:` is TCP.
 */
export function classifyIceUrl(url: string): IceTransport | null {
  const trimmed = url.trim();

  if (trimmed.startsWith("stun:") || trimmed.startsWith("stuns:")) return "stun";

  const secure = trimmed.startsWith("turns:");
  if (!secure && !trimmed.startsWith("turn:")) return null;

  const transport = /[?&]transport=(udp|tcp)\b/i.exec(trimmed)?.[1]?.toLowerCase();

  // `turns:` is TLS whatever the transport parameter says — TLS runs over TCP,
  // and `turns:...?transport=udp` means DTLS, which no browser offers.
  if (secure) return "turn-tls";

  return transport === "tcp" ? "turn-tcp" : "turn-udp";
}

export function urlsOf(server: RTCIceServer): string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

export interface IceCoverage {
  transports: IceTransport[];
  hasRelay: boolean;
  /** URLs that could not be parsed. Almost always a typo in configuration. */
  invalid: string[];
}

/**
 * What a set of ICE servers covers.
 *
 * Used to log a warning at boot when TURN is configured without a TLS entry —
 * the most common half-configuration, and the one whose symptom is "calls work
 * for everyone except the person in the office".
 */
export function describeIceServers(servers: RTCIceServer[]): IceCoverage {
  const transports = new Set<IceTransport>();
  const invalid: string[] = [];

  for (const server of servers) {
    for (const url of urlsOf(server)) {
      const kind = classifyIceUrl(url);
      if (kind) transports.add(kind);
      else invalid.push(url);
    }
  }

  return {
    transports: [...transports].sort(),
    hasRelay: [...transports].some((t) => t.startsWith("turn")),
    invalid,
  };
}

/* ========================================================================== */
/*  Timings                                                                   */
/* ========================================================================== */

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

/**
 * How long before expiry a credential is considered stale.
 *
 * A relay credential that expires mid-call cannot be renewed on the existing
 * allocation, so a reconnect would fail exactly when it is most needed. Fresh
 * ones are fetched this far ahead of the deadline.
 */
export const ICE_REFRESH_MARGIN_MS = 60_000;
