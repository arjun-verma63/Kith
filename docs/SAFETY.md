# Blocking and reporting

Block and report live on somebody's profile. `/settings/safety` is where blocks
are undone and reports are checked on.

---

## 1. The audit, which was the actual work

Blocking has existed since migration 0002 and was consulted in nine places. The
interesting question was never "does the block row work" — it was **where is it
not consulted**, and the answer was three places.

| Surface            | Before 0026                                  | After                                 |
| ------------------ | -------------------------------------------- | ------------------------------------- |
| Profiles           | `profiles_select` hid both directions        | unchanged                             |
| Search             | `search_profiles` excluded blocked           | unchanged                             |
| Sending a message  | `can_post_to_conversation` refused it        | unchanged                             |
| Calls              | `start_call` used the same gate              | unchanged                             |
| Friend requests    | the insert policy refused it                 | unchanged                             |
| Couple proposals   | `can_propose_to` refused it                  | unchanged                             |
| Avatars            | the storage policy checked it                | unchanged                             |
| **Games**          | **membership only**                          | `can_view_game_session` checks blocks |
| **Friends list**   | **returned a blocked friend, with presence** | `list_friends` excludes them          |
| **Message bodies** | **still visible in a shared thread**         | `messages_select_member` hides them   |

Two people in one group conversation could sit in the same game across a block —
see each other's moves arrive, share a scoreboard — because
`can_view_game_session` checked conversation membership and stopped.

---

## 2. A block severs

This is the change the three gaps came from. Every one of them was a
**relationship that outlived the block that should have ended it**.

`block_user` now ends:

- the **friendship** (one row, so both directions at once)
- any **pending friend request** in either direction — `cancelled`, not
  `declined`: declining is a statement about the request, this is a statement
  about the person
- an active **couple**
- a **live call** the two of them are in, both sides
- a **seat in an unfinished game**, both sides

The confirmation dialog lists all of this before the press, because people do not
expect blocking to end their couple, and finding out afterwards is a bad way to
find out. `BLOCK_CONSEQUENCES` in `reasons.ts` is that list, and the suite greps
it to make sure it still names each one.

### Unblocking is not an undo

`unblock_user` restores reachability and nothing else. It does not put back the
friendship, the couple or the game — undoing a severing would mean remembering
what was severed, and a block is not a pause button. The dialog says so, twice.

### The blocks table has no direct write path

Both the INSERT and DELETE policies are dropped. A direct insert skips every
severing step above, and the resulting half-block — blocked but still friends,
still in the couple, still seated — is exactly the inconsistency this migration
removes. SELECT stays: you can see who you blocked, and still cannot see who has
blocked you.

---

## 3. Hiding message bodies is symmetric, and that is a trade-off

"Blocked" that still shows you what they said is a mute. So
`messages_select_member` now hides them.

The blocked person's view changes too, which tells them something happened. The
alternative — hiding one way — keeps the block quiet but leaves the blocker being
read by somebody they have blocked, which is the wrong half to protect. It is
also already knowable: their next message is refused either way.

**What this does not fix:** `conversations.last_message_at` is denormalised by a
trigger and does not know about blocks, so a thread can still sort as though
something arrived in it. The message itself does not appear. A per-viewer preview
is a different feature.

The predicate is written as `NOT EXISTS` against `blocks` rather than as
`is_blocked_either()`, because this one runs **per row** — the sender varies down
a thread, so the helper could not be hoisted out of the loop the way it is
everywhere else.

---

## 4. Reports

`reports`, with six reasons. `other` is the only one that requires a
description, because a report that says only "other" is one nobody can act on.

**No admin dashboard**, deliberately — so `status`, `reviewed_at`, `reviewed_by`
and `moderator_note` exist and nothing writes them. They are not decoration:
`status = 'open'` is a true statement about a new report from the moment it
exists, and `reports_open_idx` is the queue a dashboard will read. The report
history on the settings page shows **Open** on every row, which is honest rather
than encouraging.

### RLS

| Who             | Can                                                             |
| --------------- | --------------------------------------------------------------- |
| Reporter        | SELECT their own                                                |
| Person reported | nothing — a report they can read is one that names who filed it |
| Anybody else    | nothing                                                         |
| Everybody       | no INSERT, UPDATE or DELETE policy at all                       |

Insert goes through `report_user` because two of the rules cannot be a
`WITH CHECK`: "not more than five in an hour" and "not one you already have open
against this person" both need to count rows in the table being protected.

No UPDATE or DELETE at all, on purpose. A report the reporter can withdraw is a
report somebody can be **pressured into withdrawing**.

### The evidence reference is scoped

`message_id` and `conversation_id` are checked against the reporter's own
visibility and **silently dropped** if they cannot see them — the report is still
filed. Refusing on existence would make the field an oracle: point a report at
any uuid and the acceptance tells you the message is real.

### Reporting usually blocks too

The checkbox defaults on, and the block runs **first**. If the report then fails
its rate limit, having already been blocked is the outcome the person actually
needed, and the message says so.

---

## 5. Where things live

| Concern                                  | File                                             |
| ---------------------------------------- | ------------------------------------------------ |
| Reasons, schema, consequence copy (pure) | `src/features/safety/reasons.ts`                 |
| Block / unblock / report actions         | `src/features/safety/actions.ts`                 |
| Blocked list, report history             | `src/features/safety/queries.ts`                 |
| Profile controls                         | `src/features/safety/components/safety-menu.tsx` |
| Settings page                            | `src/app/(app)/settings/safety/page.tsx`         |
| All of the SQL                           | `supabase/migrations/20260901000900_safety.sql`  |

`SafetyMenu` is passed into `ProfileView` as a prop rather than imported by it —
a feature may not import another feature, and the page composes them. Same
pattern as the couple marker.

`list_blocked()` is `SECURITY DEFINER` for an awkward but correct reason:
`profiles_select` hides a blocked profile in both directions, so once you block
somebody you can no longer read their name, and a plain query would return a
column of uuids. It returns only rows the caller created — they chose the row and
already know who is in it.

**The settings page exists so that blocking is reversible.** Blocking hides
somebody everywhere else — profile, search, friends, messages — so without it an
accidental block would be close to permanent: you could not find the person in
order to unblock them.

---

## 6. Testing

```
npm run safety:test    89 assertions
```

§4 of the suite is a **grid**: the same block, and for each of the five surfaces
the same question. A grid is the only shape that makes a missing cell obvious,
and the missing cells were the whole point.

Also asserted: the severing (all five), `cancelled` rather than `declined`, block
idempotence, the report RLS matrix, the rate limit, the duplicate rule, the
evidence-scoping oracle, `list_blocked` returning a name that `profiles_select`
would have hidden, and that unblocking restores reachability but **not** the
friendship.

Five existing suites were updated: every fixture that wrote a `blocks` row by
hand now calls `block_user`, because the direct path is gone. That change was not
cosmetic — the couple suite started failing, correctly, because a real block
severed a friendship a later assertion depended on.

### One thing worth watching

`can_view_game_session` deliberately has no `left_at is null` filter. The first
version had one and was quietly useless: `block_user` marks both players as
having left, so by the time the predicate runs there is nobody seated to find a
block against. It passed review and failed the test.
