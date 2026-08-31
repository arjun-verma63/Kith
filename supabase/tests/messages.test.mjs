/**
 * Messaging tests.
 *
 * Covers the three things the brief calls out that are invisible from the UI:
 * that only members can read a thread, that pagination is stable under
 * concurrent writes, and that a deleted message stops being readable rather than
 * being hidden by the client.
 *
 * The broadcast triggers are asserted too — the harness stubs `realtime.send`
 * as a recording table, so "sending a message fans out exactly one payload, to
 * the right topic, without the body after a delete" is a real assertion rather
 * than a hope.
 *
 *     npm run messages:test
 */

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

const { normaliseMessage, segmentText } = await import("../../src/lib/text.ts");

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

async function denied(name, promise) {
  try {
    const result = await promise;
    const affected = result.affectedRows ?? 0;
    if (affected === 0) ok(`${name} (no rows matched)`);
    else bad(name, `NOT DENIED: ${affected} row(s) written`);
  } catch (error) {
    if (/row-level security|violates row-level/i.test(error.message))
      ok(`${name} (policy refused)`);
    else bad(name, `denied for the wrong reason: ${error.message}`);
  }
}

console.log("KITH — messaging\n");

/* ========================================================================== */
section("text normalisation");

eq("plain text passes", normaliseMessage("hello there").value, "hello there");
eq("whitespace is trimmed", normaliseMessage("  hi  ").value, "hi");
eq("an empty message is refused", normaliseMessage("   ").ok, false);
eq("a non-string is refused", normaliseMessage(null).ok, false);
eq("4001 characters is refused", normaliseMessage("a".repeat(4001)).reason, "too_long");
eq("4000 characters is fine", normaliseMessage("a".repeat(4000)).ok, true);

// The invisible-character strip. Each of these renders as nothing, which is
// exactly why they are worth removing before storage.
const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0x00);

eq("zero-width space is stripped", normaliseMessage(`a${ZWSP}b`).value, "ab");
eq("bidi override is stripped (Trojan Source)", normaliseMessage(`a${RLO}b`).value, "ab");
eq("byte-order mark is stripped", normaliseMessage(`${BOM}hi`).value, "hi");
eq("null byte is stripped", normaliseMessage(`a${NUL}b`).value, "ab");
eq("a message of only invisibles is empty", normaliseMessage(`${ZWSP}${BOM}`).ok, false);
eq("newlines survive", normaliseMessage("one\ntwo").value, "one\ntwo");
eq("tabs survive", normaliseMessage("a\tb").value, "a\tb");
eq("CRLF is normalised", normaliseMessage("a\r\nb").value, "a\nb");
eq("a wall of blank lines collapses", normaliseMessage("a\n\n\n\n\n\n\nb").value, "a\n\n\nb");

/* ========================================================================== */
section("link handling");

const linkOf = (text) => segmentText(text).find((s) => s.type === "link");

eq(
  "an https URL becomes a link",
  linkOf("see https://example.com now")?.value,
  "https://example.com",
);
eq("javascript: is NOT a link", linkOf("javascript:alert(1)"), undefined);
eq("data: is NOT a link", linkOf("data:text/html,<script>"), undefined);
eq("a bare domain is NOT a link", linkOf("visit example.com"), undefined);
eq(
  "trailing punctuation is not part of the URL",
  linkOf("go to https://example.com.")?.value,
  "https://example.com",
);
eq(
  "an angle bracket does not end up inside the href",
  linkOf("https://example.com/<script>")?.href,
  "https://example.com/",
);
eq(
  "text around a link is preserved verbatim",
  segmentText("a https://x.test b")
    .filter((s) => s.type === "text")
    .map((s) => s.value),
  ["a ", " b"],
);
// The XSS that would exist if this produced HTML instead of React nodes.
eq(
  "markup in a message stays text",
  segmentText("<img src=x onerror=alert(1)>")[0]?.value,
  "<img src=x onerror=alert(1)>",
);

/* ========================================================================== */
section("access control (real Postgres)");

const db = await freshDatabase();
const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");

async function befriend(a, b) {
  const { rows } = await asUser(
    db,
    a,
    "insert into public.friend_requests (requester_id, addressee_id) values ($1,$2) returning id",
    [a, b],
  );
  await asUser(db, b, "update public.friend_requests set status='accepted' where id=$1", [
    rows[0].id,
  ]);
}

await befriend(ada, rafa);

const { rows: dm } = await asUser(db, ada, "select public.start_dm($1) as id", [rafa]);
const conversationId = dm[0].id;
if (conversationId) ok("start_dm opened a conversation between friends");
else bad("start_dm opened a conversation between friends", "returned null");

// who_can_message defaults to 'friends'.
try {
  await asUser(db, ada, "select public.start_dm($1)", [nour]);
  bad("cannot DM a non-friend under the default setting", "it was allowed");
} catch (error) {
  if (/not_permitted/.test(error.message)) ok("cannot DM a non-friend under the default setting");
  else bad("cannot DM a non-friend under the default setting", error.message);
}

await asUser(
  db,
  nour,
  "update public.user_settings set who_can_message='everyone' where user_id=$1",
  [nour],
);
try {
  await asUser(db, ada, "select public.start_dm($1)", [nour]);
  ok("...but can when they allow everyone");
} catch (error) {
  bad("...but can when they allow everyone", error.message);
}

await asUser(
  db,
  ada,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'first')",
  [conversationId, ada],
);

const member = await asUser(db, rafa, "select * from public.list_messages($1)", [conversationId]);
eq("a member reads the thread", member.rows.length, 1);

const outsider = await asUser(db, nour, "select * from public.list_messages($1)", [conversationId]);
eq("a NON-member reads nothing, not an error", outsider.rows.length, 0);

await denied(
  "a non-member cannot post",
  asUser(
    db,
    nour,
    "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'let me in')",
    [conversationId, nour],
  ),
);

await denied(
  "you cannot post as somebody else",
  asUser(
    db,
    rafa,
    "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'not me')",
    [conversationId, ada],
  ),
);

await denied(
  "you cannot edit another person's message",
  asUser(db, rafa, "update public.messages set body='tampered' where sender_id=$1", [ada]),
);

/* ========================================================================== */
section("deletion");

const { rows: mine } = await asUser(
  db,
  rafa,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'oops') returning id",
  [conversationId, rafa],
);
const messageId = mine[0].id;

await denied(
  "a non-sender cannot delete somebody else's message",
  asUser(db, ada, "update public.messages set deleted_at=now(), body=null where id=$1", [
    messageId,
  ]),
);

await asUser(db, rafa, "update public.messages set deleted_at=now(), body=null where id=$1", [
  messageId,
]);

const afterDelete = await asUser(
  db,
  ada,
  "select id, body, deleted_at from public.list_messages($1)",
  [conversationId],
);
const deletedRow = afterDelete.rows.find((r) => r.id === messageId);
eq("a deleted message keeps its place in the thread", Boolean(deletedRow), true);
eq("...but its body is NOT sent to anybody", deletedRow?.body, null);

// Hard delete is impossible: there is no DELETE policy on messages.
await denied(
  "nobody can hard-delete a message, not even its sender",
  asUser(db, rafa, "delete from public.messages where id=$1", [messageId]),
);

/* ========================================================================== */
section("keyset pagination");

for (let i = 0; i < 75; i += 1) {
  await asService(
    db,
    `insert into public.messages (conversation_id, sender_id, body, created_at)
     values ($1,$2,$3, now() - ($4 || ' seconds')::interval)`,
    [conversationId, ada, `m${i}`, String(75 - i)],
  );
}

const page1 = await asUser(db, ada, "select * from public.list_messages($1, null, null, 30)", [
  conversationId,
]);
eq("the first page is a full page", page1.rows.length, 30);

const last1 = page1.rows[page1.rows.length - 1];
const page2 = await asUser(db, ada, "select * from public.list_messages($1, $2, $3, 30)", [
  conversationId,
  last1.created_at,
  last1.id,
]);
eq("the second page is also full", page2.rows.length, 30);

const ids1 = new Set(page1.rows.map((r) => r.id));
const overlap = page2.rows.filter((r) => ids1.has(r.id));
eq("no message appears on both pages", overlap.length, 0);

// The bug offset pagination guarantees: insert while paging, then page again.
await asService(
  db,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'arrived mid-scroll')",
  [conversationId, rafa],
);

const last2 = page2.rows[page2.rows.length - 1];
const page3 = await asUser(db, ada, "select * from public.list_messages($1, $2, $3, 30)", [
  conversationId,
  last2.created_at,
  last2.id,
]);
const seen = new Set([...ids1, ...page2.rows.map((r) => r.id)]);
eq(
  "a message arriving mid-scroll does not duplicate or skip a page",
  page3.rows.filter((r) => seen.has(r.id)).length,
  0,
);

// The cap is only observable when there are MORE than 100 messages to return.
// Asking for 5000 in a thread of 78 proves nothing.
for (let i = 0; i < 40; i += 1) {
  await asService(
    db,
    "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,$3)",
    [conversationId, ada, `filler${i}`],
  );
}

const { rows: total } = await asService(
  db,
  "select count(*)::int as n from public.messages where conversation_id=$1",
  [conversationId],
);
if (total[0].n > 100) ok(`thread has ${total[0].n} messages, past the cap`);
else bad("thread is long enough to observe the cap", `only ${total[0].n}`);

const capped = await asUser(db, ada, "select * from public.list_messages($1, null, null, 5000)", [
  conversationId,
]);
eq("a client cannot ask for more than 100 at a time", capped.rows.length, 100);

/* ========================================================================== */
section("read state");

await asService(
  db,
  "update public.conversation_members set last_read_at = now() - interval '1 hour' where conversation_id=$1 and user_id=$2",
  [conversationId, rafa],
);

const beforeRead = await asUser(db, rafa, "select unread_count from public.list_conversations()");
const unread = beforeRead.rows.find((r) => r.unread_count > 0);
if (unread) ok(`unread count is reported (${unread.unread_count})`);
else bad("unread count is reported", "everything read");

await asUser(db, rafa, "select public.mark_conversation_read($1)", [conversationId]);
const afterRead = await asUser(db, rafa, "select unread_count from public.list_conversations()");
eq("marking read clears it", afterRead.rows[0].unread_count, 0);

// The cursor only moves forward.
const { rows: cursorBefore } = await asService(
  db,
  "select last_read_at from public.conversation_members where conversation_id=$1 and user_id=$2",
  [conversationId, rafa],
);
await asUser(
  db,
  rafa,
  "update public.conversation_members set last_read_at = now() - interval '1 day' where conversation_id=$1 and user_id=$2",
  [conversationId, rafa],
);
await asUser(db, rafa, "select public.mark_conversation_read($1)", [conversationId]);
const { rows: cursorAfter } = await asService(
  db,
  "select last_read_at from public.conversation_members where conversation_id=$1 and user_id=$2",
  [conversationId, rafa],
);
if (cursorAfter[0].last_read_at >= cursorBefore[0].last_read_at) {
  ok("mark_conversation_read never moves the cursor backwards");
} else {
  bad("mark_conversation_read never moves the cursor backwards", "it went back");
}

await denied(
  "you cannot move another person's read cursor",
  asUser(
    db,
    ada,
    "update public.conversation_members set last_read_at=now() where conversation_id=$1 and user_id=$2",
    [conversationId, rafa],
  ),
);

/* ========================================================================== */
section("reactions");

const { rows: target } = await asUser(
  db,
  ada,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'react to me') returning id",
  [conversationId, ada],
);
const reactId = target[0].id;

const added = await asUser(db, rafa, "select public.toggle_reaction($1, $2) as added", [
  reactId,
  "🔥",
]);
eq("toggling adds a reaction", added.rows[0].added, true);

const removed = await asUser(db, rafa, "select public.toggle_reaction($1, $2) as added", [
  reactId,
  "🔥",
]);
eq("toggling again removes it", removed.rows[0].added, false);

await asUser(db, rafa, "select public.toggle_reaction($1, $2)", [reactId, "🔥"]);
const withReaction = await asUser(db, ada, "select id, reactions from public.list_messages($1)", [
  conversationId,
]);
const reacted = withReaction.rows.find((r) => r.id === reactId);
eq("reactions come back aggregated with the message", reacted?.reactions?.length, 1);
eq("  with the emoji", reacted?.reactions?.[0]?.emoji, "🔥");

try {
  await asUser(db, nour, "select public.toggle_reaction($1, $2)", [reactId, "🔥"]);
  bad("a non-member cannot react", "it was allowed");
} catch (error) {
  if (/row-level security/i.test(error.message)) ok("a non-member cannot react");
  else bad("a non-member cannot react", error.message);
}

/* ========================================================================== */
section("realtime fan-out");

await asService(db, "delete from realtime.sent");

await asUser(
  db,
  ada,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'broadcast me')",
  [conversationId, ada],
);

const { rows: sent } = await asService(db, "select * from realtime.sent order by id");
eq("one message produces exactly one broadcast", sent.length, 1);
eq("  on the conversation's own topic", sent[0]?.topic, `conv:${conversationId}`);
eq("  as message.new", sent[0]?.event, "message.new");
eq("  marked private", sent[0]?.private, true);
eq("  carrying the body", sent[0]?.payload?.body, "broadcast me");

await asService(db, "delete from realtime.sent");
const { rows: toDelete } = await asService(
  db,
  "select id from public.messages where body='broadcast me'",
);
await asUser(db, ada, "update public.messages set deleted_at=now(), body=null where id=$1", [
  toDelete[0].id,
]);

const { rows: afterDeleteSent } = await asService(db, "select * from realtime.sent order by id");
eq("deleting broadcasts message.deleted", afterDeleteSent[0]?.event, "message.deleted");
eq("  and the payload carries NO body", afterDeleteSent[0]?.payload?.body, null);

await asService(db, "delete from realtime.sent");
await asUser(db, rafa, "select public.toggle_reaction($1, $2)", [reactId, "😂"]);
const { rows: reactionSent } = await asService(db, "select * from realtime.sent order by id");
eq("a reaction broadcasts too", reactionSent[0]?.event, "reaction.changed");
eq("  on the same conversation topic", reactionSent[0]?.topic, `conv:${conversationId}`);

/* ========================================================================== */
section("groups");

const { rows: group } = await asUser(db, ada, "select public.start_group($1, $2) as id", [
  "Weeknights",
  [rafa],
]);
const groupId = group[0].id;
if (groupId) ok("start_group creates a group");
else bad("start_group creates a group", "returned null");

const { rows: groupMembers } = await asService(
  db,
  "select user_id, role from public.conversation_members where conversation_id=$1 order by role",
  [groupId],
);
eq("both the creator and the invitee are members", groupMembers.length, 2);
eq("  and the creator owns it", groupMembers.find((m) => m.user_id === ada)?.role, "owner");

try {
  await asUser(db, ada, "select public.start_group($1, $2)", ["", [rafa]]);
  bad("an empty title is refused", "it was allowed");
} catch (error) {
  if (/invalid_title/.test(error.message)) ok("an empty title is refused");
  else bad("an empty title is refused", error.message);
}

try {
  await asUser(db, ada, "select public.start_group($1, $2)", ["Nobody", []]);
  bad("a group with no members is refused", "it was allowed");
} catch (error) {
  if (/no_members/.test(error.message)) ok("a group with no members is refused");
  else bad("a group with no members is refused", error.message);
}

const outsiderGroup = await asUser(db, nour, "select * from public.list_messages($1)", [groupId]);
eq("a non-member cannot read the group", outsiderGroup.rows.length, 0);

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
