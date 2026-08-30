# KITH

**Your people. Your space.**

A private social space for a small group of friends — messages, calls and games, and
nobody else. Built as a production-quality application, not a demo.

> **Status: Phase 1 — Foundation.** The project scaffold, design-token system, strict
> TypeScript setup and architectural boundaries are in place. Authentication, messaging,
> calls and games are not built yet. Nothing in this repository pretends to work.

---

## Requirements

- **Node.js 20.9+** (22 LTS or 24 recommended)
- npm 10+

## Running it

```bash
npm install
cp .env.example .env.local   # optional — the app runs without it
npm run dev
```

Open <http://localhost:3000>.

The first `npm run dev` or `npm run build` downloads the three web fonts through
`next/font`, so it needs network access once. After that they are cached locally and
served from our own origin.

## Scripts

| Script                 | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `npm run dev`          | Development server (Turbopack) at `localhost:3000`        |
| `npm run build`        | Production build                                          |
| `npm start`            | Serve a production build                                  |
| `npm run typecheck`    | `tsc --noEmit` against the strict config                  |
| `npm run lint`         | ESLint, including the architectural import boundaries     |
| `npm run lint:fix`     | ESLint with autofix                                       |
| `npm run format`       | Prettier write (sorts Tailwind classes)                   |
| `npm run format:check` | Prettier check — what CI runs                             |
| `npm run check`        | `typecheck` + `lint` + `format:check`. Run before pushing |
| `npm run clean`        | Remove `.next` and the build cache                        |
| `npm run check:bundle` | Scan the built client bundle for server-only secrets      |
| `npm run db:start`     | Local Supabase stack (needs Docker)                       |
| `npm run db:reset`     | Drop and replay every migration                           |
| `npm run db:diff`      | Capture local schema changes as a migration               |
| `npm run db:types`     | Regenerate `src/types/database.ts`                        |
| `npm run test`         | Schema/RLS suite + authentication suite                   |
| `npm run db:test`      | RLS suite only                                            |
| `npm run auth:test`    | Redirect rules, validation, invite redemption             |

## Structure

```
src/
├── app/                  Routes only. Composition, not logic.
│   ├── api/health/       Liveness endpoint + Phase 2 keepalive target
│   ├── layout.tsx        Fonts, metadata, theme bootstrap
│   ├── page.tsx          Landing
│   ├── error.tsx         Route error boundary
│   ├── global-error.tsx  Root layout failure boundary
│   ├── not-found.tsx     404
│   └── globals.css       Tailwind entry + token → theme mapping
│
├── components/
│   ├── ui/               Design-system primitives. Generic, no feature knowledge.
│   └── layout/           App chrome
│
├── features/             Vertical slices. All business logic. See features/README.md
│
├── lib/
│   ├── env/              Zod-validated environment, split client / server
│   ├── server/           server-only modules. See lib/server/README.md
│   ├── utils/            cn() and friends
│   ├── result.ts         Typed Result<T, E> for anything that can fail
│   └── constants.ts      Brand and site constants
│
├── styles/
│   └── tokens.css        The visual identity. Single source of truth.
│
└── types/                Cross-cutting types; generated database.ts lands here
```

### Dependencies point inward

```
app/  →  features/  →  lib/ + components/ui/
```

A feature never imports another feature. `lib/` never imports UI. `components/ui/` never
imports a feature. ESLint enforces the outer edges of this in `eslint.config.mjs` — these
rules are cheap now and very expensive to retrofit once the dependency graph has set.

Two boundaries are already wired for phases that do not exist yet:

- `app/**` may not import `@supabase/*` directly — routes go through `lib/supabase` or a slice.
- `lib/**` may not import `@/components/*` or `@/features/*`.

## TypeScript policy

`tsconfig.json` is strict beyond `"strict": true`:

| Flag                                      | Why                                                             |
| ----------------------------------------- | --------------------------------------------------------------- |
| `noUncheckedIndexedAccess`                | Array and record lookups are `T \| undefined`, because they are |
| `exactOptionalPropertyTypes`              | `{ x?: string }` will not accept an explicit `undefined`        |
| `noImplicitOverride`, `noImplicitReturns` | Catches silent refactor breakage                                |
| `noUnusedLocals`, `noUnusedParameters`    | Dead code fails the typecheck, not just the linter              |
| `noFallthroughCasesInSwitch`              | Relevant the moment state machines arrive (calls, games)        |
| `forceConsistentCasingInFileNames`        | Development is on Windows, deployment is on Linux               |

Do not loosen these per file. Fix the type. A `@ts-expect-error` needs a comment saying why.

## Environment

All environment access goes through `src/lib/env/`, never `process.env` at a call site.

- `env/client.ts` — public `NEXT_PUBLIC_*` values. Safe anywhere.
- `env/server.ts` — secrets. Starts with `import "server-only"`, so a client import is a
  build failure rather than a leak.

Adding a variable means three edits: the Zod schema, `.env.example`, and the Vercel
project settings for each environment.

The app runs on a fresh clone with **no configuration at all** — the landing page has no
database in it, so Supabase credentials are validated lazily, when a client is first
constructed, rather than at import.

## Supabase

Four clients in `src/lib/supabase/`, and the choice between them is not a preference:

| Module          | Key              | RLS          | Where                                                    |
| --------------- | ---------------- | ------------ | -------------------------------------------------------- |
| `client.ts`     | anon             | **enforced** | Client components. One singleton per tab.                |
| `server.ts`     | anon             | **enforced** | Server Components, Actions, Route Handlers. Per request. |
| `middleware.ts` | anon             | **enforced** | `src/middleware.ts` only — refreshes the session.        |
| `admin.ts`      | **service role** | **bypassed** | Almost nowhere. Each use justified at the call site.     |

`src/middleware.ts` is not optional: Server Components cannot write cookies, so token
rotation has to happen in middleware or not at all. Without it everyone is signed out
about once an hour.

Two guards worth knowing about:

- The env schema **refuses to boot** if a service-role key is given to
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`. That mistake otherwise works perfectly while
  publishing full database access in the browser bundle.
- `npm run build && npm run check:bundle` scans the built client bundle for the value of
  every server-only secret and fails if one appears. Run it in CI.

**[docs/SUPABASE.md](docs/SUPABASE.md) is the credential map** — what each key can do,
where it belongs per environment, and what to do if one leaks.

Database work lives in `supabase/` — migrations only, never the dashboard. See
[supabase/README.md](supabase/README.md).

## Design system

The visual language is **"The Lit Room"**: a warm, dark interior where light means
presence. `src/styles/tokens.css` holds every colour, type, space, radius, elevation and
motion value; `globals.css` maps them into Tailwind.

Two modes: **Dusk** (default) and **Daylight** — the second is re-authored rather than
inverted. The choice persists in `localStorage` and is applied before first paint by a
small inline script, so there is no flash.

Three type faces, three jobs: **Fraunces** (display — its `SOFT`/`WONK` axes are what
keep it from reading as a stock serif), **Manrope** (interface), **Martian Mono**
(anything numeric). Manrope is a stand-in: General Sans is the intended interface face
but is not on Google Fonts. Drop the woff2 files into `public/fonts`, wire `next/font/local`,
and `--font-general-sans` in `tokens.css` takes over with no other change.

**Tailwind's default theme is deliberately cleared.** `bg-slate-800`, `text-xl` and
`rounded-lg` do not compile. Only KITH tokens do. If a value you want is missing, it is a
design decision, not a config gap — add it to `tokens.css`.

Motion tokens (`--t-*`, `--e-*`) are respected by a three-tier reduced-motion policy
(`full` / `reduced` / `off`) driven by the `data-motion` attribute on `<html>` and read
by JavaScript through `useMotionAllowed()`, so CSS and the animation layer can never
disagree.

**Framer Motion** (the `motion` package) is installed and used on the landing page only,
for the three things CSS cannot do: a shared-element indicator that travels between tabs,
coordinated enter/exit across a swap, and masked line reveals. The design-system overlay
primitives use native `<dialog>` and CSS `@starting-style` instead. GSAP and Lenis are
**not** installed and are not currently planned.

### Components

`src/components/ui/` holds the design-system primitives — icons, button, input, field,
panel, card, avatar, badge, presence ember, dialog, menu, toast, skeleton, empty state.
`src/components/layout/` holds the chrome — nav rail, mobile nav bar, theme toggle.
`src/features/landing/` holds the marketing page: one component per section, with all
copy in `copy.ts` so the writing can be read and edited in one place.

**`/styleguide` renders the whole system on one page**, in both modes. It is a
development tool and returns 404 in production:

```bash
npm run dev   # then open http://localhost:3000/styleguide
```

See [docs/DESIGN.md](docs/DESIGN.md) for what each component decides and why.

## Security posture at this phase

- Baseline security headers in `next.config.ts`, including a `Permissions-Policy` that
  grants camera/microphone/display-capture to our own origin only.
- `X-Powered-By` removed, `noindex` on all routes — KITH is invite-only.
- **No CSP yet.** A useful one needs a per-request nonce and the final list of
  `connect-src` origins (Supabase REST + Realtime WebSocket, TURN). Both arrive in
  Phase 2. A placeholder CSP that gets widened to `unsafe-inline` is worse than none.

## Authentication

Email and password through Supabase Auth, **invite-gated**. Routes:

| Route              |                                                               |
| ------------------ | ------------------------------------------------------------- |
| `/login`           | Sign in                                                       |
| `/signup`          | Create an account, with an invitation code                    |
| `/forgot-password` | Request a reset link                                          |
| `/reset-password`  | Set a new password (requires the recovery session)            |
| `/verify-email`    | Held here until the address is confirmed                      |
| `/auth/confirm`    | Where every email link lands; exchanges the token server-side |

### Getting the first account in

There is no public sign-up, which creates a chicken-and-egg problem: the first
person needs an invitation from someone who does not exist yet. So **while there
are no profiles at all, the first signup needs no code** — an empty room lets the
first person in, and everyone after them needs an invitation.

To issue one, hash the code and insert it (the plaintext is never stored):

```sql
-- Pick a code, e.g. kith-7f3a9c. Then:
insert into public.invite_codes (code_hash, created_by, note, max_uses)
values (encode(digest('kith-7f3a9c', 'sha256'), 'hex'), '<your-profile-id>', 'for Rafa', 1);
```

Send the plaintext code. `/signup?invite=kith-7f3a9c` prefills the field.

### The rules, in one place

`src/features/auth/redirects.ts` is a pure function with no Supabase and no
Next.js in it, so middleware and pages cannot disagree about who goes where — and
so the rules can be tested exhaustively without a database. Two that matter:

- An unverified account is held at `/verify-email` and **cannot walk around it**
  by navigating to `/login`.
- `?next=` is sanitised by `safeRedirect`. An open redirect is how a phishing
  link gets to wear your domain.

### What is deliberately absent

- **No 2FA yet.** It is the next phase, and the schema already has the AAL2
  step-up policies waiting for it.
- **Sign-in errors never say whether an account exists.** On an invitation-only
  app, "no account with that email" tells a stranger who is a member.
- **Nothing logs a password.** Not on success, not on failure. Every log line in
  the auth path carries a status code and an error message, never an input.

## What is next

Two-factor authentication: TOTP enrolment, the AAL2 challenge, recovery codes, and
wiring the step-up policies the schema already carries. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full phase plan.

## Licence

Private. Not for distribution.
