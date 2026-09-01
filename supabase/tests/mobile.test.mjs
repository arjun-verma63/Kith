/**
 * Mobile invariants.
 *
 * ── Why this is a static suite and not a browser one ─────────────────────────
 *
 * Nothing here needs a database, and none of it could be checked by one. These
 * are properties of the source: a `vh` that should be a `dvh`, a z-index naming
 * a token that does not exist, a fixed bar that does not clear the navigation
 * under it. Every one of them is invisible on a desktop and obvious on a phone,
 * which is exactly the class of bug that comes back.
 *
 * The `--z-modal` check is here because it caught a real one. The incoming-call
 * screen referenced a token the scale never defined, so it resolved to
 * `z-index: auto` and layered by document order — harmless until the header
 * became sticky with a z-index of its own, at which point the header would have
 * covered a full-screen incoming call.
 *
 * ── What this suite cannot tell you ──────────────────────────────────────────
 *
 * Whether it LOOKS right. No viewport is rendered here, nothing is measured, and
 * a layout can satisfy every rule below and still be ugly at 320px. The manual
 * pass in docs/MOBILE.md is not optional and this file does not replace it.
 *
 *     npm run mobile:test
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

/** Every source file that can carry a class name or a style. */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if ([".ts", ".tsx", ".css"].includes(extname(full))) yield full;
  }
}

const FILES = [...walk(SRC)].map((path) => ({
  path: relative(ROOT, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

const tokens = FILES.find((f) => f.path.endsWith("styles/tokens.css")).text;
const components = FILES.find((f) => f.path.endsWith("styles/components.css")).text;

/** Offending files for a pattern, with the matched line for the message. */
function offenders(pattern, filter = () => true) {
  const hits = [];

  for (const file of FILES) {
    if (!filter(file)) continue;
    for (const [index, line] of file.text.split("\n").entries()) {
      if (pattern.test(line)) hits.push(`${file.path}:${index + 1}`);
      pattern.lastIndex = 0;
    }
  }

  return hits;
}

console.log("KITH — mobile\n");

/* ==========================================================================
 * 1 · Viewport units
 * ========================================================================== */

section("Viewport units");

{
  /*
   * `vh` is frozen at the tallest the viewport ever gets, so on a phone it
   * includes the browser chrome that is currently on screen and the keyboard
   * that is currently over it. A full-height chat laid out in `vh` puts its
   * composer underneath the keyboard. `dvh` tracks the space that is really
   * there.
   */
  const bad_vh = offenders(
    /(?:^|[^d])\b(?:100vh|min-h-screen|h-screen|max-h-screen)\b/,
    (f) => !f.path.endsWith(".css"),
  );
  eq("no component sizes itself in vh — dvh only", bad_vh, []);

  // `100vw` includes the classic scrollbar gutter on desktop, which is a
  // horizontal scrollbar on anything using it for a max-width.
  const bad_vw = offenders(/(?:max-w|w)-\[[^\]]*100vw/, (f) => !f.path.endsWith(".css"));
  eq("and no width is measured in vw", bad_vw, []);
}

/* ==========================================================================
 * 2 · The z-index scale
 * ========================================================================== */

section("Layering");

{
  const defined = new Set([...tokens.matchAll(/--z-([a-z-]+):/g)].map((m) => `--z-${m[1]}`));

  const used = new Set();
  for (const file of FILES) {
    for (const match of file.text.matchAll(/var\((--z-[a-z-]+)\)/g)) used.add(match[1]);
  }

  const undefinedTokens = [...used].filter((name) => !defined.has(name));

  /*
   * A z-index referencing a token that does not exist is not a warning anywhere
   * — CSS drops the declaration and the element layers by document order. It
   * looks fine until something above it grows a z-index.
   */
  eq("every z-index names a token that exists", undefinedTokens, []);
  truthy("and the scale is not empty", defined.size >= 6);
}

/* ==========================================================================
 * 3 · Safe areas and the bottom bar
 * ========================================================================== */

section("Chrome");

{
  const layout = FILES.find((f) => f.path === "src/app/layout.tsx").text;

  /*
   * `env(safe-area-inset-*)` reports zero unless the page has opted into drawing
   * under the notch and the home indicator. Without this the bottom bar sits
   * above the indicator with a strip of background under it, which reads as a
   * bug rather than as a margin.
   */
  truthy("the root layout opts into the safe area", /viewportFit:\s*"cover"/.test(layout));

  for (const name of ["--safe-b", "--safe-t", "--nav-bar-h", "--app-header-h"]) {
    truthy(`${name} is defined`, tokens.includes(`${name}:`));
  }

  truthy(
    "the bottom bar height collapses to zero on a wide screen",
    /@media \(min-width: 64rem\)[\s\S]{0,200}--nav-bar-h:\s*0px/.test(tokens),
  );
}

{
  /*
   * Anything pinned to the bottom of the viewport has to clear the navigation,
   * or it covers the way out of whatever it is.
   *
   * The bar itself is the exception — it IS the thing being cleared.
   */
  const pinned = [];

  for (const file of FILES) {
    if (file.path.endsWith(".css") || file.path.endsWith("nav-rail.tsx")) continue;

    for (const [index, line] of file.text.split("\n").entries()) {
      if (!/\bfixed\b/.test(line)) continue;
      if (!/\bbottom-0\b/.test(line)) continue;
      pinned.push(`${file.path}:${index + 1}`);
    }
  }

  eq("nothing else is pinned flat against the bottom edge", pinned, []);
}

/* ==========================================================================
 * 4 · Touch
 * ========================================================================== */

section("Touch");

{
  /*
   * iOS Safari zooms the page when a field smaller than 16px takes focus, and
   * does not zoom back out. The base scale is 15px, which is correct for the
   * type system and one pixel short of avoiding that.
   */
  truthy(
    "fields grow to 16px on a touch device",
    /@media \(pointer: coarse\)[\s\S]{0,300}font-size:\s*1rem/.test(components),
  );

  /*
   * 32px is comfortable for a mouse and frustrating for a thumb. Raised as a
   * token so every existing `size="sm"` control gets it, and so does one written
   * next year.
   */
  truthy(
    "the dense control height reaches 44px on a touch device",
    /@media \(pointer: coarse\)[\s\S]{0,200}--control-sm:\s*2\.75rem/.test(tokens),
  );
}

{
  // A canvas without `touch-none` scrolls the page instead of drawing on it.
  const canvases = FILES.filter((f) => /<canvas/.test(f.text));
  truthy("there is a canvas to check", canvases.length > 0);

  const untouchable = canvases.filter((f) => !/touch-none/.test(f.text)).map((f) => f.path);
  eq("every canvas opts out of touch scrolling", untouchable, []);
}

/* ==========================================================================
 * 5 · Scrolling
 * ========================================================================== */

section("Scrolling");

{
  /*
   * Rubber-banding a scrolled pane past its end scrolls whatever is behind it —
   * on a fixed-height app shell that looks like the whole interface has come
   * loose. `overscroll-contain` stops the chain at the pane.
   *
   * Checked on the panes that are tall enough to be flicked, which is the ones
   * with a bounded height and their own scrollbar.
   */
  const panes = [
    ["message thread", "src/features/messages/components/message-thread.tsx"],
    ["conversation list", "src/features/messages/components/conversation-list.tsx"],
    ["notification panel", "src/features/notifications/components/notification-bell.tsx"],
    ["dialog body", "src/components/ui/dialog.tsx"],
    ["the guess feed", "src/features/games/components/boards/draw-guess-board.tsx"],
  ];

  for (const [name, path] of panes) {
    const file = FILES.find((f) => f.path === path);
    truthy(`${name} contains its own overscroll`, /overscroll-contain/.test(file.text));
  }
}

/* ==========================================================================
 * 6 · Navigation
 * ========================================================================== */

section("Navigation");

{
  const destinations = FILES.find((f) => f.path.endsWith("layout/destinations.ts")).text;
  const hrefs = [...destinations.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);

  truthy("the bar has destinations", hrefs.length >= 5);

  /*
   * A destination whose route does not exist renders as the "not built yet"
   * state — correct when it was written and wrong once the route lands. Four of
   * these had been sitting in that state with the pages already built, because
   * nothing had ever rendered the nav.
   */
  const missing = hrefs.filter((href) => {
    const segments = href.split("/").filter(Boolean);
    if (segments.length === 0) return false;
    const candidates = [
      join(SRC, "app", "(app)", ...segments, "page.tsx"),
      join(SRC, "app", ...segments, "page.tsx"),
    ];
    return !candidates.some((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
  });

  eq("every destination points at a route that exists", missing, []);

  const primary = [...destinations.matchAll(/primary:\s*true/g)].length;
  eq("five fit across a 320px screen, so five is what is on the bar", primary, 5);
}

{
  const bar = FILES.find((f) => f.path.endsWith("layout/nav-rail.tsx")).text;

  truthy("the bar is hidden from lg up, where the header carries the links", /lg:hidden/.test(bar));
  truthy("and it clears the home indicator", /pb-\[var\(--safe-b\)\]/.test(bar));

  /*
   * The one place a fixed bottom bar is actively harmful: the composer lives at
   * the bottom of a thread, the software keyboard arrives under it, and on iOS a
   * fixed element ends up floating above the keyboard on top of what is being
   * typed.
   */
  truthy(
    "and it takes itself out of a conversation",
    /inThread/.test(bar) && /return null/.test(bar),
  );
}

/* ==========================================================================
 * 7 · The chat, which the keyboard is hardest on
 * ========================================================================== */

section("Chat");

{
  const layout = FILES.find((f) => f.path === "src/app/(app)/messages/layout.tsx").text;

  truthy("the thread is sized in dvh", /100dvh/.test(layout));
  truthy(
    "against tokens rather than a hard-coded header height",
    /--app-header-h/.test(layout) && /--nav-bar-h/.test(layout),
  );

  const thread = FILES.find((f) => f.path.endsWith("messages/components/message-thread.tsx")).text;

  /*
   * Enter sends on a hardware keyboard and inserts a newline on a touch one,
   * where there is no shift key within reach and no other way to break a line.
   */
  truthy(
    "Enter does not send on a touch keyboard",
    /ontouchstart/.test(thread) && /shiftKey/.test(thread),
  );
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
