# Supabase — credentials and setup

Where every credential belongs, what it can do, and what happens if it ends up
somewhere it should not.

---

## The credential map

Read the "Reaches the browser?" column first. It is the only one that matters at
3am.

| Credential                    | Set as                            | Reaches the browser? | What it can do                                                                                                                | If it leaks                                                                                                                |
| ----------------------------- | --------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Project URL**               | `NEXT_PUBLIC_SUPABASE_URL`        | **Yes — by design**  | Names your project. Not a secret; it is in every request the browser makes anyway.                                            | Nothing. It is public.                                                                                                     |
| **Publishable / anon key**    | `NEXT_PUBLIC_SUPABASE_ANON_KEY`   | **Yes — by design**  | Identifies the app to Supabase. Carries **no privileges of its own**: every query it makes is filtered by Row Level Security. | Nothing, _provided RLS is on and correct_. This is exactly why every table gets a policy in the migration that creates it. |
| **Service role / secret key** | `SUPABASE_SERVICE_ROLE_KEY`       | **NEVER**            | **Bypasses RLS entirely.** Read and write every row, for every user, with no policy applied.                                  | Total compromise. Every message, every account. Rotate immediately and assume the data was read.                           |
| **JWT secret**                | _not used by this app_            | **NEVER**            | Signs and verifies auth tokens. Whoever holds it can forge a session for any user.                                            | Total compromise, and harder to detect — the forged sessions look legitimate. Lives in the Supabase dashboard only.        |
| **Database password**         | _not used by this app_            | **NEVER**            | Direct `psql` / connection-string access. Ignores RLS, and can drop tables.                                                   | Total compromise. Used only by the CLI and by you, never by the running app.                                               |
| **Personal access token**     | `SUPABASE_ACCESS_TOKEN` (CI only) | **NEVER**            | Manages your Supabase _account_ — every project, not just this one. Used by the CLI to push migrations.                       | Every project on the account. Scope it to CI and rotate on any suspicion.                                                  |
| **Project ref**               | CLI argument                      | Harmless             | Identifies the project (`abcdefghijklm`).                                                                                     | Nothing. It is the subdomain of the public URL.                                                                            |

### The one mistake that matters

Pasting the **service-role key** into `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

It is easy to do — the two keys sit next to each other in the dashboard and look
identical. And it _works_: every query succeeds, faster than before, because RLS
is no longer in the way. Nothing in the app's behaviour looks wrong. Meanwhile
the key is compiled into the JavaScript bundle and served to anyone who visits.

So the app refuses to start. `src/lib/env/schema.ts` decodes the key's `role`
claim (and checks for the `sb_secret_` prefix on the newer key format) and fails
validation with an explicit message. It is worth the twenty lines.

---

## Where each value is set, per environment

|                                 | Local        | Preview (Vercel)                  | Production (Vercel)               |
| ------------------------------- | ------------ | --------------------------------- | --------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | `.env.local` | Preview env var → staging project | Production env var → prod project |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `.env.local` | Preview env var → staging project | Production env var → prod project |
| `SUPABASE_SERVICE_ROLE_KEY`     | `.env.local` | Preview env var → staging project | Production env var → prod project |
| `SUPABASE_ACCESS_TOKEN`         | not needed   | —                                 | GitHub Actions secret             |

`.env.local` is git-ignored. `.env.example` is the only env file that is
committed, and it contains no values.

**Preview deployments point at staging, never production.** A pull request must
never be able to delete real messages.

---

## Setting it up

### 1. Create the projects

Two projects on [supabase.com](https://supabase.com): `kith-staging` and
`kith-production`. Same region as the Vercel deployment — every query pays the
round trip.

### 2. Local environment

```bash
cp .env.example .env.local
```

From **Project Settings → API**, fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable / anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role / secret key>
```

Everything before authentication runs without these — the landing page has no
database in it, so `npm run dev` and `npm run build` work on a fresh clone with
no configuration. The Supabase clients validate their credentials lazily, on
first use, and fail with a message naming the missing variable.

### 3. Local database (optional, needs Docker)

```bash
npx supabase init
npx supabase login
npx supabase link --project-ref <ref>

npm run db:start     # full stack on localhost
npm run db:reset     # replay every migration from scratch
```

Developing against local Postgres is faster and cannot damage anything. It is
also the only way to test a migration before it runs against real data.

### 4. Types

```bash
npm run db:types     # regenerates src/types/database.ts from local
```

Run it after **every** schema change. The generated file is committed, so a
stale one shows up as a diff in review rather than as a runtime surprise.

---

## Which client to use

Four modules in `src/lib/supabase/`. The choice is not a preference.

| Module                                       | Key              | RLS          | Use it in                                                                    |
| -------------------------------------------- | ---------------- | ------------ | ---------------------------------------------------------------------------- |
| `client.ts` → `getSupabaseBrowserClient()`   | anon             | **enforced** | Client components. One singleton per tab.                                    |
| `server.ts` → `createSupabaseServerClient()` | anon             | **enforced** | Server Components, Server Actions, Route Handlers. New instance per request. |
| `middleware.ts` → `updateSession()`          | anon             | **enforced** | `src/middleware.ts` only. Refreshes the session.                             |
| `admin.ts` → `getSupabaseAdminClient()`      | **service role** | **bypassed** | Almost nowhere. See below.                                                   |

`server.ts` and `admin.ts` both start with `import "server-only"`, so a client
component that imports either — directly or through any chain — fails the build
instead of shipping a secret.

### Before reaching for the admin client

Ask whether the operation belongs in an RLS policy instead. It usually does. The
legitimate cases are narrow, and each one carries a comment at the call site
saying why the user-scoped client cannot do the job:

- redeeming an invite code, where the caller has no account yet
- resolving an authoritative game move, where the server owns hidden state
- a scheduled job with no user session (expiring stale ringing calls)
- reading another user's row during moderation, deliberately and audited

"It was easier than writing the policy" is not on that list.

### `getUser()`, not `getSession()`

On the server, always `getUser()`. `getSession()` decodes the cookie and trusts
it; `getUser()` revalidates the token against the Auth server. A cookie is
attacker-controlled input, so the difference is the difference between a check
and a formality.

---

## Why middleware is not optional

Supabase access tokens are short-lived. Something must exchange the refresh token
and write the rotated cookies back to the browser — and in the App Router, Server
Components are not permitted to set cookies. Middleware is the only place it can
happen.

Delete `src/middleware.ts` and everyone gets signed out roughly every hour,
intermittently, in a way that looks like a Supabase bug.

The corresponding trap when route protection is added in Phase 3: **return the
response `updateSession()` produced**, or copy its cookies onto whatever redirect
replaces it. Constructing a fresh `NextResponse` silently discards the refreshed
tokens.

It also reads the session's assurance level, and the order of the two calls
matters: `getAuthenticatorAssuranceLevel()` decodes the `aal` claim out of the
access token locally, which is only trustworthy because `getUser()` revalidated
that exact token against the Auth server a few lines earlier. Swapping them turns
the check into a formality. Routing is not the enforcement either way — see
[MFA.md](MFA.md).

---

## Rotation

If a service-role key is ever exposed — a screenshot, a log, a commit — treat the
data as read.

1. Supabase dashboard → **Project Settings → API → Rotate**
2. Update the Vercel environment variable, both environments
3. Redeploy
4. Check the Postgres logs for the window between exposure and rotation

The anon key does not need rotating on exposure. It is public by design. If
exposing it _does_ create a problem, the problem is a missing RLS policy, and
rotating the key would only hide it.

---

## Free-tier limits worth knowing now

Verify current numbers when the projects are created — these move.

- **Projects pause after about a week of inactivity.** A six-person app will hit
  this. `/api/health` exists to be pinged on a schedule for exactly this reason.
- **Auth emails are heavily rate-limited** and intended for development. Custom
  SMTP is required before any real user is invited — verification and password
  reset are core functionality, not polish.
- **Realtime messages are capped monthly.** ICE trickle and per-tick game input
  are what burn it; both are batched on `BROADCAST_BATCH_MS`.
- **Backups on the free tier are limited.** A weekly `pg_dump` to encrypted
  object storage costs nothing and is the difference between an incident and a
  catastrophe.
