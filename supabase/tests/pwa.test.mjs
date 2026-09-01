/**
 * The PWA.
 *
 * ── The service worker is executed, not grepped ──────────────────────────────
 *
 * §3 loads `public/sw.js` into a sandbox with a fake `caches` and a fake
 * network, fires synthetic fetch events at it, and asks one question of each:
 * did the worker take this request, and if so what did it do with it.
 *
 * That is the only honest way to test the thing that matters here. "The file
 * contains the string /auth/" is not the same claim as "a request to
 * /auth/confirm reaches the network untouched", and the second one is what keeps
 * a one-time email token from being consumed twice.
 *
 * ── What is being protected ──────────────────────────────────────────────────
 *
 * A service worker sits between the app and everything it fetches. Get it wrong
 * and you cache a signed-in page and serve it to a signed-out browser, or you
 * replay a server action, or you answer an expired session from disk. Every
 * assertion in §3 is one of those.
 *
 * WebRTC needs no assertions and gets none: a peer connection is not HTTP and a
 * WebSocket upgrade is not a fetch, so neither can reach a fetch handler. §3
 * covers the part that could — Supabase's REST and Auth origins.
 *
 *     npm run pwa:test
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const ROOT = process.cwd();

let passed = 0;
let failed = 0;
const failures = [];

const ok = (n) => {
  passed += 1;
  console.log(`  ✓ ${n}`);
};
const bad = (n, d) => {
  failed += 1;
  failures.push(`${n} — ${d}`);
  console.log(`  ✗ ${n}\n      ${d}`);
};
const eq = (n, a, e) =>
  JSON.stringify(a) === JSON.stringify(e)
    ? ok(n)
    : bad(n, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const truthy = (n, v, d = "expected a truthy value") => (v ? ok(n) : bad(n, d));
const falsy = (n, v, d = "expected a falsy value") => (v ? bad(n, d) : ok(n));
const section = (t) => console.log(`\n${t}`);

console.log("KITH — progressive web app\n");

/* ==========================================================================
 * 1 · The manifest
 * ========================================================================== */

section("Manifest");

/**
 * Read from the source rather than from a build.
 *
 * `manifest.ts` is a plain function returning an object literal, so the values
 * are extractable without running Next — and reading the built output would mean
 * the suite could only run after a build.
 */
const manifestRaw = readFileSync(join(ROOT, "src/app/manifest.ts"), "utf8");

/*
 * Comments stripped before anything is matched against it.
 *
 * This file explains at length what is deliberately NOT in the manifest, and the
 * first version of the `gcm_sender_id` check below happily found that sentence
 * and failed. A suite that reads its own documentation as evidence is a suite
 * that can only be made to pass by deleting the explanation.
 */
const manifestSource = manifestRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const field = (name) => {
  const match = new RegExp(`\\b${name}:\\s*"([^"]*)"`).exec(manifestSource);
  return match?.[1] ?? null;
};

{
  /*
   * Chrome's installability criteria: a name, a 192 and a 512, a start_url and a
   * display mode that is not `browser`. Miss one and the install prompt never
   * appears, silently.
   */
  eq("a stable id, so an install is not orphaned by moving start_url", field("id"), "/");
  truthy("a short name for the home screen", (field("short_name") ?? "").length > 0);
  truthy("a description", (field("description") ?? "").length > 0);
  eq("display is standalone", field("display"), "standalone");
  eq("scope is the whole origin", field("scope"), "/");

  const start = field("start_url");
  /*
   * Not "/". The root is the marketing page, which is the wrong thing to open
   * for somebody who has installed the app.
   */
  eq("it opens into the room, not the landing page", start, "/messages");
  truthy("and start_url is inside scope", start.startsWith(field("scope")));

  eq("the splash is the dusk ground", field("background_color"), "#0e0b0a");
  eq("and so is the fallback theme colour", field("theme_color"), "#0e0b0a");
}

{
  const icons = [...manifestSource.matchAll(/src:\s*"(\/icons\/[^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(icons)];

  for (const src of unique) {
    const path = join(ROOT, "public", src.replace(/^\//, ""));
    let exists = false;
    try {
      exists = statSync(path).isFile();
    } catch {
      exists = false;
    }
    truthy(`${src} exists on disk`, exists);
  }

  /*
   * `any` and `maskable` must be different files. Android crops a maskable icon
   * to whatever shape the launcher uses, so a rounded tile declared maskable
   * loses its corners — the single most common PWA icon mistake, and one that
   * looks wrong on exactly one platform.
   */
  const purposes = [...manifestSource.matchAll(/purpose:\s*"([^"]+)"/g)].map((m) => m[1]);
  truthy("both icon purposes are declared", purposes.includes("any"));
  truthy("including maskable", purposes.includes("maskable"));

  const anyIcons = [...manifestSource.matchAll(/src:\s*"([^"]+)",\s*sizes[^}]*purpose:\s*"any"/g)];
  const maskIcons = [
    ...manifestSource.matchAll(/src:\s*"([^"]+)",\s*sizes[^}]*purpose:\s*"maskable"/g),
  ];
  const anySrcs = new Set(anyIcons.map((m) => m[1]));
  const maskSrcs = maskIcons.map((m) => m[1]);

  eq(
    "and they are not the same file",
    maskSrcs.filter((src) => anySrcs.has(src)),
    [],
  );
}

/* ==========================================================================
 * 2 · The icons themselves
 * ========================================================================== */

section("Icons");

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
function pngSize(path) {
  const buffer = readFileSync(path);
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

{
  const expected = [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-192.png", 192],
    ["icon-maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
    ["favicon-32.png", 32],
  ];

  for (const [file, size] of expected) {
    const dimensions = pngSize(join(ROOT, "public/icons", file));
    eq(`${file} is a ${size}×${size} PNG`, dimensions, { width: size, height: size });
  }
}

{
  /*
   * The maskable safe zone, checked rather than trusted.
   *
   * Android guarantees only the central 80% of a maskable icon survives the
   * crop. This decodes the 512 and finds the bounding box of everything that is
   * not the background, then asks whether the furthest ink is inside that
   * circle.
   *
   * Worth having because the failure is invisible on the machine that made the
   * icon: it renders perfectly in a square and loses a limb on a launcher that
   * crops to a circle.
   */
  const sharp = (await import("sharp")).default;
  const file = join(ROOT, "public/icons/icon-maskable-512.png");
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  // The background is the dusk ground; anything meaningfully brighter is ink.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      // #0e0b0a is (14, 11, 10). The ember is (232, 97, 60).
      if (r > 60 || g > 50 || b > 50) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  truthy("the maskable icon has ink in it", maxX > 0 && maxY > 0);

  const cx = width / 2;
  const cy = height / 2;
  const corners = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ];
  const furthest = Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  const safeRadius = (width * 0.8) / 2;

  truthy(
    `every mark stays inside the safe circle (${Math.round(furthest)} of ${Math.round(safeRadius)})`,
    furthest <= safeRadius,
    `ink reaches ${Math.round(furthest)}px from centre, safe radius is ${Math.round(safeRadius)}px`,
  );

  // And is not so small it looks like a mistake — the other failure mode.
  truthy(
    "and is not lost in the middle of it",
    furthest > safeRadius * 0.45,
    `ink only reaches ${Math.round(furthest)}px; the icon is mostly background`,
  );
}

/* ==========================================================================
 * 3 · The service worker, run for real
 * ========================================================================== */

section("Service worker");

/**
 * Loads `sw.js` into a sandbox and returns a way to fire events at it.
 *
 * The point is to exercise the real routing decisions rather than to assert that
 * the file mentions the right strings.
 */
function loadWorker({ networkFails = false } = {}) {
  const listeners = new Map();
  const put = [];
  const shell = new Map();

  // Keyed on the path so a relative lookup finds what an absolute add stored,
  // which is what a real Cache does — it normalises both against the scope.
  const key = (request) => {
    const raw = typeof request === "string" ? request : request.url;
    try {
      return new URL(raw, "https://kith.example/").pathname;
    } catch {
      return raw;
    }
  };

  const cacheStub = (name) => ({
    async match(request) {
      return shell.get(key(request)) ?? null;
    },
    async add(request) {
      shell.set(key(request), new Response("offline shell", { status: 200 }));
    },
    // The response is deliberately dropped: what this stub records is THAT
    // something was written and under which key, which is the whole of what
    // "no page is ever cached" needs to assert.
    async put(request, _response) {
      put.push({ cache: name, url: typeof request === "string" ? request : request.url });
    },
  });

  const context = {
    self: {
      location: new URL("https://kith.example/"),
      addEventListener: (type, handler) => listeners.set(type, handler),
      clients: { claim: async () => {} },
      registration: { unregister: async () => {} },
    },
    caches: {
      open: async (name) => cacheStub(name),
      keys: async () => [],
      delete: async () => true,
      match: async (url) => shell.get(url) ?? null,
    },
    fetch: async (request) => {
      if (networkFails) throw new TypeError("Failed to fetch");
      const url = typeof request === "string" ? request : request.url;
      return new Response(`network:${url}`, { status: 200 });
    },
    /*
     * A browser resolves a relative URL in `new Request()` against the worker's
     * scope; Node's throws on it. The install handler builds
     * `new Request("/offline.html")`, so the sandbox has to do what a browser
     * does or the test fails on the harness rather than on the worker.
     */
    Request: class extends Request {
      constructor(input, init) {
        super(
          typeof input === "string" ? new URL(input, "https://kith.example/").toString() : input,
          init,
        );
      }
    },
    Response,
    URL,
    console,
  };

  runInContext(readFileSync(join(ROOT, "public/sw.js"), "utf8"), createContext(context));

  return {
    listeners,
    put,
    shell,
    /**
     * Fires a fetch event and reports whether the worker took it.
     *
     * The request is a plain object rather than a real `Request`, for two
     * reasons: `mode: "navigate"` is rejected by the constructor outside a
     * browser, and `mode` is read-only on an instance so it cannot be layered on
     * afterwards. The worker reads exactly three properties — `method`, `url`
     * and `mode` — and hands the object to `fetch` and to the cache, both of
     * which are stubs here that key on `url`.
     */
    async fetchEvent(url, { method = "GET", mode = "no-cors" } = {}) {
      let responded = null;

      const event = {
        request: { method, url, mode },
        respondWith: (value) => {
          responded = value;
        },
        waitUntil: () => {},
      };

      listeners.get("fetch")(event);

      return {
        intercepted: responded !== null,
        response: responded === null ? null : await responded,
      };
    },
  };
}

const SUPABASE = "https://abcdefgh.supabase.co";

{
  const worker = loadWorker();
  truthy(
    "it registers a fetch handler, which installability requires",
    worker.listeners.has("fetch"),
  );
  truthy("and an install handler", worker.listeners.has("install"));
  truthy("and an activate handler", worker.listeners.has("activate"));
}

{
  section("  auth is never touched");

  const worker = loadWorker();

  /*
   * Rule 2. Everything Supabase is cross-origin, so the worker returns before it
   * has looked at the request at all. Not caching them would be enough; not
   * seeing them is better.
   */
  for (const [name, url] of [
    ["the auth endpoint", `${SUPABASE}/auth/v1/token?grant_type=refresh_token`],
    ["the user endpoint", `${SUPABASE}/auth/v1/user`],
    ["PostgREST", `${SUPABASE}/rest/v1/profiles?select=*`],
    ["storage", `${SUPABASE}/storage/v1/object/sign/avatars/x.webp`],
    ["realtime", `${SUPABASE}/realtime/v1/websocket`],
  ]) {
    const { intercepted } = await worker.fetchEvent(url);
    falsy(`${name} passes straight through`, intercepted);
  }

  // Rule 4. Same-origin, but a one-time token lives behind it.
  for (const path of ["/auth/confirm?token_hash=abc", "/api/health", "/api/calls/end"]) {
    const { intercepted } = await worker.fetchEvent(`https://kith.example${path}`);
    falsy(`${path} passes straight through`, intercepted);
  }
}

{
  section("  mutations are never touched");

  const worker = loadWorker();

  /*
   * Rule 3. Server actions are POSTs to a page URL, which is also a navigation
   * target — so without the method check the worker would be sitting in front of
   * every mutation in the app.
   */
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const { intercepted } = await worker.fetchEvent("https://kith.example/messages", { method });
    falsy(`a ${method} is left alone`, intercepted);
  }

  const action = await worker.fetchEvent("https://kith.example/settings/privacy", {
    method: "POST",
    mode: "navigate",
  });
  falsy("including a server action posted to a page URL", action.intercepted);
}

{
  section("  no page is ever cached");

  const worker = loadWorker();

  const nav = await worker.fetchEvent("https://kith.example/messages", { mode: "navigate" });
  truthy("a navigation is handled", nav.intercepted);
  eq(
    "and answered from the network",
    await nav.response.text(),
    "network:https://kith.example/messages",
  );

  /*
   * The assertion this whole section exists for. Every page in KITH is rendered
   * per request and carries who you are; a cached signed-in shell served to a
   * signed-out browser is a data leak, and a stale one would render the app
   * around a session that has since been refused a second factor.
   */
  eq("and nothing was written to a cache", worker.put, []);

  for (const path of ["/", "/login", "/settings/security", "/u/ada"]) {
    const before = worker.put.length;
    await worker.fetchEvent(`https://kith.example${path}`, { mode: "navigate" });
    eq(`${path} is not cached either`, worker.put.length, before);
  }
}

{
  section("  offline");

  const worker = loadWorker({ networkFails: true });
  // Prime the shell the way the install handler does.
  await worker.listeners.get("install")({ waitUntil: (p) => p });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const nav = await worker.fetchEvent("https://kith.example/messages", { mode: "navigate" });
  truthy("a dead network falls back", nav.intercepted);
  truthy(
    "to something rather than an error",
    nav.response.status < 500 || nav.response.status === 503,
  );

  /*
   * The fallback fires on a rejected fetch, which is a dead network. A 401 or a
   * redirect to /login is a successful response and must be passed through —
   * replacing it with "you are offline" would hide a real answer.
   */
  const online = loadWorker();
  const redirected = await online.fetchEvent("https://kith.example/messages", { mode: "navigate" });
  eq(
    "and not when the server answers, whatever it answers",
    await redirected.response.text(),
    "network:https://kith.example/messages",
  );
}

{
  section("  build assets");

  const worker = loadWorker();

  const asset = await worker.fetchEvent("https://kith.example/_next/static/chunks/abc123.js");
  truthy("a hashed chunk is handled", asset.intercepted);
  await asset.response;
  truthy(
    "and kept",
    worker.put.some((entry) => entry.url.includes("/_next/static/")),
  );

  const icon = await worker.fetchEvent("https://kith.example/icons/icon-192.png");
  truthy("so is an icon", icon.intercepted);

  // Everything else same-origin is left alone rather than guessed about.
  for (const path of ["/manifest.webmanifest", "/some/other/thing.txt"]) {
    const { intercepted } = await worker.fetchEvent(`https://kith.example${path}`);
    falsy(`${path} is left alone`, intercepted);
  }
}

/* ==========================================================================
 * 4 · No push, claimed or implied
 * ========================================================================== */

section("No push");

{
  const swRaw = readFileSync(join(ROOT, "public/sw.js"), "utf8");
  const sw = swRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const manifest = manifestSource;

  /*
   * KITH's notifications are rows in a table read by the bell in the header.
   * They do not reach a locked phone, and nothing here should imply that they
   * do — an install that asks for notification permission and then never sends
   * one is worse than an install that does not ask.
   */
  falsy("the worker has no push handler", /addEventListener\(\s*["']push["']/.test(sw));
  falsy("nor a notificationclick handler", /notificationclick/.test(sw));
  falsy("nor does it show notifications", /showNotification/.test(sw));

  falsy("the manifest declares no push sender", /gcm_sender_id/.test(manifest));

  // And nothing in the app asks for the permission.
  const { readdirSync, statSync: stat } = await import("node:fs");
  const { extname } = await import("node:path");

  function* walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (stat(full).isDirectory()) yield* walk(full);
      else if ([".ts", ".tsx"].includes(extname(full))) yield full;
    }
  }

  const askers = [];
  for (const file of walk(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    if (/Notification\.requestPermission|PushManager|pushManager\.subscribe/.test(text)) {
      askers.push(file.replace(ROOT, "").replaceAll("\\", "/"));
    }
  }
  eq("and nothing in the app asks for notification permission", askers, []);
}

/* ==========================================================================
 * 5 · The PWA surface is reachable without a session
 * ========================================================================== */

section("Reachability");

{
  const middleware = readFileSync(join(ROOT, "src/middleware.ts"), "utf8");

  /*
   * All three are fetched with no session and must answer the same way to
   * everybody. A manifest that redirects to /login is a manifest a browser
   * refuses to install from, and a service worker served a redirect fails
   * registration outright.
   */
  for (const path of ["manifest.webmanifest", "sw.js", "offline.html", "icons/"]) {
    truthy(`${path} is excluded from the auth middleware`, middleware.includes(path));
  }
}

{
  const layout = readFileSync(join(ROOT, "src/app/layout.tsx"), "utf8");

  // iOS reads none of the manifest. Without `appleWebApp.capable` the home
  // screen icon opens in a tab with an address bar.
  truthy("iOS is told the app is standalone-capable", /capable:\s*true/.test(layout));
  truthy("and given its own icon", /apple-touch-icon/.test(layout));

  const boot = readFileSync(
    join(ROOT, "src/features/settings/components/appearance-boot.tsx"),
    "utf8",
  );
  /*
   * The theme is a stored preference rather than a system one, so a static
   * `theme-color` would put a near-black status bar above a Daylight app.
   */
  truthy("and the chrome colour follows the chosen theme", /theme-color/.test(boot));
}

/* ========================================================================== */

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
