# WebRTC in KITH

Voice and video for a room of six people, built peer to peer.

This document covers the foundation: how a connection is made, who is
responsible for what, and — just as importantly — what deliberately does not
exist yet. The call UI, ringing, and the `calls` lifecycle sit on top of this and
are a later phase.

---

## 1. The shape of it

```
  ┌───────────────────────────────────────────────────────────────┐
  │  features/calls          React. Mounting, unmounting, state.  │
  │    use-local-media.ts    the microphone and camera            │
  │    use-peer-connection.ts one connection, for one component   │
  │    supabase-signaling.ts the only file that knows about       │
  │                          Supabase                             │
  └───────────────────────────────┬───────────────────────────────┘
                                  │
  ┌───────────────────────────────▼───────────────────────────────┐
  │  lib/webrtc              No React. No Supabase. No DOM        │
  │    peer.ts               negotiation, ICE, state, recovery    │
  │    media.ts              capture, mute, camera, devices       │
  │    signaling.ts          the transport CONTRACT + politeness  │
  │    config.ts             ICE servers and timings              │
  └───────────────────────────────────────────────────────────────┘
```

The split is load-bearing rather than decorative. `peer.ts` has no import of
React, Supabase, or `navigator`, which is why the test suite can run the real
negotiation code against a real native WebRTC stack in Node and assert that two
peers actually connect. A layer that could only run in a browser could only be
tested by clicking.

**Dependencies point one way.** `features/calls` may use `lib/webrtc`; nothing in
`lib/webrtc` may reach back. ESLint enforces this.

---

## 2. What travels where

This is the part worth being precise about, because getting it wrong is both a
cost problem and a privacy problem.

| Data                                | Path                        | Stored?                                                   |
| ----------------------------------- | --------------------------- | --------------------------------------------------------- |
| Audio, video, screen share          | Browser → browser, SRTP     | **Never**                                                 |
| SDP offers and answers              | Supabase Realtime broadcast | No                                                        |
| ICE candidates                      | Supabase Realtime broadcast | No                                                        |
| Mute / camera / screen flags        | Supabase Realtime broadcast | Last known value only, on `call_participants.media_state` |
| Who called whom, when, how it ended | Postgres, `calls`           | Yes — metadata only                                       |

**Media never touches our infrastructure.** Not the database, not Storage, not
even the Realtime socket. Once negotiation finishes, the signalling channel goes
quiet and the two browsers talk directly. This is not only a privacy property; it
is the reason six people can have a video call on a free tier at all.

**Signalling is never persisted.** An SDP blob is worthless a second after it
arrives and an ICE candidate is worthless sooner. Writing them to a table would
mean a row per candidate per call — write amplification for data with a
two-second shelf life. `supabase/tests/webrtc.test.mjs` asserts this against the
live schema: the `calls` and `call_participants` tables have no column that could
hold an SDP, a candidate, or a byte of media.

---

## 3. Establishing a connection

```
  Caller                     Supabase Realtime                    Callee
    │                        (call:{callId})                        │
    │                                                               │
    │  1. both subscribe — RLS checks is_call_participant()         │
    │◄─────────────────────────────────────────────────────────────►│
    │                                                               │
    │  2. addTrack(microphone) → negotiationneeded                  │
    │                                                               │
    │  3. sdp: offer  ────────────────────────────────────────────► │
    │                                                               │
    │                              4. setRemoteDescription(offer)   │
    │  ◄──────────────────────────────────────────── sdp: answer    │
    │                                                               │
    │  5. ice: [candidate, candidate, …]  ◄────────────────────────►│
    │           batched on a 200 ms timer                           │
    │                                                               │
    │  6. connectionState → "connected"                             │
    │                                                               │
    │═══════════ audio and video, direct, peer to peer ════════════ │
    │            (nothing above this line is involved any more)     │
```

### Authorization happens before step 1

The `call:{callId}` channel is private. Subscribing to it is checked against an
RLS policy on `realtime.messages` that calls `is_call_participant()` — see
`supabase/migrations/20260825000900_realtime.sql`. Somebody in the conversation
who was not rung cannot open the channel at all.

Nothing in the client checks permissions, and nothing should: by the time a
message reaches `peer.ts`, the database has already decided the sender belongs on
the call. `peer.ts` adds one cheap second layer — it drops any message whose
`from`/`to` do not match the pair it was constructed for — so a participant
cannot confuse one connection by addressing another.

---

## 4. Perfect negotiation

The hard part of WebRTC is not connecting. It is connecting when both sides try
to renegotiate at the same moment: somebody starts a screen share exactly as
somebody else switches camera, both call `setLocalDescription`, and both then
receive an offer while in `have-local-offer`. Handled naively, both fail, both
retry, and the call deadlocks — under precisely the conditions that are hardest
to reproduce deliberately.

KITH uses the WHATWG **perfect negotiation** pattern, which resolves this by
making the two sides asymmetric:

- The **polite** peer rolls back its own offer and accepts the incoming one.
- The **impolite** peer ignores the incoming offer and presses on with its own.

Politeness is derived, not negotiated:

```ts
export function isPolite(selfId: string, peerId: string): boolean {
  return selfId > peerId;
}
```

Comparing user ids means both sides compute the same answer from information they
already hold — no extra round trip, and no window in which they could disagree.

Three flags in `peer.ts` implement it: `makingOffer`, `ignoreOffer`, and
`settingRemoteAnswerPending`. All three are load-bearing. Removing any one
reintroduces the deadlock.

The same asymmetry is reused for recovery: **only the impolite peer restarts
ICE.** Both restarting at once produces exactly the glare the pattern then has to
resolve, turning one recovery into two round trips.

---

## 5. Connection states

`peer.ts` collapses the browser's states into five the UI can actually render:

| State          | Meaning                        | What the UI should show                |
| -------------- | ------------------------------ | -------------------------------------- |
| `new`          | Constructed, nothing attempted | —                                      |
| `connecting`   | Negotiating, ICE in progress   | "Connecting…"                          |
| `connected`    | Media is flowing               | The call                               |
| `reconnecting` | Dropped, trying to recover     | A warning, and keep the call on screen |
| `failed`       | Negotiation errored            | An error, and offer to redial          |
| `closed`       | Torn down                      | The call is over                       |

### `disconnected` is not `failed`

The single most important line in the state machine:

```ts
case "disconnected":
  this.setState("reconnecting");
  if (this.disconnectTimer === null) {
    this.disconnectTimer = setTimeout(() => this.restart(), RECONNECT_GRACE_MS);
  }
  break;
```

`disconnected` is routinely transient. A wifi-to-cellular handover produces it
and recovers on its own within a second or two. Tearing the call down there would
end perfectly good calls every time somebody walked past a lift. So the state
becomes `reconnecting`, a four-second grace timer starts, and if the connection
comes back the timer is cleared and nothing happens at all.

`failed` gets no grace period — it is not transient — and restarts ICE
immediately.

### Reconnecting is not permanent either

Entering `reconnecting` also arms a 20-second deadline (`RECONNECT_TIMEOUT_MS`);
if the connection has not come back by then the state becomes `failed`.

Without it, a peer whose partner closed their laptop would show "Reconnecting…"
forever: the polite side never restarts ICE by design, and a restart nobody
answers does not fail on its own. That is the same failure mode presence was
built to avoid — a light that stays on because nothing ever turned it off. An
honest error beats a spinner that means nothing.

---

## 6. Microphone and camera: muted is not off

`media.ts` treats the two controls differently, on purpose.

**Microphone — `track.enabled = false`.** The hardware stays open and silence is
sent. It is instant, needs no permission prompt, and is reversible in the same
tick. That matters: people start talking before they finish pressing unmute.

**Camera — `track.stop()`, then re-acquire.** This releases the device, so the
camera indicator light goes out. It is the only honest way to turn a camera off.
A user who presses "camera off" and watches the light stay on has been lied to,
and no amount of "the track is disabled, we promise" repairs that. The cost is a
few hundred milliseconds to turn it back on, which is a fair price for a control
people can trust.

Turning the camera back on produces a _new_ track, which is handed to the peer
connection via `replaceTrack` on the existing sender rather than `addTrack`.
`addTrack` would renegotiate the whole session on every camera toggle, and the
other side would see a black frame while it happened.

### Mute state is broadcast, never inferred

A muted track still arrives — it is just silent. A receiver cannot tell "muted"
from "quiet room" by inspecting the stream, so an icon that guesses is an icon
that is sometimes wrong. Each side broadcasts its own `MediaState`
(`micEnabled`, `cameraEnabled`, `screenSharing`) explicitly.

---

## 7. ICE candidates are batched

Trickle ICE produces a burst of candidates in the first second of a call, and
sending each as its own broadcast is the one thing in KITH capable of spending a
free-tier monthly message allowance. So candidates accumulate and flush on a
200 ms timer (`ICE_BATCH_MS`), which turns a dozen messages into one or two.

Candidates arriving **before** the description they belong to are queued.
`addIceCandidate` rejects while there is no remote description, and broadcast
delivery is not ordered end to end — a candidate genuinely can overtake an SDP.
Without the queue the first candidates of a racy negotiation are silently
dropped, which does not break the call outright; it just makes connecting
intermittently slow, which is far harder to diagnose than a clean failure.

---

## 8. STUN now, TURN later

`config.ts` ships two STUN providers (Google and Cloudflare) and no TURN.

STUN only tells a peer what its public address looks like from the outside; the
two browsers still connect directly. That works for most home networks. It does
**not** work behind symmetric NAT or a restrictive corporate firewall, where a
relay is required — and a relay is what TURN is.

TURN is deliberately not implemented yet, per the phase brief. The seam for it
already exists:

```ts
buildIceConfiguration({ turnServers, forceRelay });
```

Adding relays later is a value passed in, not a change to any negotiation code.
When it lands, the credentials must be **short-lived and minted server-side** —
a static TURN password in client JavaScript is a free bandwidth relay for
anybody who opens devtools. `TURN_SHARED_SECRET` is already on the
client-bundle scanner's forbidden list (`scripts/check-client-bundle.mjs`), so
the day it appears in a browser bundle, the build fails.

---

## 9. Using it

```tsx
"use client";

import { useLocalMedia } from "@/features/calls/use-local-media";
import { usePeerConnection } from "@/features/calls/use-peer-connection";

export function CallSurface({ callId, selfId, peerId }: Props) {
  const peer = usePeerConnection({ callId, selfId, peerId, localStream: null });

  const media = useLocalMedia({
    autoStart: true,
    onVideoTrack: peer.setVideoTrack, // camera toggles replace, never renegotiate
  });

  // …attach media.stream and peer.remoteStream to <audio>/<video> elements
}
```

Publishing the stream is a matter of passing it in — `usePeerConnection` takes
`localStream` and adds its tracks when it appears. In a group call, one
`useLocalMedia` feeds several `usePeerConnection` hooks: capture once, publish
many times. That is why capture is not inside the connection hook.

`useLocalMedia` releases the hardware on unmount. That one line is what stops a
camera light staying on after a call ends.

---

## 10. Testing

`npm run webrtc:test` — 87 assertions.

The brief asked for proof that two sessions can establish a peer connection, and
a mock cannot answer that: a mock connects because it was written to. So the
connection tests drive `libdatachannel` through `node-datachannel/polyfill` — a
real C++ WebRTC stack, with real ICE, real DTLS and real SCTP. The suite creates
two `KithPeer` instances, negotiates between them through a loopback transport,
waits for both to reach `connected`, opens a data channel and sends bytes across
it. When it passes, two peers really connected and really carried data.

Those tests run with **no ICE servers**, connecting over host candidates on the
loopback interface, so the suite needs no network — a test that silently depends
on Google's STUN server is a test that fails on a train. The STUN configuration
the application actually ships is asserted separately, as configuration.

Glare is tested against a recording stub instead. A race you have to provoke is a
race you cannot assert on reliably, so the stub makes the collision exact: both
peers offer in the same tick, and the suite asserts that the impolite peer never
applied the colliding offer while the polite one accepted it and answered.

Also covered: out-of-order candidate delivery, messages from or to the wrong
peer, hangup propagation, idempotent teardown, the `disconnected`-is-not-`failed`
grace period, the recovery deadline that stops "Reconnecting…" being permanent,
that only the impolite peer restarts ICE, and — against the live
schema in PGlite — that nowhere in `calls` or `call_participants` could media or
signalling be stored.

### Two real browsers

The Node suite proves the negotiation. To watch it between two actual browser
sessions, open the app in a normal window and a private window, sign in as two
different people, and join the same call; `peer.connection` is exposed read-only
for exactly this, so `chrome://webrtc-internals` will show the candidate pairs and
the selected route.

---

## 11. Not yet built

Deliberately out of scope for this phase:

- **The call UI** — ringing, answering, declining, the in-call surface.
- **The call lifecycle** — creating `calls` rows, marking missed, ending.
- **TURN** — see §8.
- **Group calls.** The architecture is ready: one `KithPeer` per remote
  participant in a mesh, one shared local stream. At six people a mesh is the
  right answer — an SFU is a server we would have to run, and at this size it
  would cost more than it saved.
- **Screen share.** `acquireDisplayStream()` exists in `media.ts` and the
  `screenSharing` flag is already on the wire; nothing calls it yet.
