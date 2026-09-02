# Deploying KITH to Vercel

Assumes the GitHub repository exists, KITH is the production application, and
Supabase is the backend.

The general deployment reference is [DEPLOYMENT.md](DEPLOYMENT.md); this is the
Vercel-specific walkthrough. Nothing below contains a credential — every secret
is referred to by where it comes from, never by value, and none should ever be
pasted into a file, a screenshot, or a message.

---

## What is already configured

Committed, so none of it is a manual step:

| File                       | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `vercel.json`              | Framework, build command, the daily keepalive cron                |
| `.github/workflows/ci.yml` | check + types + suite + build + bundle scan, on every push and PR |
| `next.config.ts`           | Five security headers, `poweredByHeader: false`, typed routes     |
| `scripts/smoke.mjs`        | `npm run smoke -- <url>` — the post-deploy verification           |

`vercel.json` overrides the build command to
`npm run build && npm run check:bundle`. That second half scans the built client
bundle for server-only secrets, and Vercel is the only place it runs for real —
CI holds no production credentials, so the scanner there honestly reports
"nothing to scan". On Vercel the service-role key is present, so the scan means
something. It is the last thing standing between a bad refactor and publishing
the database.

---

## 1 · Connecting GitHub to Vercel

1. **vercel.com → Add New → Project → Import Git Repository.** Authorise the
   Vercel GitHub App for the KITH repository. Grant it that repository only, not
   the whole account.
2. Vercel detects Next.js and reads `vercel.json`. **Do not change the detected
   settings** — §5.
3. **Do not deploy yet.** Add the environment variables first (§2). A first
   deploy without them fails at build, which is by design, but it is a confusing
   way to start.
4. Confirm the production branch is `main` under **Settings → Git**.

From then on: every push to `main` is a production deployment, every pull request
gets a preview URL.

### Protect the branch

Automatic deployment from `main` is the point of connecting the two, and also the
risk: without a gate, the only thing between a broken commit and six people's app
is whether somebody ran the suite locally.

**GitHub → Settings → Branches → Add rule** for `main`:

- Require a pull request before merging
- Require status checks to pass → **CI / verify**
- Do not allow bypassing

The workflow needs no secrets. Every suite runs against PGlite — Postgres 17
compiled to WebAssembly — so the schema, every policy and every function are
verified with no Supabase project, no Docker and no network.

---

## 2 · Environment variables

**Settings → Environment Variables.** Add each to **Production** and **Preview**,
and point Preview at a _second_ Supabase project (§6 of
[DEPLOYMENT.md](DEPLOYMENT.md)).

| Variable                          | Scope                            | Secret  | Source            |
| --------------------------------- | -------------------------------- | ------- | ----------------- |
| `NEXT_PUBLIC_SITE_URL`            | **required**                     | no      | your domain       |
| `NEXT_PUBLIC_SUPABASE_URL`        | **required**                     | no      | Supabase (§3)     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`   | **required**                     | no¹     | Supabase (§3)     |
| `SUPABASE_SERVICE_ROLE_KEY`       | **required**                     | **yes** | Supabase (§3)     |
| `TURN_URLS`                       | recommended                      | no      | TURN (§4)         |
| `TURN_SHARED_SECRET`              | recommended                      | **yes** | TURN (§4)         |
| `TURN_CREDENTIAL_TTL_SECONDS`     | optional                         | no      | you — default 600 |
| `TURN_USERNAME` / `TURN_PASSWORD` | alternative to the shared secret | **yes** | TURN (§4)         |

¹ Public **by design** — it carries no privileges of its own and is compiled into
the browser bundle. Row Level Security is what protects the data, which is why
every table gets a policy before it gets a feature.

### Secret or Config

Vercel asks which each variable is, and refuses to save a `NEXT_PUBLIC_` one
marked **Secret** — correctly, because a Secret is write-only and a
`NEXT_PUBLIC_` value is compiled into the browser bundle, where it is readable by
anyone. The two cannot both be true.

The prefix is the whole rule:

| Variable                                   | Type       |
| ------------------------------------------ | ---------- |
| `NEXT_PUBLIC_SITE_URL`                     | **Config** |
| `NEXT_PUBLIC_SUPABASE_URL`                 | **Config** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`            | **Config** |
| `SUPABASE_SERVICE_ROLE_KEY`                | **Secret** |
| `TURN_SHARED_SECRET`, `TURN_PASSWORD`      | **Secret** |
| `TURN_URLS`, `TURN_CREDENTIAL_TTL_SECONDS` | Config     |

The anon key feels like it should be Secret and is not. Marking it so does not
make it private — the value still ships to every browser — it only stops you
reading it back in the dashboard.

Two things do **not** go here:

- **SMTP credentials.** Supabase sends KITH's mail, so they belong in the
  Supabase dashboard (§6).
- **`SUPABASE_ACCESS_TOKEN`.** It manages your whole Supabase _account_, not this
  project. GitHub Actions secret only; nothing the application runs needs it.

### `NEXT_PUBLIC_SITE_URL` is the one to get right

Set it to the exact public origin, with `https://` and no trailing slash:

```
https://kith.example.com
```

It is the origin baked into every email KITH sends — signup confirmation,
password recovery, email change — and into `metadataBase`. A production build
**refuses** a loopback or plain-http value, so getting it wrong fails the deploy
rather than mailing every new member a link to nowhere. That guard exists because
the failure without it is invisible: the build succeeds, the site renders, and
the problem lands in a stranger's inbox hours later.

Set it to the custom domain from the start, not the `.vercel.app` URL. Changing
it later means changing Supabase's redirect allowlist in lockstep, and any
password-reset email sent in between points at the old origin.

---

## 3 · Which values come from Supabase

**Supabase dashboard → Project Settings → API.**

| Vercel variable                 | Supabase field              |
| ------------------------------- | --------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Project URL                 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` / publishable key    |
| `SUPABASE_SERVICE_ROLE_KEY`     | `service_role` / secret key |

### The mistake to be careful about

Pasting the **service-role key** into `NEXT_PUBLIC_SUPABASE_ANON_KEY` is the
single most damaging thing available here. It works perfectly — every query
succeeds, because RLS is bypassed — and it publishes full read/write access to
the entire database in the browser bundle, where anyone can open devtools and
read it. Nothing about the app's behaviour would reveal it.

Three independent things catch it:

1. `src/lib/env/schema.ts` decodes the key's `role` claim and checks the
   `sb_secret_` / `sb_publishable_` prefixes, **in both directions**, and refuses
   to boot.
2. `npm run check:bundle` scans the built bundle on every Vercel deploy.
3. `npm run smoke` decodes every JWT actually served to a browser and fails if
   any carries `role: service_role`.

The dashboard labels the two keys clearly. Copy them one at a time.

---

## 4 · Which values come from TURN

Entirely optional — with none of it set, calls run on public STUN exactly as they
did before TURN existed, and a fresh clone makes calls without anybody signing up
for a relay.

What you lose without it is not random. STUN cannot solve symmetric NAT,
carrier-grade NAT (most mobile networks), or a corporate firewall that drops UDP
— exactly the networks people are on when they most want to call.

From your relay provider (Twilio, Metered, Cloudflare Calls, or self-hosted
coturn):

| Vercel variable      | Provider field                                               |
| -------------------- | ------------------------------------------------------------ |
| `TURN_URLS`          | The relay URLs, comma-separated                              |
| `TURN_SHARED_SECRET` | The shared/static auth secret (coturn: `static-auth-secret`) |

Configure all three transports:

```
turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp,turns:relay.example.com:5349?transport=tcp
```

TLS on 443 is the one people skip and the one that matters most — to a firewall
it is indistinguishable from HTTPS, which is the point. The app warns at boot if
it is missing, because the symptom of leaving it out is _"calls work for
everybody except the person in the office"_.

Prefer `TURN_SHARED_SECRET` over `TURN_USERNAME`/`TURN_PASSWORD`. The server
mints a short-lived credential per user per call and hands the browser that —
never the secret — so rotating it invalidates every outstanding credential at
once. Static credentials do not expire, which is precisely their weakness.

Setting `TURN_URLS` with no credentials is a **boot error**, deliberately: a
relay that looks configured and is not means nobody investigates why calls fail.

---

## 5 · Build settings

Leave the defaults. `vercel.json` supplies everything that needs supplying:

| Setting          | Value                                   | Why                                              |
| ---------------- | --------------------------------------- | ------------------------------------------------ |
| Framework        | Next.js                                 | From `vercel.json`                               |
| Build command    | `npm run build && npm run check:bundle` | From `vercel.json` — the scan needs real secrets |
| Install command  | `npm install` _(default)_               | —                                                |
| Output directory | _(default)_                             | Next.js is detected                              |
| Node version     | 22 or later                             | **Settings → General**                           |
| Root directory   | `./`                                    | —                                                |

Do **not** override the build command in the dashboard. A dashboard override
silently wins over `vercel.json`, and the thing it would drop is the secret scan.

Do **not** set the build command to `build:local`. That is the localhost opt-out
for smoke-testing a bundle on your own machine; on Vercel it would allow a
loopback origin, and every email the app sends would point at nowhere.

### Regions

Set the function region to whichever is nearest your **Supabase project**, not
your users — every request makes several database round trips and one of them
crossing an ocean costs more than the user's own latency. **Settings → Functions
→ Region.**

---

## 6 · Supabase redirect URLs

**The step most likely to be skipped, and it breaks signup completely.**

Every email link KITH builds lands on `/auth/confirm`, which consumes the token
server-side and never puts it in the browser's URL bar, `history`, or the
`Referer` header of the next request. Supabase refuses to send a link to an
origin that is not on its allowlist.

**Supabase → Authentication → URL Configuration:**

| Field             | Value                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| **Site URL**      | `https://kith.example.com` — byte-identical to `NEXT_PUBLIC_SITE_URL` |
| **Redirect URLs** | `https://kith.example.com/auth/confirm`                               |
|                   | `https://kith.example.com/auth/confirm?next=/reset-password`          |
|                   | `https://*-<your-team>.vercel.app/auth/confirm` _(previews only)_     |

That set is asserted by `npm run deploy:test` against what the code actually
constructs, so if the app ever grows a new email link the suite fails and this
table gets updated rather than quietly going stale.

If you skip this, the symptom is a confirmation email that fails for everybody —
found by your first real user rather than by you.

### While you are in the dashboard: SMTP

**Project Settings → Authentication → SMTP Settings.** Required, not optional.

Supabase's built-in mailer is capped at a handful of messages an hour and is
explicitly labelled development-only. Signup confirmation and password recovery
are not optional features: without working mail nobody can join and nobody can
recover an account.

Use a domain with SPF and DKIM configured. Mail from a fresh domain with neither
goes to spam, and "the confirmation email never arrived" is indistinguishable
from "the app is broken".

### And the schema

Migrations are not applied by Vercel. Run them yourself, **before** the first
deploy:

```bash
npx supabase link --project-ref <prod-ref>
npm run db:push
```

Deploy the schema before the code that needs it, never after. A database ahead of
the app is unused columns; an app ahead of the database is an outage.

---

## 7 · Verifying the deployment

### Automatically

```bash
npm run smoke -- https://kith.example.com
```

Needs no credentials — only the public URL. It signs in as nobody, sends no
writes, and is safe to run against production as often as you like. Roughly
thirty checks, of which these are the ones a local test cannot make:

- **Supabase is reachable from Vercel** — `/api/health` issues a real query, so
  this distinguishes "the site loads" from "the site works". It catches a paused
  project, a wrong URL, and a rejected key.
- **No service-role key is served** — every JWT in the served JavaScript is
  decoded and its `role` claim checked.
- **The security headers survived the edge** — set in `next.config.ts`, but a
  proxy or a dashboard override can strip them.
- **Middleware is running** — a signed-out request to `/messages` must redirect.
  If middleware is not running, protected pages render empty rather than
  redirecting, and the app looks broken rather than protected.
- **The PWA surface is served, not redirected** — a manifest that 307s to
  `/login` is one a browser refuses to install from, and a service worker served
  a redirect fails registration outright.
- **`/auth/confirm` handles a missing token**, and cannot be pointed at another
  origin.
- **No localhost origin is baked in**, which is the belt to the env guard's
  braces.

Exit code 1 on any failure. Warnings are things worth looking at, not proof of a
broken deploy.

You can rehearse it before you ever deploy:

```bash
npm run build:local && npm run start:local     # a real production bundle
npm run smoke -- http://localhost:3000
```

It will report Supabase as unconfigured, which is correct — that is what a
missing project looks like.

### By hand

The smoke test cannot open an inbox, grant a microphone permission, or be two
people. From [PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md):

- [ ] Sign up with a real invite code; **the email arrives** and its link works
- [ ] Password reset end to end — both browsers signed out afterwards
- [ ] A real call between two networks, ideally one on mobile data
- [ ] Install as a PWA on a phone; sign in and call from inside it
- [ ] The smoke pass in [MANUAL-TESTING.md](MANUAL-TESTING.md) §0 — every route
      loaded once, because no automated test in this project renders a page

### If something is wrong

**The app rolls back instantly** — Vercel → Deployments → Promote a previous one.
No rebuild, no wait.

**The database does not.** Migrations are forward-only, which is why
`deploy:test` refuses any migration containing `drop table`, `drop column` or
`truncate`: an additive migration that turns out to be wrong is fixed by another
migration, while a destructive one that has already run is not.
