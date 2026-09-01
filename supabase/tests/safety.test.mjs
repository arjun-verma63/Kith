/**
 * Safety: blocking and reporting.
 *
 * ── Why most of this file is one table with five columns ─────────────────────
 *
 * Blocking had existed since migration 0002 and was consulted in nine places.
 * The interesting question was never "does the block row work" — it was "is
 * there anywhere it is NOT consulted", and the answer was three places: games,
 * the friends list, and message bodies.
 *
 * So §4 is a grid. For each of the five surfaces the brief names — friends,
 * messages, calls, games, couple invitations — the same block is applied and the
 * same question asked. A grid is the only shape that makes a missing cell
 * obvious, and the missing cells are what this migration was for.
 *
 * §3 is the other half: a block is no longer a row that other checks consult, it
 * SEVERS. Friendship, pending requests, an active couple, a live call, a seat in
 * an unfinished game. Every one of those gaps in §4 existed because a
 * relationship outlived the block that should have ended it.
 *
 *     npm run safety:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const { BLOCK_CONSEQUENCES, REASON_LABELS, REPORT_REASONS, reportSchema, UNBLOCK_CAVEAT } =
  await import("../../src/features/safety/reasons.ts");

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

async function raises(name, promise, pattern) {
  try {
    await promise;
    bad(name, `expected ${pattern}`);
  } catch (error) {
    if (pattern.test(error.message)) ok(name);
    else bad(name, `expected ${pattern}, got ${error.message.split("\n")[0]}`);
  }
}

console.log("KITH — safety\n");

/* ==========================================================================
 * 1 · The vocabulary
 * ========================================================================== */

section("Report reasons");

{
  eq("six reasons", REPORT_REASONS.length, 6);
  eq("and every one has copy", REASON_LABELS.map((r) => r.key).sort(), [...REPORT_REASONS].sort());
  eq(
    "with a label and a hint each",
    REASON_LABELS.filter((r) => !r.label.trim() || !r.help.trim()).length,
    0,
  );

  // The one line on the page that matters more than the app does.
  const threats = REASON_LABELS.find((r) => r.key === "threats");
  truthy("threats points somewhere better than a form", /emergency/i.test(threats.help));
}

{
  const report = (over = {}) =>
    reportSchema.safeParse({ reason: "harassment", alsoBlock: true, ...over });

  truthy("a reason on its own is enough", report().success);
  truthy("with a detail too", report({ detail: "they kept messaging" }).success);
  falsy("an unknown reason is not", report({ reason: "vibes" }).success);
  falsy("nor no reason at all", reportSchema.safeParse({ alsoBlock: true }).success);

  // 'other' says nothing on its own, so it is the one that must be explained.
  falsy("'other' with no detail is refused", report({ reason: "other" }).success);
  truthy(
    "'other' with a detail is fine",
    report({ reason: "other", detail: "hard to say" }).success,
  );
  eq(
    "and the error lands on the field to fill in",
    report({ reason: "other" }).error.issues[0].path,
    ["detail"],
  );

  falsy("an enormous detail is refused", report({ detail: "x".repeat(2001) }).success);
  eq("blocking defaults on", reportSchema.safeParse({ reason: "spam" }).data.alsoBlock, true);
}

{
  /*
   * The confirmation copy is part of the feature.
   *
   * Blocking severs a friendship and a couple, and people do not expect the
   * second. If the dialog does not say so, the first anybody hears about it is
   * afterwards.
   */
  const copy = BLOCK_CONSEQUENCES.join(" ").toLowerCase();
  truthy("the dialog says the friendship goes", /friend/.test(copy));
  truthy("and that a pending request is cancelled", /request/.test(copy));
  truthy("and that the couple ends", /couple/.test(copy));
  truthy("and that they cannot call", /call/.test(copy));
  truthy("and the caveat says unblocking does not undo it", /does not undo/i.test(UNBLOCK_CAVEAT));
}

/* ==========================================================================
 * 2 · Reports
 * ========================================================================== */

section("Reports");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");
const theo = await createUser(db, "theo");

const pair = (a, b) => [a < b ? a : b, a < b ? b : a];
const befriend = (a, b) =>
  asService(db, "insert into public.friendships (user_low, user_high) values ($1,$2)", pair(a, b));

await befriend(ada, rafa);
await befriend(ada, nour);
await befriend(ada, theo);
await befriend(rafa, nour);

{
  const { rows } = await asUser(db, ada, "select public.report_user($1, 'harassment') as id", [
    rafa,
  ]);
  truthy("a report can be filed", Boolean(rows[0].id));

  const { rows: mine } = await asUser(db, ada, "select reason, status from public.reports");
  eq("the reporter can read it back", mine.length, 1);
  eq("with the reason", mine[0].reason, "harassment");
  eq("and it starts open", mine[0].status, "open");

  /*
   * The subject must never see it. A report they can read is a report that names
   * who filed it, which is how reporting somebody in a six-person room becomes
   * a thing nobody does.
   */
  await denied(
    "the person reported cannot see it",
    asUser(db, rafa, "select * from public.reports"),
  );
  await denied("nor anybody else", asUser(db, nour, "select * from public.reports"));

  // No UPDATE or DELETE policy at all: a report the reporter can withdraw is a
  // report somebody can be pressured into withdrawing.
  await denied("the reporter cannot withdraw it", asUser(db, ada, "delete from public.reports"));
  await denied("nor edit it", asUser(db, ada, "update public.reports set reason = 'spam'"));
  await denied(
    "and the subject certainly cannot",
    asUser(db, rafa, "update public.reports set status = 'dismissed'"),
  );
}

{
  await raises(
    "you cannot report yourself",
    asUser(db, ada, "select public.report_user($1, 'spam')", [ada]),
    /cannot_report_self/,
  );
  await raises(
    "nor somebody who does not exist",
    asUser(db, ada, "select public.report_user($1, 'spam')", [
      "00000000-0000-0000-0000-000000000000",
    ]),
    /no_such_account/,
  );
  await raises(
    "'other' needs a description",
    asUser(db, ada, "select public.report_user($1, 'other')", [nour]),
    /detail_required/,
  );
  await raises(
    "and one open report per person is enough",
    asUser(db, ada, "select public.report_user($1, 'spam')", [rafa]),
    /already_reported/,
  );

  // Once it is resolved, the same person can be reported again — otherwise one
  // report in 2026 silences every report after it.
  await asService(db, "update public.reports set status = 'dismissed' where reporter_id = $1", [
    ada,
  ]);
  const { rows } = await asUser(db, ada, "select public.report_user($1, 'spam') as id", [rafa]);
  truthy("a resolved report does not block the next one", Boolean(rows[0].id));
  await asService(db, "update public.reports set status = 'dismissed' where reporter_id = $1", [
    ada,
  ]);
}

{
  /*
   * The evidence reference is an oracle if it is not scoped.
   *
   * Accepting or refusing a message id on existence tells the caller whether it
   * exists. So one they cannot see is dropped, and the report is still filed.
   */
  const { rows: convRows } = await asUser(db, rafa, "select public.start_dm($1) as id", [nour]);
  const privateConversation = convRows[0].id;

  const { rows: msgRows } = await asService(
    db,
    "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'private') returning id",
    [privateConversation, rafa],
  );

  const { rows } = await asUser(
    db,
    theo,
    "select public.report_user($1, 'spam', 'saw something', $2, $3) as id",
    [rafa, msgRows[0].id, privateConversation],
  );
  truthy("a report citing a message you cannot see is still filed", Boolean(rows[0].id));

  const { rows: stored } = await asService(
    db,
    "select message_id, conversation_id from public.reports where reporter_id = $1",
    [theo],
  );
  eq("but the message reference is dropped", stored[0].message_id, null);
  eq("and so is the conversation", stored[0].conversation_id, null);

  // The same report from somebody who IS in the conversation keeps the evidence.
  const { rows: seen } = await asUser(
    db,
    nour,
    "select public.report_user($1, 'harassment', null, $2, $3) as id",
    [rafa, msgRows[0].id, privateConversation],
  );
  truthy("a report from inside the room is filed too", Boolean(seen[0].id));

  const { rows: kept } = await asService(
    db,
    "select message_id from public.reports where reporter_id = $1",
    [nour],
  );
  eq("and keeps the evidence", kept[0].message_id, msgRows[0].id);
}

{
  // Five an hour. Somebody reporting six people in an hour is either having a
  // very bad day or is the problem, and both are worth slowing down.
  await asService(db, "delete from public.reports where reporter_id = $1", [theo]);

  // Five already filed in the last hour. Marked dismissed so the per-person
  // duplicate rule is not what refuses the sixth — the cap is.
  for (const target of [ada, rafa, nour, ada, rafa]) {
    await asService(
      db,
      `insert into public.reports (reporter_id, reported_id, reason, status)
       values ($1, $2, 'spam', 'dismissed')`,
      [theo, target],
    );
  }

  await raises(
    "a sixth report in an hour is refused",
    asUser(db, theo, "select public.report_user($1, 'spam')", [nour]),
    /too_many_reports/,
  );

  await asService(db, "delete from public.reports where reporter_id = $1", [theo]);
}

/* ==========================================================================
 * 3 · A block severs
 * ========================================================================== */

section("Blocking severs");

{
  await denied(
    "there is no direct write path to blocks",
    asUser(db, ada, "insert into public.blocks (blocker_id, blocked_id) values ($1,$2)", [
      ada,
      theo,
    ]),
  );
  await raises(
    "you cannot block yourself",
    asUser(db, ada, "select public.block_user($1)", [ada]),
    /cannot_block_self/,
  );
  await raises(
    "nor somebody who does not exist",
    asUser(db, ada, "select public.block_user($1)", ["00000000-0000-0000-0000-000000000000"]),
    /no_such_account/,
  );
}

{
  // Everything a block should end, set up first.
  const { rows: conv } = await asUser(db, ada, "select public.start_dm($1) as id", [theo]);
  const dm = conv[0].id;

  const { rows: call } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
  const callId = call[0].id;

  const { rows: game } = await asUser(
    db,
    ada,
    "select public.create_game_session($1, 'would-you-rather') as id",
    [dm],
  );
  const gameId = game[0].id;
  await asUser(db, theo, "select public.join_game_session($1)", [gameId]);

  const { rows: couple } = await asUser(db, ada, "select public.propose_couple($1) as id", [theo]);
  await asUser(db, theo, "select public.respond_to_couple($1, true)", [couple[0].id]);

  // And a pending request in the other direction, from somebody else.
  await asUser(
    db,
    nour,
    "insert into public.friend_requests (requester_id, addressee_id) values ($1,$2)",
    [nour, theo],
  );

  await asUser(db, ada, "select public.block_user($1, 'enough')", [theo]);

  const count = async (sql, params) => {
    const { rows } = await asService(db, sql, params);
    return rows[0].n;
  };

  eq(
    "the friendship is gone",
    await count(
      "select count(*)::int n from public.friendships where user_low = $1 and user_high = $2",
      pair(ada, theo),
    ),
    0,
  );

  eq(
    "the couple is ended",
    (await asService(db, "select status from public.couples where id = $1", [couple[0].id])).rows[0]
      .status,
    "ended",
  );

  eq(
    "both of them have left the call",
    await count(
      "select count(*)::int n from public.call_participants where call_id = $1 and left_at is null",
      [callId],
    ),
    0,
  );

  eq(
    "and the unfinished game",
    await count(
      "select count(*)::int n from public.game_players where session_id = $1 and left_at is null",
      [gameId],
    ),
    0,
  );

  // A pending request between two OTHER people is none of this block's business.
  eq(
    "somebody else's pending request is untouched",
    await count(
      "select count(*)::int n from public.friend_requests where requester_id = $1 and status = 'pending'",
      [nour],
    ),
    1,
  );

  const { rows: note } = await asUser(db, ada, "select reason from public.blocks");
  eq("the private note is kept", note[0].reason, "enough");

  await denied(
    "and the blocked person cannot see the block",
    asUser(db, theo, "select * from public.blocks"),
  );

  // Idempotent: a double-tapped Block must not raise on the unique constraint.
  await asUser(db, ada, "select public.block_user($1)", [theo]);
  eq(
    "blocking twice is a no-op",
    await count("select count(*)::int n from public.blocks where blocker_id = $1", [ada]),
    1,
  );
}

{
  // Pending requests, both directions, cancelled rather than declined.
  await asUser(db, ada, "select public.unblock_user($1)", [theo]);
  await befriend(ada, theo);

  await asService(db, "delete from public.friend_requests");
  await asUser(
    db,
    rafa,
    "insert into public.friend_requests (requester_id, addressee_id) values ($1,$2)",
    [rafa, theo],
  );

  await asUser(db, theo, "select public.block_user($1)", [rafa]);

  const { rows } = await asService(
    db,
    "select status from public.friend_requests where requester_id = $1 and addressee_id = $2",
    [rafa, theo],
  );
  eq("a request from the blocked person is cancelled", rows[0].status, "cancelled");

  // 'cancelled', not 'declined': declining is a statement about the request, and
  // this is a statement about the person.
  falsy("not declined", rows[0].status === "declined");

  await asUser(db, theo, "select public.unblock_user($1)", [rafa]);
}

/* ==========================================================================
 * 4 · The grid — every surface the brief names
 * ========================================================================== */

section("Blocked, across every surface");

// Ada and Nour are friends, share a group thread with Rafa, and Ada blocks Nour.
const { rows: groupRows } = await asUser(db, ada, "select public.start_group($1, $2) as id", [
  "the room",
  [rafa, nour],
]);
const group = groupRows[0].id;

const { rows: theirMsg } = await asService(
  db,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'from nour') returning id",
  [group, nour],
);
await asService(
  db,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'from rafa')",
  [group, rafa],
);

// A game inside the group, with both of them seated, started before the block.
const { rows: sharedGame } = await asUser(
  db,
  ada,
  "select public.create_game_session($1, 'would-you-rather') as id",
  [group],
);
const gameInGroup = sharedGame[0].id;
await asUser(db, nour, "select public.join_game_session($1)", [gameInGroup]);

await asUser(db, ada, "select public.block_user($1)", [nour]);

const yes = async (userId, sql, params) => {
  const { rows } = await asUser(db, userId, sql, params);
  return rows[0]?.yes ?? rows.length > 0;
};

{
  section("  friends");

  eq(
    "search does not find them",
    (await asUser(db, ada, "select * from public.search_profiles('nour')")).rows.length,
    0,
  );
  eq(
    "nor the other way round",
    (await asUser(db, nour, "select * from public.search_profiles('ada')")).rows.length,
    0,
  );
  eq(
    "the friends list does not list them",
    (await asUser(db, ada, "select * from public.list_friends() where id = $1", [nour])).rows
      .length,
    0,
  );
  eq(
    "symmetrically",
    (await asUser(db, nour, "select * from public.list_friends() where id = $1", [ada])).rows
      .length,
    0,
  );
  await denied(
    "a friend request cannot be sent",
    asUser(
      db,
      nour,
      "insert into public.friend_requests (requester_id, addressee_id) values ($1,$2)",
      [nour, ada],
    ),
  );
  await denied(
    "nor in the other direction",
    asUser(
      db,
      ada,
      "insert into public.friend_requests (requester_id, addressee_id) values ($1,$2)",
      [ada, nour],
    ),
  );
  eq(
    "and the profile is invisible",
    (await asUser(db, ada, "select id from public.profiles where id = $1", [nour])).rows.length,
    0,
  );
}

{
  section("  messages");

  falsy(
    "neither can post to the shared thread",
    await yes(ada, "select public.can_post_to_conversation($1) as yes", [group]),
  );
  falsy(
    "symmetrically",
    await yes(nour, "select public.can_post_to_conversation($1) as yes", [group]),
  );
  await denied(
    "and the insert is refused",
    asUser(
      db,
      ada,
      "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'hello?')",
      [group, ada],
    ),
  );

  /*
   * The gap fixed by 0026. "Blocked" that still shows you what they said is a
   * mute — and the block is symmetric, so it goes both ways.
   */
  const { rows: seen } = await asUser(
    db,
    ada,
    "select body from public.messages where conversation_id = $1",
    [group],
  );
  eq("their messages are hidden", seen.length, 1);
  eq("and everybody else's are not", seen[0].body, "from rafa");

  const { rows: theirs } = await asUser(db, nour, "select id from public.messages where id = $1", [
    theirMsg[0].id,
  ]);
  eq("the blocked person still sees their own", theirs.length, 1);

  const { rows: bystander } = await asUser(
    db,
    rafa,
    "select body from public.messages where conversation_id = $1",
    [group],
  );
  eq("and a bystander sees everything, as they should", bystander.length, 2);
}

{
  section("  calls");

  falsy(
    "the call gate is closed",
    await yes(ada, "select public.can_call_conversation($1) as yes", [group]),
  );
  await denied("and start_call refuses", asUser(db, ada, "select public.start_call($1)", [group]));
  await denied("in both directions", asUser(db, nour, "select public.start_call($1)", [group]));
}

{
  section("  games");

  /*
   * The other gap fixed by 0026. `can_view_game_session` checked conversation
   * membership and stopped, so two people could sit in one game across a block
   * and watch each other's moves arrive.
   */
  falsy(
    "the game they were both in is no longer visible",
    await yes(ada, "select public.can_view_game_session($1) as yes", [gameInGroup]),
  );
  falsy(
    "symmetrically",
    await yes(nour, "select public.can_view_game_session($1) as yes", [gameInGroup]),
  );
  await denied(
    "the session cannot be fetched",
    asUser(db, ada, "select * from public.get_game_session($1)", [gameInGroup]),
  );
  await denied(
    "nor its players",
    asUser(db, ada, "select * from public.list_game_players($1)", [gameInGroup]),
  );
  await denied(
    "nor rejoined",
    asUser(db, nour, "select public.join_game_session($1)", [gameInGroup]),
  );

  // A game in the same thread that the blocked person is NOT in is fine. The
  // check is against who is seated, not against the conversation.
  const { rows: other } = await asUser(
    db,
    rafa,
    "select public.create_game_session($1, 'who-knows-me') as id",
    [group],
  );
  truthy(
    "a game between other people in the same thread still works",
    await yes(ada, "select public.can_view_game_session($1) as yes", [other[0].id]),
  );
}

{
  section("  couple invitations");

  falsy("they cannot be asked", await yes(ada, "select public.can_propose_to($1) as yes", [nour]));
  falsy("nor can they ask", await yes(nour, "select public.can_propose_to($1) as yes", [ada]));
  await denied(
    "and the proposal is refused",
    asUser(db, ada, "select public.propose_couple($1)", [nour]),
  );
}

/* ==========================================================================
 * 5 · Unblocking
 * ========================================================================== */

section("Unblocking");

{
  // The list exists because blocking hides the person everywhere else — without
  // it, an accidental block would be close to permanent.
  const { rows } = await asUser(db, ada, "select * from public.list_blocked()");
  eq("the blocked list has them", rows.length, 1);
  eq("with a name, which profiles_select would have hidden", rows[0].username, "nour");
  truthy("and a date", rows[0].blocked_at !== null);

  const { rows: theirs } = await asUser(db, nour, "select * from public.list_blocked()");
  eq("and shows nothing to the person blocked", theirs.length, 0);

  await denied(
    "unblocking is not a direct delete either",
    asUser(db, ada, "delete from public.blocks where blocked_id = $1", [nour]),
  );

  await asUser(db, ada, "select public.unblock_user($1)", [nour]);

  eq(
    "after unblocking, the list is empty",
    (await asUser(db, ada, "select * from public.list_blocked()")).rows.length,
    0,
  );
  eq(
    "the profile is visible again",
    (await asUser(db, ada, "select id from public.profiles where id = $1", [nour])).rows.length,
    1,
  );
  truthy(
    "and they can post again",
    await yes(ada, "select public.can_post_to_conversation($1) as yes", [group]),
  );
  eq(
    "their messages are back",
    (await asUser(db, ada, "select id from public.messages where conversation_id = $1", [group]))
      .rows.length,
    2,
  );

  /*
   * But it is not an undo.
   *
   * `unblock_user` deliberately does not restore the friendship, the couple or
   * the game — undoing a severing would mean remembering what was severed, and a
   * block is not a pause button.
   */
  eq(
    "the friendship is still gone",
    (await asUser(db, ada, "select * from public.list_friends() where id = $1", [nour])).rows
      .length,
    0,
  );
  falsy(
    "so they still cannot be asked to pair",
    await yes(ada, "select public.can_propose_to($1) as yes", [nour]),
  );

  // Unblocking somebody who was never blocked is a no-op, not an error.
  await asUser(db, ada, "select public.unblock_user($1)", [theo]);
  ok("unblocking somebody who was not blocked is harmless");
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
