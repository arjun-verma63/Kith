/**
 * Authentication as flows, not as units.
 *
 * `auth.test.mjs` already covers the two things that can be tested as pure
 * functions: the redirect rules and the input schemas. It says so honestly at
 * the top — "what is NOT covered here: anything that requires Supabase's Auth
 * server". That gap is this file.
 *
 * The six server actions in `src/features/auth/actions.ts` are the front door to
 * the entire application and had no tests at all, for a boring reason: importing
 * the module threw. A server action imports `next/navigation`, whose `redirect`
 * throws by design, and two Supabase clients that need a request and a key.
 *
 * `action-loader.mjs` substitutes exactly those three and nothing else, so what
 * runs below is the real shipped file — the real schemas, the real invite
 * hashing, the real ordering, the real sentences. The doubles record their
 * arguments, which is what makes it possible to assert that a password reset
 * signs other devices out, rather than asserting that the source contains the
 * word "signOut".
 *
 * What is still NOT covered, and cannot be from here: whether Supabase's Auth
 * server hashes a password correctly, what an email actually contains, and
 * whether a cookie survives a round trip. Those need a project, and they are in
 * the manual checklist instead — see docs/MANUAL-TESTING.md.
 *
 *     npm run auth-flows:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Read at module scope by `@/lib/env/client`, so it has to be set before the
// action module is imported rather than inside a test.
process.env.NEXT_PUBLIC_SITE_URL = "https://kith.test";

register(pathToFileURL(join(process.cwd(), "supabase/tests/action-loader.mjs")).href);

const { script, calls, callsTo, called, run, form } = await import("./stubs/registry.mjs");

const {
  signUpAction,
  signInAction,
  signOutAction,
  forgotPasswordAction,
  resetPasswordAction,
  resendVerificationAction,
} = await import("../../src/features/auth/actions.ts");

const { decideRedirect, safeRedirect } = await import("../../src/features/auth/redirects.ts");

let passed = 0;
let failed = 0;
const failures = [];

const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const bad = (name, detail) => {
  failed += 1;
  failures.push(`${name} — ${detail}`);
  console.log(`  ✗ ${name}\n      ${detail}`);
};

const eq = (name, actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected)
    ? ok(name)
    : bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const truthy = (name, value, detail = "expected a truthy value") =>
  value ? ok(name) : bad(name, detail);

const section = (title) => console.log(`\n${title}`);

const GOOD_SIGNUP = {
  email: "ada@example.test",
  password: "correct horse battery staple",
  username: "ada",
  displayName: "Ada",
  inviteCode: "LETMEIN",
};

console.log("KITH — authentication flows\n");

/* ==========================================================================
 * 1 · Signing up
 * ========================================================================== */

section("Signup");

{
  script({});
  const result = await run(signUpAction, form({ ...GOOD_SIGNUP, email: "not-an-email" }));
  truthy("a malformed email is refused", result.result?.fieldErrors?.email?.length > 0);
  truthy(
    "and nothing was created before the form was checked",
    !called("rpc:consume_invite") && !called("signUp"),
    `reached: ${calls.map((c) => c.name).join(", ")}`,
  );
}

{
  /*
   * The invitation is claimed BEFORE the account exists.
   *
   * That ordering is the whole design: creating an account for somebody without
   * a valid invitation is the failure that matters, and a briefly consumed use
   * of a code is not — it is handed back below. The reverse order would let a
   * race create an account against an invitation that ran out mid-request.
   */
  script({
    rpc: {
      consume_invite: { data: "invite-1", error: null },
      is_username_available: { data: true },
    },
    signUp: { data: { user: { id: "user-1" } }, error: null },
  });

  const result = await run(signUpAction, form(GOOD_SIGNUP));

  eq("a good signup lands on the verification page", result.to, "/verify-email?sent=1");

  const order = calls.map((c) => c.name);
  truthy(
    "the invitation is consumed before the account is created",
    order.indexOf("rpc:consume_invite") < order.indexOf("signUp"),
    order.join(" → "),
  );
  truthy(
    "and the redemption is recorded after it",
    order.indexOf("signUp") < order.indexOf("rpc:record_invite_redemption"),
    order.join(" → "),
  );
}

{
  /*
   * The code reaches the database only as a digest.
   *
   * `invite_codes` stores `code_hash`, and this is the one place a plaintext
   * code exists at all. A test that only checked the signup succeeded would pass
   * just as happily if the raw code were sent.
   */
  script({
    rpc: {
      consume_invite: { data: "invite-1", error: null },
      is_username_available: { data: true },
    },
    signUp: { data: { user: { id: "user-1" } }, error: null },
  });
  await run(signUpAction, form(GOOD_SIGNUP));

  const consume = callsTo("rpc:consume_invite")[0];
  const sent = consume?.args?.p_code_hash ?? "";
  truthy(
    "the invite code is hashed before it leaves the server",
    /^[0-9a-f]{64}$/.test(sent),
    `sent ${JSON.stringify(sent)}`,
  );
  truthy(
    "and the plaintext code appears in no argument of any call",
    !JSON.stringify(calls).includes(GOOD_SIGNUP.inviteCode),
    "the raw code reached a call argument",
  );
  truthy(
    "nor does the password",
    !JSON.stringify(calls.filter((c) => c.name !== "signUp")).includes(GOOD_SIGNUP.password),
    "the password reached a call it had no business reaching",
  );
}

{
  script({ rpc: { consume_invite: { data: null, error: { message: "invalid_invite" } } } });
  const result = await run(signUpAction, form({ ...GOOD_SIGNUP, inviteCode: "NOPE" }));

  truthy(
    "an invalid invitation is a field error",
    result.result?.fieldErrors?.inviteCode?.length > 0,
  );
  truthy("and no account is created", !called("signUp"));
}

{
  // A taken username must hand the invitation back, or a typo burns a use of it.
  script({
    rpc: {
      consume_invite: { data: "invite-1", error: null },
      is_username_available: { data: false },
    },
  });
  const result = await run(signUpAction, form(GOOD_SIGNUP));

  truthy("a taken username is a field error", result.result?.fieldErrors?.username?.length > 0);
  truthy("and the invitation is released, not burned", called("rpc:release_invite"));
  truthy("no account was created", !called("signUp"));
}

{
  // Same rule when Supabase itself refuses.
  script({
    rpc: {
      consume_invite: { data: "invite-1", error: null },
      is_username_available: { data: true },
    },
    signUp: { data: { user: null }, error: { message: "boom", status: 500 } },
  });
  const result = await run(signUpAction, form(GOOD_SIGNUP));

  eq("a failed signup returns an error", result.result?.status, "error");
  truthy("and releases the invitation too", called("rpc:release_invite"));
  truthy(
    "and records no redemption",
    !called("rpc:record_invite_redemption"),
    "a redemption was recorded for an account that does not exist",
  );
}

{
  script({
    rpc: {
      consume_invite: { data: "invite-1", error: null },
      is_username_available: { data: true },
    },
    signUp: { data: { user: { id: "user-1" } }, error: null },
  });
  await run(signUpAction, form(GOOD_SIGNUP));

  const signUp = callsTo("signUp")[0];
  eq(
    "the confirmation email points back at the token handler",
    signUp?.args?.options?.emailRedirectTo,
    "https://kith.test/auth/confirm",
  );
  eq("and carries the username the profile trigger reads", signUp?.args?.options?.data, {
    username: "ada",
    display_name: "Ada",
  });
}

/* ==========================================================================
 * 2 · Signing in
 * ========================================================================== */

section("Login");

{
  /*
   * One sentence for every failure.
   *
   * On an invitation-only app, "no account with that email" tells a stranger who
   * is inside. Supabase distinguishes 400 from 401; the app must not.
   */
  const messages = new Set();
  for (const status of [400, 401]) {
    script({ signInWithPassword: { data: {}, error: { status, message: "whatever" } } });
    const result = await run(
      signInAction,
      form({ email: "ada@example.test", password: "wrong-password-here" }),
    );
    messages.add(result.result?.message);
  }

  eq("a wrong password and an unknown account give the same answer", messages.size, 1);
  truthy(
    "and it names neither",
    ![...messages][0]?.match(/not registered|no account|unknown|exist/i),
    `said: ${[...messages][0]}`,
  );
}

{
  /*
   * An unconfirmed address is not a credential failure.
   *
   * GoTrue validates the password first and only then checks confirmation, so
   * this reaches somebody who has already proved they know it — saying so leaks
   * nothing. Reporting it as "email and password do not match" sends a person
   * hunting for a password problem they do not have, which is what happened the
   * first time this app was deployed with mail misconfigured.
   */
  script({
    signInWithPassword: {
      data: {},
      error: { status: 400, code: "email_not_confirmed", message: "Email not confirmed" },
    },
  });
  const unconfirmed = await run(
    signInAction,
    form({ email: "ada@example.test", password: "correct horse battery staple" }),
  );

  truthy(
    "an unconfirmed address says so, rather than blaming the password",
    /confirm/i.test(unconfirmed.result?.message ?? ""),
    `said: ${unconfirmed.result?.message}`,
  );
  truthy(
    "and does not claim the details are wrong",
    !/do not match/i.test(unconfirmed.result?.message ?? ""),
    `said: ${unconfirmed.result?.message}`,
  );
}

{
  script({
    signInWithPassword: { data: { user: { id: "u", email_confirmed_at: null } }, error: null },
  });
  const result = await run(
    signInAction,
    form({ email: "ada@example.test", password: "correct horse battery staple" }),
  );
  eq("an unverified account is held at the verification page", result.to, "/verify-email");
}

{
  script({
    signInWithPassword: {
      data: {
        user: { id: "u", email_confirmed_at: "2026-01-01", factors: [{ status: "verified" }] },
      },
      error: null,
    },
  });
  const result = await run(
    signInAction,
    form({ email: "ada@example.test", password: "correct horse battery staple" }),
  );
  eq("an enrolled account goes to the second factor", result.to, "/verify-2fa");
}

{
  /*
   * An unverified factor is not a factor.
   *
   * Enrollment creates a row before the first code is entered. Treating that as
   * enrolled would strand somebody who abandoned setup at a challenge they
   * cannot answer, with no way back — the account is locked by a factor that was
   * never finished.
   */
  script({
    signInWithPassword: {
      data: {
        user: { id: "u", email_confirmed_at: "2026-01-01", factors: [{ status: "unverified" }] },
      },
      error: null,
    },
  });
  const result = await run(
    signInAction,
    form({ email: "ada@example.test", password: "correct horse battery staple" }),
  );
  eq("an abandoned enrollment does not lock the account out", result.to, "/");
}

{
  const verified = {
    signInWithPassword: {
      data: { user: { id: "u", email_confirmed_at: "2026-01-01", factors: [] } },
      error: null,
    },
  };

  script(verified);
  let result = await run(
    signInAction,
    form({
      email: "ada@example.test",
      password: "correct horse battery staple",
      redirectTo: "/messages",
    }),
  );
  eq("a signed-in user lands where they were going", result.to, "/messages");

  // The open redirect. `safeRedirect` is tested exhaustively in auth.test.mjs;
  // what matters here is that the action actually routes through it.
  for (const hostile of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
    script(verified);
    result = await run(
      signInAction,
      form({
        email: "ada@example.test",
        password: "correct horse battery staple",
        redirectTo: hostile,
      }),
    );
    eq(`a redirect to ${hostile} is discarded`, result.to, "/");
  }
}

{
  script({
    signInWithPassword: {
      data: {
        user: { id: "u", email_confirmed_at: "2026-01-01", factors: [{ status: "verified" }] },
      },
      error: null,
    },
  });
  const result = await run(
    signInAction,
    form({
      email: "ada@example.test",
      password: "correct horse battery staple",
      redirectTo: "/games",
    }),
  );
  eq("the destination survives the second factor", result.to, "/verify-2fa?next=%2Fgames");
}

/* ==========================================================================
 * 3 · Signing out
 * ========================================================================== */

section("Logout");

{
  script({});
  const result = await run(async () => signOutAction(), form({}));

  eq("signing out returns to the login page", result.to, "/login?signedout=1");
  eq("and signs out this browser only, not the person's phone", callsTo("signOut")[0]?.args, {
    scope: "local",
  });
}

/* ==========================================================================
 * 4 · Email verification
 * ========================================================================== */

section("Email verification");

{
  script({ getUser: { data: { user: null } } });
  const result = await run(resendVerificationAction, form({}));
  eq("resending needs a session", result.result?.status, "error");
  truthy("and asks for nothing to be sent", !called("resend"));
}

{
  script({ getUser: { data: { user: { id: "u", email: "ada@example.test" } } } });
  const result = await run(resendVerificationAction, form({}));

  eq("a signed-in account can ask again", result.result?.status, "success");
  const resend = callsTo("resend")[0];
  eq("as a signup confirmation", resend?.args?.type, "signup");
  eq(
    "pointing at the same token handler as the first one",
    resend?.args?.options?.emailRedirectTo,
    "https://kith.test/auth/confirm",
  );
}

{
  script({
    getUser: { data: { user: { id: "u", email: "ada@example.test" } } },
    resend: { error: { status: 429, message: "rate limited" } },
  });
  const result = await run(resendVerificationAction, form({}));
  eq("being rate-limited is said plainly", result.result?.status, "error");
  truthy("and mentions waiting", /wait/i.test(result.result?.message ?? ""));
}

/* ==========================================================================
 * 5 · Forgotten password
 * ========================================================================== */

section("Forgot password");

{
  /*
   * The membership oracle.
   *
   * A different response for a registered address turns this form into a way to
   * ask "is this person in the room" — which, for an app whose whole premise is
   * that six named people are inside it, is the thing worth protecting.
   */
  const answers = new Set();

  script({ resetPasswordForEmail: { error: null } });
  answers.add(
    JSON.stringify(
      (await run(forgotPasswordAction, form({ email: "member@example.test" }))).result,
    ),
  );

  script({ resetPasswordForEmail: { error: { status: 400, message: "User not found" } } });
  answers.add(
    JSON.stringify(
      (await run(forgotPasswordAction, form({ email: "stranger@example.test" }))).result,
    ),
  );

  eq("a member and a stranger get the same answer", answers.size, 1);
  truthy("and it is a success either way", JSON.parse([...answers][0]).status === "success");
}

{
  script({ resetPasswordForEmail: { error: { status: 429, message: "rate limited" } } });
  const result = await run(forgotPasswordAction, form({ email: "ada@example.test" }));
  eq("rate limiting is the one failure worth surfacing", result.result?.status, "error");
}

{
  script({ resetPasswordForEmail: { error: null } });
  await run(forgotPasswordAction, form({ email: "ada@example.test" }));
  eq(
    "the reset link goes through the token handler, not straight to the form",
    callsTo("resetPasswordForEmail")[0]?.args?.options?.redirectTo,
    "https://kith.test/auth/confirm?next=/reset-password",
  );
}

/* ==========================================================================
 * 6 · Setting a new password
 * ========================================================================== */

section("Password reset");

{
  script({ getUser: { data: { user: null } } });
  const result = await run(
    resetPasswordAction,
    form({
      password: "correct horse battery staple",
      confirmPassword: "correct horse battery staple",
    }),
  );

  eq("a reset with no recovery session is refused", result.result?.status, "error");
  truthy("and changes nothing", !called("updateUser"));
}

{
  script({ getUser: { data: { user: { id: "u", email: "ada@example.test" } } } });
  const result = await run(
    resetPasswordAction,
    form({ password: "short", confirmPassword: "short" }),
  );
  truthy("a weak password is a field error", result.result?.fieldErrors?.password?.length > 0);
  truthy("and nothing is updated", !called("updateUser"));
}

{
  script({ getUser: { data: { user: { id: "u", email: "ada@example.test" } } } });
  const result = await run(
    resetPasswordAction,
    form({ password: "correct horse battery staple", confirmPassword: "different one entirely" }),
  );
  truthy("a mismatched confirmation is refused", result.result?.status === "error");
  truthy("and nothing is updated", !called("updateUser"));
}

{
  const good = {
    password: "correct horse battery staple",
    confirmPassword: "correct horse battery staple",
  };

  script({ getUser: { data: { user: { id: "u", email: "ada@example.test" } } } });
  const result = await run(resetPasswordAction, form(good));

  eq("a good reset sends you back to sign in", result.to, "/login?reset=1");

  /*
   * THE FINDING this suite was written to catch.
   *
   * `changePasswordAction` in account-actions.ts signs every other device out
   * after a password change, and says why in a comment: "The common reason to
   * change a password is believing somebody else has it, and leaving their
   * session running afterwards makes the change ceremonial."
   *
   * That reasoning applies with more force here, not less. Somebody who used
   * the FORGOTTEN-password flow has typically either lost access or been
   * compromised — and if an attacker holds a live session, the reset the victim
   * just performed specifically to lock them out does not.
   *
   * The two paths disagreed, which is what made it an oversight rather than a
   * decision.
   *
   * The scopes differ on purpose, and the difference is the point. A change made
   * from Settings keeps the current browser (`others`) because the person is
   * signed in and just proved their old password. A reset proves only that
   * somebody can read an inbox, so nothing that authenticated beforehand should
   * still count — including the session that performed it.
   */
  const signOut = callsTo("signOut")[0];
  truthy(
    "and signs every session out — the attacker's is the reason to reset",
    signOut !== undefined,
    "no session was revoked: a compromised session survives the password reset meant to end it",
  );
  eq("this one included, because only inbox access was proved", signOut?.args, {
    scope: "global",
  });

  /*
   * And the account's own history should show it.
   *
   * The security log exists so that the question "did anybody else do something
   * to my account" has an answer. A password reset is the single most
   * consequential entry that could be missing from it.
   */
  truthy(
    "the reset is written to the security log",
    called("insert:security_events"),
    "a password reset left no trace in the account's own security history",
  );
}

/* ==========================================================================
 * 7 · Where the token handler sends people
 *
 * `/auth/confirm` is the landing point for every email KITH sends. It cannot be
 * imported here — it is a route handler wanting a NextRequest — so what is
 * asserted is the decision table it implements, against the same `safeRedirect`
 * and `decideRedirect` the handler and middleware use. The handler's own
 * branches are walked in the manual checklist.
 * ========================================================================== */

section("Email links");

{
  // A recovery link must not be redirectable. `next` arrives from an email, and
  // an open redirect there would let somebody send a genuine KITH link that
  // deposits the recipient on a page they control.
  eq(
    "a recovery link cannot be pointed at another site",
    safeRedirect("https://evil.example"),
    null,
  );
  eq("nor at a protocol-relative one", safeRedirect("//evil.example"), null);
  eq("nor back at the reset form itself", safeRedirect("/reset-password"), null);
  eq("nor at the second-factor challenge", safeRedirect("/verify-2fa"), null);
  eq("an ordinary destination survives", safeRedirect("/messages"), "/messages");
}

{
  // The rule that makes two-factor worth having: a recovery session is aal1, so
  // somebody who can read the inbox cannot set a new password and walk past the
  // factor. Without this, the second factor protects nothing email access does not.
  eq(
    "a recovery session still owes its second factor",
    decideRedirect({
      pathname: "/reset-password",
      userId: "u",
      emailVerified: true,
      isRecovery: true,
      mfaChallengeRequired: true,
    }),
    { to: "/verify-2fa", reason: "mfa_required" },
  );
  eq(
    "and reaches the form once it has proved it",
    decideRedirect({
      pathname: "/reset-password",
      userId: "u",
      emailVerified: true,
      isRecovery: true,
      mfaChallengeRequired: false,
    }),
    null,
  );
  eq(
    "the form is closed to somebody who simply knows the URL",
    decideRedirect({ pathname: "/reset-password", userId: null, emailVerified: false }),
    { to: "/forgot-password", reason: "no_recovery_session" },
  );
}

{
  // Confirming an address cannot be skipped by navigating away from the page
  // that asks for it.
  for (const escape of ["/login", "/signup", "/messages", "/settings"]) {
    const decision = decideRedirect({ pathname: escape, userId: "u", emailVerified: false });
    eq(`an unverified account cannot escape to ${escape}`, decision?.to, "/verify-email");
  }
}

/* ========================================================================== */

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\n  Failures:");
  for (const failure of failures) console.log(`    - ${failure}`);
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
