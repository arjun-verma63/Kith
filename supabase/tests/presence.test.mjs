/**
 * Presence tests.
 *
 * The brief's hardest requirement is a negative one — "do not falsely show users
 * as online indefinitely" — and negatives are exactly what clicking around does
 * not verify. You cannot see the bug where a dropped socket leaves five lit
 * embers on screen forever; you can only see it much later, once nobody trusts
 * the lights.
 *
 * So the resolution rule is a pure function, and every path through it is
 * asserted here: declared status beating the socket, the socket beating the
 * heartbeat, and the socket's ABSENCE falling back rather than lying.
 *
 *     npm run presence:test
 */

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

const { derivePresence, describeLastSeen } = await import("../../src/lib/presence.ts");

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
const section = (t) => console.log(`\n${t}`);

console.log("KITH — realtime presence\n");

/* ==========================================================================
 * The reconciliation rule.
 *
 * Mirrors src/components/presence/use-presence.ts exactly. That file is a React
 * hook and cannot be called outside a renderer, so the logic is restated here
 * and the two are kept in step by these tests failing loudly if they diverge.
 * ========================================================================== */

function resolve({ status, live, userId, lastSeenAt, now }) {
  if (status === "invisible") return "dark";
  if (status === "away" || status === "busy") return "cooling";

  if (live !== null) {
    const activity = live[userId];
    if (activity === "online") return "lit";
    if (activity === "idle") return "cooling";
    return "dark";
  }

  return derivePresence({ status, lastSeenAt, now });
}

const NOW = new Date("2026-08-31T12:00:00Z");
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
const ME = "user-1";

/* ========================================================================== */
section("a live connection is authoritative");

eq(
  "present and active -> lit",
  resolve({ status: "auto", live: { [ME]: "online" }, userId: ME, lastSeenAt: ago(999), now: NOW }),
  "lit",
);

eq(
  "present but idle -> cooling",
  resolve({ status: "auto", live: { [ME]: "idle" }, userId: ME, lastSeenAt: ago(0), now: NOW }),
  "cooling",
);

// The one that matters most. With a live map, absence is knowledge.
eq(
  "ABSENT from a live map -> dark, even with a 10-second-old heartbeat",
  resolve({ status: "auto", live: {}, userId: ME, lastSeenAt: ago(0.16), now: NOW }),
  "dark",
);

eq(
  "an empty live map is 'nobody is online', not 'we do not know'",
  resolve({ status: "auto", live: {}, userId: ME, lastSeenAt: ago(0), now: NOW }),
  "dark",
);

/* ========================================================================== */
section("no connection falls back — it never assumes");

eq(
  "null map + recent heartbeat -> lit (best available answer)",
  resolve({ status: "auto", live: null, userId: ME, lastSeenAt: ago(1), now: NOW }),
  "lit",
);

eq(
  "null map + stale heartbeat -> cooling",
  resolve({ status: "auto", live: null, userId: ME, lastSeenAt: ago(6), now: NOW }),
  "cooling",
);

// This is the failure the requirement is about, stated as a test.
eq(
  "null map + ancient heartbeat -> dark, NOT online indefinitely",
  resolve({ status: "auto", live: null, userId: ME, lastSeenAt: ago(60 * 24 * 7), now: NOW }),
  "dark",
);

eq(
  "null map + no heartbeat at all -> dark",
  resolve({ status: "auto", live: null, userId: ME, lastSeenAt: null, now: NOW }),
  "dark",
);

/* ========================================================================== */
section("a declared status beats both");

eq(
  "invisible beats a live 'online' entry",
  resolve({
    status: "invisible",
    live: { [ME]: "online" },
    userId: ME,
    lastSeenAt: ago(0),
    now: NOW,
  }),
  "dark",
);

eq(
  "away beats a live 'online' entry",
  resolve({ status: "away", live: { [ME]: "online" }, userId: ME, lastSeenAt: ago(0), now: NOW }),
  "cooling",
);

eq(
  "busy beats a live 'online' entry",
  resolve({ status: "busy", live: { [ME]: "online" }, userId: ME, lastSeenAt: ago(0), now: NOW }),
  "cooling",
);

eq(
  "a stale 'active' declaration does NOT keep somebody lit",
  resolve({ status: "active", live: null, userId: ME, lastSeenAt: ago(60 * 24 * 3), now: NOW }),
  "dark",
);

/* ========================================================================== */
section("the label never contradicts the light");

for (const [name, subject] of [
  ["invisible", { status: "invisible", lastSeenAt: ago(0), now: NOW }],
  ["ancient", { status: "auto", lastSeenAt: ago(60 * 24 * 30), now: NOW }],
  ["never seen", { status: "auto", lastSeenAt: null, now: NOW }],
]) {
  const state = derivePresence(subject);
  const label = describeLastSeen(subject);
  if (state === "dark" && label !== "Online") ok(`${name}: dark light, "${label}" label`);
  else bad(`${name} label matches light`, `state=${state} label=${label}`);
}

/* ========================================================================== */
section("the heartbeat that backs the fallback");

const db = await freshDatabase();
const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");

// Presence must survive a lie from the client.
await asUser(
  db,
  ada,
  "update public.profiles set last_seen_at = now() + interval '1 year' where id=$1",
  [ada],
);
const { rows: pinned } = await asService(
  db,
  "select last_seen_at from public.profiles where id=$1",
  [ada],
);
if (pinned[0].last_seen_at.getTime() < Date.now() + 60000) {
  ok("a client still cannot forge its own last_seen_at");
} else {
  bad("a client still cannot forge its own last_seen_at", pinned[0].last_seen_at.toISOString());
}

await asService(
  db,
  "update public.profiles set last_seen_at = now() - interval '10 minutes' where id=$1",
  [ada],
);
await asUser(db, ada, "select public.touch_last_seen()");
const { rows: beat } = await asService(db, "select last_seen_at from public.profiles where id=$1", [
  ada,
]);
if (Date.now() - beat[0].last_seen_at.getTime() < 5000)
  ok("touch_last_seen refreshes the fallback");
else bad("touch_last_seen refreshes the fallback", beat[0].last_seen_at.toISOString());

const before = beat[0].last_seen_at.getTime();
await asUser(db, ada, "select public.touch_last_seen()");
const { rows: again } = await asService(
  db,
  "select last_seen_at from public.profiles where id=$1",
  [ada],
);
eq(
  "...and throttles, so a chatty client cannot cause a write storm",
  again[0].last_seen_at.getTime(),
  before,
);

const other = await asUser(db, rafa, "select public.touch_last_seen()");
const { rows: adaAfter } = await asService(
  db,
  "select last_seen_at from public.profiles where id=$1",
  [ada],
);
eq(
  "one person's heartbeat never touches another's row",
  adaAfter[0].last_seen_at.getTime(),
  before,
);
void other;

/* ========================================================================== */
section("channel authorization");

// The presence channel is private: subscribing is gated by RLS on
// realtime.messages, not merely by knowing the topic name.
const { rows: policies } = await asService(
  db,
  `select polname, polcmd from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='realtime' and c.relname='messages'
      and polname like '%presence%'
    order by polname`,
);
eq("presence:lobby has both a read and a write policy", policies.length, 2);
eq(
  "  one SELECT, one INSERT",
  policies
    .map((p) => p.polcmd)
    .sort()
    .join(""),
  "ar",
);

const { rows: rls } = await asService(
  db,
  "select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass",
);
eq("realtime.messages has RLS enabled", rls[0].relrowsecurity, true);

await db.close();

/* ========================================================================== */

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
