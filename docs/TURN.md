# TURN — relayed calls

Where the relay credentials live, what each one can do, and how to tell whether
any of it is working.

TURN is **optional and off by default**. A fresh clone of this repository builds,
runs and makes calls with none of it configured — calls fall back to public STUN,
exactly as they did before this existed. What you lose is described in §1.

---

## 1. Why a relay is needed at all

ICE tries three kinds of route and keeps the best one that works:

| Candidate | Route                           | Works when                                           |
| --------- | ------------------------------- | ---------------------------------------------------- |
| `host`    | The local network               | Both people are on the same wifi                     |
| `srflx`   | The public address STUN reports | Both NATs accept a return packet — most home routers |
| `relay`   | Through a TURN server           | Always, at the cost of bandwidth                     |

STUN alone fails for a real share of pairs, and the failures are not random. They
cluster on exactly the networks people are on when they most want to call:

- **Symmetric NAT** — the mapping differs per destination, so the address STUN
  reports is not the one the other peer would reach.
- **Carrier-grade NAT** — most mobile networks.
- **Corporate firewalls** — UDP simply absent, sometimes everything but TCP 443
  absent.

That last case is why **TURN over TLS on 443** matters: to a firewall it is
indistinguishable from HTTPS, which is the entire point of it.

---

## 2. Where each credential goes

**This is the part to get right.** A TURN credential in a browser bundle is an
open bandwidth proxy for anybody who opens devtools — and TURN relays arbitrary
traffic, so it is not only a bill, it is an open proxy.

| Variable                      | Secret? | Set it in                               | Reaches the browser?                |
| ----------------------------- | ------- | --------------------------------------- | ----------------------------------- |
| `TURN_URLS`                   | No      | `.env.local`, Vercel (all environments) | **Yes** — hostnames are not secrets |
| `TURN_SHARED_SECRET`          | **Yes** | `.env.local`, Vercel **server-side**    | **Never**                           |
| `TURN_CREDENTIAL_TTL_SECONDS` | No      | Optional, defaults to 600               | No                                  |
| `TURN_USERNAME`               | No      | Only for static-credential providers    | Yes, to signed-in users             |
| `TURN_PASSWORD`               | **Yes** | Only for static-credential providers    | Yes, to signed-in users — see §4    |

**Never prefix any of these with `NEXT_PUBLIC_`.** That inlines the value into
every JavaScript file the site serves.

Three mechanisms enforce it, in order of how early they catch a mistake:

1. `src/lib/server/turn.ts` starts with `import "server-only"`. A client
   component importing it, directly or through any chain, **fails the build**.
2. `src/lib/webrtc/config.ts` — the module the browser _does_ get — reads no
   environment and has no credential fields. Relay entries are passed in.
3. `npm run build && npm run check:bundle` greps the built client bundle for the
   literal values of `TURN_SHARED_SECRET` and `TURN_PASSWORD`. This is the one
   that catches a value interpolated into a string or leaked by a dependency.

---

## 3. The preferred setup: ephemeral credentials

The scheme TURN was designed for (RFC 5766 §10.2, and the "TURN REST API"
draft). Your server and the TURN server share **one secret**. Nobody registers a
user, nothing is stored, and every credential expires on its own.

```
username   = "<unix expiry>:<user id>"
credential = base64( HMAC-SHA1( shared secret, username ) )
```

The TURN server recomputes the same HMAC to verify. SHA-1 is not a preference —
`coturn` and every compatible relay compute exactly this, and a different digest
simply fails to authenticate. It is used as a MAC with a high-entropy key, which
is the one construction SHA-1 remains sound for.

### coturn

```ini
# /etc/turnserver.conf
realm=kith.example.com
listening-port=3478
tls-listening-port=5349

use-auth-secret
static-auth-secret=<the same value as TURN_SHARED_SECRET>

# TLS on 443 as well, where nothing else is bound to it. This is the entry that
# gets through a corporate firewall.
alt-tls-listening-port=443

cert=/etc/letsencrypt/live/kith.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/kith.example.com/privkey.pem

# A relay should relay, not scan. Without this it is an open proxy into your
# private network and anybody's loopback.
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
```

### KITH

```bash
# .env.local — never committed
TURN_URLS="turn:kith.example.com:3478?transport=udp,turn:kith.example.com:3478?transport=tcp,turns:kith.example.com:443?transport=tcp"
TURN_SHARED_SECRET="<the same value as static-auth-secret>"
TURN_CREDENTIAL_TTL_SECONDS="600"
```

Rotating the secret invalidates every outstanding credential at once, which is
the property that makes a leak survivable.

### Managed providers

Any provider offering the shared-secret scheme drops straight in — the point of
this design is that changing provider is a change to `.env`, not to the
application. Nothing outside `lib/server/turn.ts` and the environment knows who
the relay is.

A provider with its own credential API needs one more branch in
`getTurnCredential()`; the shape it returns (`iceServers`, `expiresAt`,
`source`) already accommodates it.

---

## 4. The fallback setup: static credentials

For providers that offer nothing else.

```bash
TURN_URLS="turn:relay.provider.example:3478?transport=udp,turns:relay.provider.example:5349?transport=tcp"
TURN_USERNAME="..."
TURN_PASSWORD="..."
```

Still never inlined into the bundle — the credential is delivered through an
authenticated server action to somebody who is demonstrably on a call. But it is
genuinely weaker, and the app logs a warning at boot saying so:

- It **does not expire**. A leak is permanent until somebody notices.
- Rotating it means editing an environment variable and redeploying.
- Every signed-in member receives the same credential, so a relay's logs cannot
  attribute traffic to a person.

Setting both `TURN_SHARED_SECRET` and the static pair is not an error: the shared
secret wins, on the assumption that somebody who configured both forgot to remove
the old one.

---

## 5. Configure all three transports

```
turn:<host>:3478?transport=udp     the fast path
turn:<host>:3478?transport=tcp     survives networks that drop UDP
turns:<host>:443?transport=tcp     survives firewalls that allow only HTTPS
```

UDP alone is the usual first configuration and it covers most of what STUN
misses. What it does not cover is the office, and the symptom of stopping there
is **"calls work for everybody except the person at work"** — which is a
miserable thing to diagnose three months later.

So the app warns at boot when the TLS entry is missing, and again when the UDP
entry is missing. `describeIceServers()` is what those warnings are computed
from, and `npm run turn:test` asserts they fire.

---

## 6. Verifying it actually works

**This is the step people skip, and it is the one that matters.** On any open
network every call connects directly, so a completely broken relay configuration
looks perfect until the first person on a locked-down network tries to ring
somebody.

Three ways to check, in increasing order of confidence:

**Watch the call panel.** A connected call that is going through a relay says
`· relayed` next to the timer. Read from the connection's selected candidate
pair, not from what was configured — so it is evidence rather than a claim. A
direct call says nothing, which is the normal case.

**Force it.** `buildIceConfiguration({ forceRelay: true })` sets
`iceTransportPolicy: "relay"`, which discards every host and server-reflexive
candidate. If the call still connects, the relay works. If it does not, the relay
was never working and you have just found out on your own network instead of
somebody else's.

**Read the ICE state.** `chrome://webrtc-internals` shows every candidate pair
and which was selected. A `relay` candidate that never appears means the
credential was rejected; one that appears but is never selected means the relay
works and was simply not needed.

---

## 7. What it costs

Relayed media is **billed bandwidth in both directions** — every packet arrives
at the relay and leaves again. A voice call at roughly 40 kbit/s each way is
about 36 MB an hour of relayed traffic for the pair.

Only the calls that need a relay use one; everything else stays peer-to-peer and
costs nothing. For a room of six people that is a small bill, and the reason
`iceCandidatePoolSize` drops to `0` as soon as TURN is configured: pre-gathering
would allocate a relay on the TURN server before anybody had called anybody, for
calls that may never happen.

---

## 8. When a credential expires mid-call

It does not break the call. An existing relay allocation keeps working after the
credential that created it expires — the credential authenticates the
_allocation_, not each packet.

It breaks the **reconnection**, which is worse, because that is the moment the
call has already dropped and the recovery fails too for a completely invisible
reason. So `KithPeer` takes a `refreshConfiguration` callback and fetches new
credentials immediately before an ICE restart. Ten minutes is short enough to be
safe and long enough that no realistic call setup outruns it.

---

## 9. Testing

```
npm run turn:test          82 assertions
npm run build && npm run check:bundle
```

The credential scheme is checked against an **independently computed HMAC**, not
against the code's own output — a wrong-but-self-consistent implementation passes
every test that only compares the code to itself, and then fails against a real
relay.

Environment-dependent behaviour runs in child processes, one per configuration,
because the environment is validated once at boot and cached. That also means the
suite covers the half-configured cases: URLs without credentials, a malformed
URL, a STUN URL in the relay list, a secret too short to be one. Every one of
them refuses to start with a message naming what is wrong — a relay that looks
configured but is not is worse than no relay, because nobody investigates.

And the assertion that matters most: the shared secret appears nowhere in what
the browser is handed.
