/**
 * Which clicks count as navigation.
 *
 * `RouteProgress` shows a bar at the top of the screen when a navigation is
 * taking a moment, because until it existed the app said nothing at all between
 * a click and the next page — no spinner, no skeleton, no `loading.tsx`
 * anywhere. On a slow connection that reads as broken, and the reflex is to
 * click again.
 *
 * The bar itself is a few timers and a div. The part that goes wrong is this
 * predicate: every case below is a click that looks like navigation and is not,
 * and a false positive strands a bar on screen until its give-up timer — which
 * is worse than the silence the whole thing was added to fix.
 *
 * Pure and clock-free, so it is enumerable. The rendering is not covered here
 * and cannot be: no test in this project renders a component. What a bar looks
 * like while it moves is a question for the manual pass.
 *
 *     npm run navigation:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register(pathToFileURL(join(process.cwd(), "supabase/tests/alias-loader.mjs")).href);

const { isNavigationClick } = await import("../../src/lib/navigation-intent.ts");

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

const section = (title) => console.log(`\n${title}`);

const HERE = "https://kith.example.com/messages";

const PLAIN_CLICK = {
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

/** An anchor as the DOM would report it, from a link written as `to`. */
function anchor(to, extra = {}) {
  return {
    href: new URL(to, HERE).href,
    rawHref: to,
    target: null,
    download: false,
    ...extra,
  };
}

function navigates(name, { click = {}, link = "/games", attrs = {}, from = HERE } = {}) {
  const result = isNavigationClick({ ...PLAIN_CLICK, ...click }, anchor(link, attrs), from);
  if (result === true) ok(name);
  else bad(name, "expected this to start the bar, and it did not");
}

function ignores(name, { click = {}, link = "/games", attrs = {}, from = HERE } = {}) {
  const result = isNavigationClick({ ...PLAIN_CLICK, ...click }, anchor(link, attrs), from);
  if (result === false) ok(name);
  else bad(name, "the bar would start for a click that does not navigate, and hang");
}

console.log("KITH — navigation intent\n");

/* ==========================================================================
 * 1 · The case it exists for
 * ========================================================================== */

section("Ordinary navigation");

navigates("a plain click on an in-app link");
navigates("to a nested route", { link: "/games/abc-123" });
navigates("to a route with a query", { link: "/friends?filter=online" });
navigates("an absolute URL on this origin", { link: "https://kith.example.com/settings" });
navigates("a link back to the landing page", { link: "/" });

/* ==========================================================================
 * 2 · Clicks that open somewhere else
 *
 * Every one of these leaves the current page exactly where it is, so a bar
 * would be describing something that is not happening to this document.
 * ========================================================================== */

section("Opening elsewhere");

ignores("middle-click, which opens a tab", { click: { button: 1 } });
ignores("right-click, which opens a menu", { click: { button: 2 } });
ignores("cmd-click", { click: { metaKey: true } });
ignores("ctrl-click", { click: { ctrlKey: true } });
ignores("shift-click, which opens a window", { click: { shiftKey: true } });
ignores("alt-click, which downloads", { click: { altKey: true } });
ignores('target="_blank"', { attrs: { target: "_blank" } });
ignores("a named frame target", { attrs: { target: "somewhere" } });

// `_self` is the default written out, and is still this document.
navigates('target="_self" is ordinary navigation', { attrs: { target: "_self" } });

/* ==========================================================================
 * 3 · Anchors that are not pages
 * ========================================================================== */

section("Not a page");

ignores("a download link", { attrs: { download: true } });
ignores("an anchor with no href at all", { link: "", attrs: { rawHref: null } });
ignores("a fragment, which scrolls rather than navigates", { link: "#privacy" });
ignores("another origin entirely", { link: "https://example.com/anything" });
ignores("a protocol-relative link to another origin", { link: "//example.com/anything" });
ignores("mailto:", { link: "mailto:someone@example.com" });
ignores("tel:", { link: "tel:+441234567890" });
ignores("a javascript: URL", { link: "javascript:void 0" });

/* ==========================================================================
 * 4 · Already handled, or already here
 * ========================================================================== */

section("Nothing to wait for");

ignores("a click somebody has already handled", { click: { defaultPrevented: true } });

/*
 * The one coupled to the caller.
 *
 * `RouteProgress` ends the bar when `usePathname` changes, and that does not
 * fire when only the query changed. Starting a bar there would leave it running
 * until the give-up timer, so the predicate refuses the whole class — the bar
 * tracks path changes, so it starts on exactly those.
 */
ignores("a link to the page you are already on", { link: "/messages" });
ignores("  the same page with a fragment", { link: "/messages#latest" });
ignores("  the same page written absolutely", { link: "https://kith.example.com/messages" });
ignores("  and the same path with a different query", {
  link: "/messages?filter=unread",
  from: "https://kith.example.com/messages?filter=all",
});

// A different path is a real navigation even when the query matches.
navigates("but a different path with the same query is real", {
  link: "/friends?filter=all",
  from: "https://kith.example.com/messages?filter=all",
});

/* ==========================================================================
 * 5 · Nothing throws
 *
 * This runs inside a capture-phase listener on every click in the app. An
 * exception here would break the click it was only supposed to observe.
 * ========================================================================== */

section("Malformed input");

for (const [label, link] of [
  ["a nonsense href", "ht!tp://[[["],
  ["a bare colon", ":"],
  ["a single space", " "],
]) {
  try {
    isNavigationClick(PLAIN_CLICK, anchor(link), HERE);
    ok(`${label} does not throw`);
  } catch (error) {
    bad(`${label} does not throw`, `${error?.name}: ${error?.message}`);
  }
}

try {
  isNavigationClick(PLAIN_CLICK, { href: "/x", rawHref: "/x", target: null, download: false }, "");
  ok("an unparseable current location does not throw");
} catch (error) {
  bad("an unparseable current location does not throw", `${error?.name}: ${error?.message}`);
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
