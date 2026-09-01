# Settings

Seven sections at `/settings`. Profile, Account, Security, Privacy,
Notifications, Appearance, Blocked users.

---

## 1. The rule this section is built on

**Every control does something.** A settings page whose switches are decorative
is worse than no settings page, because it makes a promise the app does not keep.

`user_settings` had carried nine columns since migration 0002. Four were read by
policies. Three were read by nothing at all:

| Column               | Before 0027                                                       | Now                                          |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| `notification_prefs` | `{}` for everybody, consulted by nobody                           | a `BEFORE INSERT` trigger on `notifications` |
| `theme`              | the theme lived in `localStorage`                                 | stored on the account, applied by the shell  |
| `motion`             | a comment in `tokens.css` saying "Settings → Appearance, Phase 2" | three working tiers                          |
| `read_receipts`      | read by nothing                                                   | **still nothing — so it is not on the page** |

That last row is the point. KITH has no "seen by" indicator anywhere:
`conversation_members.last_read_at` drives your own unread count and nobody
else's cursor is ever exposed. A read-receipts toggle would govern a feature that
does not exist, so there isn't one. It goes on the page when there is something
to switch off.

`PRIVACY_CONTROLS` names the SQL function that honours each privacy switch, and
`settings.test.mjs` looks every one of them up in `pg_proc`. A control cannot
ship pointing at a function that is not there.

---

## 2. Notifications: one gate, not seven

Seven trigger functions insert notifications, and there will be more. Teaching
each one to consult a preference means seven places to get right and one to
forget in six months.

So the gate is a `BEFORE INSERT` trigger on `notifications` itself. Returning
`NULL` drops the row, which is exactly the semantics wanted: **the sender's
action still succeeds, the recipient simply is not told.** Muting game
invitations does not stop anybody starting a game. It works for the set-based
insert the message trigger uses, it covers any kind added later, and a new
trigger cannot bypass it by not knowing about it.

**Absent means on.** The column is `{}` for everybody who has never opened the
page, so only an explicit `false` suppresses. A default of off would have shipped
this migration by silently muting every notification in the app.

`system` is in the enum and is **not offered**. It is how the app says something
that is not about another person — an account action, a service notice — and a
preference that can silence it is a preference that hides the one message
somebody needs to see. `notification_enabled` refuses to suppress it regardless
of what is stored, which is asserted.

---

## 3. Appearance

### Theme

Moved from `localStorage` to the account, so it follows a person to their phone
instead of belonging to one browser.

`localStorage` stays as the **pre-paint bootstrap** — a stylesheet cannot wait
for a database round trip — and the app shell reconciles it, writing
`localStorage` on the way through. So the only visible correction is the first
load on a new device after changing the theme on an old one, and it happens once.

The alternative was reading the database in the root layout, which would make the
public landing page dynamic for the sake of a preference no signed-out visitor
has.

The header's Dusk/Daylight switch flips the attribute instantly and persists in
the background. It is deliberately not awaited: making a theme toggle feel like a
network request would be a strange thing to do to the fastest control in the app.

### Motion, which was broken

Every motion rule sat inside a `prefers-reduced-motion` media query keyed on
`:not([data-motion="full"])`. With `full` as the default that meant **the system
preference reached nobody**, and the two explicit values did almost nothing. Both
halves are fixed:

- The system preference now applies on its own, with no attribute needed.
- `reduced` and `off` now apply with no media query, which is the entire point of
  offering them — somebody whose system says nothing can still turn motion down.

**`full` deliberately does not override the system preference**, and the option
text says so. An app setting that can switch an accessibility preference back on
is one that should not exist. The suite greps that copy, because if the option
claimed otherwise it would be lying about what the CSS does.

---

## 4. Profile visibility

One field, not fifteen. Of everything on a profile, the birthday is the only
properly personal one — a full date of birth is the answer to a security question
somewhere else. Bio and pronouns are things people wrote in order to be read.

`profiles_select` is a **row** policy: it decides whether you see the row and has
no way to hide one column of it from one viewer. Redacting in TypeScript would
put the rule in the one place `profile/queries.ts` says rules must not live.

So `getProfileByUsername` now goes through `get_profile(username)`, which applies
three rules in one place: the block rule (unchanged in effect), the birthday
scope, and the deleted-account rule — a tombstone still resolves **by id** so
two-year-old messages render a name, and no longer **by username** so it cannot
be browsed to.

The suite asserts the column still holds the date and the function is what
withholds it, which is the difference between a redaction and a page that forgot
to render something.

---

## 5. The shape of the pages

| Section       | What is on it                                                         |
| ------------- | --------------------------------------------------------------------- |
| Profile       | Name, username, bio, pronouns, birthday, status, accent               |
| Account       | Email address and how to change it, when you joined, sign out, delete |
| Security      | Password, two-factor, sessions, the security log                      |
| Privacy       | Discoverability, message/call/couple scopes, birthday scope, typing   |
| Notifications | Seven kinds                                                           |
| Appearance    | Theme, motion                                                         |
| Blocked users | Who you blocked, reports you filed                                    |

**Account and Security are a real split.** Deletion was on Security because there
was nowhere else to put it, and it is not a security control — it is the end of
the account. Privacy left Security for the same reason.

Changing your email sends a confirmation to the **new** address and nothing
happens until it is followed. That is the property worth having: somebody with
thirty seconds at an unlocked laptop cannot move the account to an inbox they
control, because they would have to open that inbox too. The current password is
still required, so the real owner does not get an email saying their account is
being moved.

### Responsive

A rail on the left from `lg` up; below that a horizontally scrolling strip — seven
items do not fit across a phone, and stacking them turns the top of every page
into a menu you scroll past. Rendered **once and restyled**, not twice behind
breakpoints: two copies would be two lists to keep in step, and a screen reader
would read fourteen links.

The save bar is sticky on a phone, where the form is taller than the screen and
scrolling back down to save is the difference between a setting that gets changed
and one that gets abandoned.

Three shared controls — `SettingsCard`, `ToggleRow`, `ChoiceRow` — so seven
sections read as one system. All three take a help line, always, because a
control whose consequence is not written next to it is a control people leave
alone.

---

## 6. `user_settings` has one owner now

The table had accumulated writers in three slices: couple wrote
`who_can_propose`, auth wrote the privacy scopes, notifications would have wanted
`notification_prefs`. One table with three owners is a table whose defaults drift
and whose forms overwrite each other.

It is now `src/features/settings/` — one read, three writes grouped by the
section that shows them. **Three actions rather than one**, so somebody saving
their theme does not have their privacy scopes rewritten by whatever happened to
be in the DOM.

---

## 7. Testing

```
npm run settings:test    60 assertions
```

The pattern throughout: set the preference, then check the thing it claims to
control actually changed. Notification suppression is driven through the real
message trigger, not through the helper — and the message is asserted to still
arrive, because dropping the notification must not fail the action.

Also asserted: `system` cannot be muted even when stored as `false`, the birthday
column still holds a date the function refuses to return, a deleted account does
not resolve by name, and nobody can read or write another person's settings row.

What the suite cannot check is that the CSS does what §3 claims. Worth doing once
by hand: set motion to **None**, confirm the presence ember stops; then set it to
**Full** with the OS asking for reduced motion, and confirm it stays calm.
