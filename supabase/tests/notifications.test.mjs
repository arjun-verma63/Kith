/**
 * Notification tests.
 *
 * Almost all of this is trigger behaviour, which is invisible from the UI: you
 * cannot see that a forty-message evening produced one row instead of forty
 * until the badge reads 40 and somebody stops trusting it.
 *
 *     npm run notifications:test
 */

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

const { describeNotification, describeAge } =
  await import("../../src/features/notifications/describe.ts");

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

const countFor = async (db, user, kind) => {
  const { rows } = await asService(
    db,
    kind
      ? "select count(*)::int as n from public.notifications where user_id=$1 and kind=$2"
      : "select count(*)::int as n from public.notifications where user_id=$1",
    kind ? [user, kind] : [user],
  );
  return rows[0].n;
};

console.log("KITH — notifications\n");

const db = await freshDatabase();
const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");

/* ========================================================================== */
section("friend requests");

await asUser(
  db,
  ada,
  "insert into public.friend_requests (requester_id, addressee_id) values ($1,$2)",
  [ada, rafa],
);
eq("a request notifies the addressee", await countFor(db, rafa, "friend_request"), 1);
eq("  and NOT the requester", await countFor(db, ada, "friend_request"), 0);

const { rows: req } = await asService(
  db,
  "select id from public.friend_requests where requester_id=$1 and addressee_id=$2",
  [ada, rafa],
);
await asUser(db, rafa, "update public.friend_requests set status='accepted' where id=$1", [
  req[0].id,
]);
eq("accepting notifies the requester", await countFor(db, ada, "friend_accepted"), 1);
eq("  and not the accepter", await countFor(db, rafa, "friend_accepted"), 0);

/* ========================================================================== */
section("messages — the collapse rule");

const { rows: dm } = await asUser(db, ada, "select public.start_dm($1) as id", [rafa]);
const conversationId = dm[0].id;

const before = await countFor(db, rafa, "message");

/*
 * Twenty, not forty. The collapse rule is proven by any number above one, and
 * migration 0028 caps a session at thirty messages a minute — a suite that
 * needs a burst larger than a real person can send is testing the limit by
 * accident, and would fail for a reason that has nothing to do with
 * notifications.
 */
for (let i = 0; i < 20; i += 1) {
  await asUser(
    db,
    ada,
    "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,$3)",
    [conversationId, ada, `m${i}`],
  );
}

eq(
  "twenty messages produce ONE notification, not twenty",
  (await countFor(db, rafa, "message")) - before,
  1,
);
eq("the sender is never notified of their own message", await countFor(db, ada, "message"), 0);

// Reading the conversation must clear it, or the bell outlives the reason.
await asUser(db, rafa, "select public.mark_conversation_read($1)", [conversationId]);
const { rows: unreadAfterRead } = await asService(
  db,
  "select count(*)::int as n from public.notifications where user_id=$1 and kind='message' and read_at is null",
  [rafa],
);
eq("reading the conversation marks its notification read", unreadAfterRead[0].n, 0);

// ...and the next message starts a fresh one.
await asUser(
  db,
  ada,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'again')",
  [conversationId, ada],
);
const { rows: freshUnread } = await asService(
  db,
  "select count(*)::int as n from public.notifications where user_id=$1 and kind='message' and read_at is null",
  [rafa],
);
eq("a message after reading raises a new one", freshUnread[0].n, 1);

// Muting.
await asService(
  db,
  "update public.conversation_members set muted_until = now() + interval '1 day' where conversation_id=$1 and user_id=$2",
  [conversationId, rafa],
);
await asUser(db, rafa, "select public.mark_conversation_read($1)", [conversationId]);
const mutedBefore = await countFor(db, rafa, "message");
await asUser(
  db,
  ada,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'muted')",
  [conversationId, ada],
);
eq("a muted conversation raises nothing", await countFor(db, rafa, "message"), mutedBefore);
await asService(
  db,
  "update public.conversation_members set muted_until = null where conversation_id=$1 and user_id=$2",
  [conversationId, rafa],
);

/* ========================================================================== */
section("missed calls");

const { rows: call } = await asService(
  db,
  "insert into public.calls (conversation_id, initiator_id, kind) values ($1,$2,'audio') returning id",
  [conversationId, ada],
);
await asService(
  db,
  "insert into public.call_participants (call_id, user_id) values ($1,$2), ($1,$3)",
  [call[0].id, ada, rafa],
);

await asService(
  db,
  "update public.calls set status='missed', ended_at=now(), end_reason='missed' where id=$1",
  [call[0].id],
);
eq(
  "a missed call notifies the person who did not answer",
  await countFor(db, rafa, "call_missed"),
  1,
);
eq("  and not the caller", await countFor(db, ada, "call_missed"), 0);

// Somebody who joined did not miss it.
const { rows: answered } = await asService(
  db,
  "insert into public.calls (conversation_id, initiator_id, kind) values ($1,$2,'audio') returning id",
  [conversationId, ada],
);
await asService(
  db,
  "insert into public.call_participants (call_id, user_id, joined_at) values ($1,$2,now()), ($1,$3,now())",
  [answered[0].id, ada, rafa],
);
const beforeAnswered = await countFor(db, rafa, "call_missed");
await asService(
  db,
  "update public.calls set status='missed', ended_at=now(), end_reason='missed' where id=$1",
  [answered[0].id],
);
eq(
  "somebody who answered is not told they missed it",
  await countFor(db, rafa, "call_missed"),
  beforeAnswered,
);

/* ========================================================================== */
section("games and couples");

await asService(db, "update public.games set enabled = true where key='trivia-night'");

// Through the RPC, because migration 0017 revoked INSERT on `game_sessions` from
// `authenticated` — the client cannot author a session any more than it can
// author game state, and this test was written before that was true.
await asUser(db, ada, "select public.create_game_session($1, 'trivia-night')", [conversationId]);
eq("starting a game invites the other members", await countFor(db, rafa, "game_invite"), 1);
eq("  and not the host", await countFor(db, ada, "game_invite"), 0);

// Through the RPCs, because migration 0021 revoked direct writes on `couples` —
// the lifecycle is a state machine and this test predates it.
const { rows: couple } = await asUser(db, ada, "select public.propose_couple($1) as id", [rafa]);
eq("a couple proposal notifies the other person", await countFor(db, rafa, "couple_request"), 1);
eq("  and not the proposer", await countFor(db, ada, "couple_request"), 0);

await asUser(db, rafa, "select public.respond_to_couple($1, true)", [couple[0].id]);
eq("accepting notifies the proposer", await countFor(db, ada, "couple_request"), 1);

/* ========================================================================== */
section("security");

// The whole reason there is no INSERT policy.
try {
  const result = await asUser(
    db,
    nour,
    `insert into public.notifications (user_id, kind, payload)
     values ($1, 'system', '{"body":"click here"}'::jsonb)`,
    [rafa],
  );
  if ((result.affectedRows ?? 0) === 0) ok("nobody can write into another person's feed");
  else bad("nobody can write into another person's feed", "the insert succeeded");
} catch (error) {
  if (/row-level security/i.test(error.message)) ok("nobody can write into another person's feed");
  else bad("nobody can write into another person's feed", error.message);
}

try {
  const own = await asUser(
    db,
    nour,
    "insert into public.notifications (user_id, kind) values ($1, 'system')",
    [nour],
  );
  if ((own.affectedRows ?? 0) === 0) ok("...nor into their own");
  else bad("...nor into their own", "the insert succeeded");
} catch (error) {
  if (/row-level security/i.test(error.message)) ok("...nor into their own");
  else bad("...nor into their own", error.message);
}

const others = await asUser(db, nour, "select id from public.notifications");
eq("you cannot read somebody else's notifications", others.rows.length, 0);

const marked = await asUser(db, nour, "select public.mark_notifications_read(null) as n");
eq("marking all read touches only your own", marked.rows[0].n, 0);

const { rows: rafaUnreadBefore } = await asService(
  db,
  "select count(*)::int as n from public.notifications where user_id=$1 and read_at is null",
  [rafa],
);
if (rafaUnreadBefore[0].n > 0) ok(`Rafa still has ${rafaUnreadBefore[0].n} unread`);
else bad("Rafa still has unread notifications", "they were cleared by somebody else");

// Passing another person's ids explicitly must also do nothing.
const { rows: rafaIds } = await asService(
  db,
  "select array_agg(id) as ids from public.notifications where user_id=$1",
  [rafa],
);
const targeted = await asUser(db, nour, "select public.mark_notifications_read($1) as n", [
  rafaIds[0].ids,
]);
eq("passing somebody else's ids marks nothing", targeted.rows[0].n, 0);

/* ========================================================================== */
section("mark as read");

const rafaMarked = await asUser(db, rafa, "select public.mark_notifications_read(null) as n");
if (rafaMarked.rows[0].n > 0) ok(`mark all read cleared ${rafaMarked.rows[0].n}`);
else bad("mark all read clears the feed", "nothing was marked");

const { rows: nowUnread } = await asService(
  db,
  "select count(*)::int as n from public.notifications where user_id=$1 and read_at is null",
  [rafa],
);
eq("nothing unread remains", nowUnread[0].n, 0);

const again = await asUser(db, rafa, "select public.mark_notifications_read(null) as n");
eq("marking again is a no-op, not an error", again.rows[0].n, 0);

const listed = await asUser(db, rafa, "select * from public.list_notifications(30)");
if (listed.rows.length > 0) ok(`list_notifications returns the feed (${listed.rows.length})`);
else bad("list_notifications returns the feed", "empty");
eq("  newest first", listed.rows[0].created_at >= listed.rows[1].created_at, true);
eq("  with the actor joined", typeof listed.rows[0].actor_display_name, "string");

/* ========================================================================== */
section("realtime fan-out");

await asService(db, "delete from realtime.sent");
await asUser(
  db,
  rafa,
  "insert into public.friend_requests (requester_id, addressee_id) values ($1,$2)",
  [rafa, nour],
);

const { rows: sent } = await asService(
  db,
  "select * from realtime.sent where event='notification.new'",
);
eq("a notification broadcasts exactly once", sent.length, 1);
eq("  to the RECIPIENT's personal channel", sent[0]?.topic, `user:${nour}`);
eq("  marked private", sent[0]?.private, true);
eq("  carrying the kind", sent[0]?.payload?.kind, "friend_request");

/* ========================================================================== */
section("pruning");

await asService(
  db,
  "update public.notifications set read_at = now() - interval '60 days' where user_id=$1",
  [rafa],
);
const { rows: pruned } = await asService(db, "select public.prune_notifications() as n");
if (pruned[0].n > 0) ok(`prune removed ${pruned[0].n} old read notifications`);
else bad("prune removes old read notifications", "nothing removed");

await asService(
  db,
  "update public.notifications set read_at = null, created_at = now() - interval '90 days' where user_id=$1",
  [nour],
);
const { rows: prunedAgain } = await asService(db, "select public.prune_notifications() as n");
eq("an UNREAD notification is never pruned, however old", prunedAgain[0].n, 0);

/* ========================================================================== */
section("rendering");

const describe = (kind, payload = {}, actor = { displayName: "Ada" }) =>
  describeNotification({ kind, payload, actor, id: "x", readAt: null, createdAt: "" });

eq("friend request reads sensibly", describe("friend_request").action, "wants to add you");
eq("friend request links to /friends", describe("friend_request").href, "/friends");
eq(
  "a message links to its conversation",
  describe("message", { conversation_id: "abc" }).href,
  "/messages/abc",
);
eq("a message with no conversation id has no link", describe("message", {}).href, null);
// Games landed, so this now goes somewhere. It used to assert null, when
// `/games` did not exist.
eq(
  "a game invite links to the session",
  describe("game_invite", { session_id: "abc" }).href,
  "/games/abc",
);
eq("and to the shelf when the payload has no session", describe("game_invite", {}).href, "/games");
eq("an unknown actor falls back", describe("friend_request", {}, null).actor, "Someone");
eq(
  "an accepted couple proposal reads differently",
  describe("couple_request", { accepted: true }).action,
  "accepted your proposal",
);

const NOW = new Date("2026-08-31T12:00:00Z");
const ago = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
eq("age: just now", describeAge(ago(0.2), NOW), "just now");
eq("age: minutes", describeAge(ago(42), NOW), "42m");
eq("age: hours", describeAge(ago(200), NOW), "3h");
eq("age: days", describeAge(ago(60 * 24 * 3), NOW), "3d");

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
