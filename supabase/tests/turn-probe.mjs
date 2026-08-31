/**
 * A child process that reports what TURN configuration produces.
 *
 * `getTurnEnv()` caches after its first call — deliberately, since it validates
 * and warns — so a single process cannot exercise "configured with HMAC", "…with
 * static credentials" and "…not configured at all". Each is a separate process
 * with its own environment, which is also how it actually works in production.
 *
 * Prints one JSON object on stdout. Warnings go to stderr and are captured
 * separately, because "did it warn about the missing TLS URL?" is itself a test.
 *
 * Not part of the application. Run by turn.test.mjs.
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const userId = process.argv[2] ?? "00000000-0000-4000-8000-000000000001";

try {
  const { getTurnCredential, verifyHmacCredential, isExpired } =
    await import("../../src/lib/server/turn.ts");

  const credential = getTurnCredential(userId);
  const entry = credential.iceServers[0] ?? null;

  const username = entry?.username ?? null;
  const secret = process.env.TURN_SHARED_SECRET;

  console.log(
    JSON.stringify({
      ok: true,
      source: credential.source,
      transports: credential.transports,
      expiresAt: credential.expiresAt,
      serverCount: credential.iceServers.length,
      urls: entry ? (Array.isArray(entry.urls) ? entry.urls : [entry.urls]) : [],
      username,
      credential: entry?.credential ?? null,
      // Verified in-process against the real secret, so the test can assert the
      // scheme is right without ever seeing the secret itself.
      verifies:
        secret && username && entry?.credential
          ? verifyHmacCredential(secret, username, String(entry.credential))
          : null,
      expired: username ? isExpired(username) : null,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
