/**
 * Deployment invariants.
 *
 * A production readiness checklist is a document, and documents drift. This is
 * the half of `docs/PRODUCTION-CHECKLIST.md` that a machine can check, so the
 * mechanical items stay true without anybody re-reading them: no secret in a
 * tracked file, no localhost baked into shipped code, no `console.log`, a
 * private avatar bucket, and a health endpoint that actually touches Postgres.
 *
 * Everything here failed at least once while this file was being written. The
 * site-URL guard in section 1 is the reason it exists at all: the default was
 * `http://localhost:3000`, and an unset variable in production would have mailed
 * every new member a confirmation link pointing at the deploying machine, with a
 * green build and a working-looking site.
 *
 * What this cannot check is in the checklist as a human step — whether the
 * Supabase dashboard's redirect allowlist matches the origin, whether the TURN
 * relay answers, whether the mail actually arrives.
 *
 *     npm run deploy:test
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register(pathToFileURL(join(process.cwd(), "supabase/tests/alias-loader.mjs")).href);

const { freshDatabase, asService } = await import("./harness.mjs");
const { clientEnvSchema } = await import("../../src/lib/env/schema.ts");

const ROOT = process.cwd();

let passed = 0;
let failed = 0;
const failures = [];

const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const bad = (name, detail) => {
  failed += 1;
  failures.push(`${name} — ${detail}`);
  console.log(`  ✗ ${name}\n      ${detail}`);
};

const eq = (name, actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected)
    ? ok(name)
    : bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const truthy = (name, value, detail = "expected a truthy value") =>
  value ? ok(name) : bad(name, detail);

const section = (title) => console.log(`\n${title}`);

/** Tracked files only. An untracked scratch file is not a deployment risk. */
function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // `git grep` exits 1 when nothing matched, which is the good case here.
    if (error.status === 1) return "";
    throw error;
  }
}

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

console.log("KITH — deployment readiness\n");

/* ==========================================================================
 * 1 · The origin every email is built from
 * ========================================================================== */

section("Site URL");

{
  /*
   * `NEXT_PUBLIC_SITE_URL` is not decoration. It is the origin in every
   * confirmation, recovery and email-change link KITH sends, plus
   * `metadataBase`. The schema defaults it to localhost so a fresh clone runs
   * with no configuration — which is right, and was silently catastrophic in
   * production: the build succeeds, the site renders, and the failure surfaces
   * in a stranger's inbox as "the invite link is broken".
   */
  const parse = (value) => clientEnvSchema.safeParse({ NEXT_PUBLIC_SITE_URL: value }).success;

  const previous = process.env.NODE_ENV;

  process.env.NODE_ENV = "production";
  truthy("a production build refuses an unset origin", parse(undefined) === false);
  truthy("  and localhost", parse("http://localhost:3000") === false);
  truthy("  and 127.0.0.1", parse("http://127.0.0.1:3000") === false);
  truthy("  and a subdomain of localhost", parse("http://kith.localhost") === false);
  truthy(
    "  and plain http, which breaks cookies and getUserMedia",
    parse("http://kith.example.com") === false,
  );
  truthy("  accepting only a real https origin", parse("https://kith.example.com"));

  /*
   * The escape hatch. Building locally to smoke-test a real bundle is a
   * legitimate thing to want, and localhost is the CORRECT origin for it — so
   * there is an opt-out, and it has to be typed. `npm run build:local` sets it.
   *
   * Deliberately not a platform sniff: `VERCEL` or `CI` would get the guard
   * right on Vercel and silently wrong on a VPS or a container.
   */
  process.env.KITH_ALLOW_LOCAL_ORIGIN = "1";
  truthy("an explicit opt-out allows a local build", parse("http://localhost:3000"));
  delete process.env.KITH_ALLOW_LOCAL_ORIGIN;
  truthy("and it is off unless set to exactly 1", parse("http://localhost:3000") === false);

  process.env.NODE_ENV = "development";
  truthy("development still runs with no configuration at all", parse(undefined));
  truthy("  and on localhost over http", parse("http://localhost:3000"));

  process.env.NODE_ENV = previous;
}

/* ==========================================================================
 * 2 · Nothing secret is committed
 * ========================================================================== */

section("Secrets");

{
  // Shapes, not names: a variable called SUPABASE_SERVICE_ROLE_KEY with an empty
  // value is fine, and a nameless JWT sitting in a source file is not.
  const jwts = git("grep", "-nIE", "eyJ[A-Za-z0-9_-]{30,}\\.[A-Za-z0-9_-]{20,}", "--", ".");
  eq("no JWT-shaped credential in any tracked file", jwts.trim(), "");

  const prefixed = git("grep", "-nIE", "sb_(secret|publishable)_[A-Za-z0-9]{10,}", "--", ".");
  eq("no Supabase publishable or secret key", prefixed.trim(), "");

  const projects = git("grep", "-nIE", "[a-z]{20}\\.supabase\\.(co|in)", "--", ".");
  eq("no real Supabase project hostname", projects.trim(), "");

  /*
   * The one that matters most, because it is the mistake with no symptom: the
   * service-role key bypasses RLS entirely, and pasting it into a NEXT_PUBLIC_
   * variable publishes full database access in the browser bundle while every
   * feature keeps working perfectly.
   */
  const example = read(".env.example");
  const assignments = [...example.matchAll(/^\s*#?\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?/gm)];
  const filled = assignments.filter(
    ([, name, value]) =>
      value.trim() !== "" &&
      !value.includes("<") &&
      !name.startsWith("NEXT_PUBLIC_SITE_URL") &&
      !/localhost|example\.com|600|587/.test(value),
  );
  eq(
    ".env.example carries no real values",
    filled.map(([, name]) => name),
    [],
  );
}

{
  const tracked = git("ls-files").split("\n").filter(Boolean);
  const envFiles = tracked.filter((f) => /(^|\/)\.env/.test(f) && f !== ".env.example");
  eq("no .env file is tracked except the example", envFiles, []);

  const ignore = read(".gitignore");
  truthy("and .gitignore excludes them", /^\.env\*/m.test(ignore));
  truthy("while keeping the example", /^!\.env\.example/m.test(ignore));
}

/* ==========================================================================
 * 3 · Nothing points at a developer's machine
 * ========================================================================== */

section("Hardcoded origins");

{
  /*
   * `src/lib/env/schema.ts` is the one legitimate mention — it is the guarded
   * default from section 1. Anything else is a URL that would ship.
   */
  const hits = git("grep", "-nIE", "https?://(localhost|127\\.0\\.0\\.1)", "--", "src")
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.startsWith("src/lib/env/schema.ts:"));

  eq("no localhost URL in shipped source", hits, []);
}

{
  const hits = git("grep", "-nIE", "http://[a-z0-9.-]+", "--", "src")
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.startsWith("src/lib/env/schema.ts:"))
    .filter((line) => !/w3\.org|schema\.org/.test(line));

  eq("and no plain-http origin either", hits, []);
}

/* ==========================================================================
 * 4 · No debugging left behind
 * ========================================================================== */

section("Debug output");

{
  const consoles = git("grep", "-nIE", "console\\.(log|debug|info|trace|dir|table)", "--", "src");
  eq("no console.log anywhere in src", consoles.trim(), "");

  const debuggers = git("grep", "-nIw", "debugger", "--", "src");
  eq("no debugger statement", debuggers.trim(), "");
}

{
  /*
   * Postgres puts the offending ROW in `details` — "Failing row contains (1, a
   * private message…)". Superb while debugging, unacceptable in a retained,
   * searchable production log for an app whose premise is privacy.
   */
  const errors = read("src/lib/supabase/errors.ts");
  truthy(
    "database errors redact row content in production",
    /safeDetails/.test(errors) && /failing row contains/i.test(errors),
    "PostgrestError.details is logged raw — it contains the failing row",
  );
  truthy(
    "and the raw value is still available in development",
    /NODE_ENV !== "production"/.test(errors),
    "redacting in development too would remove the only reason details exist",
  );
}

{
  // Development-only pages must not exist in production.
  const styleguide = read("src/app/styleguide/page.tsx");
  truthy(
    "the styleguide 404s in production",
    /NODE_ENV === "production"[\s\S]{0,40}notFound\(\)/.test(styleguide),
  );
}

/* ==========================================================================
 * 5 · Authentication URLs
 * ========================================================================== */

section("Auth redirects");

{
  /*
   * Every email link lands on /auth/confirm, which consumes the token
   * server-side. The set below is what the Supabase dashboard's redirect
   * allowlist has to contain — a link to an origin that is not on that list is
   * rejected by Supabase, and the symptom is a confirmation email that fails
   * for everybody.
   */
  const actions = read("src/features/auth/actions.ts");
  const account = read("src/features/auth/account-actions.ts");

  const targets = [...`${actions}${account}`.matchAll(/NEXT_PUBLIC_SITE_URL\}(\/[^`"']*)/g)].map(
    ([, path]) => path,
  );

  eq(
    "every email link is built from the configured origin, and lands on /auth/confirm",
    [...new Set(targets)].sort(),
    ["/auth/confirm", "/auth/confirm?next=/reset-password"],
  );

  truthy(
    "no email link is built from a literal origin",
    !/emailRedirectTo:\s*["'`]https?:\/\//.test(actions + account),
    "a hardcoded origin in an email link survives every environment change",
  );
}

{
  const middleware = read("src/middleware.ts");
  truthy(
    "the token handler is excluded from middleware, so a one-time token is not redirected away",
    /auth\//.test(middleware),
  );
  truthy("as is the health endpoint the keepalive pings", /api\/health/.test(middleware));
}

/* ==========================================================================
 * 6 · The keepalive actually keeps something alive
 * ========================================================================== */

section("Health and keepalive");

{
  /*
   * Free-tier Supabase pauses on DATABASE inactivity. This endpoint used to
   * return JSON and touch nothing, so the scheduled ping kept a Vercel function
   * warm and let the project it was protecting go to sleep — a cron job that
   * looked like it was working, and a site that died a week after launch.
   */
  const health = read("src/app/api/health/route.ts");

  truthy(
    "the health endpoint queries Postgres, not just itself",
    /createSupabaseServerClient|\.from\(/.test(health),
    "pinging a Vercel route does nothing for Supabase — it pauses on database inactivity",
  );
  truthy(
    "and reports the database separately from the process",
    /database/.test(health),
    "a monitor would go green while Postgres was unreachable",
  );
  truthy(
    "answering 503 when it is not reachable",
    /503/.test(health),
    "a 200 with a sad body is a health check that never fails",
  );
  truthy(
    "using the anon key rather than the service role",
    !/getSupabaseAdminClient/.test(health),
    "an unauthenticated public endpoint must not hold a key that bypasses every policy",
  );
}

/* ==========================================================================
 * 7 · Security headers
 * ========================================================================== */

section("Headers");

{
  const config = read("next.config.ts");

  for (const [header, why] of [
    ["X-Content-Type-Options", "MIME sniffing"],
    ["X-Frame-Options", "clickjacking"],
    ["Referrer-Policy", "leaking paths to third parties"],
    ["Strict-Transport-Security", "downgrade to http"],
    ["Permissions-Policy", "another origin asking for the camera"],
  ]) {
    truthy(`${header} is set — ${why}`, config.includes(header));
  }

  truthy(
    "the powered-by header is off",
    /poweredByHeader:\s*false/.test(config),
    "it names the framework and version for free",
  );

  // WebRTC needs these three; everything else should be denied.
  const permissions = config.match(/"camera=\(self\)[^"]*"/)?.[0] ?? "";
  truthy(
    "camera, microphone and display-capture are allowed to our own origin",
    /camera=\(self\), microphone=\(self\), display-capture=\(self\)/.test(permissions),
  );
  truthy(
    "and geolocation, payment and usb are denied outright",
    /geolocation=\(\)[\s\S]*payment=\(\)[\s\S]*usb=\(\)/.test(permissions),
  );
}

/* ==========================================================================
 * 8 · WebRTC and TURN
 * ========================================================================== */

section("Calls");

{
  const config = read("src/lib/webrtc/config.ts");

  truthy(
    "no TURN credential is hardcoded in client-reachable code",
    !/credential:\s*["'`][^"'`]+["'`]/.test(config),
    "a relay credential in the bundle is an open bandwidth relay for anyone with devtools",
  );
  truthy("relay entries are passed in, never imported", /turnServers\?:/.test(config));
  truthy(
    "STUN is configured from more than one operator",
    (config.match(/stun:/g) ?? []).length >= 2,
  );

  const turn = read("src/lib/server/turn.ts");
  truthy("the credential minter is server-only", /^import "server-only";/m.test(turn));
}

{
  const server = read("src/lib/env/server.ts");
  truthy(
    "TURN is optional, so a fresh clone makes calls without a relay account",
    /turnEnv = null/.test(server),
  );
  truthy(
    "but a half-configured relay is an error, not a silent downgrade",
    /credentials are required/.test(server),
    "a relay that looks configured and is not means nobody investigates why calls fail",
  );
  truthy(
    "and a missing TLS transport is warned about at boot",
    /turns:/.test(server) && /console\.warn/.test(server),
    "without turns: on 443, calls fail only for the person behind a corporate firewall",
  );
}

/* ==========================================================================
 * 9 · Storage
 * ========================================================================== */

section("Storage");

{
  const db = await freshDatabase();

  const { rows } = await asService(
    db,
    "select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars'",
  );
  const bucket = rows[0];

  truthy("the avatars bucket exists", bucket !== undefined);
  eq("and is PRIVATE — every read goes through a signed URL", bucket?.public, false);
  truthy(
    "with a size limit enforced by Storage, not just by the form",
    Number(bucket?.file_size_limit) > 0 && Number(bucket?.file_size_limit) <= 5 * 1024 * 1024,
    `file_size_limit is ${bucket?.file_size_limit}`,
  );

  const mimes = bucket?.allowed_mime_types ?? [];
  truthy("and a MIME allowlist", mimes.length > 0);
  truthy(
    "that admits images only",
    mimes.every((type) => type.startsWith("image/")),
    `allows ${mimes.join(", ")}`,
  );
  truthy(
    "and not SVG, which is a script that renders as a picture",
    !mimes.includes("image/svg+xml"),
    "an uploaded SVG is stored XSS on any origin that serves it inline",
  );

  const { rows: policies } = await asService(
    db,
    `select polname, polcmd from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'storage' and c.relname = 'objects'`,
  );

  const commands = new Set(policies.map((p) => p.polcmd));
  for (const [cmd, label] of [
    ["r", "read"],
    ["a", "insert"],
    ["w", "update"],
    ["d", "delete"],
  ]) {
    truthy(
      `objects have a ${label} policy`,
      commands.has(cmd),
      // Delete is the one people forget, and without it every replaced avatar
      // stays in the bucket forever.
      `no ${label} policy on storage.objects`,
    );
  }

  await db.close();
}

/* ==========================================================================
 * 10 · Migrations
 * ========================================================================== */

section("Migrations");

{
  const names = git("ls-files", "supabase/migrations")
    .split("\n")
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.split("/").pop());

  truthy(`${names.length} migrations are tracked`, names.length > 0);

  const sorted = [...names].sort();
  eq("filenames sort into apply order", names, sorted);

  const timestamps = names.map((n) => n.split("_")[0]);
  eq("every migration has a unique timestamp prefix", timestamps.length, new Set(timestamps).size);
  truthy(
    "each of which is a valid 14-digit stamp",
    timestamps.every((t) => /^\d{14}$/.test(t)),
    timestamps.filter((t) => !/^\d{14}$/.test(t)).join(", "),
  );
}

{
  /*
   * The whole suite replays these against real Postgres on every run, so
   * "the migrations apply" is proven 30 times over. What is worth asserting
   * separately is that none of them would destroy data on the way — a
   * `drop table` in a migration that has already run somewhere is unrecoverable
   * in a way a failed migration is not.
   */
  const destructive = [];
  for (const file of git("ls-files", "supabase/migrations").split("\n").filter(Boolean)) {
    const sql = read(file);
    const stripped = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (/\bdrop\s+table\b/i.test(stripped)) destructive.push(`${file}: drop table`);
    if (/\btruncate\b/i.test(stripped)) destructive.push(`${file}: truncate`);
    if (/\bdrop\s+column\b/i.test(stripped)) destructive.push(`${file}: drop column`);
  }
  eq("no migration drops a table, a column, or truncates", destructive, []);
}

/* ========================================================================== */

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\n  Failures:");
  for (const failure of failures) console.log(`    - ${failure}`);
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
