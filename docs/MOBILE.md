# Mobile

KITH was built desktop-first and this is the pass that fixed it. Written as an
audit, because most of the work was finding things rather than styling them.

**A caveat first:** everything below was verified by reading the source and by
`npm run mobile:test`, which is static. No viewport was rendered. §8 is the
manual pass that a person with a phone still has to do, and it is not optional.

---

## 1. Navigation — the thing that was actually broken

The signed-in header carried **ten items**: the mark, four destination links,
Couple, the room count, the bell, the theme toggle, a settings button, the
display name, an avatar and a "Sign out" button. On a 375px screen that does not
fit. It wrapped, or it clipped, depending on the name length.

Shrinking that row would have been the wrong fix. **The destinations belong at
the bottom of a phone, near the thumb** — a different component, not a smaller
one.

So: a bottom bar below `lg`, and a header that keeps only identity and status.

|        | Header                              | Bottom bar                                |
| ------ | ----------------------------------- | ----------------------------------------- |
| `< lg` | Mark, Couple (if any), bell, avatar | Messages, Calls, Games, Friends, Settings |
| `≥ lg` | Everything, as before               | Not rendered                              |

`NavBar`, `NavItem` and `DESTINATIONS` already existed — written in an early
phase and **never wired up**, with the app layout carrying a comment saying the
rail was "built around destinations that do not exist yet". Four of them existed
by now, and their `href` was still absent, so they would have rendered as the
"not built yet" state. That is now an invariant: every destination must point at
a route that exists on disk.

Five items, because five is what fits across 320px with a label under each.
**Couple is deliberately not on it** — it appears for two people out of six, and
a sixth item that materialises for some accounts would make the bar reflow for
them alone. It stays in the header, where it already appeared conditionally.

### The bar removes itself inside a conversation

The one place a fixed bottom bar is actively harmful. The composer is at the
bottom, the keyboard arrives underneath it, and on iOS a fixed element ends up
floating above the keyboard on top of what is being typed.

So a thread goes full-screen — its own back button, its own composer. Which is
what every messaging app on a phone does, for exactly this reason.

---

## 2. Two bugs the audit turned up

**`--z-modal` did not exist.** The incoming-call screen used
`z-[var(--z-modal)]` and the token scale defined `base, raised, sticky, rail,
overlay, toast, grain` — no `modal`. CSS drops a declaration with an undefined
variable, so it resolved to `z-index: auto` and layered by document order.

Harmless right up until this phase made the header sticky with a z-index of its
own, at which point **the header would have covered a full-screen incoming
call**. Now defined at 50 — above the docked call, below a toast, because you
must still be able to read "microphone blocked" while the phone is ringing.

**Nothing handled safe areas.** No `viewport-fit: cover`, so
`env(safe-area-inset-*)` reported zero everywhere. The bottom bar would have sat
above the home indicator with a strip of background under it, which reads as a
bug rather than as a margin.

---

## 3. Touch targets

Two fixes, both as tokens rather than as classes on individual controls — so
every existing button got them, and so will one written next year.

- **`--control-sm` grows from 32px to 44px under `@media (pointer: coarse)`.**
  32 is comfortable for a mouse and frustrating for a thumb; 44 is the WCAG 2.5.5
  minimum. Every `size="sm"` button and input inherits it.

- **The drawing toolbar.** Colour swatches were `size-6` — **24px**, directly
  below a canvas where a miss draws a line, which makes it the worst place in the
  app to be short. Growing the dots would have wrapped the palette into two
  ragged rows on a phone, so instead `after:-inset-2.5` extends each hit area to
  roughly 44px without changing what is drawn. The gaps grow too, so neighbouring
  targets do not steal each other's taps.

---

## 4. The keyboard

**iOS Safari zooms the page when a field under 16px takes focus, and does not
zoom back out.** The base type scale is `--fs-base: 0.9375rem` — 15px, correct
for the design and one pixel short of avoiding this. Tapping the composer would
have scaled the whole app up and left it there.

Fields now grow to 16px under `@media (pointer: coarse)` only, so the desktop
scale is untouched.

The composer already got the other half right before this phase: **Enter inserts
a newline on a touch keyboard** rather than sending, because there is no shift
key within reach and no other way to break a line.

The thread is sized in `dvh`, not `vh`. `vh` freezes at the tallest the viewport
ever gets — including the chrome that is currently on screen and the keyboard
that is currently over it — so a `vh` layout puts the composer under the
keyboard. And it subtracts `--app-header-h` and `--nav-bar-h` rather than a
literal `4rem`, which had already stopped being true.

---

## 5. Dialogs become sheets

Below `sm`, a dialog anchors to the bottom edge, full width, square at the
bottom, with a grabber.

Not a style preference. **A centred modal is fine until it holds a text field:**
the keyboard takes the bottom half of the screen, the dialog stays centred in
what is left, and the field being typed into ends up behind the keyboard.
Anchoring to the bottom means the keyboard pushes the sheet up instead of
covering it. It also puts the buttons within reach of a thumb.

The grabber is `aria-hidden` and not interactive — the backdrop and Escape are
the real dismissals. A bar that looked draggable and was not would be worse than
no bar.

---

## 6. Scrolling

Every bounded scroll pane got `overscroll-contain`: the thread, the conversation
list, the notification panel, the dialog body, the guess feed.

Without it, rubber-banding a pane past its end scrolls whatever is behind it —
and on a fixed-height app shell that looks like the whole interface has come
loose.

---

## 7. Per-surface findings

| Surface       | Finding                                       | Fix                                             |
| ------------- | --------------------------------------------- | ----------------------------------------------- |
| Navigation    | Ten items in one row                          | Bottom bar, trimmed header                      |
| Chat          | `vh`, hard-coded header offset, 13px composer | `dvh` + tokens, 16px on touch                   |
| Chat          | Fixed bar over the keyboard                   | Bar hides in a thread                           |
| Calls         | Dock at `bottom-0`, under the new bar         | `bottom-[var(--nav-bar-h)]`                     |
| Calls         | `--z-modal` undefined                         | Token added                                     |
| Video         | `aspect-video w-full object-contain`          | Already correct — no overflow                   |
| Games         | 24px swatches under a drawing surface         | Extended hit areas                              |
| Games         | Guess feed 26rem under a 4:3 canvas           | 14rem below `sm`, so both fit on a 667px screen |
| Settings      | Sticky save bar over the nav                  | Clears it                                       |
| Friends       | 56px of top padding under a sticky header     | `py-8 sm:py-14`                                 |
| Notifications | Panel already `min(22rem, …)`                 | `100vw` → `100dvw`                              |

---

## 8. What still needs a real device

`npm run mobile:test` is 29 static invariants. It proves the source does not
contain the hazards found here. **It cannot tell you whether it looks right** —
no viewport is rendered and nothing is measured.

Worth doing by hand, at **320px (iPhone SE 1st gen), 375px, 390px, 430px**, and
once in landscape:

1. **Sign in and check every bar item.** Five labels across 320px is the tightest
   thing on this list.
2. **Open a thread and tap the composer.** The page must not zoom. The composer
   must stay above the keyboard. The bottom bar must be gone.
3. **Send a message with the keyboard up.** The list should stay pinned to the
   newest.
4. **Start a call, then navigate.** The dock must sit above the bar, not on it.
5. **Receive a call.** The full-screen ring must cover the header — that is the
   `--z-modal` fix and it is the one thing on this list that used to be wrong.
6. **Play Draw & Guess.** The canvas and the guess box should both be on screen
   at once. Tap each colour; none should scroll the page or draw a stray line.
7. **Open any dialog** — Block, Delete account, the 2FA QR. It should rise from
   the bottom. With a field in it, the keyboard must push it up.
8. **Settings, every section.** The tab strip scrolls horizontally; the save bar
   sits above the nav.
9. **Rotate to landscape on a phone.** `dvh` should keep the thread usable at
   375px tall.

The one I would check first is (5), because it is the only failure on this page
that was live rather than latent.
