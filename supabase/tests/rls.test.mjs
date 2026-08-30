/**
 * Row Level Security tests.
 *
 * Every test here is a *negative* case: proof that somebody cannot reach data
 * they are not entitled to. Positive tests ("a member can read their own
 * messages") matter too, and a few are included as controls — but a policy suite
 * that only checks the happy path passes just as well with RLS switched off,
 * which is precisely the failure it is supposed to prevent.
 *
 * These run as the real `authenticated` role against real Postgres, with the
 * same JWT claim Supabase sets. If a policy is wrong, a test here fails.
 *
 *     npm run db:test
 */

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function bad(name, detail) {
  failed += 1;
  failures.push(`${name}\n      ${detail}`);
  console.log(`  ✗ ${name}\n      ${detail}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** A SELECT that RLS filters returns fewer rows rather than raising. */
async function expectRows(name, promise, expected) {
  try {
    const { rows } = await promise;
    if (rows.length === expected) ok(`${name} (${rows.length} rows)`);
    else bad(name, `expected ${expected} rows, got ${rows.length}`);
  } catch (error) {
    bad(name, `unexpected error: ${error.message}`);
  }
}

/**
 * A write blocked by RLS either raises 42501 (WITH CHECK refused the new row) or
 * affects zero rows (USING matched nothing). Both are denials; treating only the
 * first as one would let half the policy surface pass untested.
 */
async function expectDenied(name, promise) {
  try {
    const result = await promise;
    const affected = result.affectedRows ?? 0;
    if (affected === 0) ok(`${name} — denied (0 rows affected)`);
    else bad(name, `NOT DENIED: ${affected} row(s) written`);
  } catch (error) {
    if (/row-level security|violates row-level/i.test(error.message)) {
      ok(`${name} — denied (RLS policy)`);
    } else if (/permission denied|append-only|not permitted/i.test(error.message)) {
      ok(`${name} — denied (${error.message.split("\n")[0].slice(0, 60)})`);
    } else {
      bad(name, `denied for the WRONG reason: ${error.message}`);
    }
  }
}

/**
 * A denial by CHECK constraint or unique index, which is a different mechanism
 * from RLS. Kept separate so that "the policy refused this" and "the schema
 * refused this" cannot be mistaken for one another — a test that accepts either
 * is asserting neither.
 */
async function expectRejected(name, promise, expectedPattern) {
  try {
    await promise;
    bad(name, "NOT REJECTED: the write succeeded");
  } catch (error) {
    if (expectedPattern.test(error.message)) {
      ok(`${name} — rejected`);
    } else {
      bad(name, `rejected for the wrong reason: ${error.message}`);
    }
  }
}

async function expectAllowed(name, promise) {
  try {
    await promise;
    ok(name);
  } catch (error) {
    bad(name, `should have been allowed: ${error.message}`);
  }
}

const db = await freshDatabase();

// --- Cast ---------------------------------------------------------------------
const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");
const theo = await createUser(db, "theo");

console.log("KITH — Row Level Security\n");
console.log(
  `  ada=${ada.slice(0, 8)} rafa=${rafa.slice(0, 8)} nour=${nour.slice(0, 8)} theo=${theo.slice(0, 8)}`,
);

/* ========================================================================== */
section("profiles & blocks");

// Ada blocks Theo.
await asUser(db, ada, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [
  ada,
  theo,
]);

await expectRows(
  "a member sees other members' profiles",
  asUser(db, rafa, "select id from public.profiles"),
  4,
);

await expectRows(
  "a blocked user cannot see the blocker's profile",
  asUser(db, theo, "select id from public.profiles where id = $1", [ada]),
  0,
);

await expectRows(
  "the blocker cannot see the blocked user's profile either (symmetric)",
  asUser(db, ada, "select id from public.profiles where id = $1", [theo]),
  0,
);

await expectRows(
  "you cannot see who has blocked you",
  asUser(db, theo, "select blocker_id from public.blocks"),
  0,
);

await expectDenied(
  "you cannot block on somebody else's behalf",
  asUser(db, rafa, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [
    ada,
    nour,
  ]),
);

await expectDenied(
  "you cannot edit another person's profile",
  asUser(db, rafa, "update public.profiles set display_name = 'hacked' where id = $1", [ada]),
);

await expectRows(
  "you cannot read another person's settings",
  asUser(db, rafa, "select * from public.user_settings where user_id = $1", [ada]),
  0,
);

/* ========================================================================== */
section("friend requests & friendships");

const { rows: reqRows } = await asUser(
  db,
  ada,
  "insert into public.friend_requests (requester_id, addressee_id) values ($1, $2) returning id",
  [ada, rafa],
);
const requestId = reqRows[0].id;

await expectRows(
  "an uninvolved user cannot see the request",
  asUser(db, nour, "select id from public.friend_requests where id = $1", [requestId]),
  0,
);

await expectDenied(
  "the REQUESTER cannot accept their own request",
  asUser(db, ada, "update public.friend_requests set status = 'accepted' where id = $1", [
    requestId,
  ]),
);

await expectDenied(
  "a bystander cannot accept somebody else's request",
  asUser(db, nour, "update public.friend_requests set status = 'accepted' where id = $1", [
    requestId,
  ]),
);

await expectDenied(
  "you cannot forge a request from another person",
  asUser(
    db,
    nour,
    "insert into public.friend_requests (requester_id, addressee_id) values ($1, $2)",
    [ada, theo],
  ),
);

await expectDenied(
  "you cannot befriend somebody by writing to friendships directly",
  asUser(db, nour, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
    nour < theo ? nour : theo,
    nour < theo ? theo : nour,
  ]),
);

await expectAllowed(
  "the ADDRESSEE can accept",
  asUser(db, rafa, "update public.friend_requests set status = 'accepted' where id = $1", [
    requestId,
  ]),
);

await expectRows(
  "accepting created the friendship via trigger",
  asService(db, "select 1 from public.friendships where user_low = $1 and user_high = $2", [
    ada < rafa ? ada : rafa,
    ada < rafa ? rafa : ada,
  ]),
  1,
);

await expectDenied(
  "a blocked user cannot send a friend request",
  asUser(
    db,
    theo,
    "insert into public.friend_requests (requester_id, addressee_id) values ($1, $2)",
    [theo, ada],
  ),
);

/* ========================================================================== */
section("conversations & messages");

const pair = [ada, rafa].sort();
const { rows: convRows } = await asService(
  db,
  `insert into public.conversations (kind, created_by, dm_key) values ('dm', $1, $2) returning id`,
  [ada, `${pair[0]}:${pair[1]}`],
);
const conversationId = convRows[0].id;

await asService(
  db,
  `insert into public.conversation_members (conversation_id, user_id)
   values ($1, $2), ($1, $3)`,
  [conversationId, ada, rafa],
);

await asService(
  db,
  `insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'are we still on for tonight')`,
  [conversationId, ada],
);

await expectRows(
  "a member reads the conversation",
  asUser(db, rafa, "select id from public.messages where conversation_id = $1", [conversationId]),
  1,
);

await expectRows(
  "a NON-member reads nothing (the recursion trap, working)",
  asUser(db, nour, "select id from public.messages where conversation_id = $1", [conversationId]),
  0,
);

await expectRows(
  "a non-member cannot even see the conversation row",
  asUser(db, nour, "select id from public.conversations where id = $1", [conversationId]),
  0,
);

await expectRows(
  "a non-member cannot enumerate the membership",
  asUser(db, nour, "select user_id from public.conversation_members where conversation_id = $1", [
    conversationId,
  ]),
  0,
);

await expectDenied(
  "a non-member cannot post into the conversation",
  asUser(
    db,
    nour,
    "insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'let me in')",
    [conversationId, nour],
  ),
);

await expectDenied(
  "you cannot post as somebody else",
  asUser(
    db,
    rafa,
    "insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'not me')",
    [conversationId, ada],
  ),
);

await expectDenied(
  "a non-member cannot add themselves to the conversation",
  asUser(
    db,
    nour,
    "insert into public.conversation_members (conversation_id, user_id) values ($1, $2)",
    [conversationId, nour],
  ),
);

await expectAllowed(
  "start_dm() opens a DM and lets both parties in (positive control)",
  (async () => {
    const { rows } = await asUser(db, nour, "select public.start_dm($1) as id", [theo]);
    const id = rows[0].id;
    await asUser(
      db,
      nour,
      "insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'hey')",
      [id, nour],
    );
    const seen = await asUser(
      db,
      theo,
      "select id from public.messages where conversation_id = $1",
      [id],
    );
    if (seen.rows.length !== 1)
      throw new Error(`the other party saw ${seen.rows.length} messages, expected 1`);
  })(),
);

await expectAllowed(
  "start_dm() is idempotent — calling it twice returns the same conversation",
  (async () => {
    const a = await asUser(db, nour, "select public.start_dm($1) as id", [theo]);
    const b = await asUser(db, theo, "select public.start_dm($1) as id", [nour]);
    if (a.rows[0].id !== b.rows[0].id) throw new Error("two different conversations were created");
  })(),
);

await expectDenied(
  "start_dm() refuses across a block",
  asUser(db, theo, "select public.start_dm($1)", [ada]),
);

await expectDenied(
  "you cannot move another person's read cursor",
  asUser(
    db,
    rafa,
    "update public.conversation_members set last_read_at = now() where conversation_id = $1 and user_id = $2",
    [conversationId, ada],
  ),
);

await expectDenied(
  "you cannot edit another person's message",
  asUser(db, rafa, "update public.messages set body = 'tampered' where sender_id = $1", [ada]),
);

// Now block across an existing conversation.
await asUser(db, rafa, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [
  rafa,
  ada,
]);

await expectDenied(
  "a member BLOCKED by another member can no longer post",
  asUser(
    db,
    ada,
    "insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'hello?')",
    [conversationId, ada],
  ),
);

await asService(db, "delete from public.blocks where blocker_id = $1 and blocked_id = $2", [
  rafa,
  ada,
]);

await expectAllowed(
  "unblocking restores posting",
  asUser(
    db,
    ada,
    "insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'ok good')",
    [conversationId, ada],
  ),
);

/* ========================================================================== */
section("calls");

const { rows: callRows } = await asService(
  db,
  "insert into public.calls (conversation_id, initiator_id, kind) values ($1, $2, 'video') returning id",
  [conversationId, ada],
);
const callId = callRows[0].id;

await asService(
  db,
  "insert into public.call_participants (call_id, user_id) values ($1, $2), ($1, $3)",
  [callId, ada, rafa],
);

await expectRows(
  "a conversation member sees the call",
  asUser(db, rafa, "select id from public.calls where id = $1", [callId]),
  1,
);

await expectRows(
  "an outsider sees no call",
  asUser(db, nour, "select id from public.calls where id = $1", [callId]),
  0,
);

await expectDenied(
  "an outsider cannot end the call",
  asUser(
    db,
    nour,
    "update public.calls set status = 'ended', ended_at = now(), end_reason = 'hung_up' where id = $1",
    [callId],
  ),
);

await expectDenied(
  "a participant cannot mute another participant",
  asUser(
    db,
    rafa,
    `update public.call_participants set media_state = '{"muted":true}'::jsonb where call_id = $1 and user_id = $2`,
    [callId, ada],
  ),
);

/* ========================================================================== */
section("couple — the both-must-answer rule");

const cpair = [ada, rafa].sort();
const { rows: coupleRows } = await asService(
  db,
  `insert into public.couples (user_low, user_high, proposed_by, status)
   values ($1, $2, $3, 'active') returning id`,
  [cpair[0], cpair[1], ada],
);
const coupleId = coupleRows[0].id;

const { rows: promptRows } = await asService(
  db,
  "insert into public.couple_prompts (couple_id, question) values ($1, $2) returning id",
  [coupleId, "What is something you changed your mind about this year?"],
);
const promptId = promptRows[0].id;

await asService(
  db,
  "insert into public.couple_answers (prompt_id, user_id, body) values ($1, $2, $3)",
  [promptId, ada, "That I hate mornings. Turns out I hate my alarm."],
);

await expectRows(
  "Ada sees her own answer",
  asUser(db, ada, "select body from public.couple_answers where prompt_id = $1", [promptId]),
  1,
);

await expectRows(
  "Rafa CANNOT see Ada's answer before answering himself",
  asUser(db, rafa, "select body from public.couple_answers where prompt_id = $1", [promptId]),
  0,
);

await expectRows(
  "an outsider sees nothing of the couple's prompt",
  asUser(db, nour, "select id from public.couple_prompts where id = $1", [promptId]),
  0,
);

await expectDenied(
  "an outsider cannot answer somebody else's prompt",
  asUser(
    db,
    nour,
    "insert into public.couple_answers (prompt_id, user_id, body) values ($1, $2, 'hi')",
    [promptId, nour],
  ),
);

await asUser(
  db,
  rafa,
  "insert into public.couple_answers (prompt_id, user_id, body) values ($1, $2, $3)",
  [promptId, rafa, "That I could not stand camping."],
);

await expectRows(
  "once Rafa answers, BOTH answers become readable to him",
  asUser(db, rafa, "select body from public.couple_answers where prompt_id = $1", [promptId]),
  2,
);

await expectDenied(
  "you cannot propose a couple on somebody else's behalf",
  asUser(
    db,
    nour,
    `insert into public.couples (user_low, user_high, proposed_by, status)
                    values ($1, $2, $3, 'pending')`,
    [[ada, theo].sort()[0], [ada, theo].sort()[1], ada],
  ),
);

/* ========================================================================== */
section("games — server-authoritative state");

const { rows: sessionRows } = await asService(
  db,
  `insert into public.game_sessions (game_key, conversation_id, host_id, status)
   values ('trivia-night', $1, $2, 'active') returning id`,
  [conversationId, ada],
);
const sessionId = sessionRows[0].id;

await asService(
  db,
  "insert into public.game_players (session_id, user_id, seat) values ($1, $2, 0), ($1, $3, 1)",
  [sessionId, ada, rafa],
);

await expectRows(
  "a player can read the session",
  asUser(db, rafa, "select id from public.game_sessions where id = $1", [sessionId]),
  1,
);

await expectRows(
  "an outsider cannot read the session",
  asUser(db, nour, "select id from public.game_sessions where id = $1", [sessionId]),
  0,
);

await expectDenied(
  "a PLAYER cannot rewrite game state (no update policy at all)",
  asUser(
    db,
    rafa,
    `update public.game_sessions set state = '{"cheated":true}'::jsonb where id = $1`,
    [sessionId],
  ),
);

await expectDenied(
  "a player cannot award themselves points... via the session",
  asUser(db, rafa, "update public.game_sessions set state_version = 99 where id = $1", [sessionId]),
);

await expectDenied(
  "nobody can insert a game move through the API",
  asUser(
    db,
    rafa,
    `insert into public.game_moves (session_id, seq, player_id, payload)
                    values ($1, 0, $2, '{}'::jsonb)`,
    [sessionId, rafa],
  ),
);

await asService(
  db,
  `insert into public.game_moves (session_id, seq, player_id, payload)
                     values ($1, 0, $2, '{"answer":"b"}'::jsonb)`,
  [sessionId, ada],
);

await expectDenied(
  "game moves are append-only even for the service role",
  asService(db, "update public.game_moves set payload = '{}'::jsonb where session_id = $1", [
    sessionId,
  ]),
);

await expectDenied(
  "you cannot join a game you cannot see",
  asUser(
    db,
    nour,
    "insert into public.game_players (session_id, user_id, seat) values ($1, $2, 5)",
    [sessionId, nour],
  ),
);

await expectRows(
  "the catalogue is readable by everyone",
  asUser(db, nour, "select key from public.games"),
  5,
);

await expectDenied(
  "but nobody can enable a game from the client",
  asUser(db, nour, "update public.games set enabled = true where key = 'word-rush'"),
);

/* ========================================================================== */
section("notifications & audit");

await expectRows(
  "Rafa has the friend-request notifications addressed to him",
  asUser(db, rafa, "select id from public.notifications where user_id = $1", [rafa]),
  1,
);

await expectRows(
  "you cannot read somebody else's notifications",
  asUser(db, nour, "select id from public.notifications where user_id = $1", [rafa]),
  0,
);

await expectDenied(
  "you cannot inject a notification into somebody's feed",
  asUser(
    db,
    nour,
    `insert into public.notifications (user_id, kind, payload)
                    values ($1, 'system', '{"body":"click here"}'::jsonb)`,
    [rafa],
  ),
);

await asService(db, "insert into public.security_events (user_id, event) values ($1, 'sign_in')", [
  ada,
]);

await expectRows(
  "you can read your own security events",
  asUser(db, ada, "select id from public.security_events where user_id = $1", [ada]),
  1,
);

await expectRows(
  "you cannot read another person's security events",
  asUser(db, rafa, "select id from public.security_events where user_id = $1", [ada]),
  0,
);

await expectDenied(
  "security events cannot be deleted, even by the service role",
  asService(db, "delete from public.security_events where user_id = $1", [ada]),
);

/* ========================================================================== */
section("invites");

await asUser(
  db,
  ada,
  "insert into public.invite_codes (code_hash, created_by, note) values ($1, $2, 'for nour')",
  ["sha256-of-the-actual-code-which-is-never-stored", ada],
);

await expectRows(
  "you see the invites you issued",
  asUser(db, ada, "select id from public.invite_codes"),
  1,
);

await expectRows(
  "you cannot see invites issued by others",
  asUser(db, rafa, "select id from public.invite_codes"),
  0,
);

await expectDenied(
  "you cannot issue an invite in somebody else's name",
  asUser(db, rafa, "insert into public.invite_codes (code_hash, created_by) values ($1, $2)", [
    "another-hash",
    ada,
  ]),
);

/* ========================================================================== */
section("constraints");

await expectRejected(
  "friendships reject non-canonical ordering",
  asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
    [nour, theo].sort()[1],
    [nour, theo].sort()[0],
  ]),
  /friendships_canonical_order/,
);

await expectRejected(
  "a second pending request between the same pair is refused",
  asService(
    db,
    "insert into public.friend_requests (requester_id, addressee_id) values ($1, $2), ($2, $1)",
    [nour, theo],
  ),
  /friend_requests_pending_pair_key/,
);

await expectRejected(
  "a game session cannot belong to both a conversation and a couple",
  asService(
    db,
    `insert into public.game_sessions (game_key, conversation_id, couple_id, host_id)
     values ('trivia-night', $1, $2, $3)`,
    [conversationId, coupleId, ada],
  ),
  /game_sessions_one_scope/,
);

await expectRejected(
  "a person cannot be in two active couples",
  asService(
    db,
    `insert into public.couples (user_low, user_high, proposed_by, status)
     values ($1, $2, $3, 'active')`,
    [[ada, nour].sort()[0], [ada, nour].sort()[1], ada],
  ),
  /couples_one_active_violation/,
);

await expectRejected(
  "usernames are case-insensitively unique",
  asService(db, "update public.profiles set username = 'ADA' where id = $1", [rafa]),
  /profiles_username_lower_key/,
);

/* ========================================================================== */
section("schema hygiene — invariants, not spot checks");

/**
 * These assert properties of the WHOLE schema rather than of one table, so a
 * future migration that forgets RLS, forgets a policy, or writes a SECURITY
 * DEFINER function with a mutable search_path fails here instead of shipping.
 */

async function expectEmpty(name, sql, describe) {
  const { rows } = await asService(db, sql);
  if (rows.length === 0) ok(name);
  else bad(name, `${rows.length} offender(s): ${rows.map(describe).join(", ")}`);
}

await expectEmpty(
  "every public table has RLS enabled",
  `select c.relname from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
  (r) => r.relname,
);

await expectEmpty(
  "every public table has RLS FORCED (policies apply to the owner too)",
  `select c.relname from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity`,
  (r) => r.relname,
);

await expectEmpty(
  "no table has RLS on with zero policies (silent deny-all)",
  `select c.relname from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)`,
  (r) => r.relname,
);

// The privilege-escalation vector. A SECURITY DEFINER function runs as its
// owner; if its search_path is mutable, a caller can shadow an unqualified name
// with their own object and have it executed with the owner's rights.
await expectEmpty(
  "every SECURITY DEFINER function pins search_path",
  `select p.proname from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
        where cfg like 'search_path=%'
      )`,
  (r) => r.proname,
);

// An unindexed foreign key turns every parent delete into a sequential scan of
// the child, and is the usual cause of a cascade that mysteriously takes minutes.
await expectEmpty(
  "every foreign key is covered by an index",
  `select conrelid::regclass::text as tbl, conname
     from pg_constraint c
    where c.contype = 'f'
      and connamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.conrelid
          and (c.conkey::smallint[]) <@ (i.indkey::smallint[])
      )`,
  (r) => `${r.tbl}.${r.conname}`,
);

/* ========================================================================== */

await db.close();

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);

process.exit(failed === 0 ? 0 : 1);
