/**
 * Two-factor authentication.
 *
 * ── What this file can and cannot prove ──────────────────────────────────────
 *
 * TOTP itself belongs to Supabase Auth (GoTrue), which is a Go service and is
 * not running here. So nothing below calls `mfa.enroll` or `mfa.verify`, and any
 * test that claimed to would be a test of a mock.
 *
 * What IS here is the part that is ours, and it happens to be the part that
 * matters most:
 *
 *   THE DATABASE GATE (§4-§6). Migration 0024 puts a restrictive policy on every
 *   table requiring `aal2` from anybody with a verified factor. That is the only
 *   layer that stops a stolen password from being enough — a password login
 *   produces a real, working access token BEFORE any code is entered, and that
 *   token can be pointed at PostgREST directly, where no redirect exists. It is
 *   tested against the real policies, as the real `authenticated` role, with the
 *   real `aal` claim, which is exactly what Supabase sets.
 *
 *   THE STATE MACHINE (§1). Three layers ask "does this session owe a factor"
 *   and must not disagree. Pure, so the awkward cases — mid-enrolment above all
 *   — can be asserted without a server.
 *
 *   THE ROUTING (§2). Including the one that is easy to miss: a password-reset
 *   link must not be a way around the second factor.
 *
 *   THE ALGORITHM (§3). RFC 6238 against the published test vectors, so the
 *   parameters this app tells people to expect — six digits, thirty seconds,
 *   SHA-1 — are the ones an authenticator app actually produces.
 *
 * The seven scenarios from the brief are walked end to end in §5, against a
 * model of GoTrue's contract: a correct code raises the session's `aal` claim, a
 * wrong one does not. Everything downstream of that claim is the real thing.
 * What is NOT proved here is GoTrue's own verifier; docs/MFA.md carries the
 * two-browser checklist for that.
 *
 *     npm run mfa:test
 */

import { createHmac } from "node:crypto";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, asUserAtAal, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const { canPerformSensitiveAction, deriveMfaState, MAX_FACTORS, totpCodeSchema } =
  await import("../../src/features/auth/mfa.ts");
const { decideRedirect, safeRedirect, MFA_CHALLENGE_ROUTE, DEFAULT_SIGNED_IN_ROUTE } =
  await import("../../src/features/auth/redirects.ts");

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

console.log("KITH — two-factor authentication\n");

/* ==========================================================================
 * 1 · The state machine
 * ========================================================================== */

section("Deriving the state");

const factor = (over = {}) => ({
  id: "f1",
  friendlyName: "Authenticator",
  status: "verified",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

{
  const none = deriveMfaState({ factors: [], currentLevel: "aal1" });
  falsy("nobody enrolled means two-factor is off", none.enabled);
  eq("and aal1 is all that is required", none.requiredLevel, "aal1");
  falsy("so nothing is owed", none.challengeRequired);
  truthy("and a sensitive action may proceed", canPerformSensitiveAction(none));
  truthy("with room to enrol", none.canEnroll);
}

{
  /*
   * The lockout trap.
   *
   * Enrolling creates a factor BEFORE the first code is entered. If an
   * unverified factor counted as enrolled, opening the setup screen would
   * demand aal2 from a session that has no way to reach it, and the account
   * would be locked halfway through being protected.
   */
  const midEnrolment = deriveMfaState({
    factors: [factor({ status: "unverified" })],
    currentLevel: "aal1",
  });

  falsy("an unverified factor is not two-factor", midEnrolment.enabled);
  falsy("and does not lock the account mid-enrolment", midEnrolment.challengeRequired);
  eq("it is not listed as a factor", midEnrolment.factors, []);
  truthy(
    "but it does occupy a slot",
    deriveMfaState({
      factors: Array.from({ length: MAX_FACTORS }, (_, i) =>
        factor({ id: `f${i}`, status: "unverified" }),
      ),
      currentLevel: "aal1",
    }).canEnroll === false,
  );
}

{
  const owing = deriveMfaState({ factors: [factor()], currentLevel: "aal1" });
  truthy("a verified factor means two-factor is on", owing.enabled);
  eq("aal2 becomes the bar", owing.requiredLevel, "aal2");
  truthy("and a password-only session owes a code", owing.challengeRequired);
  falsy("so no sensitive action may proceed", canPerformSensitiveAction(owing));

  const met = deriveMfaState({ factors: [factor()], currentLevel: "aal2" });
  falsy("a session that produced one owes nothing", met.challengeRequired);
  truthy("and may change the account's security", canPerformSensitiveAction(met));
}

{
  const missing = deriveMfaState({ factors: [factor()], currentLevel: null });
  eq("an absent aal claim reads as aal1, never aal2", missing.currentLevel, "aal1");
  truthy("so a token with no claim is challenged", missing.challengeRequired);

  const nonsense = deriveMfaState({ factors: [factor()], currentLevel: "aal3" });
  eq("and so does anything that is not exactly aal2", nonsense.currentLevel, "aal1");
}

{
  // Just disabled: no factor left, but the session is still strong. Above the
  // bar rather than below it.
  const after = deriveMfaState({ factors: [], currentLevel: "aal2" });
  falsy("removing the last factor owes nothing", after.challengeRequired);
  eq("and drops the requirement", after.requiredLevel, "aal1");
}

{
  const two = deriveMfaState({
    factors: [factor({ id: "a" }), factor({ id: "b" }), factor({ id: "c", status: "unverified" })],
    currentLevel: "aal2",
  });
  eq("only verified factors are listed", two.factors.length, 2);
  eq(
    "in the order given",
    two.factors.map((f) => f.id),
    ["a", "b"],
  );
}

/* -------------------------------------------------------------------------- */

section("Reading a typed code");

{
  const good = (input) => totpCodeSchema.safeParse(input);

  eq("six digits", good("123456").data, "123456");
  eq("the space an authenticator app shows", good("123 456").data, "123456");
  eq("a pasted newline", good("123456\n").data, "123456");
  eq("leading and trailing space", good("  123456  ").data, "123456");
  eq("a non-breaking space", good("123 456").data, "123456");
  eq("a hyphen somebody typed", good("123-456").data, "123456");
  eq("leading zeros survive", good("000042").data, "000042");

  falsy("five digits is not enough", good("12345").success);
  falsy("seven is too many", good("1234567").success);
  falsy("letters are not digits", good("abcdef").success);
  falsy("empty", good("").success);
  falsy("a word", good("please").success);
}

/* ==========================================================================
 * 2 · Where a half-authenticated session may go
 * ========================================================================== */

section("Routing");

const owing = (pathname, over = {}) =>
  decideRedirect({
    pathname,
    userId: "u1",
    emailVerified: true,
    mfaChallengeRequired: true,
    ...over,
  });

const settled = (pathname, over = {}) =>
  decideRedirect({
    pathname,
    userId: "u1",
    emailVerified: true,
    mfaChallengeRequired: false,
    ...over,
  });

{
  eq("the challenge route is where it says it is", MFA_CHALLENGE_ROUTE, "/verify-2fa");

  eq("a protected route sends you to the challenge", owing("/messages")?.reason, "mfa_required");
  eq("carrying where you were going", owing("/messages")?.to, "/verify-2fa?next=%2Fmessages");
  eq("and a nested one", owing("/games/abc")?.to, "/verify-2fa?next=%2Fgames%2Fabc");
  eq("settings included", owing("/settings/security")?.reason, "mfa_required");

  eq("so does /login, so the challenge cannot be dodged", owing("/login")?.reason, "mfa_required");
  eq("and /signup", owing("/signup")?.reason, "mfa_required");
  eq("and /verify-email", owing("/verify-email")?.to, "/verify-2fa");

  eq("the challenge itself is allowed through", owing("/verify-2fa"), null);
  eq("the public landing page is left alone", owing("/"), null);
}

{
  /*
   * The hole this closes.
   *
   * Without it: request a password reset, read the email, set a new password,
   * sign in. The second factor is never asked for, and it turns out to protect
   * nothing that access to the inbox did not already unlock.
   */
  eq(
    "a recovery session must clear the factor before setting a password",
    owing("/reset-password", { isRecovery: true })?.to,
    "/verify-2fa",
  );
  eq(
    "for the right reason",
    owing("/reset-password", { isRecovery: true })?.reason,
    "mfa_required",
  );
  eq(
    "and once cleared, the reset page opens",
    settled("/reset-password", { isRecovery: true }),
    null,
  );
}

{
  eq(
    "nothing owed means the challenge is a dead end",
    settled("/verify-2fa")?.reason,
    "already_authenticated",
  );
  // Home is the app, not the marketing page — see redirects.ts.
  eq("so it sends you home", settled("/verify-2fa")?.to, DEFAULT_SIGNED_IN_ROUTE);

  eq(
    "and signed out, it sends you to sign in",
    decideRedirect({
      pathname: "/verify-2fa",
      userId: null,
      emailVerified: false,
      mfaChallengeRequired: false,
    })?.reason,
    "unauthenticated",
  );
}

{
  // Nothing about the old rules moved.
  eq(
    "a signed-out visitor to a protected route still goes to login",
    decideRedirect({ pathname: "/messages", userId: null, emailVerified: false })?.to,
    "/login?next=%2Fmessages",
  );
  eq(
    "an unverified email is still held",
    decideRedirect({ pathname: "/messages", userId: "u1", emailVerified: false })?.reason,
    "email_unverified",
  );
  eq("a settled session browses freely", settled("/messages"), null);
  eq("and is bounced off the auth pages", settled("/login")?.reason, "already_authenticated");
}

{
  eq("the challenge is not a place to be sent afterwards", safeRedirect("/verify-2fa"), null);
  eq("nor an auth page", safeRedirect("/login"), null);
  eq("nor another origin", safeRedirect("//evil.example"), null);
  eq("but an ordinary path is fine", safeRedirect("/messages"), "/messages");
}

/* ==========================================================================
 * 3 · RFC 6238, so "correct code" means something
 * ========================================================================== */

section("TOTP");

/**
 * The algorithm every authenticator app implements, in twelve lines.
 *
 * Here to give the database scenarios below a real notion of a correct code
 * rather than a string called "correct", and to pin the parameters this app
 * promises: six digits, a thirty-second step, SHA-1. It is NOT used by the
 * application — KITH neither generates nor checks codes.
 */
function totp(secretBytes, counter, digits = 6, algorithm = "sha1") {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, secretBytes).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

const codeAt = (secret, unixSeconds) => totp(Buffer.from(secret), Math.floor(unixSeconds / 30));

{
  // RFC 6238, Appendix B. The SHA-1 rows, truncated to the six digits every
  // authenticator app shows.
  const RFC_SECRET = Buffer.from("12345678901234567890");
  const vectors = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  for (const [time, expected] of vectors) {
    eq(`RFC 6238 vector at T=${time}`, totp(RFC_SECRET, Math.floor(time / 30)), expected);
  }

  const secret = "kith-test-secret-0001";
  const now = 1_800_000_000;

  eq("the same step gives the same code", codeAt(secret, now), codeAt(secret, now + 29));
  truthy("the next step gives a different one", codeAt(secret, now) !== codeAt(secret, now + 30));
  truthy(
    "and a different secret gives a different one",
    codeAt(secret, now) !== codeAt("kith-test-secret-0002", now),
  );
  eq("codes are six digits", codeAt(secret, now).length, 6);
  truthy("and digits only", /^\d{6}$/.test(codeAt(secret, now)));
}

/* ==========================================================================
 * 4 · The gate, against real policies
 * ========================================================================== */

section("The database gate");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");

await asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
  ada < rafa ? ada : rafa,
  ada < rafa ? rafa : ada,
]);

/** Enrols a factor the way GoTrue does. Unverified until a code is accepted. */
async function enroll(userId, { secret, verified = false, name = "Phone" } = {}) {
  const { rows } = await asService(
    db,
    `insert into auth.mfa_factors (user_id, friendly_name, factor_type, status, secret)
     values ($1, $2, 'totp', $3, $4)
     returning id`,
    [userId, name, verified ? "verified" : "unverified", secret ?? "s"],
  );
  return rows[0].id;
}

{
  // Nothing enrolled: aal1 is a full session, exactly as before this feature.
  const { rows } = await asUser(db, ada, "select id from public.profiles where id = $1", [ada]);
  eq("without a factor, an ordinary session reads normally", rows.length, 1);

  const { rows: satisfied } = await asUser(db, ada, "select public.mfa_satisfied() as yes");
  eq("and the gate says so", satisfied[0].yes, true);
}

{
  // Mid-enrolment. The account is not protected yet and must not behave as if
  // it is, or the setup screen locks the person out of finishing setup.
  const pending = await enroll(ada, { verified: false });

  const { rows } = await asUser(db, ada, "select public.mfa_satisfied() as yes");
  eq("an unverified factor does not raise the bar", rows[0].yes, true);

  const { rows: readable } = await asUser(db, ada, "select id from public.profiles where id = $1", [
    ada,
  ]);
  eq("so the app still works during setup", readable.length, 1);

  await asService(db, "delete from auth.mfa_factors where id = $1", [pending]);
}

/* ==========================================================================
 * 5 · The seven scenarios from the brief
 * ========================================================================== */

section("End to end");

/*
 * Modelling GoTrue's contract, and only its contract.
 *
 * `signIn` produces a session at aal1. `challenge` accepts a code and returns
 * the level the session is now at: aal2 for a correct one, unchanged for a wrong
 * one. That is the entire interface between Supabase Auth and this application —
 * everything downstream of the `aal` claim is the real policy, evaluated by real
 * Postgres as the real `authenticated` role.
 */
const SECRET = "ada-authenticator-secret";
const NOW = 1_800_000_000;

function signIn() {
  return { aal: "aal1" };
}

function challenge(session, code, { secret = SECRET, at = NOW } = {}) {
  if (code === codeAt(secret, at)) {
    session.aal = "aal2";
    return true;
  }
  return false;
}

const asSession = (userId, session, sql, params) =>
  asUserAtAal(db, userId, session.aal, sql, params);

let adaFactor;

{
  /* --- 1 · Enable MFA ---------------------------------------------------- */
  adaFactor = await enroll(ada, { secret: SECRET, verified: true, name: "Ada's phone" });

  const { rows } = await asUserAtAal(db, ada, "aal2", "select public.mfa_satisfied() as yes");
  eq("1 · enabling leaves the enrolling session working", rows[0].yes, true);

  const { rows: profile } = await asUserAtAal(
    db,
    ada,
    "aal2",
    "select id from public.profiles where id = $1",
    [ada],
  );
  eq("    and it can still read", profile.length, 1);
}

{
  /* --- 2 · Log out, 3 · Log in ------------------------------------------- */
  const session = signIn();
  eq("2-3 · signing back in starts at aal1", session.aal, "aal1");

  /* --- 4 · The challenge is owed ----------------------------------------- */
  const state = deriveMfaState({
    factors: [factor({ id: adaFactor })],
    currentLevel: session.aal,
  });
  truthy("4 · the app knows a code is owed", state.challengeRequired);
  eq(
    "    and routing holds the session at the challenge",
    owing("/messages")?.to,
    "/verify-2fa?next=%2Fmessages",
  );

  /*
   * The point of the whole migration.
   *
   * This session is real. Its access token works. A browser would be looking at
   * the challenge screen, but nothing stops the token being pointed straight at
   * PostgREST — so the answer has to come from the database, and it does.
   */
  const { rows } = await asSession(ada, session, "select public.mfa_satisfied() as yes");
  eq("    the gate refuses the password-only session", rows[0].yes, false);

  await denied(
    "    it cannot read its own profile",
    asSession(ada, session, "select id from public.profiles where id = $1", [ada]),
  );
  await denied("    nor its friends", asSession(ada, session, "select * from public.friendships"));
  await denied("    nor its messages", asSession(ada, session, "select * from public.messages"));
  await denied(
    "    nor its own security log",
    asSession(ada, session, "select * from public.security_events"),
  );

  /* --- 6 · An incorrect code (checked before the correct one) ------------ */
  falsy("6 · a wrong code is rejected", challenge(session, "000000"));
  eq("    and the session stays at aal1", session.aal, "aal1");

  falsy(
    "    a code from the right app but the wrong minute is rejected",
    challenge(session, codeAt(SECRET, NOW - 120)),
  );
  falsy(
    "    and a code from a different secret",
    challenge(session, codeAt("somebody-elses-secret", NOW)),
  );
  eq("    still aal1", session.aal, "aal1");

  const { rows: still } = await asSession(ada, session, "select public.mfa_satisfied() as yes");
  eq("    so the gate still refuses", still[0].yes, false);
  await denied(
    "    and there is still nothing to read",
    asSession(ada, session, "select id from public.profiles where id = $1", [ada]),
  );

  /* --- 5 · The correct code ---------------------------------------------- */
  truthy("5 · the current code is accepted", challenge(session, codeAt(SECRET, NOW)));
  eq("    and the session becomes aal2", session.aal, "aal2");

  const { rows: passed2 } = await asSession(ada, session, "select public.mfa_satisfied() as yes");
  eq("    the gate opens", passed2[0].yes, true);

  const { rows: profile } = await asSession(
    ada,
    session,
    "select id from public.profiles where id = $1",
    [ada],
  );
  eq("    and the account is readable again", profile.length, 1);
}

{
  /* --- 7 · Disable MFA ---------------------------------------------------- */
  await asService(db, "delete from auth.mfa_factors where id = $1", [adaFactor]);

  const { rows } = await asUser(db, ada, "select public.mfa_satisfied() as yes");
  eq("7 · with the factor gone, aal1 is enough again", rows[0].yes, true);

  const { rows: profile } = await asUser(db, ada, "select id from public.profiles where id = $1", [
    ada,
  ]);
  eq("    and an ordinary session reads normally", profile.length, 1);
}

/* ==========================================================================
 * 6 · The edges of the gate
 * ========================================================================== */

section("The edges");

{
  const enrolled = await enroll(ada, { secret: SECRET, verified: true });

  // Writes, not just reads. A restrictive policy that only covered SELECT would
  // let a half-authenticated session send messages and leave the room.
  await denied(
    "an aal1 session cannot write either",
    asUser(db, ada, "update public.profiles set display_name = 'x' where id = $1", [ada]),
  );
  await denied(
    "nor insert",
    asUser(
      db,
      ada,
      "insert into public.security_events (user_id, event) values ($1, 'mfa.enabled')",
      [ada],
    ),
  );
  await denied(
    "nor delete",
    asUser(db, ada, "delete from public.friendships where user_low = $1", [ada]),
  );

  // One person's factor is one person's problem.
  const { rows: other } = await asUser(db, rafa, "select public.mfa_satisfied() as yes");
  eq("somebody else's enrolment does not gate you", other[0].yes, true);

  const { rows: rafaProfile } = await asUser(
    db,
    rafa,
    "select id from public.profiles where id = $1",
    [rafa],
  );
  eq("and they carry on unaffected", rafaProfile.length, 1);

  // The service role has no session and therefore no factor. The game runtime,
  // the signup path and the audit writer all depend on this.
  const { rows: admin } = await asService(db, "select count(*)::int as n from public.profiles");
  truthy("the service role is never gated", admin[0].n >= 2);

  await asService(db, "delete from auth.mfa_factors where id = $1", [enrolled]);
}

{
  // Every table, not a sample. This is the invariant that keeps the gate honest
  // as the schema grows, asserted here against behaviour rather than catalogue.
  const factorId = await enroll(ada, { secret: SECRET, verified: true });

  const { rows: tables } = await asService(
    db,
    `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`,
  );

  const leaked = [];
  /*
   * Tables that DO return rows once the factor is met.
   *
   * Counted because without it this loop is vacuous: an empty table returns
   * nothing to a gated session and nothing to a satisfied one, and a gate that
   * had been forgotten on every table would still pass. What proves the gate is
   * a table that goes from readable to not.
   */
  const proven = [];

  for (const { relname } of tables) {
    const count = async (level) => {
      try {
        const { rows } = await asUserAtAal(
          db,
          ada,
          level,
          `select count(*)::int as n from public.${relname}`,
        );
        return rows[0]?.n ?? 0;
      } catch {
        // A raise is a refusal too.
        return 0;
      }
    };

    // A gated table returns zero rows to a SELECT rather than raising — correct
    // RLS behaviour, and why this counts rather than catches.
    if ((await count("aal1")) > 0) leaked.push(relname);
    if ((await count("aal2")) > 0) proven.push(relname);
  }

  eq(`all ${tables.length} tables refuse a half-authenticated session`, leaked, []);
  truthy(
    `and ${proven.length} of them hand rows to a satisfied one, so that means something`,
    proven.length >= 3,
    `only ${proven.length} table(s) had readable rows: ${proven.join(", ")}`,
  );

  await asService(db, "delete from auth.mfa_factors where id = $1", [factorId]);
}

/* ==========================================================================
 * 7 · The audit trail
 * ========================================================================== */

section("The security log");

{
  await asService(
    db,
    `insert into public.security_events (user_id, event, metadata)
     values ($1, 'mfa.enabled', '{"factorId":"f1"}'::jsonb),
            ($1, 'mfa.challenge_failed', '{"stage":"sign_in"}'::jsonb)`,
    [ada],
  );

  const { rows } = await asUser(
    db,
    ada,
    "select event from public.security_events where user_id = $1 order by created_at",
    [ada],
  );
  eq("you can read your own security history", rows.length, 2);
  eq(
    "including a rejected code, which is the one worth seeing",
    rows.some((r) => r.event === "mfa.challenge_failed"),
    true,
  );

  await denied(
    "nobody else can read it",
    asUser(db, rafa, "select * from public.security_events where user_id = $1", [ada]),
  );

  // The value of this table is that its contents were put there by the server.
  await denied(
    "and you cannot write your own entries",
    asUser(
      db,
      ada,
      "insert into public.security_events (user_id, event) values ($1, 'mfa.enabled')",
      [ada],
    ),
  );

  await denied(
    "nor tidy away one you do not like",
    asService(db, "delete from public.security_events where user_id = $1", [ada]),
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
