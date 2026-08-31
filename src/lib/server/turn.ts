import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { classifyIceUrl, type IceTransport } from "@/lib/webrtc/config";
import { getTurnEnv } from "@/lib/env/server";

/**
 * TURN credentials, minted here and nowhere else.
 *
 * ── The rule this file exists to enforce ─────────────────────────────────────
 *
 * A TURN credential in a browser bundle is an open bandwidth relay for the
 * internet. Anybody who opens devtools, or greps the JavaScript, gets a free
 * proxy billed to us — and TURN relays arbitrary UDP, so it is also an open
 * proxy for whatever somebody wants to send through it.
 *
 * So the secret stays on the server, and the browser is handed a credential that
 * is short-lived and useless tomorrow. `import "server-only"` at the top is the
 * mechanical guard: a client component importing this file, directly or through
 * any chain, fails the build rather than shipping the secret.
 *
 * ── Two ways to hold a credential, both supported ────────────────────────────
 *
 * Providers differ, and the point of this module is that swapping provider is a
 * change to `.env` rather than to the application:
 *
 *   HMAC (preferred).  coturn's `use-auth-secret`, and the same scheme used by
 *   most self-hosted and several managed relays. The server and the TURN server
 *   share one secret. A credential is derived from it — `username` is an expiry
 *   timestamp, `credential` is an HMAC of that username — and the TURN server
 *   verifies it by recomputing the same HMAC. Nothing is stored, nothing is
 *   registered, and every credential dies on its own. This is the shape TURN was
 *   designed for (RFC 5766 §10.2, the "TURN REST API" draft).
 *
 *   STATIC.  A long-lived username and password issued by a provider that does
 *   not support HMAC. Still never inlined into the bundle — it is delivered
 *   through an authenticated request, so only signed-in members of the room ever
 *   receive it. That is weaker: a member who wants to abuse it can, and rotating
 *   means changing an environment variable. Supported because some providers
 *   offer nothing else, and flagged as second-best wherever it appears.
 *
 * ── And a third: none ────────────────────────────────────────────────────────
 *
 * With nothing configured, this returns an empty list and calls run on STUN
 * alone — exactly as they did before TURN existed. That is the graceful
 * fallback, and it is the default: a fresh clone of this repository runs, builds
 * and makes calls without anybody signing up for a relay.
 */

export interface TurnCredential {
  iceServers: RTCIceServer[];
  /** When these stop working. Null when they never expire (static mode). */
  expiresAt: string | null;
  /** For diagnostics and the docs' "is TURN actually on?" question. */
  source: "hmac" | "static" | "none";
  transports: IceTransport[];
}

/** Nothing configured. Calls fall back to STUN, which is the pre-TURN behaviour. */
const NO_RELAY: TurnCredential = {
  iceServers: [],
  expiresAt: null,
  source: "none",
  transports: [],
};

/**
 * Derives an ephemeral credential.
 *
 * The scheme, which is fixed by what TURN servers verify rather than by
 * preference:
 *
 *   username   = "<unix expiry>:<opaque user id>"
 *   credential = base64( HMAC-SHA1( shared secret, username ) )
 *
 * SHA-1 is not a choice. `coturn` and every compatible relay compute exactly
 * this, and a different digest simply fails to authenticate. It is used here as
 * a MAC with a high-entropy key, which is the one construction SHA-1 is still
 * sound for — the collision attacks that killed it for signatures do not apply.
 *
 * The user id is included so a relay's logs can attribute traffic, and so a
 * leaked credential is traceable to the account it was minted for.
 */
function mintHmacCredential(
  secret: string,
  userId: string,
  ttlSeconds: number,
): { username: string; credential: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const username = `${Math.floor(expiresAt.getTime() / 1000)}:${userId}`;

  const credential = createHmac("sha1", secret).update(username).digest("base64");

  return { username, credential, expiresAt };
}

/**
 * Verifies a credential this server minted.
 *
 * Not used by the application — the TURN server does the checking — but it is
 * what lets the test suite assert the scheme is implemented correctly rather
 * than merely consistently with itself. A wrong-but-self-consistent HMAC passes
 * every test that only compares our output to our output, and then fails against
 * a real relay.
 */
export function verifyHmacCredential(
  secret: string,
  username: string,
  credential: string,
): boolean {
  const expected = createHmac("sha1", secret).update(username).digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(credential);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/** Whether a credential's expiry has passed. */
export function isExpired(username: string, now = new Date()): boolean {
  const seconds = Number.parseInt(username.split(":")[0] ?? "", 10);
  if (!Number.isFinite(seconds)) return true;
  return seconds * 1000 <= now.getTime();
}

/**
 * The relay entries for one user, right now.
 *
 * Called per call rather than cached across users: an HMAC credential embeds the
 * user id, and handing one person's credential to another would make a relay's
 * logs useless and a leak untraceable.
 *
 * Never throws. A misconfigured relay must degrade a call to STUN, not stop
 * somebody from ringing their friend — the failure this protects against is
 * "nobody can call anybody because an environment variable has a typo in it".
 */
export function getTurnCredential(userId: string): TurnCredential {
  const env = getTurnEnv();
  if (!env) return NO_RELAY;

  const transports = env.urls
    .map((url) => classifyIceUrl(url))
    .filter((kind): kind is IceTransport => kind !== null);

  try {
    if (env.mode === "hmac") {
      const { username, credential, expiresAt } = mintHmacCredential(
        env.sharedSecret,
        userId,
        env.ttlSeconds,
      );

      return {
        // One entry carrying every URL, rather than one entry per URL. Browsers
        // gather from all of them, and grouping keeps the credential written
        // once instead of repeated per transport.
        iceServers: [{ urls: env.urls, username, credential }],
        expiresAt: expiresAt.toISOString(),
        source: "hmac",
        transports,
      };
    }

    return {
      iceServers: [{ urls: env.urls, username: env.username, credential: env.password }],
      // Static credentials do not expire, which is precisely their weakness.
      expiresAt: null,
      source: "static",
      transports,
    };
  } catch (error) {
    // Reaching here means the environment validated but minting still failed —
    // an unusable secret, most likely. Logged loudly, because a silent
    // degradation to STUN looks exactly like TURN working right up until
    // somebody on a locked-down network cannot connect.
    console.error("[turn] could not mint a credential; falling back to STUN only", error);
    return NO_RELAY;
  }
}
