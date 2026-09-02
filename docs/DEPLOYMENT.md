# Deployment

How to run KITH locally, and how to put it on the internet.

Two environments, deliberately. There is no staging: KITH has six users, and a
third environment is a third place for configuration to drift out of sync. What
would be staging is a Vercel preview deployment pointed at its own Supabase
project — see §6.

The mechanical half of this document is enforced by `npm run deploy:test`
(62 assertions). The half a machine cannot check is
[PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md).

---

## 1. Environment variables

Six variables in total, and only two are secret. Everything is validated by Zod
in `src/lib/env/` — **a variable that is not in a schema there is not used by the
application**, which is the whole reason this table can be trusted.

### The checklist

| Variable                        | Dev                              | Prod         | Secret  | Where it goes              |
| ------------------------------- | -------------------------------- | ------------ | ------- | -------------------------- |
| `NEXT_PUBLIC_SITE_URL`          | optional                         | **required** | no      | `.env.local` / Vercel      |
| `NEXT_PUBLIC_SUPABASE_URL`      | required¹                        | **required** | no      | `.env.local` / Vercel      |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | required¹                        | **required** | no²     | `.env.local` / Vercel      |
| `SUPABASE_SERVICE_ROLE_KEY`     | required¹                        | **required** | **yes** | `.env.local` / Vercel      |
| `TURN_URLS`                     | optional                         | recommended³ | no      | `.env.local` / Vercel      |
| `TURN_SHARED_SECRET`            | optional                         | recommended³ | **yes** | `.env.local` / Vercel      |
| `TURN_CREDENTIAL_TTL_SECONDS`   | optional (600)                   | optional     | no      | Vercel                     |
| `TURN_USERNAME` / `_PASSWORD`   | alternative to the shared secret | **yes**      | Vercel  |
| `SUPABASE_ACCESS_TOKEN`         | —                                | CI only      | **yes** | GitHub Actions secret only |

¹ Validated **lazily**, when a Supabase client is first constructed. The landing
page has no database in it, so a fresh clone builds and runs the marketing route
with none of them set. Anything that reaches for Supabase fails immediately and
names the missing variable.

² Public **by design**. It carries no privileges of its own — Row Level Security
is what protects the data, which is why every table gets a policy before it gets
a feature. It is compiled into the browser bundle and that is fine.

³ Optional in the sense that the app runs without it. Not optional in the sense
that calls will work for everybody — see §5.

### The two that must never be confused

The single most damaging configuration mistake available in a Supabase app is
pasting the **service-role key** into `NEXT_PUBLIC_SUPABASE_ANON_KEY`. It works
perfectly. Every query succeeds, because RLS is bypassed. And it publishes full
read/write access to the entire database in the browser bundle, where anybody can
open devtools and read it.

Nothing about the app's behaviour would reveal it, so the schema refuses to boot:
`src/lib/env/schema.ts` decodes the JWT's `role` claim and checks the
`sb_secret_` / `sb_publishable_` prefixes, in both directions. Give the anon key
to the service-role variable and it also refuses.

`SUPABASE_ACCESS_TOKEN` is the third trap. It is not a project key — it manages
your whole Supabase **account**. It belongs in a GitHub Actions secret and
nowhere else. Nothing the application runs ever needs it.

### `NEXT_PUBLIC_SITE_URL` is not decoration

It is the origin baked into every email KITH sends — signup confirmation,
password recovery, email change — and into `metadataBase`.

Left unset, the schema used to default it to `http://localhost:3000` and a
production build would succeed, render correctly, and mail every new member a
confirmation link pointing at the deploying machine. Nothing about the deployment
would look wrong; the failure lands in a stranger's inbox hours later and reads
as "the invite link is broken".

A production build now refuses a loopback or plain-http origin. The consequence
worth knowing: **`npm run build` is held to that rule**, because a build is a
production build.

Smoke-testing a real bundle locally is a different thing, and `localhost` is the
correct origin for it, so there is an opt-out you have to type:

```bash
npm run build          # production artifact — needs a real https origin
npm run build:local    # same build, localhost allowed
```

It is an explicit flag rather than a platform sniff (`VERCEL`, `CI`) on purpose.
Sniffing gets the guard right on Vercel and silently wrong on a VPS or a
container; `NODE_ENV` is the one signal every platform sets.

---

## 2. Development environment

```bash
git clone <repo> && cd KITH
npm install
cp .env.example .env.local
npm run dev                       # http://localhost:3000
```

With no `.env.local` at all, the landing page still builds and runs. Everything
behind a sign-in needs a Supabase project.

### Getting a database

Two options, and the second is what you want most days.

**A cloud project** — create one at supabase.com, copy the three credentials from
Project Settings → API into `.env.local`, then:

```bash
npx supabase login
npx supabase link --project-ref <ref>
npm run db:push                   # apply all 28 migrations
npm run db:types                  # regenerate src/types/database.ts
```

**Local Supabase** — the full stack in Docker, no account needed:

```bash
npm run db:start                  # Postgres, Auth, Realtime, Storage
npm run db:reset                  # drop, replay every migration
npm run db:stop
```

`db:start` prints local credentials; paste those into `.env.local` instead.

### You usually need neither

The test suites run against **PGlite** — Postgres 17 compiled to WebAssembly —
so the schema, every policy and every function are verified with no Docker, no
account and no network:

```bash
npm test                          # 31 suites, ~2350 assertions
npm run deploy:test               # the deployment invariants in this document
npm run check                     # typecheck + lint + format
```

A test with a prerequisite is a test that stops being run. That constraint is why
there is no `docker compose` step above.

### Schema changes

**Migrations only.** Editing the schema in the Supabase dashboard is banned: it
makes local and production diverge silently and there is no way back. The
dashboard is for reading.

```bash
npm run db:diff -f add_something  # capture local changes as a migration
npm run db:types                  # types must be regenerated and committed
npm run db:types:check            # CI-style check that they were
```

---

## 3. Production environment

**Vercel** for the app, **Supabase** for everything with state. Both have free
tiers that fit six people, which was a constraint from the start.

### 3.1 Supabase project

1. Create the project. Pick the region nearest the six people, not nearest you —
   every query and every realtime message pays that latency.
2. Save the database password somewhere real. It cannot be recovered.
3. Copy the three credentials from **Project Settings → API**.

### 3.2 Apply the schema

```bash
npx supabase link --project-ref <prod-ref>
npm run db:push
```

28 migrations, applied in filename order. They are additive — `deploy:test`
asserts that none of them drops a table, drops a column, or truncates — so
`db:push` on an existing project applies only what is new.

Verify afterwards:

```bash
npm run db:types && npm run db:types:check   # no drift between schema and types
```

### 3.3 Authentication URLs — the step that is easy to miss

**Authentication → URL Configuration** in the dashboard:

| Field             | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| **Site URL**      | `https://your-domain` — identical to `NEXT_PUBLIC_SITE_URL` |
| **Redirect URLs** | `https://your-domain/auth/confirm`                          |
|                   | `https://your-domain/auth/confirm?next=/reset-password`     |
|                   | `https://*-your-team.vercel.app/auth/confirm` _(previews)_  |

Every email link KITH builds lands on `/auth/confirm`, which consumes the token
server-side and never puts it in the browser's URL bar, `history`, or the
`Referer` header of the next request. `deploy:test` asserts that this set is
exactly what the code constructs, so if the app grows a new email link the test
fails and this table gets updated.

A link to an origin that is not on the allowlist is rejected by Supabase. The
symptom is a confirmation email that fails for everybody, which is discovered by
your first real user rather than by you.

### 3.4 SMTP — required, and not an app variable

Supabase's built-in mailer is capped at a handful of messages an hour and is
explicitly labelled development-only. Signup confirmation and password recovery
are not optional features: without working mail nobody can join and nobody can
recover an account.

Configure it under **Project Settings → Authentication → SMTP Settings**. It goes
in the Supabase dashboard, never in `.env.local` and never in Vercel — Supabase
sends the mail, not the app.

Use a domain with SPF and DKIM configured. Mail from a fresh domain with neither
goes to spam, and "the confirmation email never arrived" is indistinguishable
from "the app is broken".

### 3.5 Vercel

```bash
npx vercel link
```

Set every variable from §1 under **Settings → Environment Variables**, scoped to
**Production**. Then set the same set for **Preview** pointing at a _different_
Supabase project (§6).

Build settings are the defaults — `npm run build`, output detected
automatically. There is no `vercel.json` because nothing needs overriding.

### 3.6 The keepalive

Free-tier Supabase projects pause after a week of inactivity, and a six-person
app will hit that.

`/api/health` issues a real query against Postgres for exactly this reason. It
did not always: the endpoint used to return JSON and touch nothing, so the
scheduled ping kept a Vercel function warm while the project it was protecting
went to sleep — a cron job that looked like it was working and a site that would
have died a week after launch.

Schedule a daily GET. Any cron will do; a Vercel Cron is one line:

```json
{ "crons": [{ "path": "/api/health", "schedule": "0 6 * * *" }] }
```

It answers `200` with `{"database":"ok"}`, or `503` when Postgres is unreachable,
so a monitor watching it fails for the right reason.

---

## 4. Deploying

```bash
npm run check && npm test && npm run build:local   # all three, in that order
git push origin main                                # Vercel builds from main
```

`build:local` rather than `build` because you have no production origin set
locally; Vercel runs the strict one, with the real variable, and fails the deploy
if it is missing.

Nothing deploys that has not passed the suite locally, because there is no CI
yet — see §7.

### Rollback

**The app** rolls back instantly: Vercel → Deployments → Promote a previous one.
No build, no wait.

**The database does not.** Migrations are forward-only, and this is why
`deploy:test` refuses a migration containing `drop table`, `drop column` or
`truncate`: an additive migration that turns out to be wrong is fixed by another
migration, while a destructive one that has already run is unrecoverable.

That asymmetry is the reason to deploy the schema _before_ the code that needs
it, never after. A database ahead of the app is harmless — unused columns. An
app ahead of the database is an outage.

Restoring data is a `pg_dump` restore, from a backup you took, into a new
project. Free-tier backup guarantees are not a plan; §7.

---

## 5. TURN

Entirely optional. With none of it set, calls run on public STUN exactly as they
did before TURN existed, and a fresh clone makes calls without anybody signing up
for a relay.

What you lose without it is not random. STUN cannot solve symmetric NAT,
carrier-grade NAT (most mobile networks), or a corporate firewall that drops UDP
— which are exactly the networks people are on when they most want to call.

Configure all three transports:

```
TURN_URLS="turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp,turns:relay.example.com:5349?transport=tcp"
TURN_SHARED_SECRET="<from your provider>"
```

TLS on 443 is the one that matters most and the one people skip. To a firewall it
is indistinguishable from HTTPS, which is the point. The app warns at boot if it
is missing, because the symptom of leaving it out is _"calls work for everybody
except the person in the office"_.

Prefer `TURN_SHARED_SECRET` over `TURN_USERNAME`/`TURN_PASSWORD`. The server
mints a short-lived credential per user per call and hands the browser that —
never the secret — so rotating it invalidates every outstanding credential at
once. Static credentials do not expire, which is precisely their weakness.

**Verify it actually works.** A developer on an open network connects
peer-to-peer every time and never exercises the relay, so a broken TURN
configuration ships and is found by the one person who cannot call anybody.
`buildIceConfiguration({ forceRelay: true })` forces every candidate through the
relay; see [TURN.md](TURN.md).

---

## 6. Preview deployments

Vercel builds every branch. Point previews at a **second Supabase project**, not
production.

The reason is not caution about schema changes — it is that a preview build
shares production's `NEXT_PUBLIC_SITE_URL` if you let it, and then a password
reset requested from a preview mails a link to production, or vice versa. Two
projects, two sets of variables, no shared state.

Add the preview origin to Supabase's redirect allowlist (§3.3) or authentication
will not work there at all.

---

## 7. Not built yet

Written down rather than left implied. None of these blocks a first deploy; all
of them should exist before the app is depended on.

**Continuous integration.** There is no `.github/`. Everything runs locally and
nothing enforces that it ran. The workflow is small — `npm run check`, `npm test`,
`npm run build` on every push, plus `npm run db:types:check` — and the value is
that the readiness checklist stops depending on somebody remembering.

**Backups.** Free-tier Supabase backup guarantees are not a plan for six people's
years of conversations. A weekly `pg_dump` to encrypted object storage, from a
scheduled workflow, using `SUPABASE_ACCESS_TOKEN`.

**Error tracking.** `src/app/error.tsx` logs a digest to the browser console and
nothing collects it. Sentry, or an equivalent, so a production failure is
something you learn about rather than something you are told about.

**A Content-Security-Policy.** `next.config.ts` sets five security headers and
deliberately no CSP, with a comment saying it waits on a per-request nonce and
the final `connect-src` list. Both are now known — Supabase REST and its realtime
WebSocket, plus the TURN origins — so the remaining work is issuing a nonce from
middleware and threading it through the two inline `<script>` tags (the theme
bootstrap in `layout.tsx` and `appearance-boot.tsx`).

It is not done here because it cannot be verified here: no automated test in this
project renders a page, so a CSP that breaks the app breaks it silently, in a
browser, after deploy. It needs the two-browser pass in
[MANUAL-TESTING.md](MANUAL-TESTING.md) behind it.
