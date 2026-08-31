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

| Script                       | What it does                                              |
| ---------------------------- | --------------------------------------------------------- |
| `npm run dev`                | Development server (Turbopack) at `localhost:3000`        |
| `npm run build`              | Production build                                          |
| `npm start`                  | Serve a production build                                  |
| `npm run typecheck`          | `tsc --noEmit` against the strict config                  |
| `npm run lint`               | ESLint, including the architectural import boundaries     |
| `npm run lint:fix`           | ESLint with autofix                                       |
| `npm run format`             | Prettier write (sorts Tailwind classes)                   |
| `npm run format:check`       | Prettier check — what CI runs                             |
| `npm run check`              | `typecheck` + `lint` + `format:check`. Run before pushing |
| `npm run clean`              | Remove `.next` and the build cache                        |
| `npm run check:bundle`       | Scan the built client bundle for server-only secrets      |
| `npm run db:start`           | Local Supabase stack (needs Docker)                       |
| `npm run db:reset`           | Drop and replay every migration                           |
| `npm run db:diff`            | Capture local schema changes as a migration               |
| `npm run test`               | Every suite below, in order                               |
| `npm run db:test`            | Schema and RLS                                            |
| `npm run auth:test`          | Redirect rules, validation, invite redemption             |
| `npm run profile:test`       | Profile triggers, username rules, storage policies        |
| `npm run friends:test`       | Requests, friendships, the constraints behind them        |
| `npm run presence:test`      | The presence resolution rule and its channel policy       |
| `npm run messages:test`      | Membership, pagination, reactions, sanitisation           |
| `npm run notifications:test` | Fan-out, collapsing, read state                           |
| `npm run webrtc:test`        | Two real peers connecting, and perfect negotiation        |
| `npm run calls:test`         | The call lifecycle and who may do what to it              |
| `npm run call-session:test`  | Two sessions, one call, end to end                        |
| `npm run screen-share:test`  | Capture, stopping, and the one-sender rule                |
| `npm run turn:test`          | Relay credentials, transports, and the route              |
| `npm run db:types`           | Regenerate `src/types/database.ts` from the migrations    |
| `npm run db:types:check`     | Fail if the generated types have drifted (for CI)         |

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
│   ├── webrtc/           Peer connection, media, signalling contract. No React.
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
imports a feature. **All of this is enforced in `eslint.config.mjs`**, including the
cross-feature rule — which was quietly false until presence needed to be shared and the
violations came to light. Anything two features need lives in `lib/` (`presence.ts`,
`forms.ts`, `validation.ts`) or `components/`.

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

**[docs/SUPABASE.md](docs/SUPABASE.md) and [docs/TURN.md](docs/TURN.md) are the credential maps** — what each key can do,
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

#### Profiles

| Route               |                                    |
| ------------------- | ---------------------------------- |
| `/u/[username]`     | Anyone's profile. Case-insensitive |
| `/settings/profile` | Edit your own                      |

Username, display name, avatar, bio, pronouns, accent, status, optional birthday,
joined date and online state. Three decisions worth knowing:

- **`avatar_path`, not `avatar_url`.** The bucket is private, so avatars are
  served through short-lived signed URLs minted per request. A column named
  `avatar_url` invites somebody to store one, and a stored signed URL works for
  ten minutes and then renders a broken image forever.
- **Presence is observed, not declared.** `last_seen_at` is pinned by a trigger
  so a client cannot write its own — only the throttled `touch_last_seen()` can
  move it. A declared status (`away`, `busy`, `invisible`) always overrides the
  heartbeat, because a privacy control that leaks is worse than none.
- **The birthday year is stored but never rendered.** Day and month only.

Avatars are resized to 512px and re-encoded as WebP **in the browser** before
upload, then go straight to Storage rather than through a server action — the
bucket policy already restricts the write to the uploader's own folder, so a
server in the middle adds a round trip and no check.

### Friends

| Route      |                                                                   |
| ---------- | ----------------------------------------------------------------- |
| `/friends` | Friends, incoming requests, sent requests, and search — four tabs |

Search, send, accept, decline, withdraw, remove. The page opens on Requests when
somebody is waiting, because that is the tab that needs a decision.

**Everything the brief asks to prevent is prevented by the database, not by this
code.** Delete every check in `features/friends/actions.ts` and the guarantees
still hold:

|                               | Enforced by                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No self-requests              | `friend_requests_no_self` CHECK                                                                                                                                   |
| No duplicate friendships      | primary key on the canonical `(low, high)` pair                                                                                                                   |
| No duplicate pending requests | partial unique index on the **unordered** pair, so A→B blocks B→A too                                                                                             |
| No unauthorized modification  | RLS. Accept and withdraw are _separate_ policies with different permitted target states — one policy allowing both would let a requester accept their own request |

Search has three rules that are privacy decisions rather than features: a blank
query returns nothing (an empty search that lists everyone is a member
directory), `discoverable = false` hides you from strangers but not from
existing friends, and a blocked person is absent from the result set entirely
rather than shown as "no results".

### Presence

Realtime Presence on one channel, `presence:lobby`, for the whole room — no
database writes and no polling. Shown on the friend list, on profiles, and as a
count in the header ("3 in the room").

**The load-bearing rule is what happens when we do NOT know.** The live map is
`null` whenever there is no subscription — server rendering, a dropped socket,
Supabase unreachable — and `null` makes every consumer fall back to
`last_seen_at`. An empty map means "nobody is online"; `null` means "ask the
database". Conflating those two is exactly how an app ends up showing five lit
embers forever after its socket died.

Resolution order, in [use-presence.ts](src/components/presence/use-presence.ts):

1. A **declared** status wins outright. `invisible` reads as offline even to a
   client that can see the person on the channel — and an invisible user never
   joins it in the first place, so the meta never leaves their browser.
2. With a live map, it is **authoritative including absence**. Not in the set
   means offline, full stop.
3. With no live map, fall back to `last_seen_at`.

Idle is a hidden tab (immediately) or five minutes without a pointer or key.
The `last_seen_at` heartbeat still runs alongside: the channel answers "who is
here now", the heartbeat answers "when were they last here" after they leave.

### Messaging

| Route            |                                                        |
| ---------------- | ------------------------------------------------------ |
| `/messages`      | Conversation list. On a phone this IS the page         |
| `/messages/[id]` | The thread. Two panes on a wide screen, one on a phone |

One-to-one and group conversations, realtime delivery, typing indicators, read
state, reactions, sender-only deletion, and infinite scroll upward.

**Pagination is keyset, not offset.** `offset 40 limit 20` makes the database
walk and discard 40 rows per page, and — worse in a feed that grows from the end
you are reading — a message arriving mid-scroll shifts every later page by one,
so you see a duplicate or a gap. The cursor is a specific message, which is
stable under concurrent writes and is one index seek however deep you scroll.

**Realtime is broadcast from a database trigger**, not Postgres Changes. A
trigger is one fan-out rather than an RLS re-evaluation per subscriber per row,
and it lets the payload be shaped — so deleting a message broadcasts the deletion
_without_ re-broadcasting the text it just removed. Authorization happens at
subscribe time, through the `conv:{id}` policy on `realtime.messages`.

**Typing indicators are never stored.** Client-to-client broadcast, throttled on
send and expired on receive — a sender who closes the tab mid-word never sends a
"stopped", so an indicator that waits for one stays on screen forever.

On sanitisation: message bodies are rendered as React children, never as HTML.
There is no `dangerouslySetInnerHTML` in this codebase. Links are the one place
raw input reaches an attribute, and only `http` and `https` produce one — a
`javascript:` URL stays plain text. Stored messages are stripped of control
characters and bidirectional overrides ("Trojan Source"), which have no
legitimate use in a chat message and several illegitimate ones.

### Notifications

A bell in the app header with a live badge and a dropdown panel. Six kinds:
friend requests, accepted requests, new messages, missed calls, game
invitations and couple proposals.

**No client can create a notification.** `notifications` has no INSERT policy at
all — every row arrives from a `SECURITY DEFINER` trigger, so the actor is
whoever the database saw rather than whoever the request claimed to be. Without
that rule, any account could write into any other account's feed: a spam and
phishing channel delivered by the product itself.

Three efficiency decisions that are really correctness decisions:

- **Message notifications collapse per conversation.** A new one is raised only
  when there is no _unread_ one for that conversation already, so a forty-message
  evening produces one row and the badge counts conversations that want you —
  a number a person can act on.
- **Reading a conversation marks its notification read**, in the same
  transaction. A badge that outlives the reason for it is a badge nobody looks
  at twice.
- **Muted conversations raise nothing**, and you are never notified of your own
  actions.

Delivery is a broadcast onto `user:{id}`, the personal bus — read-only from a
browser, so notifications are delivered _to_ you there and nobody can broadcast
into somebody else's. Read notifications older than 30 days are pruned by a
scheduled job; unread ones never are, however old.

Browser push is deliberately not built. It needs a service worker and VAPID
keys, and on iOS an installed PWA — a separate piece of work rather than a
finishing touch on this one.

## What is deliberately absent

- **No 2FA yet.** It is the next phase, and the schema already has the AAL2
  step-up policies waiting for it.
- **Sign-in errors never say whether an account exists.** On an invitation-only
  app, "no account with that email" tells a stranger who is a member.
- **Nothing logs a password.** Not on success, not on failure. Every log line in
  the auth path carries a status code and an error message, never an input.

## What is next

Voice and video calls: WebRTC, TURN, and the call UI. Then the nav rail — which
now has destinations and your people to put in it — followed by blocking and
reporting surfaces and two-factor authentication. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full phase plan.

## Licence

Private. Not for distribution.
