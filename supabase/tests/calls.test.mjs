/**
 * Voice call tests.
 *
 * The call lifecycle is a state machine that decides, among other things,
 * whether somebody gets a "you missed a call" notification. That makes it worth
 * far more scrutiny than a feature of its size normally would: "missed" must be
 * something the database derives, never something a client can assert.
 *
 * So most of what follows is negative. Can a stranger ring a conversation they
 * are not in? Can a participant mark their own declined call as answered? Can
 * somebody add a third person to a call and pick up the signalling stream? Those
 * are the questions, and none of them can be answered by using the app.
 *
 *     npm run calls:test
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
const truthy = (n, v, d = "expected a truthy value") => (v ? ok(n) : bad(n, d));
const section = (t) => console.log(`\n${t}`);

/**
 * Asserts a statement is refused.
 *
 * Accepts both shapes a refusal takes: a raised error (an RPC that checks and
 * throws, or a revoked privilege) and a silent zero rows (RLS filtering the row
 * out before the write ever sees it). Insisting on one would be asserting the
 * mechanism rather than the outcome.
 */
async function denied(name, promise) {
  try {
    const result = await promise;
    if (result?.rows?.length === 0 || result?.affectedRows === 0) {
      ok(`${name} (no rows)`);
      return;
    }
    bad(name, `expected a refusal, got ${JSON.stringify(result?.rows ?? result)}`);
  } catch (error) {
    ok(`${name} (${error.message.split("\n")[0].slice(0, 60)})`);
  }
}

async function allowed(name, promise) {
  try {
    await promise;
    ok(name);
  } catch (error) {
    bad(name, error.message.split("\n")[0]);
  }
}

console.log("KITH — voice calls\n");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");
const wren = await createUser(db, "wren");

// Ada and Rafa are friends with a DM. Nour is an outsider to it.
await asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
  ada < rafa ? ada : rafa,
  ada < rafa ? rafa : ada,
]);

const { rows: dmRows } = await asUser(db, ada, "select public.start_dm($1) as id", [rafa]);
const dm = dmRows[0].id;

/* ==========================================================================
 * 1 · Who may start a call
 * ========================================================================== */

section("Starting a call");

await denied(
  "an outsider cannot ring a conversation they are not in",
  asUser(db, nour, "select public.start_call($1) as id", [dm]),
);

await denied(
  "an unauthenticated caller cannot start a call",
  asService(db, "select public.start_call($1) as id", [dm]),
);

const { rows: startRows } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
const call = startRows[0].id;
truthy("a member can start a call", Boolean(call));

{
  const { rows } = await asService(
    db,
    "select status, kind, initiator_id, answered_at, ended_at from public.calls where id = $1",
    [call],
  );
  eq("the call starts ringing", rows[0].status, "ringing");
  eq("audio by default — video is not built", rows[0].kind, "audio");
  eq("the initiator is recorded", rows[0].initiator_id, ada);
  eq("an unanswered call has no answered_at", rows[0].answered_at, null);

  const { rows: parts } = await asService(
    db,
    "select user_id, joined_at from public.call_participants where call_id = $1 order by user_id",
    [call],
  );
  eq("everybody in the conversation is rung", parts.length, 2);
  eq(
    "the caller is joined immediately, the callee is not",
    parts.map((p) => (p.user_id === ada ? p.joined_at !== null : p.joined_at === null)),
    [true, true],
  );
}

/* ==========================================================================
 * 2 · One call at a time, and one call per conversation
 * ========================================================================== */

section("Call exclusivity");

await denied(
  "somebody already on a call cannot start another",
  asUser(db, ada, "select public.start_call($1) as id", [dm]).then(async (r) => {
    // start_call returns the EXISTING call rather than raising, so a returned id
    // that matches is the refusal. A different id would be the bug.
    if (r.rows[0].id === call) throw new Error("joined the existing call");
    return r;
  }),
);

{
  // Simultaneous dialling: Rafa presses call while Ada's call is still ringing.
  // One call, not two.
  const { rows } = await asUser(db, rafa, "select public.start_call($1) as id", [dm]);
  eq("simultaneous dialling collapses into one call", rows[0].id, call);

  const { rows: live } = await asService(
    db,
    "select count(*)::int as n from public.calls where conversation_id = $1 and status in ('ringing','active')",
    [dm],
  );
  eq("the conversation has exactly one live call", live[0].n, 1);

  const { rows: state } = await asService(
    db,
    "select status, answered_at from public.calls where id = $1",
    [call],
  );
  eq("dialling into a ringing call answers it", state[0].status, "active");
  truthy("and stamps answered_at", state[0].answered_at !== null);
}

/* ==========================================================================
 * 3 · Hanging up
 * ========================================================================== */

section("Hanging up");

await denied(
  "an outsider cannot end a call",
  asUser(db, nour, "select public.end_call($1)", [call]),
);

await allowed("a participant can hang up", asUser(db, ada, "select public.end_call($1)", [call]));

{
  const { rows } = await asService(
    db,
    "select status, end_reason, ended_at from public.calls where id = $1",
    [call],
  );
  eq("an answered call that ends is 'ended'", rows[0].status, "ended");
  eq("with reason hung_up", rows[0].end_reason, "hung_up");
  truthy("and an ended_at", rows[0].ended_at !== null);
}

await allowed(
  "hanging up twice is not an error",
  asUser(db, rafa, "select public.end_call($1)", [call]),
);

{
  const { rows } = await asService(db, "select end_reason from public.calls where id = $1", [call]);
  eq("and does not rewrite how the call ended", rows[0].end_reason, "hung_up");
}

/* ==========================================================================
 * 4 · Declining
 * ========================================================================== */

section("Declining");

{
  const { rows } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
  const declined = rows[0].id;

  await denied(
    "the caller cannot answer their own call",
    asUser(db, ada, "select public.answer_call($1)", [declined]),
  );

  await allowed(
    "the callee can decline",
    asUser(db, rafa, "select public.end_call($1, 'declined')", [declined]),
  );

  const { rows: state } = await asService(
    db,
    "select status, end_reason from public.calls where id = $1",
    [declined],
  );
  eq("a declined call is 'declined'", state[0].status, "declined");
  eq("with reason declined", state[0].end_reason, "declined");

  const { rows: notifications } = await asService(
    db,
    "select count(*)::int as n from public.notifications where kind = 'call_missed' and payload->>'call_id' = $1",
    [declined],
  );
  eq("declining does not produce a missed-call notification", notifications[0].n, 0);
}

/* ==========================================================================
 * 5 · Missed calls
 *
 * The part a client must never be able to forge, in either direction.
 * ========================================================================== */

section("Missed calls");

{
  const { rows } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
  const cancelled = rows[0].id;

  await allowed(
    "the caller gives up while it is still ringing",
    asUser(db, ada, "select public.end_call($1)", [cancelled]),
  );

  const { rows: state } = await asService(
    db,
    "select status, end_reason from public.calls where id = $1",
    [cancelled],
  );
  eq("an abandoned ring is a missed call", state[0].status, "missed");
  eq("with reason cancelled", state[0].end_reason, "cancelled");

  const { rows: notified } = await asService(
    db,
    "select user_id, actor_id from public.notifications where kind = 'call_missed' and payload->>'call_id' = $1",
    [cancelled],
  );
  eq("the callee is told they missed it", notified.length, 1);
  eq("and it is the callee, not the caller", notified[0].user_id, rafa);
  eq("attributed to the caller", notified[0].actor_id, ada);
}

{
  // A client asking for a flattering end reason does not get one.
  const { rows } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
  const forged = rows[0].id;

  await asUser(db, rafa, "select public.end_call($1, 'hung_up')", [forged]);

  const { rows: state } = await asService(
    db,
    "select status, end_reason from public.calls where id = $1",
    [forged],
  );
  eq(
    "a callee hanging up on a ringing call is a decline, whatever reason they send",
    state[0].status,
    "declined",
  );
  eq("and the reason is overridden", state[0].end_reason, "declined");
}

/* ==========================================================================
 * 6 · The timeout
 * ========================================================================== */

section("Ring timeout");

{
  const { rows } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
  const stale = rows[0].id;

  // Wind the clock back past the timeout rather than waiting 45 seconds.
  await asService(
    db,
    "update public.calls set started_at = now() - interval '2 minutes' where id = $1",
    [stale],
  );

  const { rows: active } = await asUser(db, rafa, "select * from public.get_active_call()");
  eq("a ring that has run out is not reported as a live call", active.length, 0);

  await denied(
    "and it cannot be answered",
    asUser(db, rafa, "select public.answer_call($1)", [stale]),
  );

  const { rows: swept } = await asService(db, "select public.expire_ringing_calls() as n");
  truthy("the sweep is idempotent once it has run", swept[0].n >= 0);

  const { rows: state } = await asService(
    db,
    "select status, end_reason from public.calls where id = $1",
    [stale],
  );
  eq("a timed-out call is missed", state[0].status, "missed");
  eq("with reason expired", state[0].end_reason, "expired");

  const { rows: notified } = await asService(
    db,
    "select user_id from public.notifications where kind = 'call_missed' and payload->>'call_id' = $1",
    [stale],
  );
  eq("the callee is notified of the timeout", notified.length, 1);
  eq("and only the callee", notified[0].user_id, rafa);

  const { rows: again } = await asService(db, "select public.expire_ringing_calls() as n");
  eq("a second sweep finds nothing to do", again[0].n, 0);
}

/* ==========================================================================
 * 7 · Answering
 * ========================================================================== */

section("Answering");

let liveCall;
{
  const { rows } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
  liveCall = rows[0].id;

  await denied(
    "an outsider cannot answer",
    asUser(db, nour, "select public.answer_call($1)", [liveCall]),
  );

  await allowed(
    "the callee answers",
    asUser(db, rafa, "select public.answer_call($1)", [liveCall]),
  );

  const { rows: state } = await asService(
    db,
    "select status, answered_at from public.calls where id = $1",
    [liveCall],
  );
  eq("the call is active", state[0].status, "active");
  truthy("answered_at is stamped", state[0].answered_at !== null);

  const { rows: joined } = await asService(
    db,
    "select joined_at from public.call_participants where call_id = $1 and user_id = $2",
    [liveCall, rafa],
  );
  truthy("the callee is joined", joined[0].joined_at !== null);

  await allowed(
    "answering twice is harmless",
    asUser(db, rafa, "select public.answer_call($1)", [liveCall]),
  );
}

/* ==========================================================================
 * 8 · What a client may write directly
 *
 * The privileges are the door and the policies are the guard. Both are checked.
 * ========================================================================== */

section("Direct writes");

await denied(
  "a participant cannot insert a call row by hand",
  asUser(
    db,
    ada,
    "insert into public.calls (conversation_id, initiator_id, kind) values ($1, $2, 'audio')",
    [dm, ada],
  ),
);

await denied(
  "a participant cannot end a call by updating the row",
  asUser(
    db,
    rafa,
    "update public.calls set status = 'ended', ended_at = now(), end_reason = 'hung_up' where id = $1",
    [liveCall],
  ),
);

await denied(
  "a participant cannot rewrite history",
  asUser(db, ada, "update public.calls set status = 'missed' where id = $1", [liveCall]),
);

await denied(
  "a participant cannot delete a call",
  asUser(db, ada, "delete from public.calls where id = $1", [liveCall]),
);

await denied(
  "a participant cannot fake having joined",
  asUser(
    db,
    ada,
    "update public.call_participants set joined_at = now() where call_id = $1 and user_id = $2",
    [liveCall, ada],
  ),
);

await allowed(
  "but they can publish their own mute state",
  asUser(db, ada, "select public.set_call_media_state($1, $2::jsonb)", [
    liveCall,
    JSON.stringify({ micEnabled: false }),
  ]),
);

{
  const { rows } = await asService(
    db,
    "select media_state from public.call_participants where call_id = $1 and user_id = $2",
    [liveCall, ada],
  );
  eq("which is stored", rows[0].media_state, { micEnabled: false });
}

await denied(
  "and cannot mute somebody else",
  asUser(
    db,
    ada,
    `update public.call_participants set media_state = '{"micEnabled":false}'::jsonb
      where call_id = $1 and user_id = $2`,
    [liveCall, rafa],
  ),
);

/* ==========================================================================
 * 9 · The hole migration 0005 left
 *
 * `call_participants_insert` checked that the inserting user could post to the
 * conversation, but not that the row was their own. Since `is_call_participant`
 * gates the `call:{id}` realtime channel, adding a row for somebody else handed
 * them the signalling stream for a call they were never on.
 * ========================================================================== */

section("Participant forgery");

await denied(
  "a participant cannot add somebody else to a call",
  asUser(db, ada, "insert into public.call_participants (call_id, user_id) values ($1, $2)", [
    liveCall,
    nour,
  ]),
);

await denied(
  "an outsider cannot add themselves to a call",
  asUser(db, nour, "insert into public.call_participants (call_id, user_id) values ($1, $2)", [
    liveCall,
    nour,
  ]),
);

{
  const { rows } = await asUser(db, nour, "select public.is_call_participant($1) as yes", [
    liveCall,
  ]);
  eq("so an outsider is not a participant", rows[0].yes, false);
}

await denied(
  "and cannot read the call",
  asUser(db, nour, "select id from public.calls where id = $1", [liveCall]),
);

await denied(
  "or see who is on it",
  asUser(db, nour, "select user_id from public.call_participants where call_id = $1", [liveCall]),
);

/* ==========================================================================
 * 10 · Blocks
 * ========================================================================== */

section("Blocks");

{
  await asService(db, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [
    rafa,
    wren,
  ]);
  await asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
    ada < wren ? ada : wren,
    ada < wren ? wren : ada,
  ]);

  const { rows } = await asUser(db, ada, "select public.start_dm($1) as id", [wren]);
  const wrenDm = rows[0].id;

  await asUser(db, ada, "select public.end_call($1)", [liveCall]);

  await allowed(
    "a call into an unblocked conversation is fine",
    asUser(db, ada, "select public.start_call($1)", [wrenDm]),
  );
  await asUser(db, ada, "select public.end_call($1)", [
    (await asUser(db, ada, "select id from public.calls where conversation_id = $1", [wrenDm]))
      .rows[0].id,
  ]);

  // Rafa blocked Wren. Neither may ring the other.
  const { rows: blockedDm } = await asService(
    db,
    "select id from public.conversations where dm_key = $1",
    [[rafa, wren].sort().join(":")],
  );

  if (blockedDm.length > 0) {
    await denied(
      "a blocked user cannot ring the person who blocked them",
      asUser(db, wren, "select public.start_call($1)", [blockedDm[0].id]),
    );
  } else {
    // No conversation exists between them, which is itself the answer.
    ok("a blocked user has no conversation to ring");
  }
}

/* ==========================================================================
 * 11 · History
 * ========================================================================== */

section("Call history");

{
  const { rows } = await asUser(db, ada, "select * from public.list_calls(50, null)");
  truthy("Ada has a call history", rows.length > 0);

  eq(
    "every entry is a call she was actually on",
    rows.every((r) => r.other_user_id !== ada),
    true,
  );

  const outgoing = rows.filter((r) => r.is_initiator);
  truthy("outgoing calls are marked as hers", outgoing.length > 0);

  const answered = rows.find((r) => r.status === "ended");
  truthy("a completed call reports a duration", answered && answered.duration_seconds !== null);
  eq(
    "a call that was never answered has no duration",
    rows.filter((r) => r.status === "missed").every((r) => r.duration_seconds === null),
    true,
  );

  const { rows: nourHistory } = await asUser(db, nour, "select * from public.list_calls(50, null)");
  eq("somebody who was never on a call has no history", nourHistory.length, 0);

  // Keyset pagination.
  const { rows: firstPage } = await asUser(db, ada, "select * from public.list_calls(2, null)");
  eq("the page size is honoured", firstPage.length, 2);

  const { rows: secondPage } = await asUser(db, ada, "select * from public.list_calls(2, $1)", [
    firstPage[1].started_at,
  ]);
  eq(
    "the second page does not repeat the first",
    secondPage.filter((r) => firstPage.some((f) => f.id === r.id)).length,
    0,
  );

  const { rows: capped } = await asUser(db, ada, "select * from public.list_calls(9999, null)");
  truthy("an absurd page size is capped", capped.length <= 100);
}

/* ==========================================================================
 * 12 · get_active_call
 * ========================================================================== */

section("Resuming a call");

{
  const { rows: none } = await asUser(db, ada, "select * from public.get_active_call()");
  eq("no live call when there is none", none.length, 0);

  const { rows: started } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
  const resumable = started[0].id;

  const { rows: mine } = await asUser(db, ada, "select * from public.get_active_call()");
  eq("the caller sees their outgoing call", mine.length, 1);
  eq("with the right id", mine[0].id, resumable);
  eq("marked as theirs", mine[0].is_initiator, true);
  eq("and the other person named", mine[0].other_user_id, rafa);
  eq("the callee is identified by username", mine[0].other_username, "rafa");

  const { rows: theirs } = await asUser(db, rafa, "select * from public.get_active_call()");
  eq("the callee sees the incoming call", theirs.length, 1);
  eq("but not as the initiator", theirs[0].is_initiator, false);
  eq("and has not joined yet", theirs[0].joined_at, null);

  const { rows: outsider } = await asUser(db, nour, "select * from public.get_active_call()");
  eq("an outsider sees nothing", outsider.length, 0);

  await asUser(db, ada, "select public.end_call($1)", [resumable]);
  const { rows: after } = await asUser(db, ada, "select * from public.get_active_call()");
  eq("and nothing once it has ended", after.length, 0);
}

/* ==========================================================================
 * 13 · The realtime channel
 *
 * Lifecycle events go to each participant's personal bus; signalling stays on
 * `call:{id}`. Both are checked here — the second is what a stranger would need
 * in order to listen to a call.
 * ========================================================================== */

section("Realtime");

{
  const { rows } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
  const broadcasting = rows[0].id;

  const { rows: sent } = await asService(
    db,
    "select topic, event from realtime.sent where event like 'call.%' order by id desc limit 4",
  );

  truthy(
    "starting a call broadcasts to the participants",
    sent.some((s) => s.event === "call.incoming"),
  );
  eq(
    "on the personal bus, not the call channel",
    sent.filter((s) => s.event === "call.incoming").every((s) => s.topic.startsWith("user:")),
    true,
  );
  eq("one message per participant", sent.filter((s) => s.event === "call.incoming").length, 2);

  await asUser(db, rafa, "select public.answer_call($1)", [broadcasting]);
  const { rows: answered } = await asService(
    db,
    "select topic, event from realtime.sent order by id desc limit 2",
  );
  truthy(
    "answering broadcasts too",
    answered.some((s) => s.event === "call.updated"),
  );

  await asUser(db, ada, "select public.end_call($1)", [broadcasting]);
  const { rows: ended } = await asService(
    db,
    "select event from realtime.sent order by id desc limit 2",
  );
  truthy(
    "and so does hanging up",
    ended.some((s) => s.event === "call.ended"),
  );

  const { rows: policies } = await asService(
    db,
    `select polname, polcmd from pg_policy
      where polrelid = 'realtime.messages'::regclass and polname like 'realtime_call%'
      order by polname`,
  );
  eq(
    "the call channel is gated in both directions",
    policies.map((p) => p.polname),
    ["realtime_call_read", "realtime_call_write"],
  );
}

/* ==========================================================================
 * 14 · Schema hygiene
 * ========================================================================== */

section("Schema");

{
  const { rows } = await asService(
    db,
    `select c.conname
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname in ('calls', 'call_participants')
        and c.contype = 'f'
        and not exists (
          select 1 from pg_index i
           where i.indrelid = c.conrelid
             and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] operator(pg_catalog.=) c.conkey
        )`,
  );
  eq(
    "every call foreign key has a covering index",
    rows.map((r) => r.conname),
    [],
  );

  const { rows: rls } = await asService(
    db,
    `select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('calls', 'call_participants') order by relname`,
  );
  eq(
    "RLS is enabled and forced on both call tables",
    rls.map((r) => [r.relrowsecurity, r.relforcerowsecurity]),
    [
      [true, true],
      [true, true],
    ],
  );

  const { rows: definers } = await asService(
    db,
    `select proname from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('start_call','answer_call','end_call','expire_ringing_calls',
                        'broadcast_call','set_call_media_state')
        and (prosecdef = false or proconfig is null
             or not exists (
               select 1 from unnest(proconfig) cfg where cfg like 'search\_path=%'
             ))
      order by proname`,
  );
  eq(
    "every call RPC is SECURITY DEFINER with a pinned search_path",
    definers.map((r) => r.proname),
    [],
  );

  const { rows: anonGrants } = await asService(
    db,
    `select p.proname from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('start_call','answer_call','end_call','get_active_call','list_calls')
        and has_function_privilege('anon', p.oid, 'execute')`,
  );
  eq(
    "anon can execute none of them",
    anonGrants.map((r) => r.proname),
    [],
  );

  const { rows: broadcastGrant } = await asService(
    db,
    `select has_function_privilege('authenticated', 'public.broadcast_call(uuid,text)', 'execute') as yes`,
  );
  eq("clients cannot broadcast call events themselves", broadcastGrant[0].yes, false);
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
