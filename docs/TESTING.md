# Testing strategy

2,293 assertions across 30 suites, no test framework, no Docker, no CI service
required. `npm test` runs everything in a few minutes on a laptop.

This document is the map: what is tested, at which layer, why that layer, and —
the part most strategy documents leave out — **what is deliberately not tested
and how it gets checked instead**.

---

## 1. The one rule

> **Test the shipped file, against the real thing, or say plainly that you did
> not.**

Every choice below follows from that.

Policies are tested against real Postgres, not against a description of what the
policies say. Peer connections are tested against a real WebRTC stack, not a mock
that connects because it was written to. Server actions are tested by running
them, not by grepping their source for a function name. Where none of that is
possible — a real confirmation email, a real permission prompt, two real browsers
— it goes in [MANUAL-TESTING.md](MANUAL-TESTING.md) rather than being faked into
a green tick.

A test that passes against a copy of the code is worse than no test, because it
reports confidence it has not earned.

---

## 2. Five layers

| Layer                | Mechanism                                   | Answers                                          |
| -------------------- | ------------------------------------------- | ------------------------------------------------ |
| **Database**         | PGlite — Postgres 17 in WASM, real RLS      | Can this person read that row?                   |
| **Adversarial**      | Same, but every assertion is an attack      | What happens when they try anyway?               |
| **Pure logic**       | Node imports the `.ts` source directly      | Given this input, what comes out?                |
| **Real stacks**      | `node-datachannel`, scripted `mediaDevices` | Does it work against something that pushes back? |
| **Static invariant** | Read the source, assert a property          | Did somebody quietly stop using this?            |

### Database — the trust boundary

The anon key is public by design. Everything the app can do, a member with a
browser console can do. So RLS is not a layer of defence, it is **the** layer, and
it is tested as the real `authenticated` role against the real migrations:

```js
await asUser(db, mallory, "select * from public.messages where conversation_id = $1", [dm]);
```

`set local role authenticated` with the JWT claims in a request-scoped GUC — the
same thing PostgREST does for a signed-in browser. If a policy is wrong the query
returns rows it should not, exactly as it would in production.

PGlite over Docker deliberately: a suite with prerequisites is a suite that stops
being run.

### Adversarial — the same layer, inverted

`security.test.mjs` is the same machinery with the assertions reversed. Each check
is an attack and **a green tick means it failed**. That inversion is easy to get
wrong, and it was got wrong: the `blocked()` helper originally read "returned no
rows" as "was refused", but a successful `INSERT` returns no rows, so three probes
sat green over successful attacks. It checks `affectedRows` now. The story is in
[SECURITY.md](SECURITY.md) because the lesson generalises — **an inverted
assertion needs its own test.**

### Pure logic — exhaustive, because it can be

Node 24 strips TypeScript types natively, so a suite imports
`src/features/auth/redirects.ts` and calls it. Not a copy: `alias-loader.mjs`
resolves `@/` exactly as the bundler does.

Redirect rules, input schemas, game engines, presence resolution, typing expiry,
text normalisation. Cheap enough to enumerate every case, which matters most for
the pieces least likely to be caught by clicking the happy path — an open
redirect, a verification gate that can be walked around by visiting `/login`.

### Real stacks — where a mock would lie

Two peers connecting is the claim a mock cannot support, so `webrtc.test.mjs`
drives `libdatachannel` through `node-datachannel/polyfill`: real ICE, real DTLS,
real SCTP over loopback. When that suite says two peers connected, two peers
connected.

The exception is glare — a race you have to provoke is a race you cannot assert
on — so perfect negotiation is tested against a recording stub that makes the
collision exact.

### Static invariant — for things that rot silently

A handful of properties are asserted by reading the source, because the failure
being guarded against is _nobody calls this any more_ and behaviour cannot see
that. `perf.test.mjs` asserts every `.channel()` has a matching removal;
`rls.test.mjs` asserts every table carries the `mfa_required` gate;
`typing.test.mjs` asserts the hook still uses the extracted roster.

Used sparingly. A source check proves a string is present, not that it runs.

---

## 3. Coverage against the brief

| Asked for                | Suite                                                       | Layer                          |
| ------------------------ | ----------------------------------------------------------- | ------------------------------ |
| **Signup**               | `auth-flows` 63, `auth` 61                                  | Real action + PGlite           |
| **Login**                | `auth-flows`                                                | Real action                    |
| **Logout**               | `auth-flows`                                                | Real action                    |
| **Email verification**   | `auth-flows`                                                | Real action + redirect rules   |
| **Password reset**       | `auth-flows`                                                | Real action — **2 bugs found** |
| **2FA**                  | `mfa` 109                                                   | PGlite + RFC 6238              |
| **Friend requests**      | `friends` 40                                                | PGlite                         |
| **Blocking**             | `safety` 89                                                 | PGlite, every surface          |
| **Messaging**            | `messages` 65                                               | PGlite                         |
| **Realtime**             | `messages`, `notifications` 47                              | Channel policies               |
| **Typing**               | `typing` 45 — **new, was untested**                         | Pure logic + wiring            |
| **Read state**           | `messages`                                                  | PGlite                         |
| **Voice**                | `calls` 94, `call-session` 55                               | PGlite + two sessions          |
| **Video**                | `call-media` 67 — **new**                                   | Scripted `mediaDevices`        |
| **Screen sharing**       | `screen-share` 82                                           | Scripted `mediaDevices`        |
| **Permissions**          | `call-media` — **new, was untested**                        | Every error name a browser has |
| **Disconnect**           | `webrtc` 87                                                 | Real stack                     |
| **Lobby / join / leave** | `games` 109                                                 | PGlite                         |
| **Synchronization**      | `games`, per-game suites                                    | PGlite + realtime              |
| **Scoring**              | `wyr` 102, `wkm` 112, `draw` 125, `guess` 209, `howwell` 95 | PGlite                         |
| **Rematch**              | `games`                                                     | PGlite                         |
| **Couple invitations**   | `couple` 94                                                 | PGlite                         |
| **Couple privacy**       | `couple`                                                    | PGlite                         |
| **Couple games**         | `howwell`                                                   | PGlite                         |
| **Account deletion**     | `account` 92                                                | PGlite                         |
| **Security**             | `security` 62, `rls` 70                                     | Adversarial                    |

Three suites are new. The other twenty-seven already existed; the work here was
finding the three holes in them.

---

## 4. Running a server action outside a server

The interesting piece of new infrastructure, and the reason the auth gap existed.

`src/features/auth/actions.ts` is the front door to the entire application — six
actions, every one of them the first thing a person touches — and it had no tests
for a boring reason: **importing it threw.** A server action imports
`next/navigation`, whose `redirect` throws by design; the cookie-bound Supabase
client, which reads `cookies()`; and the service-role client, which is
`server-only` and wants a key.

`action-loader.mjs` substitutes exactly those three, and nothing else:

```
next/navigation      → a redirect that throws a tagged error
@/lib/supabase/server → a double that records every call
@/lib/supabase/admin  → the same, for rpc
```

Everything else is the real file — the real zod schemas, the real SHA-256 of the
invite code, the real order of operations, the real sentence shown to a person who
gets their password wrong. Which is what makes an assertion like this meaningful:

```js
eq("this one included, because only inbox access was proved", signOut?.args, {
  scope: "global",
});
```

That is not "the source contains the string signOut". That is _the action, run,
called signOut, with that scope_.

**Deliberately narrow.** Substituting `@/features/auth/schema` would make the
tests pass while validation was broken — the exact failure this approach exists to
avoid. Only the three things that cannot physically run outside a request are
replaced.

---

## 5. What this found

Three bugs, all in code that already shipped.

### Password reset left the attacker signed in

`changePasswordAction` (Settings → Security) signs every **other** device out after
a change, and says why: _"The common reason to change a password is believing
somebody else has it, and leaving their session running afterwards makes the
change ceremonial."_

`resetPasswordAction` — the forgotten-password flow — signed out nothing.

The reasoning applies with more force there, not less. Somebody using that flow
has typically lost access or been compromised; if an attacker holds a live
session, the reset performed specifically to lock them out did not. **The two
paths disagreeing is what made it an oversight rather than a decision.**

Fixed to `scope: "global"` — everything, including the browser doing the reset.
The scopes differ on purpose: a change from Settings proves you know the old
password, a reset proves only that somebody can read an inbox, so nothing that
authenticated beforehand should still count.

That also repaired dead code. `/login?reset=1` renders _"Password changed. Sign in
with the new one."_ — a message no one could ever have seen, because the session
survived and middleware bounces a signed-in user off `/login`.

### A password reset left no trace

`security_events` exists so the question _"did somebody else do something to my
account"_ has an answer. A password reset — arguably the most consequential entry
possible — was not in the vocabulary. Added as `password.reset`, with a label.

### Typing indicators reshuffled

Found by a test written against code I had just extracted, which is the honest
version of this story. The roster sorted by _last heard_, so two people typing at
once swapped places several times a second — while the comment above it claimed
the ordering existed to prevent exactly that. It now keeps two timestamps:
`lastHeard` decides whether to show somebody, `startedAt` decides where.

The extraction also removed a timer per typist in favour of one for the roster.
Five people typing was five pending callbacks to cancel on unmount, and one missed
cancellation is a `setState` on a component that has gone.

---

## 6. Deliberately not automated

Each of these could be automated. Each would cost more than it returns, and the
cost is usually paid in false confidence rather than in time.

**A browser.** No Playwright, no jsdom. Three suites needed browser APIs and got
a scripted `navigator.mediaDevices` — about eighty lines, no install, and it can
raise `NotReadableError` on demand, which is genuinely awkward to provoke in a
real browser. What a real browser is needed for is in the manual checklist, where
its absence is visible rather than papered over.

**Rendering.** No component tests. React rendering correctly is React's problem;
the props are typed; and a snapshot test mostly asserts that nobody changed the
markup, which is not a property worth defending. Layout and design are checked by
looking.

**Supabase Auth itself.** Password hashing, email delivery, cookie round trips,
token rotation. Exercised through the public API and assumed correct beneath it —
testing it would be testing Supabase.

**A bundle-size budget.** Sizes move for reasons nobody caused — a Next upgrade, a
React patch — and a threshold that fails on those gets raised until it means
nothing. Numbers and dates are in [PERF.md](PERF.md) instead.

**Load and concurrency.** KITH has six users. A suite proving it survives ten
thousand would be proving something nobody needs.

---

## 7. Known weak spots

Written down because an audit that only lists strengths is marketing.

**No test has ever loaded a page.** Not one assertion in 2,293 renders a
component, so a route that throws on mount would pass everything and fail on
sight. The production build catches compilation, not runtime. This is the single
largest gap and the reason the manual checklist opens with a smoke pass.

**Realtime is asserted at the policy layer only.** The suites prove who may
subscribe to a channel and that every subscription is cleaned up. Whether a
message actually arrives at the other browser is checked by two browsers.

**The harness is a faithful stub, not Supabase.** `auth.uid()` reads the same GUC
Supabase's does, and the roles carry the same grants — but it is a reproduction.
It has been wrong once: it granted `select on auth.users to authenticated`, which
production does not, and produced a finding that did not exist. Removed, and
recorded in [SECURITY.md](SECURITY.md).

**Static invariants can be satisfied without being true.** `typing.test.mjs`
asserts the hook imports `TypingRoster`. An import it never calls would pass.

**Coverage is uneven by design.** Games have 752 assertions and Settings has 60,
because a game has rules that can be broken and a settings toggle mostly has a
column. Uneven is right; it is worth knowing it is uneven.

---

## 8. Running it

```bash
npm test                  # 30 suites, 2293 assertions
npm run auth-flows:test   # one suite
npm run check             # typecheck + lint + format
npm run build             # the errors tests cannot catch
```

No suite needs Docker, a Supabase project, a network, or an environment variable.
That is a deliberate constraint: **a test with a prerequisite is a test that stops
being run**, and the whole value of 2,293 assertions is that running them is
boring.

Before pushing: `npm run check && npm test && npm run build`, then the smoke pass
at the top of [MANUAL-TESTING.md](MANUAL-TESTING.md) if anything touched a page.
