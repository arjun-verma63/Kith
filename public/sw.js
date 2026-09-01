/*
 * KITH service worker.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS FILE CACHES BUILD ASSETS AND NOTHING ELSE.
 *
 *  It exists for two reasons: an installable PWA needs a fetch handler, and a
 *  phone on a bad train connection should not stare at a browser error page.
 *  It does not exist to make KITH work offline. KITH is a room with other
 *  people in it; there is nothing to do in it alone.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── The rules, and what each one is protecting ───────────────────────────────
 *
 * 1. NO HTML IS EVER CACHED. Every page in KITH is rendered per request and
 *    carries who you are: a cached signed-in shell handed to a signed-out
 *    browser is a data leak, and a stale one would render the app around a
 *    session that has since been refused a second factor. Navigations go to the
 *    network, always, and fall back to a static offline page only when the
 *    network throws.
 *
 * 2. NOTHING CROSS-ORIGIN IS TOUCHED. Supabase Auth, PostgREST, Storage and
 *    Realtime all live on another origin, so a `return` on the first line of the
 *    handler keeps the service worker out of every request that carries a
 *    token. Not caching them would be enough; not seeing them is better.
 *
 * 3. NOTHING BUT GET IS TOUCHED. Server actions are POSTs. A service worker
 *    that retried, deduplicated or replayed one would be a bug with a very long
 *    tail.
 *
 * 4. /auth AND /api ARE UNTOUCHED even though they are same-origin. The email
 *    confirmation route consumes a one-time token; anything clever in front of
 *    it is a way to consume that token twice.
 *
 * ── WebRTC ───────────────────────────────────────────────────────────────────
 *
 * Unaffected, structurally rather than by care. A peer connection is not HTTP,
 * so it never produces a fetch event. Neither does a WebSocket upgrade, so
 * Supabase Realtime — which carries the signalling — is invisible here too.
 * STUN and TURN are UDP/TCP to another host entirely.
 *
 * ── Updating ─────────────────────────────────────────────────────────────────
 *
 * Deliberately no `skipWaiting()`. A new worker waits until every tab is closed
 * before activating, which means the cache cleanup below can never run while a
 * page is still using the assets it is deleting. The cost is that an update
 * lands on the next cold start rather than the next reload, which for six people
 * is not a cost.
 */

const VERSION = "kith-v1";
const ASSETS = `${VERSION}-assets`;
const SHELL = `${VERSION}-shell`;

const OFFLINE_URL = "/offline.html";

/** Same-origin paths the worker must never come between. */
const OFF_LIMITS = ["/auth/", "/api/"];

/** Same-origin paths that are safe to keep, because their URLs are immutable. */
const CACHEABLE = ["/_next/static/", "/icons/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // `reload` so an install never picks up a stale copy from the HTTP cache.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
      );

      // Safe here and not before: without skipWaiting, activation only happens
      // once nothing is left running against the old worker.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Rule 3.
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Rule 2.
  if (url.origin !== self.location.origin) return;

  // Rule 4.
  if (OFF_LIMITS.some((prefix) => url.pathname.startsWith(prefix))) return;

  /*
   * Rule 1. A navigation is a page, and a page is per-session.
   *
   * The response is returned untouched and never stored. The fallback fires
   * only when fetch REJECTS — which is a dead network. A 401, a 500 or a
   * redirect to /login are all successful responses and are passed straight
   * through, because replacing a redirect with "you are offline" would be a lie
   * that hides a real answer.
   */
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cached = await caches.match(OFFLINE_URL, { cacheName: SHELL });
          return (
            cached ??
            new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } })
          );
        }
      })(),
    );
    return;
  }

  if (!CACHEABLE.some((prefix) => url.pathname.startsWith(prefix))) return;

  /*
   * Cache-first, and correct to be: everything under `/_next/static/` is
   * content-hashed, so a given URL's bytes can never change. `/icons/` is not
   * hashed, but it changes when the brand does, which is a deploy and a cache
   * version bump.
   *
   * Only 200s are kept. Storing a 404 under an immutable URL would make it
   * permanent.
   */
  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(request);
      if (hit) return hit;

      const response = await fetch(request);
      if (response.ok && response.status === 200) {
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});

/*
 * The escape hatch.
 *
 * A service worker that has gone wrong is very hard to talk somebody through
 * clearing on a phone. This lets the page ask it to remove every cache and
 * unregister itself — see `unregisterServiceWorker` in the client.
 */
self.addEventListener("message", (event) => {
  if (event.data !== "kith:reset") return;

  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.registration.unregister();
    })(),
  );
});
