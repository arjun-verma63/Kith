# Couple mode

An optional, private corner of KITH for two people who are already friends here.

The brief for this feature contained a warning as well as a requirement: **do not
make the entire application feel like a dating app.** That is not a styling note.
It is a constraint on what the feature is allowed to do, and most of the
decisions below exist to satisfy it.

---

## 1. What keeps it from being a dating app

Three rules, each enforced somewhere it cannot be quietly undone.

**You can only ask a friend.** `can_propose_to()` requires an existing
friendship, and no setting can widen that — `who_can_propose` accepts `everyone`
because the shared enum has that value, and treats it exactly as `friends`. A
proposal from a stranger is the behaviour this feature is defined against, so it
is impossible rather than discouraged.

**There is no discovery of any kind.** No search, no suggestions, no browsing, no
"who is single". The only entry point in the entire application is a small button
at the bottom of a friend's profile, rendered only when the database says a
proposal would be permitted.

**It is private by default and invisible everywhere else.** A new couple has
`visibility = 'private'`, which means it appears nowhere at all. The navigation
link only exists when you are in a couple or have one waiting; for everybody else
KITH looks exactly as it did before the feature was written.

The nearest thing to a leak is one line on a profile — the same shape as "in the
room since" — and only when both people have chosen `friends` visibility and the
viewer is one of those friends. The temptation is to make that bigger. Resisting
it is the feature.

---

## 2. Consent, in one clause each

| Action                     | Who                                        | Where it is enforced                                 |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| Propose                    | Anybody, to a friend who has not opted out | `can_propose_to`, re-checked inside an advisory lock |
| Accept or decline          | Only the person who did **not** propose    | `respond_to_couple`, and the `couples_accept` policy |
| End it                     | **Either** partner, alone                  | `end_couple`                                         |
| Change the shared settings | Either partner                             | `set_couple_details`                                 |

Ending is deliberately asymmetric. A relationship one person has left is not a
relationship, and requiring the other's agreement to leave would be a way of
trapping somebody. Nothing written is deleted when it ends — the couple simply
stops being active, and the answers stay where they are.

A declined proposal becomes `ended` rather than being deleted, so the record that
it was asked and answered survives.

**One active couple per person**, enforced by a trigger rather than a unique
index. Migration 0006 explains why at length: the obvious pair of partial unique
indexes silently fails, because somebody who is `user_low` in one row and
`user_high` in another satisfies both.

---

## 3. The daily question

One question per couple per day, and the mechanic is the only thing in KITH
enforced entirely by a Row Level Security policy:

> **Neither partner can read the other's answer until they have written their
> own.**

```sql
create policy couple_answers_select_after_answering on public.couple_answers
  for select to authenticated
  using (
    public.is_couple_prompt_member(prompt_id)
    and (user_id = (select auth.uid()) or public.has_answered_prompt(prompt_id))
  );
```

The row is not hidden with CSS, not filtered out of a payload, not blurred. It is
**not in the response**. There is no request to craft, no devtools panel to open
and no interface bug that can reveal it.

Two consequences worth knowing:

- **`list_couple_prompts` is `SECURITY INVOKER`.** Making it `DEFINER` would have
  been tidier and would have run it as the owner, bypassing the policy and
  returning both answers to whoever asked. The suite asserts `prosecdef = false`
  for exactly this function, because nothing else would catch it.
- **"Have they answered?" is a separate question from "what did they say?"**
  `partner_answered_prompt()` is `SECURITY DEFINER` on purpose: it answers only
  about existence, and it has to work in precisely the state where the reveal
  policy hides the row. Without it the waiting state could not be drawn.

The questions themselves live in `src/features/couple/prompts.ts` — content, not
data. The pick is deterministic from the couple and the date, so both partners
compute the same one without coordinating, and the unique constraint on
`(couple, day)` makes the race harmless anyway.

---

## 4. Privacy controls

| Setting                         | Where                                | Default   |
| ------------------------------- | ------------------------------------ | --------- |
| `couples.visibility`            | Shared, either partner may change it | `private` |
| `user_settings.who_can_propose` | Personal                             | `friends` |

Visibility is shared rather than per-person on purpose: a couple half-announced
is worse than either option, because one profile saying it and the other not is
itself a statement.

---

## 5. Two gaps this feature found

Building it surfaced problems in code that was already there.

**Three foreign keys were never actually covered by an index.** The schema-hygiene
suite has asserted "every foreign key is covered by an index" since migration
0002, and it was checking `conkey <@ indkey` — whether the columns appear
_anywhere_ in an index. A btree can only serve a lookup that starts at its
leading column, so an index on `(user_low, user_high)` "covered" a foreign key on
`user_high` while being no use for it. `couples.user_high`,
`couple_answers.user_id` and `message_reactions.user_id` were all uncovered. The
check now requires a prefix match, and the indexes exist.

**Migration 0006's helpers were executable by `anon`.** Not exploitable — they key
off `auth.uid()`, which is null for an anonymous caller — but every other module
revokes from `anon` as a matter of course, and an exception nobody decided on is
not an exception.

---

## 6. Testing

```
npm run couple:test    91 assertions
```

Aimed at the two claims. That only the two people involved can reach any of it,
asked from every path a browser has — the RPCs, the tables directly, a friend of
one of them, a stranger. And that the reveal gate genuinely holds: a partner who
has not answered gets `null` from the query _and_ nothing from
`select body from couple_answers`.

The anti-dating-app constraints are asserted too, because they are the kind of
thing that erodes quietly: a stranger cannot be asked, `everyone` does not mean
everyone, and a new couple is invisible until somebody changes it.

---

## 7. Games

Couple games are offered on this page rather than the games shelf, because a
couple game does not have the question a shelf asks — "who with". There are two,
and neither has a winner; see [GAMES.md §10](GAMES.md).

- **How Well Do You Know Me?** One of you answers about yourself, the other
  guesses, and the score is the pair's.
- **Guess My Answer.** Both of you answer and both of you predict, every round,
  in a category you choose before you start.

Guess My Answer is the only game so far that asks something before it opens, so
the shelf has a `NEEDS_SETUP` list: games on it get a category picker, everything
else goes straight from Play to a lobby. A settings step in front of a game with
nothing to settle is a step for nothing.

The history the two of them have played, with scores, sits under it.

---

## 8. Not built

- **Anniversary reminders.** The date is stored and shown; nothing notifies.
- **A shared space beyond the daily question** — photos, notes, a list. The
  schema does not assume any of it.
