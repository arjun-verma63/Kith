# Production readiness checklist

Sign-off before KITH is exposed to the internet. How to actually deploy is
[DEPLOYMENT.md](DEPLOYMENT.md); this is what must be true first.

Items marked **BLOCKING** mean somebody cannot use the app, or data is at risk,
if they are wrong. The rest can follow a first deploy.

Sixty-two of these are checked by `npm run deploy:test` and marked ⚙. The others need
a human, a browser, or an inbox — they are here precisely because a machine
cannot see them.

---

## Status: **not deployed**

Verified 2 September 2026 against `fe82494`. Four issues found and fixed while
writing this; they are §9.

| Gate                        | State                                      |
| --------------------------- | ------------------------------------------ |
| Code and configuration      | ✅ ready                                   |
| Automated verification      | ✅ 31 suites, 2,355 assertions, 0 failures |
| Supabase project            | ⛔ not created — §2                        |
| SMTP                        | ⛔ not configured — **blocking**, §2.4     |
| Manual two-browser pass     | ⛔ not run — §6                            |
| CI, backups, error tracking | ⚠️ not built — §8                          |

---

## 1 · Code and configuration

### Secrets

- [x] ⚙ No JWT-shaped credential in any tracked file
- [x] ⚙ No `sb_secret_` or `sb_publishable_` key committed
- [x] ⚙ No real Supabase project hostname committed
- [x] ⚙ No `.env` file tracked except `.env.example`
- [x] ⚙ `.gitignore` excludes `.env*` and keeps `.env.example`
- [x] ⚙ `.env.example` carries no real values
- [x] No `.env` file has **ever** been committed — checked across all history,
      not just the working tree. A secret removed in a later commit is still in
      the history and still leaked
- [ ] Every production secret is set only in Vercel and Supabase, never in a
      file, a screenshot, or a message

### Hardcoded values

- [x] ⚙ No `localhost` or `127.0.0.1` URL in shipped source
- [x] ⚙ No plain-`http://` origin in shipped source
- [x] ⚙ `NEXT_PUBLIC_SITE_URL` — a production build **refuses** a loopback or
      plain-http value, so a misconfigured deploy fails loudly instead of mailing
      everyone a link to the deploying machine

### Debug output

- [x] ⚙ No `console.log` / `debug` / `info` / `trace` anywhere in `src/`
- [x] ⚙ No `debugger` statement
- [x] ⚙ `/styleguide` returns 404 in production
- [x] ⚙ Database errors redact row content in production logs — Postgres puts
      the failing row in `details`, which for KITH means private message text in
      a retained, searchable log
- [x] Every remaining `console.warn` / `console.error` logs a status or a
      message, never a whole error object or a form payload — 30 sites, all read
- [x] No password, token, invite code or message body reaches a log. The invite
      code is SHA-256'd before it leaves the server; `auth-flows.test.mjs` proves
      the plaintext appears in no call argument

---

## 2 · Supabase

- [ ] Project created in the region nearest the six people, not nearest you
- [ ] Database password stored somewhere real — it cannot be recovered
- [ ] `npm run db:push` applied all 28 migrations
- [ ] `npm run db:types:check` passes against the production schema

### 2.1 Row Level Security

- [x] Every public table has RLS enabled, forced, and at least one policy
- [x] Every `SECURITY DEFINER` function pins `search_path`
- [x] Every table carries the restrictive `mfa_required` gate
- [x] No session-callable function trusts a caller-supplied user id
- [x] 62 adversarial assertions pass — every one an attack, a green tick means
      it failed ([SECURITY.md](SECURITY.md))

### 2.2 Storage — **BLOCKING**

- [x] ⚙ `avatars` bucket is **private**; every read goes through a signed URL
- [x] ⚙ Size limit enforced by Storage itself (2 MiB), not just by the form
- [x] ⚙ MIME allowlist admits images only
- [x] ⚙ SVG is **not** on it — an uploaded SVG is a script that renders as a
      picture
- [x] ⚙ Read, insert, update **and delete** policies all exist. Delete is the one
      people forget, and without it every replaced avatar stays forever
- [x] Writes are scoped to `{uid}/…` by path prefix, so no filename a client can
      construct lands in somebody else's folder
- [x] Reads are block-aware in both directions

### 2.3 Authentication URLs — **BLOCKING**

- [ ] **Site URL** in the dashboard is byte-identical to `NEXT_PUBLIC_SITE_URL`
- [ ] Redirect allowlist contains `https://<domain>/auth/confirm`
- [ ] …and `https://<domain>/auth/confirm?next=/reset-password`
- [ ] …and the preview-deployment origin, if previews are used
- [x] ⚙ Every email link in the code is built from the configured origin and
      lands on `/auth/confirm` — never a literal origin
- [x] ⚙ `/auth/*` is excluded from middleware, so a one-time token is not
      redirected away before it can be consumed

A link to an origin that is not on the allowlist is rejected by Supabase. The
symptom is a confirmation email that fails for everybody, found by your first
real user.

### 2.4 SMTP — **BLOCKING**

- [ ] Custom SMTP configured in the Supabase dashboard
- [ ] Sending domain has SPF **and** DKIM
- [ ] A real signup email arrived, in an inbox, not spam
- [ ] A real password-reset email arrived and its link worked

Supabase's built-in mailer is rate-limited to a handful of messages an hour and
labelled development-only. Without working mail nobody can join and nobody can
recover an account. This is the one item most likely to be assumed rather than
checked.

---

## 3 · Application

### Authentication

- [x] Signup consumes the invitation **before** creating the account, and
      releases it on any failure
- [x] Invite codes are SHA-256'd; plaintext never reaches the database
- [x] Wrong password and unknown account return the identical sentence — on an
      invitation-only app, a difference tells a stranger who is a member
- [x] Forgotten-password returns the same message whether or not the account
      exists
- [x] Password reset signs out **every** session including its own, and writes to
      the security log
- [x] `?next=` is sanitised everywhere — no open redirect from an email link
- [x] Email verification cannot be skipped by navigating to `/login`
- [x] A recovery session still owes its second factor, so inbox access alone
      cannot walk past 2FA

### Calls — §5 of [DEPLOYMENT.md](DEPLOYMENT.md)

- [x] ⚙ No TURN credential hardcoded anywhere client-reachable
- [x] ⚙ Relay entries are passed in, minted server-side, short-lived
- [x] ⚙ The credential minter is `server-only`
- [x] ⚙ STUN configured from two operators, so one outage slows rather than
      breaks
- [x] ⚙ A half-configured relay is a boot error, not a silent downgrade
- [x] ⚙ Missing `turns:` warns at boot
- [ ] TURN provider account exists and `TURN_URLS` covers UDP, TCP **and** TLS
- [ ] Relay verified with `forceRelay: true` — a developer on an open network
      never exercises it otherwise, and a broken relay ships

### Headers

- [x] ⚙ `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
      `Strict-Transport-Security`, `Permissions-Policy`
- [x] ⚙ `poweredByHeader` off
- [x] ⚙ Camera, microphone and display-capture allowed to our own origin only;
      geolocation, payment and USB denied outright
- [ ] ⚠️ **No Content-Security-Policy.** Deliberate, and the largest remaining
      gap — §8

---

## 4 · Migrations

- [x] ⚙ 28 migrations, tracked, filenames sort into apply order
- [x] ⚙ Unique 14-digit timestamp prefixes
- [x] ⚙ **None drops a table, drops a column, or truncates.** The app rolls back
      in one click; the database does not. An additive migration that is wrong is
      fixed by another migration — a destructive one that has run is not
- [x] All 28 replay cleanly against real Postgres — proven on every one of the
      31 suite runs
- [ ] Schema deployed **before** the code that needs it. A database ahead of the
      app is unused columns; an app ahead of the database is an outage

---

## 5 · Operations

- [x] ⚙ `/api/health` issues a real query against Postgres
- [x] ⚙ …reports `database` separately from process liveness
- [x] ⚙ …answers 503 when Postgres is unreachable
- [x] ⚙ …uses the anon key, not the service role — it is public and
      unauthenticated
- [ ] Daily cron pointed at `/api/health`. Free-tier Supabase pauses after a week
      of inactivity and six people will hit that
- [ ] Custom domain with a valid certificate
- [ ] `NEXT_PUBLIC_SITE_URL` matches that domain exactly

---

## 6 · Manual verification

The suite has never rendered a page. Not one of 2,355 assertions mounts a
component, so a route that throws on mount passes everything and fails on sight.

- [ ] Smoke pass — every route loads with a clean console
      ([MANUAL-TESTING.md](MANUAL-TESTING.md) §0)
- [ ] Full two-browser pass against the production build
- [ ] Signup → email → verify → sign in, end to end, with real mail
- [ ] Password reset end to end, confirming **both** browsers are signed out
- [ ] A real call between two networks, ideally one behind mobile data
- [ ] Install as a PWA on a real phone; sign in and call from inside it

---

## 7 · Before inviting anybody

- [ ] Somebody other than you has completed signup unaided
- [ ] You know how to restore from a backup, because you have done it once
- [ ] You know where to look when a user says "it's broken" — §8

---

## 8 · Accepted gaps

None blocks a first deploy. All should exist before the app is depended on.
Listed so they are decisions rather than oversights.

**No CI.** Everything runs locally; nothing enforces that it ran. The workflow is
four commands. Until it exists, this checklist depends on somebody remembering.

**No backups.** Free-tier guarantees are not a plan for six people's years of
conversations. Weekly `pg_dump` to encrypted object storage.

**No error tracking.** `error.tsx` logs a digest nobody collects. A production
failure is currently something you are _told_ about.

**No Content-Security-Policy.** Five security headers are set and a CSP is
deliberately not, because a placeholder widened to `unsafe-inline` is worse than
none. The two blockers named in `next.config.ts` are now resolved — the
`connect-src` list is known (Supabase REST, its realtime WebSocket, the TURN
origins) and the nonce would come from middleware, threading into the two inline
`<script>` tags in `layout.tsx` and `appearance-boot.tsx`.

It is not done because it cannot be verified from here. No test renders a page,
so a CSP that breaks the app breaks it silently, in a browser, after deploy. It
needs §6 behind it. This is the largest remaining gap and should be the next
piece of work.

---

## 9 · Fixed while writing this

Four issues, all in code that already shipped.

**`NEXT_PUBLIC_SITE_URL` defaulted to localhost.** Unset in production, the build
succeeded and every confirmation and recovery email pointed at
`http://localhost:3000`. Nobody could sign up; nobody could reset a password; and
nothing about the deployment looked wrong. Now a production build refuses a
loopback or plain-http origin. The https half matters too — a plain-http origin
breaks secure cookies and `getUserMedia`, which is every call.

**Database errors logged private data.** `fromPostgrestError` logged
`PostgrestError.details`, and Postgres puts the offending row there:
`Failing row contains (1, a private message nobody should read)`. For an app
whose premise is that six people can speak privately, that is message content in
a retained, searchable production log. Redacted in production, kept in
development where it earns its keep.

**The keepalive kept nothing alive.** `/api/health` returned JSON and touched
nothing, while ARCHITECTURE.md described it as the answer to free-tier Supabase
pausing on inactivity. Pinging a Vercel route keeps a Vercel function warm and
has no effect on Supabase, which pauses on _database_ inactivity — so the cron
would have run happily every day while the project it protected went to sleep,
and the site would have died a week after launch with a fix already "in place".
It now issues a real query.

**A raw error object in the TURN path.** Logged whole, in the one code path that
reads `TURN_SHARED_SECRET`. No secret was in it, but it was the only site
inconsistent with the codebase's `{ status }` / `{ message }` discipline. Narrowed.

---

## Sign-off

```
Deployed by ......................  Date ..................
Commit ...........................  Domain ................
Supabase project .................  Region ................

§2.2 storage        [ ]     §2.3 auth URLs      [ ]
§2.4 SMTP           [ ]     §5 keepalive        [ ]
§6 manual pass      [ ]     §7 someone else     [ ]

Accepted gaps from §8 ...........................................
```
