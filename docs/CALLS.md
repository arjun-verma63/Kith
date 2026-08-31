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

## 8. The interface

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

## 9. Testing

```
npm run calls:test         94 assertions — the lifecycle and its boundaries
npm run call-session:test  48 assertions — two sessions, one call, end to end
```

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
5. Then the unhappy paths — decline, let it ring out for 45 seconds, close the
   caller's tab mid-call, and turn one machine's wifi off and on again.
6. `chrome://webrtc-internals` shows the candidate pairs and the selected route
   if a connection does not come up.

**Both browsers must reach each other's network.** On the same wifi that is
automatic. Across the internet it will work for most home connections and fail
behind symmetric or carrier-grade NAT, because there is no TURN relay yet —
[WEBRTC.md §8](WEBRTC.md) covers what that will take.

---

## 10. Not built

- **Video.** The `calls.kind` column and the `MediaState.cameraEnabled` flag both
  exist and the capture code is written (`lib/webrtc/media.ts`); nothing offers
  it.
- **Group calls.** The schema is group-shaped throughout — `start_call` rings
  every member and `end_call` keeps a call alive while two people remain — but
  the provider holds one peer connection, so it is 1:1 in practice. A mesh is one
  `KithPeer` per participant.
- **TURN**, so calls behind restrictive NAT will not connect.
- **A call inside the message thread.** `message_kind` already has a `call_event`
  member for this; the log is a separate page for now.
- **Ring on other devices.** The ring goes to every session of yours that is
  listening, but answering on one does not visibly stop the others beyond the
  `call.updated` broadcast.
