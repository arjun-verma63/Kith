# Progressive web app

KITH installs to a home screen, opens without browser chrome, and has an offline
page. It does **not** have push notifications — §5.

---

## 1. There is no push, and nothing pretends there is

**KITH's notifications are rows in a table read by the bell in the header.** They
do not reach a locked phone.

So the manifest declares no `gcm_sender_id`, the service worker has no `push` or
`notificationclick` handler and never calls `showNotification`, and nothing in
the app calls `Notification.requestPermission()`. An install that asks for
notification permission and then never sends one is worse than an install that
does not ask.

All five of those are asserted, and the assertion is not vacuous — adding a
`gcm_sender_id` to the manifest makes `npm run pwa:test` fail.

**What real push would take:** VAPID keys, a `push_subscriptions` table, a
`pushManager.subscribe()` flow with its own permission UI, a `push` handler in
the worker, and something server-side to send from — a Supabase Edge Function
triggered by the same insert the bell already watches. That is a feature with a
schema, not a manifest key, and it is not here.

---

## 2. The service worker caches build assets and nothing else

This is the part that could break authentication, so the rules are narrow and
each one is tested by **running the worker**, not by grepping it. `pwa.test.mjs`
loads `public/sw.js` into a sandbox with a fake cache and a fake network and
fires synthetic fetch events at it.

| Rule                             | Protecting                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No HTML is ever cached           | Every page carries who you are. A cached signed-in shell served to a signed-out browser is a leak; a stale one renders the app around a session that has since been refused a second factor |
| Nothing cross-origin is touched  | Supabase Auth, PostgREST, Storage and Realtime are all another origin. Not caching them would do; not _seeing_ them is better                                                               |
| Nothing but GET is touched       | Server actions are POSTs to page URLs. A worker that retried or replayed one is a very long-tailed bug                                                                                      |
| `/auth` and `/api` are untouched | The confirmation route consumes a one-time token. Anything clever in front of it can consume it twice                                                                                       |

What _is_ cached: `/_next/static/*`, which is content-hashed so a URL's bytes can
never change, and `/icons/`. Only 200s — storing a 404 under an immutable URL
would make it permanent.

### Navigations

Network first, always, and the response is never stored. The offline page appears
only when `fetch` **rejects**, which is a dead network. A 401, a 500 or a redirect
to `/login` are all successful responses and pass straight through — replacing a
redirect with "you are offline" would hide a real answer.

### Updating

Deliberately **no `skipWaiting()`**. A new worker waits until every tab is closed,
which means the cache cleanup on activate can never delete assets a live page is
still using. The cost is that an update lands on the next cold start rather than
the next reload, which for six people is not a cost.

---

## 3. WebRTC is unaffected, structurally

Not by care — by the shape of the thing. A peer connection is not HTTP, so it
never produces a fetch event. Neither does a WebSocket upgrade, so Supabase
Realtime — which carries the signalling — is invisible to the worker too. STUN
and TURN are UDP/TCP to another host entirely.

The suite still asserts the Supabase origins pass through untouched, because that
is the part that _could_ have been intercepted.

One real interaction worth knowing: **`getUserMedia` in an iOS home-screen web
app was broken until iOS 14.3.** It works now. Permissions are per-origin and are
granted separately in the installed app from Safari, so the first call from the
installed app asks for the microphone again.

---

## 4. Installability

Chrome wants: a manifest with a name, a 192 and a 512 icon, a `start_url`, a
`display` that is not `browser`, and a service worker with a fetch handler. All
five are asserted, because missing one means the install prompt silently never
appears.

### `start_url` is `/messages`, not `/`

The root is the marketing page, which is the wrong thing to open for somebody who
has installed the app — they are signed in and want the room. Signed out,
middleware sends it to `/login` carrying the destination, so the first launch
after installing still lands in the right place.

`id` is pinned to `/` and must never change. It is what a browser uses to decide
whether an install is _this_ app; without it the identity is `start_url`, so
moving where the app opens would orphan every existing installation.

### Three icon shapes, not one file at three sizes

| Purpose     | Shape                   | Why                                                                                                                                     |
| ----------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `any`       | Rounded tile            | Drawn as supplied — tabs, task switchers, shortcuts                                                                                     |
| `maskable`  | Full bleed, mark at 82% | Android crops to the launcher's shape and only the central 80% survives. A rounded tile handed to a circular launcher loses its corners |
| Apple touch | Square, opaque          | iOS rounds it itself and **ignores transparency** — a transparent PNG comes out on a black square                                       |

Shipping one file for all three is the most common PWA icon mistake, and it looks
wrong on exactly one platform, which is how it survives review.

The suite decodes the maskable 512, finds the bounding box of the ink and checks
it is inside the safe circle — 158px of an available 205. It also checks the mark
is not _too_ small, because the first pass used a 0.62 scale and drew a timid
little K in a lot of nothing.

Regenerate with `npm run icons` after changing the mark. The output is committed,
because the manifest and the iOS `<link>` need stable URLs and a build-time image
route gives you hashed ones.

---

## 5. Launch behaviour and the chrome

`display: standalone`, `background_color` and `theme_color` both the dusk ground.

**The theme colour follows the theme the person chose**, which a manifest cannot
express — KITH's theme is a stored preference, not a system one, so a static
value would put a near-black status bar above a Daylight app. The appearance
bootstrap rewrites the `<meta name="theme-color">` tag alongside `data-theme`.

iOS reads none of the manifest, so it gets its own metadata: `appleWebApp.capable`
(without it the home-screen icon opens in a tab with an address bar) and
`statusBarStyle: "black-translucent"`, which is the other half of
`viewport-fit: cover` and the reason the header pads itself by `--safe-t`.

Two shortcuts on a long-press — Messages and Games. Not five: a shortcut menu
mirroring the navigation is a second navigation to maintain, and these are the
two things somebody opens the app _to do_.

No `orientation` lock, because the mobile pass made landscape work. No
`screenshots`, because there are none that would not be invented.

### The manifest, the worker and the offline page bypass the auth middleware

All three are fetched with no session and must answer the same way to everybody.
A manifest that 307s to `/login` is one a browser refuses to install from, and a
service worker served a redirect fails registration outright.

---

## 6. The iOS storage jar

**Worth knowing before anybody installs it.** On iOS, a home-screen web app has
its own storage, separate from Safari's. Signing in _in Safari_ does not sign you
in in the installed app.

So the flow is: install first, then sign in from inside the installed app. The
same applies to an email confirmation link — tapping one opens Safari, and the
session it creates belongs to Safari.

There is no fix for this at the app layer; it is how the platform works. It is
here so that "I installed it and it asked me to sign in again" is a documented
answer rather than a mystery.

---

## 7. Testing

```
npm run pwa:test    68 assertions
```

The service-worker section is the valuable half, and it **executes** the worker.
"The file contains the string `/auth/`" is not the same claim as "a request to
`/auth/confirm` reaches the network untouched", and only the second one keeps a
one-time token from being consumed twice.

What it cannot check: whether an install actually succeeds, what the icon looks
like on a launcher, or whether the splash screen is the right colour. A person
with a phone still has to:

1. **Open the app in Chrome on Android.** An install prompt should appear; take
   it. The icon should be a K in a rounded tile, and on a launcher that crops to
   a circle it should still be a whole K.
2. **Open the installed app.** No address bar. It should land on Messages, not on
   the landing page.
3. **Long-press the icon.** Messages and Games.
4. **Turn off the network mid-session and navigate.** The offline page, not the
   browser's error. Then back on, and "Try again".
5. **Sign out and back in, inside the installed app.** Auth must work exactly as
   it does in a tab — this is the one the service worker could have broken.
6. **Make a call from the installed app.** It should ask for the microphone
   separately from Safari, and then work.
7. **iOS: Share → Add to Home Screen**, then sign in _from the installed app_
   (§6). Check the status bar is dark in Dusk and light in Daylight.

Number 5 is the one to do first.
