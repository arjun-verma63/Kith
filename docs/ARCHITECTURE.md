# KITH — Architecture

Reference document. Decisions recorded here are binding until superseded by a note in
this file; the reasoning matters as much as the choice.

## 1. System shape

A serverless-first Next.js application with a **Postgres-enforced trust boundary**. There
is no long-lived application server. Every durable authorization decision is made by
Postgres Row Level Security. Next.js renders and orchestrates; it is not the security
perimeter.

```
Browser (Next.js App Router)
  ├─ UI  →  feature hooks  →  server actions
  ├─ Realtime client (one websocket, N channels)
  └─ RTCPeerConnection (media, peer-to-peer, never through us)
        │              │                      │
     STUN/TURN    Supabase Realtime      Vercel Edge + Node
                  broadcast / presence   (middleware, RSC, actions,
                        │                 route handlers)
                        └──────┬──────────────────┘
                        Supabase Postgres
                        RLS · SECURITY DEFINER helpers
                        triggers → realtime.broadcast_changes()
                        pg_cron · Auth schema · Storage
```

## 2. The five laws

1. **Postgres is the authority.** Any rule that matters is an RLS policy or a
   `SECURITY DEFINER` function. Server actions add ergonomics and validation; they never
   replace database enforcement. A leaked anon key must be harmless.
2. **Three clients, three privileges.** Browser (anon key, RLS), server (cookie-bound
   user JWT, RLS), admin (service role, bypasses RLS, `import "server-only"`, used in at
   most a handful of places, each justified in a comment).
3. **Durable vs. ephemeral is an explicit decision per data type.** Survives a refresh →
   Postgres. Typing dot, ICE candidate, countdown tick → Realtime broadcast only.
4. **Vertical feature slices.** Logic in `features/<domain>/`. Components hold no data
   access.
5. **Media never touches our infrastructure.** WebRTC is peer-to-peer; TURN relays
   encrypted packets it cannot read. We store call metadata, never call content.

## 3. Data-flow patterns

| Need               | Pattern                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| Initial page data  | Server Component → server Supabase client → RLS-filtered query                    |
| Mutation           | Server Action → Zod parse → rate limit → RLS-scoped write → revalidate            |
| Live update        | Postgres trigger → `realtime.broadcast_changes()` → private channel → cache patch |
| Transient signal   | `channel.send({ type: "broadcast" })`, never persisted                            |
| Privileged compute | Route Handler (Node) → admin client → game authority, TURN credentials            |
| Media              | Browser ↔ browser, TURN relay on fallback                                         |

Client state: TanStack Query for server state (patched directly by realtime events, not
refetched); small Zustand stores per feature for ephemeral state; one `RealtimeProvider`
owning the single websocket and one `CallProvider` owning the peer connections, both
above the router so navigation never kills a call.

## 4. Database entities

Built in phase order. `id uuid default gen_random_uuid()`, `created_at timestamptz`.

**Identity** — `profiles` (username citext unique, display_name, avatar_url, bio,
pronouns, accent, last_seen_at), `user_settings` (discoverability, who_can_call,
read_receipts, typing_indicators, theme, notification_prefs), `invite_codes`
(code_hash, created_by, max_uses, uses, expires_at, revoked_at), `security_events`.

**Social graph** — `friend_requests` (partial unique index on pending pairs),
`friendships` (`CHECK (user_low < user_high)` canonical ordering — halves the index
count and simplifies every policy), `blocks`, `reports`.

**Messaging** — `conversations` (dm/group, deterministic unique key on the DM member
pair), `conversation_members` (`last_read_at` _is_ the read-receipt model at this
scale), `messages`, `message_reactions`, private Storage bucket for attachments.

**Calls** — `calls` (status, end_reason; `pg_cron` expires stale `ringing` rows to
`missed`), `call_participants`. SDP and ICE are never stored.

**Games** — `games` (catalog, FK target), `game_sessions` (`state` jsonb +
`state_version` for compare-and-swap), `game_players`, `game_moves` (append-only,
enables replay), `game_results`.

**Couple** — `couples` (mutual acceptance, canonical ordering, partial unique index for
at most one active couple per user), `couple_prompts` / `couple_answers` (hidden until
both submit — enforced in RLS, not UI), `couple_milestones`, `couple_notes`.

**System** — `notifications`, `rate_limits`, `app_config`.

## 5. Security

| Layer         | Control                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| Edge          | Security headers; CSP with a per-request nonce from Phase 2                                 |
| Entry         | **Invite-gated signup.** Open registration on a six-person private app is the wrong default |
| Identity      | Supabase Auth, mandatory email verification, TOTP MFA (AAL2)                                |
| Session       | httpOnly/secure/sameSite cookies via `@supabase/ssr`, refreshed in middleware               |
| Authorization | RLS on every table, `FORCE ROW LEVEL SECURITY`, deny by default                             |
| Input         | Zod at every boundary — actions, route handlers, **and realtime payloads**                  |
| Abuse         | Postgres token-bucket rate limits on sends, requests, calls, invites, resets                |
| Audit         | `security_events` on login, MFA change, password change, block, report                      |

### RLS rules that prevent the known failures

- No table has a client-writable `user_id`; it is `DEFAULT auth.uid()` and pinned by a
  `WITH CHECK` policy.
- Wrap as `(select auth.uid())` so Postgres caches it as an InitPlan instead of
  re-evaluating per row.
- **Break policy recursion with `SECURITY DEFINER` helpers.** The canonical footgun is
  `conversation_members` policies referencing `conversations` whose policies reference
  `conversation_members`. Use `is_conversation_member()`, `are_friends()`,
  `is_blocked_either()` — `SECURITY DEFINER STABLE`, **`SET search_path = ''`**, fully
  qualified table names. The pinned search_path is not optional; a mutable one is a
  privilege-escalation vector.
- Blocks are a first-class predicate in messages, requests, calls, invites and profile
  visibility. A blocked user must fail at the database, not at the UI.
- Sensitive operations carry `(select auth.jwt()->>'aal') = 'aal2'`. UI gating alone is
  theatre.
- pgTAP suite asserting the negative cases per table, in CI on every migration.

**Secrets.** `NEXT_PUBLIC_*` is the anon key and URL only — both are designed to be
public and RLS is what protects the data. Service role, TURN shared secret and SMTP
credentials are server-only behind `import "server-only"`. TURN credentials are minted
per call with an HMAC over a short expiry, never embedded in client code.

## 6. Realtime

All channels are private; subscription is gated by RLS on `realtime.messages`.

| Channel          | Purpose                                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| `user:{id}`      | Personal bus — incoming call, friend request, notification, private game deltas |
| `presence:lobby` | Group presence and current activity                                             |
| `conv:{id}`      | Message events, typing, read cursors                                            |
| `call:{id}`      | SDP, ICE, media state, hangup                                                   |
| `game:{id}`      | Public game state and phase                                                     |

Durable events use a Postgres trigger calling `realtime.broadcast_changes()` rather than
Postgres Changes: Changes re-evaluates RLS per subscriber per row, while broadcast is a
single fan-out and lets us shape the payload — so a column rename is not a client
breaking change.

One `RealtimeProvider` owns one websocket behind a ref-counted channel registry. On
reconnect every feature **resyncs** (fetch rows newer than the last seen id) before
resuming live. Never assume the stream was gap-free.

Presence uses Realtime Presence plus a throttled `profiles.last_seen_at` write (at most
once per 60s, plus one on `beforeunload`) for "last seen".

**Message budget.** The free tier caps monthly realtime messages. ICE trickle and game
input are what burn it, so ICE candidates batch on a ~200ms timer and game input is
throttled to a fixed tick rate. This is designed in, not retrofitted.

## 7. WebRTC

> Implemented. **[WEBRTC.md](WEBRTC.md) is the detailed reference for the connection,
> [CALLS.md](CALLS.md) for the call lifecycle**; this section is the summary and records
> where the plan moved.

**Full mesh**, which is optimal for 1:1 and sound to about four participants — upstream
bandwidth and CPU grow linearly with peers. Group video is capped at 4 with an explicit
UI limit. The escape hatch is an SFU (LiveKit or mediasoup); the negotiation code is
isolated in `lib/webrtc/peer.ts` so that swap does not touch UI.

The plan put `peer.ts` under `features/calls/`. It ended up in `lib/webrtc/` instead,
because a module that imports nothing from React, Supabase or the DOM can be run against
a real native WebRTC stack in Node — which is what makes "two peers can connect" a test
rather than a claim. `features/calls/` keeps the React hooks and the one file that knows
signalling goes over Supabase.

Signaling: create the `calls` row via a server action → trigger broadcasts
`call.incoming` to `user:{callee}` → on accept both join `call:{id}` → **perfect
negotiation** with the lower user id as the impolite peer (deterministic, no coin flip).
This is what stops simultaneous renegotiation — someone starting a screen share exactly
as someone else toggles video — from deadlocking the connection.

**TURN is required, not optional** — though not yet built (STUN only, by phase
instruction; `buildIceConfiguration()` already takes the relay list). A meaningful share of real pairs (symmetric NAT,
carrier-grade NAT on mobile, restrictive corporate networks) cannot connect without a
relay, and TURN over TCP/443 is what survives hostile firewalls. This is the one
component that is neither free nor serverless: managed (Cloudflare) or self-hosted
coturn, decided before Phase 7.

Screen share adds a second video track and renegotiates, rather than replacing the
camera track. Mute and camera state are broadcast events, not inferred from track state.
Connection quality comes from `pc.getStats()` polled every ~2s; `iceConnectionState`
`failed` triggers an ICE restart before the call is declared dead. An explicit state
machine lives in `lib/webrtc/peer.ts` (`new → connecting → connected → reconnecting →
failed → closed`) — ad-hoc booleans are how call features rot. `disconnected` maps to
`reconnecting` with a grace period rather than to failure: it is routinely transient, and
treating it as fatal would end good calls on every network handover.

## 8. Games

Every game is a **pure TypeScript module**:

```
GameDefinition<State, Move, View>
  init(seed, players)             → State
  validate(state, move, playerId) → Result
  apply(state, move)              → State
  view(state, playerId)           → View     // redaction happens here
  status(state)                   → active | { finished, results }
```

Pure, deterministic, seeded RNG, no I/O. One implementation gives us optimistic client
play, server authority, replay from `game_moves`, and unit tests.

Two execution models: **turn-based** (client posts a move, a Node route handler
validates and applies it, then `UPDATE ... WHERE state_version = $n`; a lost race returns
409 and the client resyncs) and **real-time host-authoritative** (host runs a fixed tick
and broadcasts snapshots, checkpointing to Postgres every few seconds so a host crash is
recoverable). Authority lives in Node rather than plpgsql because the rules are
TypeScript and two implementations of one ruleset is not maintainable.

Hidden information never leaves the server: `view(state, playerId)` produces a redacted
per-player projection. The public part goes on `game:{id}`, the private part on
`user:{playerId}`.

Adding a game is one folder under `features/games/titles/<slug>/` and one row in `games`.

## 9. Deployment

|            | Local                 | Preview                | Production            |
| ---------- | --------------------- | ---------------------- | --------------------- |
| App        | `next dev`            | Vercel preview per PR  | Vercel production     |
| DB         | Supabase CLI (Docker) | shared staging project | production project    |
| Migrations | `supabase db reset`   | CI → staging           | CI on merge to `main` |

Preview deployments point at staging, never production. Schema changes are **only** ever
migrations in `supabase/migrations/`, applied by CI. Editing production schema in the
dashboard is banned — it makes environments diverge silently with no way back.

Supporting infrastructure: custom SMTP (Supabase's built-in mail is rate-limited and
development-only, and verification mail is core functionality); weekly `pg_dump` to
encrypted object storage via GitHub Actions rather than relying on free-tier backup
guarantees; a scheduled ping to `/api/health` because free-tier Supabase projects pause
after inactivity and a six-person app will hit that; Sentry and Vercel Analytics.

## 10. Phases

| #   | Phase                     | Done when                                                      |
| --- | ------------------------- | -------------------------------------------------------------- |
| 0–1 | Foundation                | Styled shell deployed, CI green, boundaries enforced           |
| 2   | Identity                  | Invited user can register, verify, sign in, reset, sign out    |
| 3   | Profile & settings        | Profiles editable, RLS-tested                                  |
| 4   | MFA & security            | AAL2 enforced in the database, sessions revocable              |
| 5   | Social graph              | Request lifecycle including database-level denial for blocks   |
| 6   | Realtime foundation       | Presence accurate across tabs, survives a network drop         |
| 7   | Messaging                 | Two users converse in real time, reliably                      |
| 8   | Calls                     | Connects across networks, including mobile-hotspot ↔ home-wifi |
| 9   | Screen share + group      | Screen share and a 3-way call both stable                      |
| 10  | Game engine + first title | Full match playable and resumable after refresh                |
| 11  | Second game + couple      | Engine proven across both execution models                     |
| 12  | Hardening                 | Restore-from-backup rehearsed successfully                     |

## 11. Known risks

Ordered by expected pain.

1. **RLS recursion and silent over-permission.** The reflex fix is disabling RLS on one
   table, which quietly opens everything. Mitigated by `SECURITY DEFINER` helpers with a
   pinned `search_path` and pgTAP negative-case tests in CI from Phase 2.
2. **TURN is a hard external dependency with real cost.** Decide the provider by Phase 7
   and measure the relay rate.
3. **Serverless has no signaling server.** Supabase Realtime _is_ the signaling plane. If
   it degrades, calls cannot be established. Keep signaling in a swappable module and
   show a clear failure state rather than a spinner.
4. **Free-tier operational cliffs.** Project pausing, realtime message caps, auth-email
   rate limits, backup limitations. Each surfaces as a mysterious outage.
5. **Mobile Safari WebRTC.** Autoplay restrictions, audio requiring a user gesture,
   background-tab suspension. Test on real iOS hardware from Phase 8, not at the end.
6. **Service-role key leaking into a client bundle.** `import "server-only"`, ESLint
   restriction, and a CI grep of the built client bundle.
7. **Scope.** Seven navigation sections for one developer. Strict phase gates; a
   destination renders a designed "not built yet" state, never a fake one.
8. **Mesh ceiling** beyond four video participants.
9. **Optimistic UI diverging from server truth.** Every optimistic write carries a client
   id and a rollback path; a CAS conflict forces a full resync, never a partial patch.
10. **Notifications when the app is closed.** Realtime needs an open tab. Web Push
    (VAPID + service worker) is a scoped Phase 12 item; iOS requires an installed PWA.
11. **Migration drift** from dashboard edits.
12. **Design identity dissolving into defaults** under delivery pressure. Tokens are
    locked and Tailwind's default theme is cleared so off-system values do not compile.
