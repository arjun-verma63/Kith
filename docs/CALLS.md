# Voice calls in KITH

Ringing, answering, hanging up, and the log of who called whom.

This is the layer above [WEBRTC.md](WEBRTC.md). That document explains how two
browsers connect; this one explains what a _call_ is — the record, the states it
moves through, and who is allowed to do what.

Audio only. Video is deliberately not built.

---

## 1. The pieces

```
  ┌───────────────────────────────────────────────────────────────────┐
  │  features/calls                                                   │
  │    call-provider.tsx      one call, mounted once in the app shell │
  │    components/            the button, the overlay, the log        │
  │    actions.ts             thin wrappers over the RPCs             │
  │    queries.ts             get_active_call, list_calls             │
  │    ringtone.ts            synthesised, no asset                   │
  └────────────────────┬──────────────────────────────┬───────────────┘
                       │                              │
        ┌──────────────▼──────────────┐  ┌────────────▼──────────────┐
        │  lib/webrtc                 │  │  migration 0016           │
        │  the connection             │  │  the lifecycle            │
        │  (peer.ts, media.ts)        │  │  (start/answer/end)       │
        └─────────────────────────────┘  └───────────────────────────┘
```

The provider is mounted once, in the app shell, and never in a route. A call
outlives the page you were on when it started: a ring has to follow you from
Messages to Friends, and a peer connection that lived in a route would be torn
down by navigating.

**The database owns what the call is; `lib/webrtc` owns the connection.** The
join between them is one line in the provider — when the status becomes
`active`, the peer connection is enabled.

---

## 2. The state machine

```
                       start_call
                           │
                           ▼
                     ┌───────────┐
        ┌────────────│  ringing  │────────────┐
        │            └─────┬─────┘            │
        │                  │                  │
  callee declines    callee answers     45s, or the
        │                  │            caller gives up
        ▼                  ▼                  ▼
  ┌──────────┐       ┌──────────┐       ┌──────────┐
  │ declined │       │  active  │       │  missed  │
  └──────────┘       └────┬─────┘       └──────────┘
                          │                   │
                    somebody hangs up    notification
                          │
                          ▼
                     ┌──────────┐
                     │  ended   │
                     └──────────┘
```

Every transition is an RPC in `supabase/migrations/20260831000600_calls.sql`.
**A client cannot write to `calls` at all** — INSERT, UPDATE and DELETE are
revoked from `authenticated`, so the functions are the only door.

### Why that matters more here than elsewhere

`missed` is the difference between a notification and no notification. If a
client could set status directly it could mark its own missed calls as answered,
or manufacture a missed call from somebody else. So the outcome is **derived**,
never asserted:

| The call was… | and…                       | outcome               |
| ------------- | -------------------------- | --------------------- |
| ringing       | the initiator gave up      | `missed` · cancelled  |
| ringing       | 45 seconds passed          | `missed` · expired    |
| ringing       | a rung participant said no | `declined` · declined |
| active        | the last person left       | `ended` · hung_up     |

`end_call` takes a `reason`, but it is a _hint_. A callee hanging up on a ringing
call is a decline whatever they send — `supabase/tests/calls.test.mjs` asserts
exactly that.

---

## 3. Who may call whom

Three gates, none of them in application code:

1. **`can_post_to_conversation`** — `start_call` uses the same test as sending a
   message: you must be in the conversation, and not blocked by anyone in it. If
   you cannot write to the thread you cannot ring it.
2. **RLS on `calls`** — a call is visible to conversation members, so the record
   of one you missed is visible to you.
3. **`is_call_participant`** — gates the `call:{id}` realtime channel. Somebody
   in the conversation who was not rung cannot open the signalling stream at all.

### The hole migration 0005 left

`call_participants_insert` checked that the _inserting_ user could post to the
conversation — but not that the row they were inserting was **their own**. Any
member could add an arbitrary user id to a call, and since `is_call_participant`
gates the signalling channel, that handed a stranger the stream for a call they
were never on.

Migration 0016 replaces it with a self-only policy. The initiator still rings
everybody, which is why `start_call` is `SECURITY DEFINER`. Both directions are
now tested.

---

## 4. Two races that produce broken calls

**Simultaneous dialling.** Two friends pressing "call" in the same second must
end up in one call, not two that each think the other is not answering.
`start_call` takes an advisory lock on the conversation, and the second caller
joins the first call instead of starting a rival.

**Stale rings.** A call left ringing by a closed tab looks live and would block
every future call in that conversation. Both sweeps run before the check.

---

## 5. The timeout, in three layers

A ring stops after 45 seconds. Three things enforce that, because each covers a
case the others cannot:

| Layer                             | Covers                                    |
| --------------------------------- | ----------------------------------------- |
| `RING_TIMEOUT_MS` in the client   | The normal case, instantly, on both sides |
| `expire_ringing_calls()`          | A caller whose browser vanished mid-ring  |
| `get_active_call()`'s clock check | A read landing before the sweep has run   |

`RING_TIMEOUT_MS` and `public.ring_timeout()` are two definitions of one number.
`supabase/tests/call-session.test.mjs` fails if they drift apart.

### And an abandoned _active_ call

An active call normally ends when somebody hangs up. Three fallbacks, in the
order they fire:

1. A closing tab sends `navigator.sendBeacon` to `/api/calls/end`. A server
   action would be cancelled mid-flight; a beacon survives.
2. The surviving peer's connection reports `failed` — `KithPeer` has already
   waited out a blip and tried an ICE restart by then — and that browser ends the
   call.
3. `expire_abandoned_calls()`, a six-hour ceiling, for the only remaining case:
   both browsers dying at the same instant. It should never fire. There is no
   heartbeat on a call and adding one would mean a write every few seconds to
   catch a case that needs a power cut.

---

## 6. What travels where

| Data                                | Path                    | Stored?                                             |
| ----------------------------------- | ----------------------- | --------------------------------------------------- |
| Audio                               | Browser → browser, SRTP | **Never**                                           |
| SDP, ICE                            | `call:{id}` broadcast   | No                                                  |
| Mute state                          | `call:{id}` broadcast   | Last value only, on `call_participants.media_state` |
| Ring, answer, end                   | `user:{id}` broadcast   | The transition is, the event is not                 |
| Who called whom, when, how it ended | `calls`                 | Yes — metadata only                                 |

**Lifecycle events go to each participant's personal channel, not to
`call:{id}`.** The personal bus is already open — that is what it is for — so a
callee learns about a call before they have joined anything, and a cancelled call
cannot race a subscription that has not finished.

`user:{id}` is a shared, reference-counted subscription
(`lib/supabase/user-channel.ts`). The notification bell listens on it too, and
two Phoenix joins on one topic over one socket is not a thing to rely on.

---

## 7. Mute is told, never inferred

A muted track still arrives — it is just silent. A receiver cannot tell "muted"
from "quiet room" by listening, so an icon that guesses is an icon that is
sometimes wrong.

Each side broadcasts its own state explicitly, and the microphone toggles
`track.enabled` rather than stopping the track: unmuting has to be instant,
because people start talking before they finish pressing the button. (The camera
does the opposite, and [WEBRTC.md §6](WEBRTC.md) explains why.)

---

## 8. Screen sharing

Audio only means the microphone. A screen is video, and it is the only video
KITH sends.

### One sender, several sources

A participant sends at most one video stream, and during a call its source
changes: nothing, then a screen, then nothing again. Every one of those switches
travels on the **same sender** (`lib/webrtc/video.ts`).

That rule is what makes them free. `addTrack` creates a media line and fires
`negotiationneeded` — an offer, an answer, and a gap of black frames on the far
end. `replaceTrack` swaps the source in place with no SDP at all. So `addTrack`
happens exactly once, the first time there is any video on the call, and
everything after it is `replaceTrack` — including `replaceTrack(null)` to stop,
which keeps the sender for next time.

A voice call therefore costs one renegotiation the first time somebody shares,
and none after that.

### Stopping does not end the remote track

The consequence worth knowing, because it produces a convincing bug:
`replaceTrack(sender, null)` leaves the receiving track **alive and muted**.
`ended` only fires when the connection goes away. A receiver watching for `ended`
to learn that a share stopped waits forever and leaves a frozen last frame on
screen for the rest of the call.

The events that matter are `mute` and `unmute`, and `useHasVideoTrack` in the
overlay watches those — plus `addtrack` on the stream, because the browser
mutates the remote `MediaStream` in place when a track arrives, so React never
re-renders on its own.

### The camera and microphone are not touched

Starting a share does not re-acquire audio, does not read the mute flag, and does
not stop the camera. Somebody muted stays muted through a share; a camera that
was on stays on and gets the sender back when the share ends. Those are three
assertions in `screen-share.test.mjs` rather than three things to remember.

The camera is _not sent_ while a screen is, because they share a sender — but it
keeps running, so handing it back is instant.

### The browser's own Stop button

A native "Stop sharing" bar ends the track and tells the page nothing else. A
page that listens only to its own button goes on claiming to share a screen that
stopped — the most common screen-sharing bug, and a privacy failure rather than a
cosmetic one. `LocalMedia` listens for `ended` on the display track and treats it
exactly like the in-app Stop.

### Cancelling is not denying

`getDisplayMedia` throws `NotAllowedError` both when a policy blocks capture and
when somebody opens the picker and changes their mind. The two are genuinely
indistinguishable — same error name, and the messages differ by browser and
version.

KITH treats both as **cancelled** and shows nothing. That means somebody blocked
by enterprise policy gets no explanation, which is the cheaper mistake: they
press the button again, nothing happens, and they go and look at their settings.
The alternative accuses every person who changes their mind of denying
permission.

Other failures — no screen available, capture failed, window not focused — are
classified separately and do raise a message.

### Where it will not work at all

`getDisplayMedia` does not exist on iOS (no browser there has it, because WebKit
does not), in most embedded webviews, or on an insecure origin. The control is
**hidden** rather than disabled in those cases: a button that can never work is
not a button. Detection goes through `useSyncExternalStore` so it survives
hydration, since the overlay is server-rendered for anybody who refreshes
mid-call.

### No tab audio

`getDisplayMedia` is asked for video only. Chromium offers a "share tab audio"
checkbox when you request audio, and publishing that would need a second audio
sender alongside the microphone — mixing them into one track would mean the far
end could not mute you without also muting the video. A checkbox that silently
does nothing is worse than no checkbox, so it is not offered until that sender
exists.

### Saying so

Sharing a screen is the one state in KITH where forgetting you are in it has real
consequences, so it is signposted three ways at once: the control turns ember and
sets `aria-pressed`, a pulsing ember strip in the call panel reads "You're
sharing your screen" with a Stop button beside it, and your own screen is
previewed underneath — which is how people notice they picked the wrong window.

The panel widens rather than being replaced, so a share reads as the same call
changing rather than a new surface arriving.

---

## 9. The interface

**The call button** sits in the conversation header and on every row of the call
log. It is disabled whenever any call is live, because there is only ever one —
the database refuses a second (`already_in_call`), but a button that cannot be
pressed is a better answer than an error you have to read.

**Ringing is full-screen.** A ring is the only thing that matters until it is
dealt with, and burying it in a corner is how calls get missed. **Connected is a
bar.** You are meant to carry on using the app while talking.

Answer and hang up are the only two controls in KITH that are not built from the
design system's `Button`. They must be hit correctly under pressure and without
reading, so they are big, round, colour-coded and far enough apart that a thumb
cannot catch the wrong one.

**The ring is synthesised** — two sine tones through a soft envelope, no asset to
download. Browsers refuse to start audio before the page has been interacted
with, so a freshly restored tab may genuinely be silent. The visual ring never
depends on the audible one.

---

## 10. Testing

```
npm run calls:test         94 assertions — the lifecycle and its boundaries
npm run call-session:test  55 assertions — two sessions, one call, end to end
npm run screen-share:test  82 assertions — capture, stopping, and the sender rule
```

`screen-share.test.mjs` installs a fake `navigator.mediaDevices` — tracks that
record whether they were stopped, a picker that can be told to be cancelled — and
drives the real `LocalMedia` and `VideoPublisher` against it. That is what makes
the invisible half assertable: that a share never re-acquires the microphone,
that a mute survives one, that the browser's own stop bar is noticed, and that
exactly one media line is ever created however many times the source changes.

`calls.test.mjs` is mostly negative, because the interesting questions are:
can a stranger ring a conversation they are not in, can a participant mark their
own declined call as answered, can somebody add a third person to a call and pick
up the signalling stream. None of those can be answered by using the app.

`call-session.test.mjs` runs the whole thing: two authenticated Postgres roles
against the real migrations, and two `KithPeer` instances over `libdatachannel`
— real ICE, real DTLS — that negotiate, connect and carry bytes. It also
evaluates the `call:{id}` channel policies for the first time in this codebase.
Every earlier suite asserted those policies _existed_; existence is not
behaviour, and a policy naming the wrong helper still exists.

### Two real browsers

The automated suites cannot cover `getUserMedia`, autoplay policy, or whether the
ring is audible. Those need hands:

1. `npm run dev`, with Supabase configured (see [SUPABASE.md](SUPABASE.md)).
2. Sign in as one person in a normal window, another in a private window.
3. Become friends, open the DM, press the call button.
4. Check, in order: the ring is heard and seen; answer connects within a second
   or two; both people can hear each other; mute shows on the _other_ side;
   hang up ends it for both; the call appears in both logs with the same
   duration.
5. Then screen sharing: share a window, check the other person sees it and that
   your own preview matches what you picked; stop from the in-app button, then
   share again and stop from the **browser's own** bar — the panel must notice
   both. Mute yourself first and confirm you are still muted afterwards.
6. Then the unhappy paths — decline, let it ring out for 45 seconds, close the
   caller's tab mid-call, dismiss the screen picker without choosing anything
   (nothing should happen, and no error should appear), and turn one machine's
   wifi off and on again.
7. `chrome://webrtc-internals` shows the candidate pairs and the selected route
   if a connection does not come up.

**Both browsers must reach each other's network.** On the same wifi that is
automatic. Across the internet, STUN alone covers most home connections and
fails behind symmetric NAT, carrier-grade NAT, or a firewall that drops UDP.
Configure a relay to cover those — [TURN.md](TURN.md) — and check the call panel
for `· relayed` to confirm it is being used.

---

## 11. Not built

- **Camera video.** The `calls.kind` column and the `MediaState.cameraEnabled`
  flag both exist, the capture code is written (`lib/webrtc/media.ts`), and
  `VideoPublisher` already switches between a camera and a screen on one sender —
  every one of those paths is tested. Nothing offers the control yet.
- **Tab and system audio** alongside a share. See §8.
- **Group calls.** The schema is group-shaped throughout — `start_call` rings
  every member and `end_call` keeps a call alive while two people remain — but
  the provider holds one peer connection, so it is 1:1 in practice. A mesh is one
  `KithPeer` per participant.
- **TURN by default.** It is supported and documented ([TURN.md](TURN.md)) but not configured here, so calls behind restrictive NAT will not connect until somebody sets it up.
- **A call inside the message thread.** `message_kind` already has a `call_event`
  member for this; the log is a separate page for now.
- **Ring on other devices.** The ring goes to every session of yours that is
  listening, but answering on one does not visibly stop the others beyond the
  `call.updated` broadcast.
