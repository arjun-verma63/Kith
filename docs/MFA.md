# Two-factor authentication

TOTP, through Supabase Auth. Settings → Security → Enable 2FA.

**No SMS.** Not "not yet" — SMS second factors are defeated by SIM swap, which is
a phone call to a carrier rather than an attack on anything technical, and they
cost money per message. An authenticator app needs no signal, no carrier and no
budget.

---

## 1. KITH stores no secrets

The TOTP secret exists in exactly two places: Supabase Auth's `auth.mfa_factors`
table, and the authenticator app it was scanned into. It passes through
`beginEnrollmentAction` on its way to a QR code and is not written down, cached,
logged, or put in a cookie.

There is no `mfa_secrets` table, no QR library, and no code that computes an
HMAC. `src/features/auth/mfa.ts` is the whole of our TOTP surface and it contains
no cryptography — if it ever grows a `base32` import, something has gone wrong.

The QR code is an SVG data URI rendered by Supabase and put straight into an
`<img>`. Rendering it client-side would mean the secret being handled by our code
on its way to a canvas, which is a worse place for it than the one it is already
in.

---

## 2. The bit that is actually two-factor authentication

**A redirect is not a second factor.**

`signInWithPassword` returns a real, working session before any code is entered.
Its access token is valid, and PostgREST will answer it. So an attacker holding a
stolen password can skip the browser entirely, take the `aal1` token, and read
the whole account over HTTP — while the app dutifully shows an "enter your code"
screen to nobody.

Middleware decides where to **send** somebody. Row Level Security decides what
they can **read**. Only the second one is two-factor authentication.

So migration 0024 puts a **restrictive** policy on every table in `public`:

```sql
create policy mfa_required on public.<table>
  as restrictive
  for all
  to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));
```

`mfa_satisfied()` is `SECURITY DEFINER` — `authenticated` has no grant on
`auth.mfa_factors` and must not be given one, because that table holds the
secrets. The function reads it on the caller's behalf, about the caller only, and
returns one boolean.

| Caller                           | Result                                                   |
| -------------------------------- | -------------------------------------------------------- |
| No session (`anon`)              | `true` — the table's own policies decide, as before      |
| Session, no verified factor      | `true` — two-factor is opt-in and most accounts have not |
| Session, verified factor, `aal1` | **`false`** — everything is refused                      |
| Session, verified factor, `aal2` | `true`                                                   |
| `service_role`                   | Policy does not apply (`to authenticated`)               |

Restrictive policies are ANDed with everything else, so this cannot be widened by
a permissive policy somebody adds later. It can only be **forgotten on a new
table** — which is why `rls.test.mjs` asserts that every table in `public` carries
it, and `mfa.test.mjs` proves behaviourally that all 22 refuse a half-
authenticated session while four of them hand rows to a satisfied one.

### An unverified factor deliberately does not count

Enrolling creates the factor _before_ the first code is entered. If that locked
the account to `aal2`, opening the enrolment screen would lock you out of the app
halfway through enrolling, with no way to finish. `mfa_satisfied()` and
`deriveMfaState` both count only `status = 'verified'`, and both are tested for
it.

---

## 3. The password-reset hole

Worth its own section because it is easy to miss and it undoes the whole feature.

A recovery link creates a session — at `aal1`. Without a rule, the flow is:
request a reset, read the email, set a new password, sign in. The second factor is
never asked for, and it turns out to protect nothing that access to the inbox did
not already unlock.

So `/reset-password` requires the factor first:

```
recovery link → aal1 session → /verify-2fa → aal2 → /reset-password
```

`decideRedirect` handles it and `mfa.test.mjs` asserts it. The cost is a genuine
lockout risk — lose the phone _and_ need a password reset and you need §6.

---

## 4. Where everything lives

| Concern                              | File                                            |
| ------------------------------------ | ----------------------------------------------- |
| The state machine (pure)             | `src/features/auth/mfa.ts`                      |
| Status, audit writes, log reads      | `src/features/auth/mfa-queries.ts`              |
| Enrol / confirm / remove / challenge | `src/features/auth/mfa-actions.ts`              |
| Routing rules (pure)                 | `src/features/auth/redirects.ts`                |
| Assurance level per request          | `src/lib/supabase/middleware.ts`                |
| The data-layer gate                  | `supabase/migrations/20260901000700_mfa.sql`    |
| Settings UI                          | `src/features/auth/components/mfa-settings.tsx` |
| Sign-in challenge                    | `src/app/(auth)/verify-2fa/page.tsx`            |
| Admin removal                        | `scripts/mfa-reset.mjs`                         |

The rest of the Security page — password, sessions, privacy, deletion — is in
[ACCOUNT.md](ACCOUNT.md).

Three layers ask "does this session owe a factor", and `deriveMfaState` is the
single answer all three use, so they cannot drift.

---

## 5. Sensitive actions

Anything that hands somebody a durable way back in requires the session to
already be at the level the account demands, and — for removal — a **current
code on top of that**.

| Action                             | Requires                                  |
| ---------------------------------- | ----------------------------------------- |
| Enable 2FA                         | A session; the code proves the new factor |
| Add a second authenticator         | `aal2`                                    |
| Remove an authenticator            | `aal2` **and** a fresh code               |
| Turn 2FA off (remove the last one) | `aal2` **and** a fresh code               |
| Set a new password via recovery    | `aal2`                                    |

Asking for a code during removal is not belt-and-braces. An `aal2` session lasts
as long as its token does, and removal is the one action that makes every future
sign-in easier — six digits closes the window where a borrowed laptop can switch
the protection off.

The code may come from **any** of the account's verified authenticators, tried in
order. "Remove the phone I lost, using the tablet I still have" is the whole
reason more than one is allowed.

Every one of these writes to `security_events`, through the service role, because
that table is closed to `authenticated` by policy. A log the account holder can
write to is a log an attacker with that account can write to.

---

## 6. Recovery — the honest version

**TOTP has no "forgot my phone" link and cannot have one.** The server would need
to be able to produce a code on your behalf, which is precisely the property the
scheme exists to lack. Recovery codes are the usual mitigation and **Supabase
Auth does not issue them**, so this app does not pretend to have them.

What there is instead, in order of preference:

1. **A second authenticator.** Up to `MAX_FACTORS` (3). This is the real answer
   and the settings page nags about it the moment you have exactly one, because
   the useful time to add a second device is before the first one is lost.

2. **A human with the service-role key.** `npm run mfa:reset -- someone@example.com`
   lists what an account has; `--remove` deletes it. It runs in a terminal on
   purpose — it needs the key, leaves a shell history, and writes an
   `mfa.disabled` event the account holder can see on their own settings page.

   **Verify the person out of band first.** A voice call, in person, something an
   attacker holding their inbox cannot fake. An email asking for this is exactly
   what the attack looks like.

3. There is no third option. An account with no factors left and nobody to ask is
   an account that is gone.

If KITH ever wants real recovery codes, the shape is: generate ten, store only
their hashes in a new table, and add a redemption path that consumes one and
marks it used. That is a genuine feature with a genuine schema, not a checkbox,
and it is deliberately not half-built here.

---

## 7. Testing

```
npm run mfa:test    109 assertions
npm run db:test      69 assertions — includes the "every table is gated" invariant
```

### What the suite proves

- **The gate**, against real Postgres, as the real `authenticated` role, with the
  real `aal` claim. Reads and writes, every table, other users unaffected, the
  service role never gated.
- **The state machine**, including mid-enrolment, a missing `aal` claim, and the
  moment after the last factor is removed.
- **The routing**, including the password-reset hole in §3.
- **RFC 6238** against the published Appendix B test vectors, so the parameters
  this app promises — six digits, thirty seconds, SHA-1 — are the ones an
  authenticator app actually produces.
- **The seven scenarios from the brief**, end to end, against a model of GoTrue's
  contract: a correct code raises the session's `aal` claim, a wrong one does not.
  Everything downstream of that claim is the real thing.

### What it does not prove

**GoTrue's own verifier.** It is a Go service and is not running in the suite; a
test that called `mfa.enroll` against a mock would be a test of the mock. The
model in §5 of the test file asserts our half of the contract and stops there.

So the following needs a live Supabase project and two browsers. Run it before
shipping:

1. **Enable** — Settings → Security → Enable 2FA. Scan with Google Authenticator.
   Enter the code. Badge flips to **On**, `mfa.enabled` appears in the log.
2. **Log out.**
3. **Log in** with email and password.
4. **Challenge** — you land on `/verify-2fa`, not on the app.
5. **Incorrect code** — `000000` is rejected, you stay on the page,
   `mfa.challenge_failed` is logged. Then, in a second browser, sign in and
   confirm `/messages` bounces you back to the challenge.
6. **Correct code** — you land where you were heading.
7. **Disable** — Settings → Security → Disable, enter a current code. Badge flips
   to **Off**. Log out and back in: no challenge.

Also worth doing once: with 2FA on and a session sitting at the challenge, take
the access token out of the cookie and `curl` PostgREST with it. It must return
`[]` for every table. That is the assertion the whole feature rests on, and it is
the one a browser cannot make for you.
