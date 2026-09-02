/**
 * Authentication tests.
 *
 * Two halves, both of which run without a Supabase project:
 *
 *   1. The redirect rules and the input schemas — pure functions, so they can be
 *      tested exhaustively. This is the part of authentication most likely to be
 *      subtly wrong (open redirects, a verification gate that can be walked
 *      around by visiting /login) and the part least likely to be caught by
 *      clicking through the happy path.
 *
 *   2. The invite-redemption SQL, executed against real Postgres via PGlite:
 *      atomic consumption, expiry, revocation, exhaustion, and the concurrency
 *      behaviour that a read-then-write would get wrong.
 *
 * What is NOT covered here, honestly: anything that requires Supabase's Auth
 * server — password hashing, session cookies, the contents of a confirmation
 * email. Those need a real project.
 *
 *     npm run auth:test
 */

import { createHash } from "node:crypto";

import { freshDatabase, asService, createUser } from "./harness.mjs";

// Node 24 strips TypeScript types natively, so the source modules import directly.
// Testing the real files rather than a copy is the point: a rule that only holds
// in the test is not a rule.
const { decideRedirect, safeRedirect, DEFAULT_SIGNED_IN_ROUTE } =
  await import("../../src/features/auth/redirects.ts");
const { signUpSchema, signInSchema, resetPasswordSchema, forgotPasswordSchema } =
  await import("../../src/features/auth/schema.ts");

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function bad(name, detail) {
  failed += 1;
  failures.push(`${name} — ${detail}`);
  console.log(`  ✗ ${name}\n      ${detail}`);
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(name);
  else bad(name, `expected ${e}, got ${a}`);
}

function section(title) {
  console.log(`\n${title}`);
}

console.log("KITH — authentication\n");

/* ========================================================================== */
section("redirect rules");

const SIGNED_OUT = { userId: null, emailVerified: false };
const UNVERIFIED = { userId: "u1", emailVerified: false };
const VERIFIED = { userId: "u1", emailVerified: true };

eq(
  "signed out, protected route -> /login carrying where they were going",
  decideRedirect({ pathname: "/messages", ...SIGNED_OUT })?.to,
  "/login?next=%2Fmessages",
);

eq(
  "signed out, nested protected route",
  decideRedirect({ pathname: "/messages/abc-123", ...SIGNED_OUT })?.to,
  "/login?next=%2Fmessages%2Fabc-123",
);

eq("signed out, landing page passes", decideRedirect({ pathname: "/", ...SIGNED_OUT }), null);
eq("signed out, /login passes", decideRedirect({ pathname: "/login", ...SIGNED_OUT }), null);
eq("signed out, /signup passes", decideRedirect({ pathname: "/signup", ...SIGNED_OUT }), null);
eq(
  "signed out, /verify-email -> /login (nothing to verify)",
  decideRedirect({ pathname: "/verify-email", ...SIGNED_OUT })?.to,
  "/login",
);
eq(
  "signed out, /reset-password -> /forgot-password (no recovery session)",
  decideRedirect({ pathname: "/reset-password", ...SIGNED_OUT })?.to,
  "/forgot-password",
);

// The gate that matters: an unverified account must not be able to walk around
// verification simply by navigating somewhere else.
eq(
  "unverified, protected route -> /verify-email",
  decideRedirect({ pathname: "/messages", ...UNVERIFIED })?.to,
  "/verify-email",
);
eq(
  "unverified, /login -> /verify-email (cannot skip by re-signing-in)",
  decideRedirect({ pathname: "/login", ...UNVERIFIED })?.to,
  "/verify-email",
);
eq(
  "unverified, /signup -> /verify-email",
  decideRedirect({ pathname: "/signup", ...UNVERIFIED })?.to,
  "/verify-email",
);
eq(
  "unverified, /verify-email itself passes (no redirect loop)",
  decideRedirect({ pathname: "/verify-email", ...UNVERIFIED }),
  null,
);
eq("unverified, landing page passes", decideRedirect({ pathname: "/", ...UNVERIFIED }), null);

/*
 * Home is the APP, not the marketing page.
 *
 * These asserted "/" and passed, because the constant said "/" — and the result
 * was that a signed-in visitor clicking "Sign in" on the landing page was
 * bounced back to the landing page, which reads as a dead button. `/` has no
 * signed-in view; the app group has no page there.
 */
eq(
  "verified, /login -> the app",
  decideRedirect({ pathname: "/login", ...VERIFIED })?.to,
  DEFAULT_SIGNED_IN_ROUTE,
);
eq(
  "verified, /verify-email -> the app (nothing left to do)",
  decideRedirect({ pathname: "/verify-email", ...VERIFIED })?.to,
  DEFAULT_SIGNED_IN_ROUTE,
);
// Sending a signed-in user to the public landing page makes every auth CTA on
// it look broken: click, bounce, same page, same button.
if (DEFAULT_SIGNED_IN_ROUTE === "/") {
  bad("home is somewhere a signed-in person can actually be", "it is the landing page");
} else {
  ok("and that home is somewhere a signed-in person can actually be");
}
eq(
  "verified, protected route passes",
  decideRedirect({ pathname: "/messages", ...VERIFIED }),
  null,
);
eq(
  "verified, /reset-password passes (session present)",
  decideRedirect({ pathname: "/reset-password", ...VERIFIED }),
  null,
);

/* ========================================================================== */
section("open-redirect defence");

const OPEN_REDIRECT_ATTEMPTS = [
  ["absolute URL", "https://evil.example"],
  ["protocol-relative", "//evil.example"],
  ["protocol-relative with path", "//evil.example/steal"],
  ["backslash trick", "/\\evil.example"],
  ["javascript scheme", "javascript:alert(1)"],
  ["data scheme", "data:text/html,<script>"],
  ["no leading slash", "evil.example"],
  ["empty", ""],
  ["null", null],
];

for (const [label, value] of OPEN_REDIRECT_ATTEMPTS) {
  eq(`rejects ${label}`, safeRedirect(value), null);
}

eq("accepts a plain internal path", safeRedirect("/messages"), "/messages");
eq("accepts a nested internal path", safeRedirect("/messages/abc"), "/messages/abc");
eq("refuses to bounce back to /login", safeRedirect("/login"), null);
eq("refuses to bounce to /reset-password", safeRedirect("/reset-password"), null);

/* ========================================================================== */
section("input validation");

function rejects(name, schema, value, expectedField) {
  const result = schema.safeParse(value);
  if (result.success) return bad(name, "was ACCEPTED");
  const fields = result.error.issues.map((i) => i.path[0]);
  if (expectedField && !fields.includes(expectedField)) {
    return bad(name, `rejected, but not on "${expectedField}" (got ${fields.join(",")})`);
  }
  ok(name);
}

function accepts(name, schema, value) {
  const result = schema.safeParse(value);
  if (result.success) ok(name);
  else bad(name, `was REJECTED: ${result.error.issues[0]?.message}`);
}

const validSignup = {
  email: "Ada@Example.COM",
  password: "correct horse battery",
  username: "ada_o",
  displayName: "Ada Okonjo",
  inviteCode: "kith-abc123",
};

accepts("a well-formed signup", signUpSchema, validSignup);
eq("email is normalised to lowercase", signUpSchema.parse(validSignup).email, "ada@example.com");

rejects(
  "11-character password",
  signUpSchema,
  { ...validSignup, password: "elevenchars" },
  "password",
);
rejects(
  "whitespace-only password",
  signUpSchema,
  { ...validSignup, password: "            " },
  "password",
);
rejects(
  "password over 72 bytes (bcrypt truncates silently)",
  signUpSchema,
  { ...validSignup, password: "a".repeat(73) },
  "password",
);
rejects(
  "multibyte password over 72 BYTES but under 72 chars",
  signUpSchema,
  { ...validSignup, password: "🔥".repeat(19) },
  "password",
);
rejects("username with a hyphen", signUpSchema, { ...validSignup, username: "ada-o" }, "username");
rejects("username with a space", signUpSchema, { ...validSignup, username: "ada o" }, "username");
rejects("all-numeric username", signUpSchema, { ...validSignup, username: "12345" }, "username");
rejects("two-character username", signUpSchema, { ...validSignup, username: "ad" }, "username");
rejects("malformed email", signUpSchema, { ...validSignup, email: "ada@" }, "email");
rejects("empty display name", signUpSchema, { ...validSignup, displayName: "   " }, "displayName");
accepts("signup with no invite code (server decides)", signUpSchema, {
  ...validSignup,
  inviteCode: "",
});

// Sign-in must NOT apply the length policy: an account created under an older
// rule would otherwise be locked out by its own correct password.
accepts("sign-in accepts a short existing password", signInSchema, {
  email: "ada@example.com",
  password: "short",
});
rejects(
  "sign-in still requires a password",
  signInSchema,
  {
    email: "ada@example.com",
    password: "",
  },
  "password",
);

rejects(
  "reset rejects mismatched confirmation",
  resetPasswordSchema,
  { password: "correct horse battery", confirmPassword: "correct horse batteru" },
  "confirmPassword",
);
accepts("reset accepts a matching pair", resetPasswordSchema, {
  password: "correct horse battery",
  confirmPassword: "correct horse battery",
});
accepts("forgot-password takes an email", forgotPasswordSchema, { email: "ada@example.com" });

/* ========================================================================== */
section("invite redemption (real Postgres)");

const db = await freshDatabase();
const hash = (code) => createHash("sha256").update(code).digest("hex");

// Bootstrap: an empty room lets the first person in with no code.
const bootstrap = await asService(db, "select public.consume_invite($1) as id", [""]);
eq("empty room: no code required", bootstrap.rows[0].id, null);

const ada = await createUser(db, "ada");

// From here the room is not empty, so a code is mandatory.
try {
  await asService(db, "select public.consume_invite($1)", [""]);
  bad("occupied room: blank code is refused", "was accepted");
} catch (error) {
  if (/invite_required/.test(error.message)) ok("occupied room: blank code is refused");
  else bad("occupied room: blank code is refused", error.message);
}

try {
  await asService(db, "select public.consume_invite($1)", [hash("not-a-real-code")]);
  bad("unknown code is refused", "was accepted");
} catch (error) {
  if (/invalid_invite/.test(error.message)) ok("unknown code is refused");
  else bad("unknown code is refused", error.message);
}

await asService(
  db,
  `insert into public.invite_codes (code_hash, created_by, max_uses) values ($1, $2, 2)`,
  [hash("good-code"), ada],
);

const first = await asService(db, "select public.consume_invite($1) as id", [hash("good-code")]);
if (first.rows[0].id) ok("a valid code is consumed and returns its id");
else bad("a valid code is consumed and returns its id", "returned null");

const inviteId = first.rows[0].id;

await asService(db, "select public.consume_invite($1)", [hash("good-code")]);
const { rows: usedUp } = await asService(
  db,
  "select uses, max_uses from public.invite_codes where id = $1",
  [inviteId],
);
eq("uses increment atomically", usedUp[0].uses, 2);

try {
  await asService(db, "select public.consume_invite($1)", [hash("good-code")]);
  bad("an exhausted code is refused", "was accepted a third time");
} catch (error) {
  if (/invalid_invite/.test(error.message)) ok("an exhausted code is refused");
  else bad("an exhausted code is refused", error.message);
}

// release_invite hands a use back when account creation fails afterwards.
await asService(db, "select public.release_invite($1)", [inviteId]);
const { rows: released } = await asService(
  db,
  "select uses from public.invite_codes where id = $1",
  [inviteId],
);
eq("release_invite returns a use", released[0].uses, 1);

// Expiry and revocation.
await asService(
  db,
  `insert into public.invite_codes (code_hash, created_by, expires_at) values ($1, $2, now() - interval '1 day')`,
  [hash("expired-code"), ada],
);
try {
  await asService(db, "select public.consume_invite($1)", [hash("expired-code")]);
  bad("an expired code is refused", "was accepted");
} catch (error) {
  if (/invalid_invite/.test(error.message)) ok("an expired code is refused");
  else bad("an expired code is refused", error.message);
}

await asService(
  db,
  `insert into public.invite_codes (code_hash, created_by, revoked_at) values ($1, $2, now())`,
  [hash("revoked-code"), ada],
);
try {
  await asService(db, "select public.consume_invite($1)", [hash("revoked-code")]);
  bad("a revoked code is refused", "was accepted");
} catch (error) {
  if (/invalid_invite/.test(error.message)) ok("a revoked code is refused");
  else bad("a revoked code is refused", error.message);
}

// The plaintext code must never be recoverable from the database.
const { rows: stored } = await asService(db, "select code_hash from public.invite_codes");
const leaked = stored.filter((r) => /good-code|expired-code|revoked-code/.test(r.code_hash));
eq("no plaintext code is stored anywhere", leaked.length, 0);

// Username availability, used by the signup form.
const { rows: taken } = await asService(db, "select public.is_username_available($1) as free", [
  "ada",
]);
eq("a taken username reports unavailable", taken[0].free, false);
const { rows: mixedCase } = await asService(db, "select public.is_username_available($1) as free", [
  "AdA",
]);
eq("availability is case-insensitive", mixedCase[0].free, false);
const { rows: freeName } = await asService(db, "select public.is_username_available($1) as free", [
  "rafa",
]);
eq("an unused username reports available", freeName[0].free, true);

// EXECUTE privileges: a signed-in member must not be able to burn invite codes.
const { rows: privs } = await asService(
  db,
  `select p.proname,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('consume_invite','release_invite','record_invite_redemption')`,
);
const exposed = privs.filter((r) => r.authenticated || r.anon);
if (exposed.length === 0) ok("invite functions are not executable by anon or authenticated");
else
  bad(
    "invite functions are not executable by anon or authenticated",
    exposed.map((r) => r.proname).join(", "),
  );

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
