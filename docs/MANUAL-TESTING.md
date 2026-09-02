# Manual test checklist

Everything the 2,293 automated assertions cannot reach: a real browser, a real
email, a real microphone, and a second person.

Each item says **what to do** and **what should happen**. Where something has
historically gone wrong, it says that too — those are the ones worth doing
slowly.

> Automated coverage and why these are not part of it:
> [TESTING.md](TESTING.md) §6.

---

## Setup

Two browsers, not two tabs. **Chrome** as `A` and **Firefox** as `B` — separate
cookie jars, separate media permissions, and two engines' worth of WebRTC. A
private window works for `B` at a pinch, but it forgets permissions between runs,
which makes the permission tests noisier than they need to be.

```bash
npm run build && npm start      # test the real build, not the dev server
```

Use the production build. The dev server double-invokes effects, papers over
hydration mismatches, and does not run the service worker — three of the things
this checklist exists to catch.

|       |                                                           |
| ----- | --------------------------------------------------------- |
| **A** | Chrome, signed in as **Ada**                              |
| **B** | Firefox, signed in as **Rafa**                            |
|       | Ada and Rafa are friends, unless a section says otherwise |

Keep both consoles open. A red line in either is a finding even if the screen
looks right.

---

## 0 · Smoke pass — do this first, always

**Every route, loaded once.** No automated test has ever rendered a page
(TESTING.md §7), so a component that throws on mount passes the entire suite and
fails the moment anybody looks at it. This is the only thing standing between
that bug and a user.

In `A`, visit each and confirm it renders with a clean console:

- [ ] `/` — landing
- [ ] `/login`, `/signup`, `/forgot-password`
- [ ] `/` signed in — home
- [ ] `/friends`
- [ ] `/messages`, and a conversation
- [ ] `/games`, and a session
- [ ] `/couple`
- [ ] `/u/ada` — own profile, and `/u/rafa` — somebody else's
- [ ] `/settings` and all seven sections
- [ ] `/styleguide`
- [ ] a URL that does not exist → 404, not a crash

### The navigation progress bar

Nothing automated renders it — `navigation.test.mjs` covers only which clicks
should start it. Throttle the network to "Slow 3G" in devtools, then:

- [ ] Click a nav item → a thin ember line appears at the top within a moment
      and advances while the page loads
- [ ] It reaches the right edge and fades as the new page arrives
- [ ] Click something on a **fast** connection → **no bar at all.** It waits
      140ms first, because a bar that flashes on every click is noise
- [ ] Cmd-click / middle-click a link → new tab opens, **no bar** on this page
- [ ] Click the nav item for the page you are already on → no bar
- [ ] Browser back and forward → the bar appears for those too
- [ ] Settings → Appearance → motion off, then navigate → the bar still appears
      and still advances, it just does not slide
- [ ] It sits above everything, including a toast, and never eats a click

Anything below here is only worth running if this passed.

---

## 1 · Authentication

### Signup

- [ ] Submit with no invite code → refused, and **no account is created**
- [ ] Submit with a made-up code → refused, same
- [ ] Submit with a valid code → lands on `/verify-email`
- [ ] **The email actually arrives.** Check spam. This is not testable anywhere
      else — the automated suite asserts the _request_ was made and nothing about
      delivery
- [ ] Two browsers submit the **same username** at once → exactly one succeeds,
      the other gets a field error, and the loser's invitation is **not** burned
- [ ] Signing up with an email that already has an account does not reveal that
      it does

### Email verification

- [ ] Click the link in the email → signed in, landed on `/`
- [ ] Click the **same link again** → expired, not a crash
- [ ] Edit the link's `token_hash` before clicking → `/login?error=link_expired`
- [ ] Add `&next=https://example.com` to the link → lands on KITH, **not** the
      other site. An open redirect here is a genuine KITH link that deposits
      somebody on an attacker's page
- [ ] Before verifying, try to reach `/messages` directly → held at
      `/verify-email`
- [ ] Before verifying, try `/login` → still held. Confirming cannot be skipped
      by navigating away
- [ ] "Resend" works, and twice in quick succession says to wait rather than
      failing silently

### Login

- [ ] Wrong password → _"That email and password do not match"_
- [ ] Email with **no account** → the identical sentence. Any difference here
      tells a stranger who is a member
- [ ] Correct → lands on `/`
- [ ] Visit `/messages` signed out → `/login?next=/messages`, and after signing
      in you land on `/messages`
- [ ] `/login?next=https://example.com` → after signing in you land on `/`

### Logout

- [ ] Sign out in `A` → `/login`, with _"Signed out."_
- [ ] `B` is **still signed in**. Scope is `local` on purpose: signing somebody
      out of their phone because they closed a laptop tab is a surprise, not a
      feature
- [ ] Back button after signing out does not show a cached signed-in page

### Password reset

The flow with two bugs found this round — worth doing carefully.

- [ ] `/forgot-password` with a **real** address → _"If that address has an
      account…"_
- [ ] With an address that has **no** account → **the identical message**
- [ ] The email arrives; the link opens `/reset-password`
- [ ] Visit `/reset-password` directly with no session → `/forgot-password`
- [ ] Set a new password →
  - [ ] lands on `/login` showing _"Password changed. Sign in with the new one."_
        — **this message was unreachable before this round**
  - [ ] the new password works
  - [ ] the old password does not
- [ ] **The session revocation.** Sign in as Ada in _both_ browsers. Reset the
      password from `A`. Now reload `B`:
  - [ ] `B` is signed out
  - [ ] `A` is signed out too
  - [ ] Settings → Security → recent activity shows _"Reset the password from a
        link sent by email"_

  This is the whole point of the flow. Somebody resets a password because they
  think an attacker has it; before this round, the attacker's session survived.

### Two-factor

- [ ] Settings → Security → enable 2FA. The QR scans in a real authenticator app
- [ ] A wrong code is refused and says so
- [ ] The correct code enables it
- [ ] Sign out, sign back in → held at `/verify-2fa`
- [ ] **With a code outstanding, try `/messages` directly** → still held. Then
      confirm the data is genuinely unreachable, not just the page: open the
      console and query PostgREST directly. It must return nothing — routing is
      convenience, migration 0024 is the boundary
- [ ] A wrong code at the challenge is refused; recent activity logs it
- [ ] The correct code lets you through, to where you were going
- [ ] **Recovery interaction:** with 2FA on, do a password reset. The recovery
      link must still ask for the code. Without that, the second factor protects
      nothing that inbox access did not already unlock
- [ ] Disable 2FA → asks for a code first

---

## 2 · Friends and blocking

- [ ] `A` sends Rafa a request → appears in `B` **without a reload**
- [ ] `B` accepts → both sides show the friendship, both bells update
- [ ] Decline, and cancel-before-answer, both behave
- [ ] Search finds a member by username and by display name
- [ ] Search does **not** reveal non-members

### Blocking — check every surface

`A` blocks Rafa. Then in `B`, as Rafa, try each:

- [ ] Send Ada a friend request → refused
- [ ] Open the existing conversation → cannot post
- [ ] Call Ada → does not ring in `A`
- [ ] Invite Ada to a game → refused
- [ ] Propose couple mode → refused
- [ ] **Add Ada to a group** Rafa is in → refused. Adding a blocked person to a
      group used to take the group away from whoever did the blocking
- [ ] Ada does not appear in Rafa's lists, and Rafa does not appear in Ada's
- [ ] Unblock → each of the above works again

---

## 3 · Chat

- [ ] `A` sends a message → appears in `B` in under a second, **no reload**
- [ ] `B` replies → same in reverse
- [ ] Both send at the same moment → both arrive, neither is lost, order is
      stable in both browsers
- [ ] Scroll up in a long thread → older messages load, position does not jump
- [ ] While `A` scrolls history, `B` sends → the new message does not skip a row
      or duplicate one
- [ ] A message with a link → clickable, opens correctly
- [ ] A message pasted with invisible characters or a right-to-left override →
      stripped, does not corrupt the layout of the thread
- [ ] Delete a message in `A` → shows as deleted in `B`; the text is **gone**,
      not hidden
- [ ] React → the count updates in both
- [ ] **Rate limit:** paste-and-send rapidly. Around 30 in a minute it refuses,
      says why, and **keeps the text in the composer**

### Typing

- [ ] `B` starts typing → `A` shows _"Rafa is typing"_ within about a second
- [ ] `B` keeps typing → the indicator stays up, does not flicker
- [ ] `B` **stops** → gone after about four seconds
- [ ] `B` **closes the tab mid-word** → also gone after about four seconds. This
      is the case the expiry exists for; there is no "stopped typing" message
- [ ] Three people typing at once → the list does not reshuffle as they type.
      Names stay in the order they started
- [ ] `A` typing does **not** show "Ada is typing" to Ada
- [ ] Settings → Privacy → typing indicators **off** in `A`:
  - [ ] `B` no longer sees Ada typing
  - [ ] `A` **still sees Rafa** typing. Turning yours off is your choice, not a
        way to be blinded to everyone else's

### Read state

- [ ] `A` sends → `B`'s badge increments
- [ ] `B` opens the thread → badge clears in `B`
- [ ] **`B` receives a message with the tab in the background** → badge does
      **not** clear. "Read" and "delivered to a laptop lid" are different things
- [ ] Bring the tab forward → now it clears

---

## 4 · Calls

### Permissions — do these first, they are the common path

- [ ] Start a call and **deny** the microphone → a message naming the address
      bar, and no half-started call
- [ ] Grant, then unplug the microphone mid-call → handled, no crash
- [ ] Have another app hold the camera, then turn the camera on → _"Another app
      is using your microphone or camera"_ — not "permission denied", which
      would send you to the wrong settings page
- [ ] Load over plain `http://` on a LAN address → says the connection is not
      secure, does not claim the hardware is broken
- [ ] A device picker with permission never granted still shows usable names,
      not blank rows

### Voice

- [ ] `A` calls `B` → rings in `B`, ringtone plays
- [ ] `B` answers → audio both ways
- [ ] Mute in `A` → `B` sees it, hears silence, **and `A`'s hardware indicator
      stays on** — muted keeps the track open so unmuting is instant
- [ ] Unmute → immediate, no second permission prompt
- [ ] `B` declines → `A` is told, no stuck ringing state
- [ ] Let it ring unanswered → times out on both sides, missed-call notification
- [ ] Hang up from each side in turn → both ends clean up
- [ ] While on a call, try to start a second → refused

### Video

- [ ] Turn the camera on mid-call → appears in `B` with no visible renegotiation
      gap
- [ ] Turn it **off** → **the camera light goes out.** A control that says off
      while the light stays on is a lie
- [ ] Turn it back on → works, new light, `B` sees it again
- [ ] Video fills its box without overflowing at 320px, 768px, and full screen
- [ ] Rotate a phone mid-call → layout survives

### Screen sharing

- [ ] Share a tab → `B` sees it
- [ ] **Cancel the picker** → no error banner. Cancelling is not a failure
- [ ] While sharing, the **camera preview is unaffected** and the microphone is
      untouched — muted stays muted through a share
- [ ] Stop sharing → the camera resumes sending if it was on
- [ ] Stop via the browser's own "Stop sharing" bar → the app notices
- [ ] Text on a shared screen is legible in `B`

### Disconnect and reconnect

- [ ] Mid-call, disable `B`'s network for ~5 seconds, then restore → the call
      recovers without either side hanging up
- [ ] Disable for ~60 seconds → both ends give up cleanly, no ghost call
- [ ] Switch `B` from wi-fi to a phone hotspot mid-call → recovers or fails
      cleanly
- [ ] Close `B`'s tab outright → `A` is told within a reasonable time
- [ ] Put a phone to sleep mid-call, wake it → recovers or ends cleanly
- [ ] **After every one of these:** the camera and microphone indicators are
      **out** in both browsers. A call that ends without releasing hardware is
      the worst bug in this document

---

## 5 · Games

Run at least one turn-based game (Would You Rather) and Draw & Guess.

### Lobby

- [ ] `A` creates a session → appears in `B`'s list
- [ ] `B` joins → `A` sees them arrive without a reload
- [ ] Ready up in both → the game starts for both **at the same moment**
- [ ] Try to start with one player → refused

### Synchronization — the part two browsers exist for

- [ ] `A` answers → `B` sees the state advance
- [ ] **Both answer simultaneously** → both land, the round resolves once, and
      the two browsers agree on the result
- [ ] The timer runs down at the same rate in both, ends within a second of each
      other
- [ ] Let a round time out with nobody answering → both advance, neither hangs
- [ ] **`B` reloads mid-game** → rejoins into the current state, does not
      restart the round or duplicate a move
- [ ] `B` **backgrounds the tab** for a round, comes back → caught up, not stuck

### Secrecy

- [ ] Before the reveal, `A` cannot see `B`'s answer — check the **network
      response**, not just the screen. If the answer is in the payload, hiding it
      in the UI is theatre

### Leaving, scoring, rematch

- [ ] `B` leaves mid-game → `A` is told, the game resolves rather than hanging
- [ ] Scores match in both browsers at the end
- [ ] Rematch → a fresh game, scores reset, both players in it
- [ ] One player leaves during a rematch offer → handled

### Draw & Guess specifically

- [ ] Strokes appear in `B` smoothly, not in jerky batches
- [ ] Draw fast for ten seconds → `B` keeps up, nothing is dropped
- [ ] The guesser cannot see the word in the network payload
- [ ] A correct guess scores both; a near-miss is handled as designed

---

## 6 · Couples

- [ ] `A` proposes → `B` sees the invitation
- [ ] `B` accepts → both show the couple
- [ ] While one proposal is open, a second cannot be made
- [ ] **Privacy:** a third account can see **nothing** about the couple — check
      the network responses, not the screen
- [ ] The daily question appears for both
- [ ] `A` answers → **`B` cannot see the answer until `B` has answered too.**
      Check the payload
- [ ] Both answered → both reveal at once
- [ ] Play a couple game end to end
- [ ] End the couple → both sides update, and previously revealed answers behave
      as designed
- [ ] Block a partner → couple surfaces respect it

---

## 7 · Settings

- [ ] All seven sections load and save
- [ ] A saved preference **survives a reload**, and shows up in `B` where it
      should
- [ ] Theme switches with no flash of the wrong colour on reload — this is what
      the inline bootstrap script exists for
- [ ] Notification preferences actually suppress the notification
- [ ] Privacy → who can call, who can DM: verify from `B` that the restriction
      holds

### Security

- [ ] Change password → asks for the current one; a wrong one is refused and
      logged
- [ ] After a successful change, **`B` is signed out and `A` is not** — the
      opposite of the reset flow, deliberately: you proved your old password here
- [ ] Sessions list shows both browsers; "sign out others" works
- [ ] Recent activity shows each of the above with a readable label

### Account deletion

Do this last, on a throwaway account.

- [ ] Deletion asks for confirmation and cannot be triggered by accident
- [ ] After deleting, the account cannot sign in
- [ ] **The other person's history survives.** Messages Ada sent to Rafa are
      still in Rafa's thread, attributed to a departed member. One person leaving
      must not delete five other people's evenings
- [ ] Games the deleted account hosted still resolve for everyone else

---

## 8 · PWA and mobile

On a real phone, not a simulator.

- [ ] Install to the home screen; the icon is correct
- [ ] Launching from the icon opens with no browser chrome
- [ ] **Signing in works inside the installed app** — a service worker caching an
      auth response is the classic way to break this
- [ ] A call works inside the installed app
- [ ] Go offline → the offline page, not a browser error
- [ ] Back online → recovers without a manual reload
- [ ] Deploy a change and reload twice → the new version appears; the service
      worker does not pin an old build
- [ ] The on-screen keyboard does not cover the message composer
- [ ] Bottom navigation clears the home indicator
- [ ] Every tap target is comfortable one-handed

---

## Recording a run

Date, commit, browsers, what failed. A checklist with no record of the last run
is a checklist nobody ran.

```
2026-09-02 · 0ae5df5 · Chrome 141 / Firefox 143
  §0 smoke ......... pass
  §1 auth .......... pass
  §4 calls ......... FAIL — camera light stayed on after network drop (#31)
  ...
```
