/**
 * TURN tests.
 *
 * A relay is the one piece of KITH that costs money if it goes wrong, and the
 * two ways it goes wrong are silent:
 *
 *   A credential leaks, and somebody has a free proxy billed to us. TURN relays
 *   arbitrary traffic, so it is not only bandwidth — it is an open proxy.
 *
 *   A credential is subtly wrong, and every relayed call fails. This one is
 *   invisible in development: on an open network every call connects directly,
 *   so a completely broken relay configuration looks perfect until the first
 *   person on a corporate network tries to ring somebody.
 *
 * So this suite checks the scheme against what a real TURN server computes
 * rather than against itself, and checks that the secret never appears in
 * anything handed to a browser.
 *
 * Environment-dependent behaviour runs in child processes — `getTurnEnv()`
 * caches, and one process cannot hold three different configurations.
 *
 *     npm run turn:test
 */

import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const { buildIceConfiguration, classifyIceUrl, describeIceServers } =
  await import("../../src/lib/webrtc/config.ts");

let passed = 0;
let failed = 0;
const failures = [];

const ok = (n) => {
  passed += 1;
  console.log(`  ✓ ${n}`);
};
const bad = (n, d) => {
  failed += 1;
  failures.push(`${n} — ${d}`);
  console.log(`  ✗ ${n}\n      ${d}`);
};
const eq = (n, a, e) =>
  JSON.stringify(a) === JSON.stringify(e)
    ? ok(n)
    : bad(n, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const truthy = (n, v, d = "expected a truthy value") => (v ? ok(n) : bad(n, d));
const section = (t) => console.log(`\n${t}`);

const PROBE = join(import.meta.dirname, "turn-probe.mjs");

/**
 * Runs the probe with a given environment.
 *
 * A child process per configuration, because `getTurnEnv()` caches after its
 * first call and one process cannot hold three different setups. That is also
 * how it behaves in production — validated once, at boot.
 *
 * `--conditions=react-server` is what lets a `server-only` module be imported at
 * all: the package deliberately throws under every other condition, which is
 * exactly the guard being relied on everywhere else in the codebase.
 */
function probe(env, userId = "11111111-1111-4111-8111-111111111111") {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("TURN_")) delete clean[key];
  }

  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--no-warnings", PROBE, userId],
    { env: { ...clean, ...env }, encoding: "utf8" },
  );

  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).at(-1);

  return {
    ...(line ? JSON.parse(line) : { ok: false, message: result.stderr ?? "no output" }),
    stderr: result.stderr ?? "",
  };
}

console.log("KITH — TURN\n");

const RELAY_URLS = [
  "turn:relay.example.com:3478?transport=udp",
  "turn:relay.example.com:3478?transport=tcp",
  "turns:relay.example.com:5349?transport=tcp",
].join(",");

/* ==========================================================================
 * 1 · Reading an ICE URL
 *
 * The difference between turn: and turns: is the difference between "works in a
 * coffee shop" and "works in an office". A typo is otherwise invisible.
 * ========================================================================== */

section("ICE URLs");

eq("plain STUN", classifyIceUrl("stun:stun.example.com:3478"), "stun");
eq("secure STUN", classifyIceUrl("stuns:stun.example.com:5349"), "stun");
eq("TURN defaults to UDP", classifyIceUrl("turn:relay.example.com:3478"), "turn-udp");
eq("explicit UDP", classifyIceUrl("turn:relay.example.com:3478?transport=udp"), "turn-udp");
eq("explicit TCP", classifyIceUrl("turn:relay.example.com:3478?transport=tcp"), "turn-tcp");
eq("TURNS is TLS", classifyIceUrl("turns:relay.example.com:5349"), "turn-tls");
eq(
  "TURNS is TLS whatever the transport says",
  classifyIceUrl("turns:relay.example.com:5349?transport=tcp"),
  "turn-tls",
);
eq("uppercase parameters still parse", classifyIceUrl("turn:h:3478?TRANSPORT=TCP"), "turn-tcp");
eq("whitespace is tolerated", classifyIceUrl("  turn:h:3478  "), "turn-udp");
eq("a bare hostname is not a URL", classifyIceUrl("relay.example.com"), null);
eq("nor is an https URL", classifyIceUrl("https://relay.example.com"), null);
eq("nor an empty string", classifyIceUrl(""), null);

{
  const coverage = describeIceServers([
    { urls: ["stun:stun.example.com:3478"] },
    { urls: RELAY_URLS.split(","), username: "u", credential: "c" },
  ]);

  eq("a full configuration covers every transport", coverage.transports, [
    "stun",
    "turn-tcp",
    "turn-tls",
    "turn-udp",
  ]);
  eq("and is recognised as having a relay", coverage.hasRelay, true);
  eq("with nothing unparseable", coverage.invalid, []);

  const stunOnly = describeIceServers([{ urls: ["stun:stun.example.com:3478"] }]);
  eq("STUN alone has no relay", stunOnly.hasRelay, false);

  const broken = describeIceServers([{ urls: ["relay.example.com:3478"] }]);
  eq("a malformed URL is reported rather than ignored", broken.invalid, ["relay.example.com:3478"]);
}

/* ==========================================================================
 * 2 · Building the configuration
 * ========================================================================== */

section("ICE configuration");

{
  const stunOnly = buildIceConfiguration();
  const coverage = describeIceServers(stunOnly.iceServers);

  eq("with no relay, STUN only", coverage.transports, ["stun"]);
  eq("and direct paths allowed", stunOnly.iceTransportPolicy, "all");
  eq("pre-gathering is on when it costs nothing", stunOnly.iceCandidatePoolSize, 1);
  eq(
    "no credential appears anywhere",
    stunOnly.iceServers.every((s) => s.username === undefined && s.credential === undefined),
    true,
  );

  const relayed = buildIceConfiguration({
    turnServers: [{ urls: RELAY_URLS.split(","), username: "1700000000:ada", credential: "abc" }],
  });
  const relayedCoverage = describeIceServers(relayed.iceServers);

  eq("relays are added alongside STUN, not instead of it", relayedCoverage.transports, [
    "stun",
    "turn-tcp",
    "turn-tls",
    "turn-udp",
  ]);
  eq("STUN comes first", classifyIceUrl(relayedCoverage.transports[0]), null);
  truthy(
    "the STUN entries are unchanged",
    relayed.iceServers.length === stunOnly.iceServers.length + 1,
  );

  // Pre-gathering with TURN allocates a relay before anybody has called anybody.
  eq("pre-gathering is off once a relay could be allocated", relayed.iceCandidatePoolSize, 0);

  const forced = buildIceConfiguration({
    turnServers: [{ urls: ["turn:relay.example.com:3478"], username: "u", credential: "c" }],
    forceRelay: true,
  });
  eq("forceRelay pins every candidate to the relay", forced.iceTransportPolicy, "relay");
  eq("which is how TURN gets verified at all", forced.iceServers.length > 0, true);

  eq("media is bundled", relayed.bundlePolicy, "max-bundle");
  eq("and RTCP muxed", relayed.rtcpMuxPolicy, "require");
}

/* ==========================================================================
 * 3 · The HMAC scheme
 *
 * Checked against an independently computed HMAC, not against our own output.
 * A wrong-but-self-consistent implementation passes every test that only
 * compares the code to itself, and then fails against a real relay.
 * ========================================================================== */

section("Ephemeral credentials");

const SECRET = "a-shared-secret-long-enough-to-be-real";

{
  const result = probe({ TURN_URLS: RELAY_URLS, TURN_SHARED_SECRET: SECRET });

  eq("the credential is ephemeral", result.source, "hmac");
  eq("one ICE server entry carrying every URL", result.serverCount, 1);
  eq("with all three transports", result.transports.sort(), ["turn-tcp", "turn-tls", "turn-udp"]);

  const [expiry, user] = result.username.split(":");
  truthy("the username starts with a unix expiry", /^\d{10,}$/.test(expiry));
  eq("followed by the user it was minted for", user, "11111111-1111-4111-8111-111111111111");

  // The independent check: what coturn would compute.
  const expected = createHmac("sha1", SECRET).update(result.username).digest("base64");
  eq("the credential is HMAC-SHA1(secret, username), base64", result.credential, expected);
  eq("and verifies against the secret", result.verifies, true);
  eq("and has not already expired", result.expired, false);

  const ttl = Number(expiry) * 1000 - Date.now();
  truthy("the default lifetime is about ten minutes", ttl > 500_000 && ttl <= 600_000, `${ttl}ms`);
  eq("an expiry is reported to the caller", typeof result.expiresAt, "string");

  /* --- the part that matters most --------------------------------------- */

  const handedToBrowser = JSON.stringify(result);
  eq(
    "the shared secret is nowhere in what the browser receives",
    handedToBrowser.includes(SECRET),
    false,
  );
  eq("not even a prefix of it", handedToBrowser.includes(SECRET.slice(0, 16)), false);
}

{
  // Two users must not receive the same credential — a relay's logs are useless
  // otherwise, and a leak becomes untraceable.
  const a = probe(
    { TURN_URLS: RELAY_URLS, TURN_SHARED_SECRET: SECRET },
    "aaaaaaaa-0000-4000-8000-000000000001",
  );
  const b = probe(
    { TURN_URLS: RELAY_URLS, TURN_SHARED_SECRET: SECRET },
    "bbbbbbbb-0000-4000-8000-000000000002",
  );

  truthy("each user gets their own username", a.username !== b.username);
  truthy("and their own credential", a.credential !== b.credential);
  truthy("each naming its own user", a.username.endsWith("0001") && b.username.endsWith("0002"));
}

{
  const short = probe({
    TURN_URLS: RELAY_URLS,
    TURN_SHARED_SECRET: SECRET,
    TURN_CREDENTIAL_TTL_SECONDS: "120",
  });

  const ttl = Number(short.username.split(":")[0]) * 1000 - Date.now();
  truthy("a configured lifetime is honoured", ttl > 60_000 && ttl <= 120_000, `${ttl}ms`);
}

/* ==========================================================================
 * 4 · Static credentials
 * ========================================================================== */

section("Static credentials");

{
  const result = probe({
    TURN_URLS: RELAY_URLS,
    TURN_USERNAME: "kith",
    TURN_PASSWORD: "a-static-relay-password",
  });

  eq("the source is reported honestly", result.source, "static");
  eq("the username is the configured one", result.username, "kith");
  eq("as is the password", result.credential, "a-static-relay-password");
  eq("and there is no expiry, which is the weakness", result.expiresAt, null);
}

{
  // Both configured: the ephemeral scheme wins, because somebody who set both
  // has almost certainly forgotten to remove the old one.
  const result = probe({
    TURN_URLS: RELAY_URLS,
    TURN_SHARED_SECRET: SECRET,
    TURN_USERNAME: "kith",
    TURN_PASSWORD: "a-static-relay-password",
  });

  eq("the shared secret takes precedence", result.source, "hmac");
  eq(
    "so the static password is never handed out",
    result.credential === "a-static-relay-password",
    false,
  );
}

/* ==========================================================================
 * 5 · Graceful fallback
 *
 * Nothing configured is a supported configuration and the default one.
 * ========================================================================== */

section("Fallback");

{
  const result = probe({});

  eq("no relay configured is not an error", result.ok, true);
  eq("the source says so", result.source, "none");
  eq("and the list is empty", result.serverCount, 0);

  const config = buildIceConfiguration({ turnServers: [] });
  eq("so the call runs on STUN", describeIceServers(config.iceServers).hasRelay, false);
  truthy("which still has servers to work with", config.iceServers.length > 0);
}

{
  // Half-configured is different from unconfigured, and must be loud. A relay
  // that looks set up but is not is worse than no relay: nobody investigates.
  const result = probe({ TURN_URLS: RELAY_URLS });

  eq("URLs without credentials refuse to start", result.ok, false);
  truthy(
    "and the message says exactly what is missing",
    /TURN_SHARED_SECRET/.test(result.message) && /TURN_USERNAME/.test(result.message),
    result.message,
  );
}

{
  const result = probe({ TURN_URLS: "relay.example.com:3478", TURN_SHARED_SECRET: SECRET });
  eq("a malformed URL refuses to start", result.ok, false);
  truthy("naming the format expected", /turn:/.test(result.message), result.message);
}

{
  const result = probe({ TURN_URLS: "stun:stun.example.com:3478", TURN_SHARED_SECRET: SECRET });
  eq("a STUN URL in the relay list is rejected", result.ok, false);
  truthy(
    "explaining that STUN is built in",
    /STUN is built in/i.test(result.message),
    result.message,
  );
}

{
  const result = probe({ TURN_URLS: RELAY_URLS, TURN_SHARED_SECRET: "short" });
  eq("a trivially short secret is rejected", result.ok, false);
}

/* ==========================================================================
 * 6 · Configuration warnings
 *
 * TURN over UDP only is the usual first configuration, and the symptom of
 * stopping there is "calls work for everybody except the person in the office".
 * ========================================================================== */

section("Warnings");

{
  const udpOnly = probe({
    TURN_URLS: "turn:relay.example.com:3478?transport=udp",
    TURN_SHARED_SECRET: SECRET,
  });

  truthy(
    "a missing TLS URL is called out",
    /turns:/.test(udpOnly.stderr) && /firewall/i.test(udpOnly.stderr),
    udpOnly.stderr.slice(0, 200),
  );

  const tlsOnly = probe({
    TURN_URLS: "turns:relay.example.com:5349?transport=tcp",
    TURN_SHARED_SECRET: SECRET,
  });

  truthy(
    "a missing UDP URL is called out too",
    /UDP/.test(tlsOnly.stderr) && /latency/i.test(tlsOnly.stderr),
    tlsOnly.stderr.slice(0, 200),
  );

  const complete = probe({ TURN_URLS: RELAY_URLS, TURN_SHARED_SECRET: SECRET });
  eq("a complete configuration says nothing", /turns:|UDP relay/.test(complete.stderr), false);

  const staticCreds = probe({
    TURN_URLS: RELAY_URLS,
    TURN_USERNAME: "kith",
    TURN_PASSWORD: "a-static-relay-password",
  });
  truthy(
    "static credentials are flagged as second-best",
    /STATIC/.test(staticCreds.stderr),
    staticCreds.stderr.slice(0, 200),
  );

  eq(
    "and no warning ever prints the secret",
    [udpOnly, tlsOnly, complete].some((r) => r.stderr.includes(SECRET)),
    false,
  );
}

/* ==========================================================================
 * 7 · The route a call actually took
 *
 * Reading it from the connection is the only way to know the relay is doing
 * anything. Configuration says what was asked for, not what happened.
 * ========================================================================== */

section("Route detection");

{
  const { KithPeer } = await import("../../src/lib/webrtc/peer.ts");
  const { createLoopbackTransports } = await import("../../src/lib/webrtc/signaling.ts");

  /** A connection whose stats report can be scripted. */
  const connectionWith = (report) => ({
    signalingState: "stable",
    connectionState: "connected",
    iceConnectionState: "connected",
    localDescription: null,
    remoteDescription: null,
    onnegotiationneeded: null,
    onicecandidate: null,
    ontrack: null,
    onconnectionstatechange: null,
    oniceconnectionstatechange: null,
    getSenders: () => [],
    getStats: async () => new Map(report.map((entry) => [entry.id, entry])),
    close() {},
    setConfiguration() {},
  });

  const statsFor = (localType, remoteType) => [
    { id: "L", type: "local-candidate", candidateType: localType },
    { id: "R", type: "remote-candidate", candidateType: remoteType },
    {
      id: "P",
      type: "candidate-pair",
      state: "succeeded",
      localCandidateId: "L",
      remoteCandidateId: "R",
      currentRoundTripTime: 0.042,
    },
  ];

  const routeOf = async (report) => {
    const [mine] = createLoopbackTransports("a", "b");
    const peer = new KithPeer({
      selfId: "a",
      peerId: "b",
      transport: mine,
      configuration: { iceServers: [] },
      createConnection: () => connectionWith(report),
    });
    const stats = await peer.getStats();
    peer.close();
    return stats;
  };

  eq("host to host is direct", (await routeOf(statsFor("host", "host"))).route, "direct");
  eq("srflx to srflx is direct", (await routeOf(statsFor("srflx", "srflx"))).route, "direct");
  eq("a local relay is relayed", (await routeOf(statsFor("relay", "srflx"))).route, "relayed");
  eq("a remote relay is relayed too", (await routeOf(statsFor("srflx", "relay"))).route, "relayed");
  eq("both relayed is relayed", (await routeOf(statsFor("relay", "relay"))).route, "relayed");
  eq("no candidate pair yet is unknown", (await routeOf([])).route, "unknown");

  const stats = await routeOf(statsFor("relay", "relay"));
  eq("and the round-trip time comes back with it", stats.rtt, 0.042);
}

/* ==========================================================================
 * 8 · Nothing secret is importable from a browser
 * ========================================================================== */

section("Boundaries");

{
  const { readFileSync } = await import("node:fs");

  const turnSource = readFileSync("src/lib/server/turn.ts", "utf8");
  truthy(
    "the minter is behind server-only",
    /^import "server-only";/m.test(turnSource),
    'src/lib/server/turn.ts must start with import "server-only"',
  );

  const configSource = readFileSync("src/lib/webrtc/config.ts", "utf8");
  eq(
    "the browser-side config module reads no environment",
    /process\.env/.test(configSource),
    false,
  );
  eq("and contains no credential fields", /credential\s*:|username\s*:/.test(configSource), false);

  const scanner = readFileSync("scripts/check-client-bundle.mjs", "utf8");
  truthy("the bundle scan covers the shared secret", scanner.includes("TURN_SHARED_SECRET"));
  truthy("and the static password", scanner.includes("TURN_PASSWORD"));

  const example = readFileSync(".env.example", "utf8");
  truthy("the example file documents the relay URLs", example.includes("TURN_URLS"));
  eq(
    "and every TURN variable in it is empty",
    /TURN_(SHARED_SECRET|PASSWORD)="[^"]+"/.test(example),
    false,
  );
}

/* ========================================================================== */

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
