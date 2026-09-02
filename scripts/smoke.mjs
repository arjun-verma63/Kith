#!/usr/bin/env node
/**
 * Production smoke test.
 *
 *     npm run smoke -- https://kith.example.com
 *
 * Everything a deployment can get wrong that no local test can see: whether
 * Supabase is reachable *from Vercel*, whether the security headers survived the
 * edge, whether middleware is running, whether the service-role key ended up in
 * the browser bundle, and whether the PWA surface is served rather than
 * redirected.
 *
 * Needs no credentials — only the public URL. It signs in as nobody, which is
 * deliberate: everything here is checkable from outside, and a smoke test that
 * needs a password is a smoke test with a password in it. The half that needs an
 * account is the two-browser pass in docs/MANUAL-TESTING.md.
 *
 * Read-only. It sends no writes and creates no accounts, so it is safe to run
 * against production as often as you like.
 *
 * Exit code is 1 if anything FAILED, 0 otherwise. Warnings do not fail the run —
 * they are things worth looking at that are not proof of a broken deploy.
 */

const RAW = process.argv[2] ?? process.env.SMOKE_URL;

if (!RAW) {
  console.error("Usage: npm run smoke -- https://your-domain\n");
  console.error("  The public origin of the deployment to test.");
  process.exit(2);
}

let ORIGIN;
try {
  ORIGIN = new URL(RAW).origin;
} catch {
  console.error(`Not a URL: ${RAW}`);
  process.exit(2);
}

const TIMEOUT_MS = 15_000;

let passed = 0;
let failed = 0;
let warned = 0;
const failures = [];

const ok = (name, detail) => {
  passed += 1;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
};

const bad = (name, detail) => {
  failed += 1;
  failures.push(`${name} — ${detail}`);
  console.log(`  ✗ ${name}\n      ${detail}`);
};

const warn = (name, detail) => {
  warned += 1;
  console.log(`  ! ${name}\n      ${detail}`);
};

/**
 * One assertion, so a check reads as a statement.
 *
 * `pass` is the detail shown when it holds; `fail` explains what is wrong when
 * it does not, and is the more important of the two — somebody reading this
 * output at speed needs to know what to go and fix.
 */
function check(name, condition, fail, pass) {
  if (condition) ok(name, pass);
  else bad(name, fail);
}

const section = (title) => console.log(`\n${title}`);

/** Never follows redirects: a redirect is frequently the thing being asserted. */
async function get(path, { redirect = "manual", headers = {} } = {}) {
  const url = `${ORIGIN}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      redirect,
      headers: { "user-agent": "kith-smoke/1", ...headers },
      signal: controller.signal,
    });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body, url };
  } catch (error) {
    return { status: 0, headers: new Headers(), body: "", url, error };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`KITH — production smoke test\n\n  ${ORIGIN}`);

/* ==========================================================================
 * 1 · Is it even up
 * ========================================================================== */

section("Reachability");

const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(ORIGIN);

if (ORIGIN.startsWith("https://")) {
  ok("the origin is https");
} else if (isLoopback) {
  // Rehearsing against `npm start` is the best way to find a broken smoke test
  // before you need it, and localhost is a secure context by definition.
  warn("the origin is https", "loopback — fine for a rehearsal, never for production");
} else {
  bad(
    "the origin is https",
    "Secure cookies and getUserMedia both require a secure context — every call in the app depends on this",
  );
}

const landing = await get("/");

if (landing.status === 0) {
  bad("the landing page responds", `no response: ${landing.error?.message ?? "unknown"}`);
  console.log("\nNothing else can be checked. Is the deployment live?\n");
  process.exit(1);
}

check(
  "the landing page responds",
  landing.status === 200,
  `got ${landing.status}, expected 200`,
  `${landing.status}`,
);

/* ==========================================================================
 * 2 · Supabase, from the deployment rather than from here
 * ========================================================================== */

section("Database");

{
  /*
   * The check this whole script exists for.
   *
   * `/api/health` issues a real query against Postgres. A local test cannot tell
   * you whether the deployed environment variables are correct, whether the
   * Supabase project is paused, or whether Vercel can reach it at all — this
   * can, and it is the difference between "the site loads" and "the site works".
   */
  const health = await get("/api/health");

  if (health.status === 0) {
    bad("the health endpoint responds", health.error?.message ?? "no response");
  } else {
    let payload = null;
    try {
      payload = JSON.parse(health.body);
    } catch {
      /* reported below */
    }

    if (!payload) {
      bad("the health endpoint returns JSON", `got ${health.status}: ${health.body.slice(0, 120)}`);
    } else {
      switch (payload.database) {
        case "ok":
          ok("Supabase is reachable from the deployment");
          break;
        case "unreachable":
          bad(
            "Supabase is reachable from the deployment",
            "the health endpoint reached Postgres and got nothing back. Paused project, wrong URL, or a rejected key — check the Vercel environment variables",
          );
          break;
        case "not_configured":
          bad(
            "Supabase is reachable from the deployment",
            "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set in this environment. Nothing behind a sign-in will work",
          );
          break;
        default:
          bad("the health endpoint reports a database status", `got ${JSON.stringify(payload)}`);
      }

      // A warning rather than a failure: a preview deployment is a legitimate
      // thing to point this at, and it will honestly say so.
      if (payload.environment === "production") {
        ok("it is running as a production build");
      } else {
        warn(
          "it is running as a production build",
          `NODE_ENV is "${payload.environment}" — a preview, or a misconfigured project`,
        );
      }

      check("and answers 200 while healthy", health.status === 200, `got ${health.status}`);

      check(
        "uncached, so the keepalive actually reaches Postgres each day",
        health.headers.get("cache-control")?.includes("no-store"),
        "a cached health response means the cron pings the CDN and the project still pauses",
      );
    }
  }
}

/* ==========================================================================
 * 3 · Nothing secret is being served
 * ========================================================================== */

section("Secrets");

{
  /*
   * The catastrophic mistake, checked against what is actually on the wire.
   *
   * Pasting the service-role key into NEXT_PUBLIC_SUPABASE_ANON_KEY works
   * perfectly — every query succeeds, because RLS is bypassed — and publishes
   * full read/write access to the database in the browser bundle. The env schema
   * refuses to boot on it, and `check:bundle` scans the build. This is the third
   * check, on the served bytes, because the first two can be misconfigured and
   * this one cannot be argued with.
   */
  const scripts = [...landing.body.matchAll(/<script[^>]+src="([^"]+)"/g)].map(([, src]) => src);
  const sources = [landing.body];

  for (const src of scripts.slice(0, 25)) {
    const path = src.startsWith("http") ? new URL(src).pathname : src;
    const asset = await get(path);
    if (asset.status === 200) sources.push(asset.body);
  }

  const combined = sources.join("\n");
  const jwts = [...combined.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{20,})\./g)];

  const roles = new Set();
  for (const [, payload] of jwts) {
    try {
      const json = JSON.parse(
        Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
      );
      if (typeof json?.role === "string") roles.add(json.role);
    } catch {
      /* not a JWT we can read */
    }
  }

  check(
    "no service-role key is served to the browser",
    !roles.has("service_role"),
    "THE SERVICE ROLE KEY IS IN THE CLIENT BUNDLE. It bypasses Row Level Security completely. Take the deployment down, rotate the key in Supabase, and find the import that pulled it in",
    roles.size > 0 ? `found only: ${[...roles].join(", ")}` : "no JWT in the bundle",
  );

  // A warning, not a failure: the NAME appearing is not the value leaking. But
  // nothing client-side should be reaching for one of these at all.
  for (const marker of ["SUPABASE_SERVICE_ROLE_KEY", "TURN_SHARED_SECRET", "TURN_PASSWORD"]) {
    if (combined.includes(marker)) {
      warn(
        `${marker} is not named in served JavaScript`,
        "the name alone is not a leak, but nothing should be reaching for it client-side",
      );
    } else {
      ok(`${marker} is not named in served JavaScript`);
    }
  }

  /*
   * A deployment built with NEXT_PUBLIC_SITE_URL unset would have baked
   * localhost into metadata and — much worse — into every email it sends. The
   * env schema now refuses that build, so this is the belt to that braces.
   */
  check(
    "no localhost origin is baked into the deployment",
    !/localhost:\d|127\.0\.0\.1/.test(combined),
    "NEXT_PUBLIC_SITE_URL was probably unset at build time — check what the confirmation emails point at",
  );
}

/* ==========================================================================
 * 4 · Headers survived the edge
 * ========================================================================== */

section("Headers");

{
  const required = [
    ["x-content-type-options", "nosniff", "MIME sniffing"],
    ["x-frame-options", "DENY", "clickjacking"],
    ["referrer-policy", "strict-origin-when-cross-origin", "leaking paths to third parties"],
    ["strict-transport-security", "max-age=", "downgrade to http"],
    ["permissions-policy", "camera=(self)", "another origin asking for the camera"],
  ];

  for (const [header, expected, why] of required) {
    const value = landing.headers.get(header);
    if (!value) bad(`${header} is set — ${why}`, "absent from the response");
    else if (!value.includes(expected))
      bad(`${header} is set — ${why}`, `got "${value}", expected it to contain "${expected}"`);
    else ok(`${header} — ${why}`);
  }

  if (landing.headers.get("x-powered-by")) {
    warn(
      "x-powered-by is absent",
      `got "${landing.headers.get("x-powered-by")}" — it names the framework and version for free`,
    );
  } else {
    ok("x-powered-by is absent");
  }

  // Not a header, but the same class: KITH is invitation-only and has nothing
  // for a search engine.
  // Not a failure: nothing breaks without it. But KITH is invitation-only and
  // has nothing for a search engine, so its absence is worth a look.
  if (/<meta name="robots"[^>]*noindex/i.test(landing.body)) {
    ok("the app asks not to be indexed");
  } else {
    warn("the app asks not to be indexed", "no noindex meta tag on the landing page");
  }
}

/* ==========================================================================
 * 5 · Middleware is running
 * ========================================================================== */

section("Routing");

{
  /*
   * Middleware refreshes the session and applies the redirect rules. If it is
   * not running — a bad matcher, a failed edge deploy — a signed-out visitor
   * reaches a protected page, which renders empty because RLS returns nothing.
   * The app looks broken rather than protected, and no local test sees it.
   */
  const protectedRoute = await get("/messages");

  if (protectedRoute.status === 307 || protectedRoute.status === 302) {
    const location = protectedRoute.headers.get("location") ?? "";
    check(
      "a signed-out visitor is sent to /login",
      location.includes("/login"),
      `redirected to ${location}`,
      location,
    );
  } else {
    bad(
      "a signed-out visitor is redirected off a protected route",
      `got ${protectedRoute.status} — middleware may not be running, so protected pages render empty rather than redirecting`,
    );
  }

  for (const route of ["/login", "/signup", "/forgot-password"]) {
    const response = await get(route);
    check(`${route} renders`, response.status === 200, `got ${response.status}`);
  }

  // Development-only surface must not exist in production.
  const styleguide = await get("/styleguide");
  check(
    "/styleguide is 404 in production",
    styleguide.status === 404,
    `got ${styleguide.status} — a dev page is public`,
  );

  const missing = await get("/this-route-does-not-exist");
  check("an unknown route is a 404, not a crash", missing.status === 404, `got ${missing.status}`);
}

/* ==========================================================================
 * 6 · The PWA surface
 * ========================================================================== */

section("Progressive web app");

{
  /*
   * All three are fetched with no session and must answer the same way to
   * everybody. A manifest that 307s to /login is one a browser refuses to
   * install from, and a service worker served a redirect fails registration
   * outright — so the middleware matcher excludes them, and this proves the
   * exclusion survived deployment.
   */
  const manifest = await get("/manifest.webmanifest");

  if (manifest.status !== 200) {
    bad("the manifest is served", `got ${manifest.status} — the app is not installable`);
  } else {
    ok("the manifest is served");

    try {
      const parsed = JSON.parse(manifest.body);
      check("  and is valid JSON with a name", parsed.name, "none", parsed.name);
      check("  with icons", parsed.icons?.length > 0, "none declared", `${parsed.icons.length}`);

      // A start_url on another origin makes the installed app open somebody
      // else's site.
      const start = new URL(parsed.start_url ?? "/", ORIGIN);
      check(
        "  and a start_url on this origin",
        start.origin === ORIGIN,
        `points at ${start.origin}`,
      );
    } catch {
      bad("the manifest is valid JSON", manifest.body.slice(0, 120));
    }
  }

  const worker = await get("/sw.js");
  check(
    "the service worker is served",
    worker.status === 200,
    `got ${worker.status} — registration will fail`,
  );

  // A warning: the offline page is a courtesy, not a requirement, and its
  // absence does not stop anybody using the app.
  const offline = await get("/offline.html");
  if (offline.status === 200) {
    ok("the offline page is served");
  } else {
    warn("the offline page is served", `got ${offline.status}`);
  }
}

/* ==========================================================================
 * 7 · The token handler
 * ========================================================================== */

section("Email links");

{
  /*
   * Every confirmation and recovery email lands on /auth/confirm. It must be
   * reachable with no session and must NOT be swallowed by middleware, or the
   * token is redirected away before it can be consumed and every link in every
   * email fails.
   *
   * Called with no token, so nothing is consumed: it should bounce to a login
   * or forgot-password page rather than error.
   */
  const confirm = await get("/auth/confirm");

  if (confirm.status === 0) {
    bad("/auth/confirm responds", confirm.error?.message ?? "no response");
  } else if (confirm.status >= 500) {
    bad("/auth/confirm handles a missing token", `got ${confirm.status} — every email link errors`);
  } else {
    ok("/auth/confirm handles a missing token", `${confirm.status}`);

    const location = confirm.headers.get("location");
    if (location) {
      check(
        "  and redirects within this origin",
        new URL(location, ORIGIN).origin === ORIGIN,
        `sends visitors to ${location}`,
      );
    }
  }

  // The open redirect that would matter most: a genuine KITH link that deposits
  // the recipient on somebody else's page.
  const hostile = await get("/auth/confirm?next=https%3A%2F%2Fexample.com%2Fowned");
  const target = hostile.headers.get("location");
  if (target && new URL(target, ORIGIN).origin !== ORIGIN) {
    bad(
      "an email link cannot be pointed at another site",
      `redirected to ${target} — this is an open redirect in the one place it hurts most`,
    );
  } else {
    ok("an email link cannot be pointed at another site");
  }
}

/* ========================================================================== */

console.log(`\n${"=".repeat(64)}`);
console.log(`  ${passed} passed, ${failed} failed, ${warned} to look at`);

if (failures.length > 0) {
  console.log("\n  Failures:");
  for (const failure of failures) console.log(`    - ${failure}`);
  console.log("\n  Do not announce this deployment.");
} else {
  console.log("\n  Nothing automated is broken.");
  console.log("  The half that needs an account is docs/MANUAL-TESTING.md —");
  console.log("  signup with real mail, a real call, and the two-browser pass.");
}
console.log("=".repeat(64));

process.exit(failed > 0 ? 1 : 0);
