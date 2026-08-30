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
project settings for each environment. See `.env.example` for the variables that later
phases will need — they are documented but deliberately not yet validated.

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
(`full` / `reduced` / `off`) driven by the `data-motion` attribute on `<html>`. GSAP,
Framer Motion and Lenis are **not** installed: the overlay primitives reach the motion
spec with native `<dialog>` and CSS `@starting-style`, so a library would have bought
nothing. They arrive with the app shell, where shared-element transitions and drag start
to need them.

### Components

`src/components/ui/` holds the design-system primitives — icons, button, input, field,
panel, card, avatar, badge, presence ember, dialog, menu, toast, skeleton, empty state.
`src/components/layout/` holds the chrome — nav rail, mobile nav bar, theme toggle.

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

## What is next

Phase 2 is identity: invite-gated signup, email verification, password reset, session
middleware, the `profiles` table and its RLS policies. See the architecture document for
the full phase plan.

## Licence

Private. Not for distribution.
