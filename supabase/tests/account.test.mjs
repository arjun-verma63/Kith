/**
 * The Security page.
 *
 * ── What is worth testing here ───────────────────────────────────────────────
 *
 * Three things, and the first one is the reason this file is long.
 *
 *   DELETION IS THE ONLY IRREVERSIBLE THING IN KITH. `anonymise_account` is
 *   asserted from both directions: everything about the person is gone, and
 *   everything about OTHER people survives. A cascade nobody noticed would take
 *   five other accounts' game history with it, and the only way to know is to
 *   set that history up and count it afterwards.
 *
 *   `who_can_call` WAS A COLUMN NOTHING READ. Wiring it in is the interesting
 *   half of "privacy controls" — a control that controls nothing is a promise
 *   the database does not keep — so all three scopes are exercised against
 *   `start_call` for real.
 *
 *   THE SESSION LIST TOUCHES A TABLE SUPABASE OWNS. That is a calculated risk,
 *   and the mitigations (caller-scoped, no tokens selected, degrades instead of
 *   raising) are assertions rather than intentions.
 *
 * The pure half — what may be shown on screen — is §1. `coarsenIp` and
 * `describeDevice` decide what a security page leaks into a screenshot, which
 * makes them worth pinning exactly.
 *
 *     npm run account:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, asUserAtAal, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const {
  changePasswordSchema,
  coarsenIp,
  confirmsDeletion,
  describeDevice,
  PRIVACY_CONTROLS,
  privacySchema,
} = await import("../../src/features/auth/account.ts");

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
const falsy = (n, v, d = "expected a falsy value") => (v ? bad(n, d) : ok(n));
const section = (t) => console.log(`\n${t}`);

async function denied(name, promise) {
  try {
    const result = await promise;
    if (result?.rows?.length === 0 || result?.affectedRows === 0) {
      ok(`${name} (no rows)`);
      return;
    }
    bad(name, `expected a refusal, got ${JSON.stringify(result?.rows ?? result)}`);
  } catch (error) {
    ok(`${name} (${error.message.split("\n")[0].slice(0, 55)})`);
  }
}

console.log("KITH — account & security settings\n");

/* ==========================================================================
 * 1 · What may be shown
 * ========================================================================== */

section("Addresses");

{
  eq("an IPv4 address loses its last octet", coarsenIp("203.0.113.42"), "203.0.113.x");
  eq("including a single-digit one", coarsenIp("10.0.0.1"), "10.0.0.x");
  eq("and it is trimmed first", coarsenIp("  198.51.100.7  "), "198.51.100.x");

  eq(
    "an IPv6 address keeps three groups",
    coarsenIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334"),
    "2001:0db8:85a3:…",
  );
  eq("a compressed one too", coarsenIp("fe80::1"), "fe80:1:…");

  // The value arrives from a proxy header, so it is attacker-influenced text.
  // Anything unrecognisable is dropped rather than echoed onto the page.
  eq("nothing becomes nothing", coarsenIp(null), null);
  eq("empty becomes nothing", coarsenIp(""), null);
  eq("an out-of-range octet is not an address", coarsenIp("999.1.1.1"), null);
  eq("nor is a hostname", coarsenIp("example.com"), null);
  eq("nor a script tag", coarsenIp("<script>alert(1)</script>"), null);
  eq("nor an SQL fragment", coarsenIp("1.1.1.1; drop table"), null);

  truthy(
    "no coarsened address ever contains the final octet",
    !String(coarsenIp("203.0.113.42")).includes("42"),
  );
}

section("Devices");

{
  const ua = (s) => describeDevice(s);

  eq(
    "Chrome on Windows",
    ua(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    ),
    "Chrome on Windows",
  );
  eq(
    "Safari on a Mac",
    ua(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    ),
    "Safari on Mac",
  );
  eq(
    "Safari on an iPhone",
    ua(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
    ),
    "Safari on iPhone",
  );
  eq(
    "Firefox on Android",
    ua("Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0"),
    "Firefox on Android",
  );

  // Edge and Chrome both claim to be Safari; Chrome claims it too. Most
  // specific has to win or every session says "Safari".
  eq(
    "Edge is not reported as Chrome",
    ua(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0",
    ),
    "Edge on Windows",
  );
  eq(
    "and Chrome is not reported as Safari",
    ua(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    ),
    "Chrome on Mac",
  );

  eq("nothing at all still renders", ua(null), "Unknown device");
  eq("and so does nonsense", ua("aaaa"), "Unknown device");

  // The raw string is a fingerprint. Whatever comes out is a label, never the
  // input echoed back.
  const nasty = "<img onerror=alert(1)> Chrome/1 Windows";
  falsy("the raw agent is never returned", ua(nasty).includes("<img"));
  eq("it is reduced to the label", ua(nasty), "Chrome on Windows");
}

section("Confirming a deletion");

{
  truthy("the username matches", confirmsDeletion("ada", "ada"));
  truthy("trimmed", confirmsDeletion("  ada  ", "ada"));
  truthy("and case-insensitively, as usernames already are", confirmsDeletion("ADA", "ada"));

  falsy("a different name does not", confirmsDeletion("rafa", "ada"));
  falsy("nor a prefix", confirmsDeletion("ad", "ada"));
  falsy("nor empty", confirmsDeletion("", "ada"));
  falsy("nor the word people type without reading", confirmsDeletion("DELETE", "ada"));
}

section("Schemas");

{
  const password = (over = {}) =>
    changePasswordSchema.safeParse({
      currentPassword: "the-old-one-12",
      newPassword: "a-much-longer-one",
      confirmPassword: "a-much-longer-one",
      ...over,
    });

  truthy("a good change is accepted", password().success);
  falsy("a mismatch is not", password({ confirmPassword: "different" }).success);
  falsy(
    "nor a short new password",
    password({ newPassword: "short", confirmPassword: "short" }).success,
  );
  falsy("nor a missing current password", password({ currentPassword: "" }).success);
  falsy(
    "nor the password they already have",
    password({ newPassword: "the-old-one-12", confirmPassword: "the-old-one-12" }).success,
  );

  truthy(
    "privacy accepts the three scopes",
    privacySchema.safeParse({
      discoverable: false,
      whoCanMessage: "nobody",
      whoCanCall: "friends",
      whoCanPropose: "everyone",
    }).success,
  );
  falsy(
    "and refuses one it does not know",
    privacySchema.safeParse({
      discoverable: true,
      whoCanMessage: "anyone",
      whoCanCall: "friends",
      whoCanPropose: "friends",
    }).success,
  );
}

/* ==========================================================================
 * 2 · Every privacy control is enforced somewhere
 * ========================================================================== */

section("Privacy controls are real");

const db = await freshDatabase();

{
  /*
   * The invariant that keeps this section honest.
   *
   * A switch on the settings page whose `enforcedBy` function does not exist is
   * a promise the database does not keep. `who_can_call` sat in that state from
   * migration 0002 until 0025.
   */
  const missing = [];

  for (const control of PRIVACY_CONTROLS) {
    const { rows } = await asService(
      db,
      `select 1 from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [control.enforcedBy],
    );
    if (rows.length === 0) missing.push(`${control.key} -> ${control.enforcedBy}()`);
  }

  eq("every control on the page names a function that exists", missing, []);
  eq("and there are four of them", PRIVACY_CONTROLS.length, 4);
}

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");

const pair = (a, b) => [a < b ? a : b, a < b ? b : a];

await asService(
  db,
  "insert into public.friendships (user_low, user_high) values ($1,$2)",
  pair(ada, rafa),
);
await asService(
  db,
  "insert into public.friendships (user_low, user_high) values ($1,$2)",
  pair(ada, nour),
);

const { rows: dmRows } = await asUser(db, ada, "select public.start_dm($1) as id", [rafa]);
const dm = dmRows[0].id;

section("who_can_call");

{
  // Default is 'friends', and they are friends.
  const { rows } = await asUser(db, ada, "select public.can_call_conversation($1) as yes", [dm]);
  eq("a friend may call by default", rows[0].yes, true);

  await asService(
    db,
    "update public.user_settings set who_can_call = 'nobody' where user_id = $1",
    [rafa],
  );

  const { rows: refused } = await asUser(
    db,
    ada,
    "select public.can_call_conversation($1) as yes",
    [dm],
  );
  eq("'nobody' means nobody", refused[0].yes, false);

  await denied("and start_call refuses", asUser(db, ada, "select public.start_call($1)", [dm]));

  // The setting is one-directional: Rafa taking no calls does not stop Rafa
  // calling out.
  const { rows: outbound } = await asUser(
    db,
    rafa,
    "select public.can_call_conversation($1) as yes",
    [dm],
  );
  eq("but they can still call out", outbound[0].yes, true);

  await asService(
    db,
    "update public.user_settings set who_can_call = 'everyone' where user_id = $1",
    [rafa],
  );
  const { rows: open } = await asUser(db, ada, "select public.can_call_conversation($1) as yes", [
    dm,
  ]);
  eq("'everyone' lets it through", open[0].yes, true);

  // 'friends' when they are NOT friends.
  await asService(
    db,
    "update public.user_settings set who_can_call = 'friends' where user_id = $1",
    [rafa],
  );
  await asService(
    db,
    "delete from public.friendships where user_low = $1 and user_high = $2",
    pair(ada, rafa),
  );

  const { rows: stranger } = await asUser(
    db,
    ada,
    "select public.can_call_conversation($1) as yes",
    [dm],
  );
  eq("'friends' refuses somebody who is not one", stranger[0].yes, false);

  await asService(
    db,
    "insert into public.friendships (user_low, user_high) values ($1,$2)",
    pair(ada, rafa),
  );
  const { rows: restored } = await asUser(
    db,
    ada,
    "select public.can_call_conversation($1) as yes",
    [dm],
  );
  eq("and allows them again once they are", restored[0].yes, true);
}

{
  // A group thread has no single "them" to consult, so the setting does not
  // apply there — which is a decision worth pinning rather than discovering.
  const { rows: groupRows } = await asUser(db, ada, "select public.start_group($1, $2) as id", [
    "three of us",
    [rafa, nour],
  ]);
  const group = groupRows[0].id;

  await asService(
    db,
    "update public.user_settings set who_can_call = 'nobody' where user_id = $1",
    [rafa],
  );

  const { rows } = await asUser(db, ada, "select public.can_call_conversation($1) as yes", [group]);
  eq("a group call is not blocked by one member's setting", rows[0].yes, true);

  await asService(
    db,
    "update public.user_settings set who_can_call = 'friends' where user_id = $1",
    [rafa],
  );
}

section("Privacy settings are your own");

{
  const { rows } = await asUser(
    db,
    ada,
    "update public.user_settings set discoverable = false where user_id = $1 returning discoverable",
    [ada],
  );
  eq("you can change your own", rows[0].discoverable, false);

  await denied(
    "and nobody else's",
    asUser(db, rafa, "update public.user_settings set discoverable = false where user_id = $1", [
      ada,
    ]),
  );

  await denied(
    "nor read them",
    asUser(db, rafa, "select * from public.user_settings where user_id = $1", [ada]),
  );

  await asService(db, "update public.user_settings set discoverable = true where user_id = $1", [
    ada,
  ]);
}

/* ==========================================================================
 * 3 · Sessions
 * ========================================================================== */

section("The session list");

{
  await asService(
    db,
    `insert into auth.sessions (user_id, user_agent, ip, aal)
     values ($1, 'Mozilla/5.0 (Macintosh) Chrome/120', '203.0.113.42', 'aal2'),
            ($1, 'Mozilla/5.0 (iPhone) Safari/604', '198.51.100.9', 'aal1'),
            ($2, 'Mozilla/5.0 (Windows) Firefox/120', '192.0.2.5', 'aal1')`,
    [ada, rafa],
  );

  const { rows } = await asUser(db, ada, "select * from public.list_my_sessions()");
  eq("you see your own sessions", rows.length, 2);
  eq("and only your own", new Set(rows.map((r) => r.ip)).has("192.0.2.5"), false);

  const { rows: theirs } = await asUser(db, rafa, "select * from public.list_my_sessions()");
  eq("they see theirs", theirs.length, 1);

  /*
   * The column list is the security boundary here. `auth.sessions` is GoTrue's
   * table and the function is SECURITY DEFINER, so anything named in the return
   * type is something an ordinary session can read.
   */
  const columns = Object.keys(rows[0]).sort();
  eq("the shape is exactly what the page needs", columns, [
    "aal",
    "created_at",
    "id",
    "ip",
    "refreshed_at",
    "user_agent",
  ]);

  const text = JSON.stringify(rows).toLowerCase();
  falsy("no token", text.includes("token"));
  falsy("no secret", text.includes("secret"));
  falsy("no user_id, because there is only one it could be", "user_id" in rows[0]);

  eq("the strong one is reported as strong", rows.filter((r) => r.aal === "aal2").length, 1);
}

{
  // Expired sessions are not live sessions.
  await asService(
    db,
    `insert into auth.sessions (user_id, user_agent, ip, not_after)
     values ($1, 'old', '203.0.113.1', now() - interval '1 day')`,
    [ada],
  );

  const { rows } = await asUser(db, ada, "select * from public.list_my_sessions()");
  eq("an expired session is not listed", rows.length, 2);
}

{
  await denied(
    "the underlying table is not readable directly",
    asUser(db, ada, "select * from auth.sessions"),
  );

  const { rows } = await asService(db, "select * from public.list_my_sessions()");
  eq("and with no session there is nothing to list", rows.length, 0);
}

/* ==========================================================================
 * 4 · Deletion
 * ========================================================================== */

section("Leaving");

{
  await denied(
    "a signed-in session cannot call the scrub itself",
    asUser(db, ada, "select public.anonymise_account($1)", [ada]),
  );
  await denied(
    "and certainly not on somebody else",
    asUser(db, rafa, "select public.anonymise_account($1)", [ada]),
  );
  await denied(
    "even at aal2",
    asUserAtAal(db, ada, "aal2", "select public.anonymise_account($1)", [ada]),
  );
}

/* --- Everything that must survive, set up before the scrub ---------------- */

const { rows: coupleRows } = await asUser(db, ada, "select public.propose_couple($1) as id", [
  rafa,
]);
const couple = coupleRows[0].id;
await asUser(db, rafa, "select public.respond_to_couple($1, true)", [couple]);

const { rows: sessionRows } = await asUser(
  db,
  ada,
  "select public.create_couple_game($1, 'how-well') as id",
  [couple],
);
const gameSession = sessionRows[0].id;

await asService(
  db,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'still here')",
  [dm, ada],
);
await asService(
  db,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'and mine')",
  [dm, rafa],
);

const before = {};
for (const table of ["messages", "game_sessions", "game_players", "couples"]) {
  const { rows } = await asService(db, `select count(*)::int n from public.${table}`);
  before[table] = rows[0].n;
}

await asService(db, "select public.anonymise_account($1)", [ada]);

{
  const { rows } = await asService(
    db,
    "select username, display_name, bio, pronouns, avatar_path, status_text, deleted_at from public.profiles where id = $1",
    [ada],
  );
  const profile = rows[0];

  truthy("the profile row survives", Boolean(profile));
  truthy("marked as deleted", profile.deleted_at !== null);
  eq("with no name", profile.display_name, "Deleted account");
  truthy("and a tombstone username", /^deleted_[0-9a-f]{12}$/.test(profile.username));
  truthy(
    "which still satisfies the username constraint",
    /^[A-Za-z0-9_]{3,20}$/.test(profile.username),
  );
  eq("no bio", profile.bio, null);
  eq("no pronouns", profile.pronouns, null);
  eq("no avatar", profile.avatar_path, null);
  eq("no status text", profile.status_text, null);

  // The username is replaced rather than freed. Handing @ada to the next person
  // would make every old message look like it came from them.
  falsy("the old username is not released", profile.username === "ada");
}

{
  // The point of not hard-deleting.
  for (const table of ["messages", "game_sessions", "game_players"]) {
    const { rows } = await asService(db, `select count(*)::int n from public.${table}`);
    eq(`${table} is untouched — that is other people's history`, rows[0].n, before[table]);
  }

  const { rows: mine } = await asService(
    db,
    "select sender_id from public.messages where body = 'still here'",
  );
  eq(
    "their message keeps pointing at the tombstone, so it still renders a name",
    mine[0].sender_id,
    ada,
  );

  const { rows: theirs } = await asService(
    db,
    "select count(*)::int n from public.messages where sender_id = $1",
    [rafa],
  );
  eq("and the other person's messages are all still there", theirs[0].n, 1);

  const { rows: host } = await asService(
    db,
    "select host_id from public.game_sessions where id = $1",
    [gameSession],
  );
  eq("the game they hosted still exists", host[0].host_id, ada);
}

{
  const gone = async (table, where, params) => {
    const { rows } = await asService(
      db,
      `select count(*)::int n from public.${table} ${where}`,
      params,
    );
    return rows[0].n;
  };

  eq(
    "friendships are gone",
    await gone("friendships", "where user_low = $1 or user_high = $1", [ada]),
    0,
  );
  eq(
    "friend requests are gone",
    await gone("friend_requests", "where requester_id = $1 or addressee_id = $1", [ada]),
    0,
  );
  eq("blocks are gone", await gone("blocks", "where blocker_id = $1 or blocked_id = $1", [ada]), 0);
  eq("their inbox is gone", await gone("notifications", "where user_id = $1", [ada]), 0);
  eq(
    "they are out of every thread",
    await gone("conversation_members", "where user_id = $1", [ada]),
    0,
  );
  eq("and their reactions", await gone("message_reactions", "where user_id = $1", [ada]), 0);

  const { rows: settings } = await asService(
    db,
    "select discoverable, who_can_call, who_can_message, who_can_propose from public.user_settings where user_id = $1",
    [ada],
  );
  eq("settings are at their most private", settings[0], {
    discoverable: false,
    who_can_call: "nobody",
    who_can_message: "nobody",
    who_can_propose: "nobody",
  });

  const { rows: couples } = await asService(
    db,
    "select status, ended_at from public.couples where id = $1",
    [couple],
  );
  eq("the couple is ended rather than deleted", couples[0].status, "ended");
  truthy("with a date on it", couples[0].ended_at !== null);
  eq("the row survives, so the other partner's page has something to render", before.couples, 1);

  const { rows: players } = await asService(
    db,
    "select left_at from public.game_players where session_id = $1 and user_id = $2",
    [gameSession, ada],
  );
  truthy("they have left the unfinished game", players[0].left_at !== null);
}

{
  const { rows } = await asUser(db, rafa, "select * from public.search_profiles('ada')");
  eq("a deleted account cannot be found in search", rows.length, 0);

  const { rows: tombstone } = await asUser(
    db,
    rafa,
    "select * from public.search_profiles('deleted')",
  );
  eq("nor by its tombstone name", tombstone.length, 0);

  const { rows: others } = await asUser(db, rafa, "select * from public.search_profiles('nour')");
  eq("but search still works", others.length, 1);
}

{
  // Running it twice must not fail or re-scrub — a retried request is a normal
  // thing and the second one should be a no-op.
  await asService(db, "select public.anonymise_account($1)", [ada]);

  const { rows } = await asService(db, "select username from public.profiles where id = $1", [ada]);
  truthy("a second scrub is a no-op", /^deleted_[0-9a-f]{12}$/.test(rows[0].username));

  await denied(
    "and an account that does not exist is refused",
    asService(db, "select public.anonymise_account($1)", ["00000000-0000-0000-0000-000000000000"]),
  );
}

{
  // The audit entry outlives the account: `security_events.user_id` is
  // `on delete set null`, and the row is what somebody would look at afterwards.
  await asService(
    db,
    "insert into public.security_events (user_id, event) values ($1, 'account.deleted')",
    [nour],
  );
  const { rows } = await asService(
    db,
    "select count(*)::int n from public.security_events where event = 'account.deleted'",
  );
  eq("the deletion is recorded", rows[0].n, 1);
}

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
