/**
 * Performance invariants.
 *
 * ── What belongs in here ─────────────────────────────────────────────────────
 *
 * Only the things that (a) cost a network round trip or leak a resource, and
 * (b) come back silently. A duplicated avatar signer is not a bug anybody
 * notices; it is four extra calls to Supabase Storage on every page render, and
 * the only reason it existed is that seven modules each wrote their own and none
 * of them could see the others.
 *
 * Deliberately NOT a bundle-size budget. Sizes move for reasons that are nobody's
 * fault — a Next upgrade, a React patch — and a threshold that fails on those
 * gets raised until it means nothing. The bundle numbers live in docs/PERF.md
 * with the date they were measured.
 *
 *     npm run perf:test
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

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
const section = (t) => console.log(`\n${t}`);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if ([".ts", ".tsx"].includes(extname(full))) yield full;
  }
}

const FILES = [...walk(SRC)].map((path) => ({
  path: relative(ROOT, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

const find = (suffix) => FILES.find((f) => f.path.endsWith(suffix));

console.log("KITH — performance\n");

/* ==========================================================================
 * 1 · Round trips
 * ========================================================================== */

section("Network round trips per render");

{
  /*
   * Seven feature modules each had a private copy of the avatar signer. Every
   * copy batched correctly on its own, so none of them looked wrong in review —
   * but one render of a conversation made a separate call to Supabase Storage
   * for each, mostly to sign the same six people.
   *
   * One implementation, request-scoped, is what stops that returning: a second
   * copy cannot dedupe against the first, however carefully it is written.
   */
  const signers = FILES.filter((f) => f.text.includes("createSignedUrls")).map((f) => f.path);

  eq("exactly one module signs storage URLs", signers, ["src/lib/supabase/avatars.ts"]);

  const signer = find("lib/supabase/avatars.ts");
  truthy(
    "and it is scoped to the request",
    /cache\(\(\)[^)]*=>\s*new Map/.test(signer.text),
    "the path→URL store must come from React cache(), or it is either per-call or global",
  );
}

{
  /*
   * `getUser()` is a network call to the Auth server — it is the whole reason
   * this function exists rather than `getSession()`, which reads the cookie and
   * believes it.
   *
   * A single render asks two or three times, through the shell and again on the
   * page, and each call built a fresh client so nothing deduplicated them.
   */
  const server = find("lib/supabase/server.ts");

  truthy(
    "getCurrentUser answers once per request",
    /export const getCurrentUser = cache\(/.test(server.text),
    "getCurrentUser must be wrapped in cache() or it re-validates the JWT per call site",
  );

  // The reason it is expensive is also the reason it must not be cached harder.
  truthy(
    "and still revalidates rather than trusting the cookie",
    /auth\.getUser\(\)/.test(server.text) && !/auth\.getSession\(\)/.test(server.text),
  );
}

/* ==========================================================================
 * 2 · Resources that outlive their component
 * ========================================================================== */

section("Cleanup");

{
  /*
   * Every listener added has to come off. Counted per file rather than globally,
   * because a global tally balances happily while one component leaks and
   * another over-removes.
   */
  const unbalanced = [];

  for (const file of FILES) {
    const added = (file.text.match(/addEventListener\(/g) ?? []).length;
    const removed = (file.text.match(/removeEventListener\(/g) ?? []).length;
    // `{ once: true }` removes itself, so it is allowed to be unmatched.
    const once = (file.text.match(/\{\s*once:\s*true\s*\}/g) ?? []).length;
    if (added > removed + once) {
      unbalanced.push(`${file.path} (+${added} / -${removed}, ${once} once)`);
    }
  }

  eq("every event listener is removed", unbalanced, []);
}

{
  /*
   * A realtime channel that is never removed keeps its WebSocket subscription
   * open for the life of the tab, and keeps firing handlers into a component
   * that has gone.
   */
  const opened = FILES.filter((f) => /supabase\.channel\(|\.channel\(/.test(f.text));
  const leaked = opened
    .filter((f) => !/removeChannel|\.unsubscribe\(\)/.test(f.text))
    .map((f) => f.path);

  truthy("there are channels to check", opened.length >= 3);
  eq("every module that opens a channel also closes one", leaked, []);
}

{
  /*
   * The shared channel is reference-counted, so the last subscriber closes it and
   * the others do not. Two properties matter: release is idempotent, and the
   * channel is only removed at zero.
   */
  const shared = find("lib/supabase/shared-channel.ts");

  truthy("releasing twice is a no-op", /if \(released\) return;/.test(shared.text));
  truthy(
    "and the channel closes only at the last subscriber",
    /entry\.refs -= 1;[\s\S]{0,80}if \(entry\.refs > 0\) return;/.test(shared.text),
  );
}

{
  /*
   * Tearing down a peer connection means more than calling close(): the ICE
   * batch timer, the disconnect grace timer and the recovery timer all outlive
   * it otherwise, and a live handler holds the whole connection in memory.
   */
  const peer = find("lib/webrtc/peer.ts");

  truthy("closing a peer is idempotent", /if \(this\.closed\) return;/.test(peer.text));
  truthy(
    "and clears every timer it started",
    ["ice", "disconnect", "recovery"].every((t) =>
      new RegExp(`clearTimer\\("${t}"\\)`).test(peer.text),
    ),
  );
  truthy(
    "and detaches its handlers",
    /onicecandidate = null/.test(peer.text) && /ontrack = null/.test(peer.text),
  );
}

/* ==========================================================================
 * 3 · Re-render pressure
 * ========================================================================== */

section("Re-renders");

{
  /*
   * A context value rebuilt on every render re-renders every consumer, which for
   * these three is most of the app.
   */
  const providers = FILES.filter((f) => /\.Provider\b/.test(f.text) && /"use client"/.test(f.text));
  const unmemoised = providers.filter((f) => !/useMemo/.test(f.text)).map((f) => f.path);

  truthy("there are providers to check", providers.length >= 3);
  eq("every context value is memoised", unmemoised, []);
}

{
  /*
   * Each game board ticks a clock four times a second to animate its countdown.
   * That is a full board re-render at 4Hz, which is affordable only because it
   * stops the moment the round is over — an interval that keeps running through
   * the reveal, the scoreboard and the rematch prompt would not be.
   */
  const boards = FILES.filter((f) => /components\/boards\/.*-board\.tsx$/.test(f.path));
  truthy("there are boards to check", boards.length >= 4);

  const alwaysTicking = boards
    .filter((f) => /setInterval/.test(f.text) && !/if \(!running\) return;/.test(f.text))
    .map((f) => f.path);

  eq("every countdown stops when the round does", alwaysTicking, []);
}

/* ==========================================================================
 * 4 · Pagination
 * ========================================================================== */

section("Pagination");

{
  /*
   * Keyset pagination, not OFFSET. A conversation is unbounded, and `offset` gets
   * slower the further back you scroll — and skips or repeats a row when
   * something arrives mid-scroll, which in a live chat is most of the time.
   */
  const messages = find("features/messages/queries.ts");

  truthy(
    "messages page by cursor",
    /p_before_created_at/.test(messages.text) && /p_before_id/.test(messages.text),
  );
  truthy("with a bounded page size", /p_limit:\s*PAGE_SIZE/.test(messages.text));

  const offsetUsers = FILES.filter((f) => /\.range\(|offset:/.test(f.text)).map((f) => f.path);
  eq("and nothing pages by offset", offsetUsers, []);
}

/* ==========================================================================
 * 5 · The client boundary
 * ========================================================================== */

section("Client boundary");

{
  /*
   * Framer Motion is 149 kB and belongs to the landing page's animation. It is
   * allowed to be there and nowhere else: pulled into the signed-in shell it
   * would be on every page in the app, for a library the app itself does not
   * animate with.
   */
  const motion = FILES.filter((f) => /from "motion\/react"/.test(f.text)).map((f) => f.path);

  truthy("motion is used", motion.length > 0);
  eq(
    "and only by the landing page",
    motion.filter((p) => !p.startsWith("src/features/landing/")),
    [],
  );
}

{
  /*
   * A component marked `"use client"` with nothing client about it renders in the
   * browser for no reason and drags its imports with it. Four landing sections
   * were in that state — they compose an animated wrapper, which is the part that
   * needs to be a client component, not them.
   *
   * The design-system primitives are excluded: they take handlers from their
   * callers, so the directive is what lets a client component pass one.
   *
   * Only `.tsx` is examined. A `.ts` module can be browser-only for reasons that
   * do not look like a component — `ringtone.ts` reaches for `AudioContext`,
   * `shared-channel.ts` for the browser Supabase client — and the first version
   * of this check flagged all four of them. That was the check being wrong, not
   * the code, which is a good argument for keeping the signal narrow.
   */
  const EXEMPT = ["components/ui/", "boards/registry.tsx", "auth-form.tsx"];

  const CLIENT_ONLY =
    /use[A-Z]|on[A-Z][a-z]+=|window\.|document\.|navigator\.|localStorage|AudioContext|new Audio|matchMedia|getSupabaseBrowserClient|requestAnimationFrame|IntersectionObserver|from "motion\/react"/;

  const pointless = FILES.filter((f) => {
    if (!f.path.endsWith(".tsx")) return false;
    if (!f.text.startsWith('"use client"')) return false;
    if (EXEMPT.some((e) => f.path.includes(e))) return false;
    return !CLIENT_ONLY.test(f.text);
  }).map((f) => f.path);

  eq("no component is a client component for nothing", pointless, []);
}

/* ==========================================================================
 * 6 · Images
 * ========================================================================== */

section("Images");

{
  /*
   * `next/image` is deliberately not used for avatars, and this is the note that
   * stops somebody "fixing" that.
   *
   * Avatars are signed URLs from a private bucket. The signature changes every
   * second the clock ticks, so `/_next/image` would key its cache on a URL that
   * is never the same twice: every render would re-optimise the same picture.
   * A plain `<img>` with `loading="lazy"` in a fixed-size box is the right answer
   * here, and it has no layout shift because the box is sized by a token.
   */
  const imgs = FILES.filter((f) => /<img\b/.test(f.text));
  truthy("there are images to check", imgs.length > 0);

  const eager = imgs
    .filter((f) => f.path.includes("avatar"))
    .filter((f) => !/loading="lazy"/.test(f.text))
    .map((f) => f.path);

  eq("avatars load lazily", eager, []);
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
