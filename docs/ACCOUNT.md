# The Security page

`/settings/security`. Password, two-factor, sessions, privacy, the audit log, and
the way out. Two-factor has its own document — [MFA.md](MFA.md) — because the
enforcement story there is longer than the UI.

---

## 1. What a security page must not show

This is the one page where the useful information and the dangerous information
are the same information. Four rules, each enforced in code rather than by care:

| Rule                          | Where                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| No tokens, no session ids     | `list_my_sessions` does not select them; the return type is asserted in `account.test.mjs` |
| No raw user agent             | `describeDevice` reduces it to "Chrome on Windows"                                         |
| Coarse addresses only         | `coarsenIp` drops the last octet: `203.0.113.x`                                            |
| Nothing about another account | Scoped in SQL to `auth.uid()`, never filtered in TypeScript                                |

The address rule is the one with a real trade-off. A full IP is what most apps
show and it does answer "was that me?" more precisely. `/24` still separates home
from the office from a country you have never visited, which is the actual
question, and it is no longer worth harvesting out of a screenshot pasted into a
support thread. Both `coarsenIp` and `describeDevice` are given hostile input in
the suite — a script tag, an SQL fragment — because their output goes on a page
and their input comes from a proxy header.

---

## 2. Reauthentication

| Action                          | Requires                                                       |
| ------------------------------- | -------------------------------------------------------------- |
| Change password                 | Current password                                               |
| Enable / add a second factor    | `aal2`                                                         |
| Remove a factor, disable 2FA    | `aal2` **and** a current code                                  |
| Set a new password via recovery | `aal2`                                                         |
| Sign out other devices          | Confirmation only                                              |
| **Delete the account**          | Password **and** a code (if 2FA on) **and** the typed username |

The password is asked for even though the person is signed in, because a session
cookie is something a borrowed laptop already has, and a password change is what
turns temporary access into permanent access.

Signing out other devices is deliberately _not_ password-gated. It only ever
reduces access, and the person reaching for it usually believes somebody else is
signed in — a password prompt in front of the panic button is how the panic
button goes unused.

### How the password is checked

GoTrue has no "is this password correct" endpoint, so the only honest check is a
sign-in. Doing that on the request-bound client would be a bug rather than a
check: it rotates the session cookie, and because a password sign-in starts at
`aal1` it would **silently downgrade a two-factor session** and bounce the person
to the challenge screen mid-form.

So `passwordIsCorrect` uses a throwaway client with `persistSession: false`,
which writes no cookies, and signs out the session it creates rather than leaving
one live in `auth.sessions` after every password change.

---

## 3. Sessions

**Listing is not in the Supabase client API.** `signOut` takes a scope
(`local` / `others` / `global`) and that is the whole supported surface.

So the split is: **read the table, write through the API.**

- `list_my_sessions()` (migration 0025) reads GoTrue's `auth.sessions`. It is
  `SECURITY DEFINER` because `authenticated` has no grant there and must not get
  one, filtered to `auth.uid()`, and selects six columns chosen so there is
  nothing replayable in the result.
- Revoking goes through `signOut({ scope: 'others' })`. Deleting a row out of
  `auth.sessions` to fake a per-session revoke would mean **writing** to a schema
  Supabase owns. Reading it is a calculated risk; writing to it is not.

This is the only place KITH touches a table it does not own, so the function is
built to fail quietly: a `to_regclass` guard for a table that has been renamed,
and an exception handler for `undefined_column`. Both return an empty list, and
the UI then says _"this list is not available right now"_ rather than showing a
confident empty state — "no sessions" would be a lie you are reading in one.

There is no per-session revoke button, because there is no honest way to build
one.

---

## 4. Deletion: why the profile row survives

**A hard delete would take other people's data with it.**

`profiles.id` cascades from `auth.users`, and the cascade does not stop there.
Two of the onward edges are not the leaver's to delete:

```
game_sessions.host_id   on delete cascade  →  every game they hosted,
                                              and everyone else's history in it
couples.user_low/high   on delete cascade  →  the couple record, its prompts,
                                              and both partners' answers
```

One person leaving a six-person room should not delete five other people's
evenings. Messages already knew this — `sender_id` has been `on delete set null`
since migration 0004 — and this is the same instinct applied to the rest.

So `anonymise_account` **scrubs in place**:

| Goes                                                            | Stays                                        |
| --------------------------------------------------------------- | -------------------------------------------- |
| Username → `deleted_<12 hex>`, display name → "Deleted account" | The row itself, so old threads render a name |
| Bio, pronouns, avatar (file included), status                   | Messages, attributed to the tombstone        |
| Friendships, requests, blocks                                   | Games they hosted or played                  |
| Notifications, conversation memberships, reactions              | The couple record, marked `ended`            |
| Settings, reset to the most private position                    | `security_events`, including the deletion    |

Then the auth account is disabled: the email is replaced with
`deleted-<id>@deleted.invalid`, the account is banned, and `deleteUser(id, true)`
soft-deletes it. Soft, because a hard delete would fire the cascade the scrub
just spent its time avoiding.

The username is **replaced, not freed**. Handing `@ada` to the next person who
wants it would make every old message look like it came from them.

### The copy says this

The dialog does not promise "everything you have written will be erased", because
that is not what happens. It says messages stay, unattributed, and why.

### Not reachable from a browser

`anonymise_account` has execute revoked from `authenticated` entirely — asserted
three ways in the suite, including at `aal2`. It runs through the service role
from a server action that has already checked the password, the code, and the
typed username. An irreversible RPC an access token can call on its own is a
one-request account wipe.

---

## 5. Privacy controls

Four switches. Every one is read by a SQL function that decides what other people
may do:

| Control                             | Enforced by                           |
| ----------------------------------- | ------------------------------------- |
| Findable in search                  | `search_profiles`                     |
| Who can start a conversation        | `can_open_conversation_with`          |
| Who can call you                    | `can_call_conversation` (new in 0025) |
| Who can ask you to be their partner | `can_propose_to`                      |

`who_can_call` had existed as a column since migration 0002 and **nothing read
it** — the same state `who_can_message` was in before 0014. A control that
controls nothing is worse than no control: it is a promise on a settings page
that the database does not keep. Migration 0025 wires it into `start_call`, for
DMs only — a group thread has no single "them" whose preference could be
consulted.

`PRIVACY_CONTROLS` in `account.ts` carries the enforcing function's name for each
row, and the suite checks every one of them exists in `pg_proc`. That invariant
caught a wrong name the first time it ran.

`read_receipts` and `typing_indicators` are in `user_settings` and are
deliberately **not** on this page. Nothing reads them yet, and they are messaging
courtesies rather than access controls — they belong next to the code that would
honour them.

---

## 6. Testing

```
npm run account:test    96 assertions
npm run mfa:test       109 assertions — two-factor, see MFA.md
```

What the suite proves, against real Postgres:

- **Deletion from both directions.** A couple, a hosted game, and messages from
  two people are set up first, then counted afterwards: everything about the
  leaver is gone and every row belonging to somebody else is untouched. This is
  the assertion that would catch a cascade nobody noticed.
- **Idempotence.** A retried deletion is a no-op, not a failure.
- **`who_can_call` across all three scopes**, against `start_call` for real,
  including the one-directional case (taking no calls does not stop you calling
  out) and the group exemption.
- **Session scoping**: your own only, expired excluded, `auth.sessions` not
  readable directly, and the returned column list pinned exactly.
- **The screenshot rules** — `coarsenIp` and `describeDevice` against hostile
  input.

What needs a live Supabase project, because GoTrue is not running in the suite:
the password check, `signOut({scope:'others'})` actually ending a session,
`admin.deleteUser(id, true)` blocking sign-in, and the ban. Worth doing once in
two browsers:

1. Sign in on two browsers. **Sign out other devices** in one; the other should
   be signed out on its next navigation.
2. **Change the password** with the wrong current password — refused, and
   `password.change_failed` appears in the log.
3. Change it correctly — the other browser is signed out, this one is not.
4. With 2FA on, confirm the password change did **not** send you to the challenge
   screen. That is the throwaway-client bug, and it is invisible until it happens.
5. **Delete a throwaway account**, then confirm from another account that the
   messages are still in the thread and read "Deleted account", and that the
   deleted username no longer appears in search.
