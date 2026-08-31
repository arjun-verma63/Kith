/**
 * Friend system tests.
 *
 * The brief lists four things to prevent — self-requests, duplicate
 * friendships, duplicate pending requests, unauthorized modifications — and
 * every one of them is asserted below against real Postgres, as the real
 * `authenticated` role. None of them is enforced in application code, so this is
 * the only place the guarantee can actually be checked.
 *
 *     npm run friends:test
 */

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

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

/**
 * RLS denies a write in one of two ways, and which one depends on the policy
 * that matched:
 *
 *   0 rows affected — no policy's USING clause selected the row, so there was
 *     nothing to update.
 *   error 42501     — a USING clause DID match, but every WITH CHECK refused the
 *     resulting row.
 *
 * Both are denials. Asserting only the first is how a test comes to expect the
 * weaker outcome and then fails when the database does something stricter.
 */
async function denied(name, promise) {
  try {
    const result = await promise;
    const affected = result.affectedRows ?? 0;
    if (affected === 0) ok(`${name} (no rows matched)`);
    else bad(name, `NOT DENIED: ${affected} row(s) written`);
  } catch (error) {
    if (/row-level security|violates row-level/i.test(error.message)) {
      ok(`${name} (policy refused)`);
    } else {
      bad(name, `denied for the wrong reason: ${error.message}`);
    }
  }
}

async function rejects(name, promise, pattern) {
  try {
    await promise;
    bad(name, "it was ALLOWED");
  } catch (error) {
    if (pattern.test(error.message)) ok(name);
    else bad(name, `wrong reason: ${error.message}`);
  }
}

console.log("KITH — friends\n");

const db = await freshDatabase();
const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");
const theo = await createUser(db, "theo");

const request = (from, to) =>
  asUser(
    db,
    from,
    "insert into public.friend_requests (requester_id, addressee_id) values ($1, $2) returning id",
    [from, to],
  );

/* ========================================================================== */
section("the four things the brief says to prevent");

await rejects(
  "1. you cannot send a request to yourself",
  asUser(
    db,
    ada,
    "insert into public.friend_requests (requester_id, addressee_id) values ($1, $1)",
    [ada],
  ),
  /friend_requests_no_self/,
);

const { rows: first } = await request(ada, rafa);
const requestId = first[0].id;

await rejects(
  "2. you cannot open a second pending request to the same person",
  request(ada, rafa),
  /friend_requests_pending_pair_key/,
);

await rejects(
  "   ...nor one in the OPPOSITE direction while yours is open",
  request(rafa, ada),
  /friend_requests_pending_pair_key/,
);

// Accept, which fires the trigger that creates the friendship.
await asUser(db, rafa, "update public.friend_requests set status='accepted' where id=$1", [
  requestId,
]);

const { rows: friendship } = await asService(
  db,
  "select count(*)::int as n from public.friendships",
);
eq("accepting created exactly one friendship row", friendship[0].n, 1);

await rejects(
  "3. you cannot create a duplicate friendship",
  asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
    [ada, rafa].sort()[0],
    [ada, rafa].sort()[1],
  ]),
  /friendships_pkey|duplicate key/,
);

await rejects(
  "   ...nor a mirrored one, because ordering is enforced",
  asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
    [ada, rafa].sort()[1],
    [ada, rafa].sort()[0],
  ]),
  /friendships_canonical_order/,
);

// 4. Unauthorized modification.
await denied(
  "4. a bystander cannot modify somebody else's request",
  asUser(db, nour, "update public.friend_requests set status='accepted' where id=$1", [requestId]),
);

await denied(
  "   a bystander cannot delete somebody else's friendship",
  asUser(db, nour, "delete from public.friendships"),
);

/* ========================================================================== */
section("request lifecycle");

// A requester accepting their own request would be a way to befriend anybody.
const { rows: second } = await request(ada, nour);
const adaToNour = second[0].id;

// The requester's own row DOES match the cancel policy's USING clause, so this
// gets as far as WITH CHECK and is refused there — a hard 42501 rather than a
// silent no-op. Two policies with different permitted target states is what
// makes "send a request and accept it yourself" impossible.
await denied(
  "the requester cannot accept their own request",
  asUser(db, ada, "update public.friend_requests set status='accepted' where id=$1", [adaToNour]),
);

const cancelled = await asUser(
  db,
  ada,
  "update public.friend_requests set status='cancelled' where id=$1",
  [adaToNour],
);
eq("the requester CAN withdraw it", cancelled.affectedRows ?? 0, 1);

// Withdrawing frees the pair, so a later request is possible.
try {
  const { rows: retry } = await request(ada, nour);
  ok("after withdrawing, a fresh request is allowed");
  await asUser(db, nour, "update public.friend_requests set status='declined' where id=$1", [
    retry[0].id,
  ]);
  ok("the addressee can decline");
} catch (error) {
  bad("after withdrawing, a fresh request is allowed", error.message);
}

const { rows: afterDecline } = await asService(
  db,
  "select count(*)::int as n from public.friendships",
);
eq("declining creates no friendship", afterDecline[0].n, 1);

try {
  const { rows: again } = await request(ada, nour);
  ok("a declined request does not block trying again");
  // Leave the pair clean. A fixture that leaks a pending request makes the next
  // section fail on the unique index for reasons that have nothing to do with it.
  await asUser(db, ada, "update public.friend_requests set status='cancelled' where id=$1", [
    again[0].id,
  ]);
} catch (error) {
  bad("a declined request does not block trying again", error.message);
}

// Blocked people cannot reach each other.
await asUser(db, theo, "insert into public.blocks (blocker_id, blocked_id) values ($1,$2)", [
  theo,
  ada,
]);
await rejects("a blocked person cannot send a request", request(ada, theo), /row-level security/i);
await asService(db, "delete from public.blocks where blocker_id=$1", [theo]);

// Unfriending is symmetric.
const removed = await asUser(
  db,
  rafa,
  "delete from public.friendships where user_low=$1 and user_high=$2",
  [[ada, rafa].sort()[0], [ada, rafa].sort()[1]],
);
eq("either side can unfriend", removed.affectedRows ?? 0, 1);

/* ========================================================================== */
section("list functions");

// Rebuild a friendship for the list tests.
const { rows: fresh } = await request(ada, rafa);
await asUser(db, rafa, "update public.friend_requests set status='accepted' where id=$1", [
  fresh[0].id,
]);
const { rows: pendingReq } = await request(nour, ada);

const adaFriends = await asUser(db, ada, "select * from public.list_friends()");
eq("list_friends returns the OTHER person, whichever side you are on", adaFriends.rows.length, 1);
eq("  and it is the right person", adaFriends.rows[0].username, "rafa");

const rafaFriends = await asUser(db, rafa, "select * from public.list_friends()");
eq("the same row read from the other side returns ada", rafaFriends.rows[0].username, "ada");

const theoFriends = await asUser(db, theo, "select * from public.list_friends()");
eq("somebody with no friends gets an empty list, not everyone's", theoFriends.rows.length, 0);

const incoming = await asUser(db, ada, "select * from public.list_friend_requests('incoming')");
eq("incoming lists requests addressed to me", incoming.rows.length, 1);
eq("  showing the requester", incoming.rows[0].username, "nour");

const outgoing = await asUser(db, ada, "select * from public.list_friend_requests('outgoing')");
eq("outgoing is empty when I have sent nothing", outgoing.rows.length, 0);

const nourOutgoing = await asUser(
  db,
  nour,
  "select * from public.list_friend_requests('outgoing')",
);
eq("the sender sees it as outgoing", nourOutgoing.rows.length, 1);

const theoIncoming = await asUser(
  db,
  theo,
  "select * from public.list_friend_requests('incoming')",
);
eq("an uninvolved person sees no requests at all", theoIncoming.rows.length, 0);

await asUser(db, ada, "update public.friend_requests set status='declined' where id=$1", [
  pendingReq[0].id,
]);
const afterAnswered = await asUser(
  db,
  ada,
  "select * from public.list_friend_requests('incoming')",
);
eq("an answered request leaves the pending list", afterAnswered.rows.length, 0);

/* ========================================================================== */
section("search");

const blank = await asUser(db, ada, "select * from public.search_profiles('')");
eq("a BLANK query returns nothing — no member directory", blank.rows.length, 0);

const whitespace = await asUser(db, ada, "select * from public.search_profiles('   ')");
eq("whitespace is not a query either", whitespace.rows.length, 0);

const byName = await asUser(db, ada, "select * from public.search_profiles('raf')");
eq("prefix search finds a username", byName.rows.length, 1);
eq("  and reports the relationship", byName.rows[0].relationship, "friend");

const caseInsensitive = await asUser(db, ada, "select * from public.search_profiles('RAF')");
eq("search is case-insensitive", caseInsensitive.rows.length, 1);

const noSelf = await asUser(db, ada, "select * from public.search_profiles('ada')");
eq("you never appear in your own search results", noSelf.rows.length, 0);

const { rows: pend } = await request(ada, theo);
const outgoingRel = await asUser(
  db,
  ada,
  "select relationship from public.search_profiles('theo')",
);
eq("an open request I sent shows as outgoing", outgoingRel.rows[0].relationship, "outgoing");

const incomingRel = await asUser(
  db,
  theo,
  "select relationship from public.search_profiles('ada')",
);
eq(
  "the other side sees the same request as incoming",
  incomingRel.rows[0].relationship,
  "incoming",
);
await asUser(db, ada, "update public.friend_requests set status='cancelled' where id=$1", [
  pend[0].id,
]);

// Discoverability.
await asUser(db, theo, "update public.user_settings set discoverable = false where user_id=$1", [
  theo,
]);
const hidden = await asUser(db, nour, "select * from public.search_profiles('theo')");
eq("someone not discoverable is hidden from a stranger", hidden.rows.length, 0);

const { rows: theoReq } = await request(theo, nour);
await asUser(db, nour, "update public.friend_requests set status='accepted' where id=$1", [
  theoReq[0].id,
]);
const foundByFriend = await asUser(db, nour, "select * from public.search_profiles('theo')");
eq("...but still findable by an existing friend", foundByFriend.rows.length, 1);

// Blocks.
await asUser(db, rafa, "insert into public.blocks (blocker_id, blocked_id) values ($1,$2)", [
  rafa,
  nour,
]);
const blockedSearch = await asUser(db, nour, "select * from public.search_profiles('rafa')");
eq("a blocked person is absent from search entirely", blockedSearch.rows.length, 0);
const reverse = await asUser(db, rafa, "select * from public.search_profiles('nour')");
eq("  symmetrically, in both directions", reverse.rows.length, 0);
await asService(db, "delete from public.blocks where blocker_id=$1", [rafa]);

// Invisible must not leak a heartbeat through search.
await asUser(db, rafa, "update public.profiles set status='invisible' where id=$1", [rafa]);
const invisible = await asUser(
  db,
  ada,
  "select status, last_seen_at from public.search_profiles('rafa')",
);
eq("an invisible person's last_seen_at is never sent", invisible.rows[0].last_seen_at, null);

/* ========================================================================== */
section("privileges");

const { rows: privs } = await asService(
  db,
  `select p.proname,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public'
      and p.proname in ('search_profiles','list_friends','list_friend_requests')`,
);
const exposed = privs.filter((r) => r.anon);
if (exposed.length === 0) ok("friend functions are not executable by anon");
else bad("friend functions are not executable by anon", exposed.map((r) => r.proname).join(", "));

await db.close();

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
