/**
 * Typing indicators.
 *
 * The one feature in KITH with no server side at all: a typing broadcast is
 * client-to-client and never stored, because a row per keystroke is the single
 * easiest way to turn a chat app into a write-amplified one. Which also meant
 * there was nothing for the RLS suites to assert against, and the feature
 * shipped with no tests of any kind.
 *
 * The logic used to live inside a `useEffect`, so testing it would have meant a
 * React renderer this project does not have — adding jsdom for one hook is a
 * poor trade. It is now `src/features/messages/typing.ts`: two small classes
 * with an injected clock, which the hook wires up. That is a better shape
 * anyway. The old version kept one timer per person typing, and one missed
 * cancellation on unmount is a `setState` on a component that has gone.
 *
 * The clock being injected is what makes a four-second expiry a test that runs
 * in a microsecond instead of one that sleeps.
 *
 * Section 5 asserts the hook still uses these classes, because an extraction
 * nothing consumes is worse than no extraction: the tests go green and the
 * shipped code keeps its own copy of the bug.
 *
 *     npm run typing:test
 */

import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register(pathToFileURL(join(process.cwd(), "supabase/tests/alias-loader.mjs")).href);

const { TypingRoster, TypingThrottle, TYPING_TTL_MS, typingCadenceIsSane } =
  await import("../../src/features/messages/typing.ts");
const { BROADCAST_BATCH_MS } = await import("../../src/lib/supabase/realtime.ts");

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

/** A clock a test can wind forward. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

const ADA = "ada";
const RAFA = "rafa";
const MO = "mo";

console.log("KITH — typing indicators\n");

/* ==========================================================================
 * 1 · Who is shown
 * ========================================================================== */

section("The roster");

{
  const c = clock();
  const roster = new TypingRoster(ADA, c.now);

  eq("nobody is typing to begin with", roster.ids(), []);

  truthy("a first keystroke from somebody else is a change", roster.note(RAFA));
  eq("and they are shown", roster.ids(), [RAFA]);

  truthy(
    "their second keystroke is not a change",
    roster.note(RAFA) === false,
    "a repaint per keystroke — most keystrokes change nothing anybody can see",
  );
  eq("and they are shown exactly once", roster.ids(), [RAFA]);
}

{
  /*
   * You are not typing at yourself.
   *
   * The broadcast goes to the whole channel including the sender, so without
   * this every person watches themselves type — which reads as a bug the very
   * first time anybody uses the feature.
   */
  const roster = new TypingRoster(ADA, clock().now);

  truthy("your own broadcast is ignored", roster.note(ADA) === false);
  eq("and you never appear in your own list", roster.ids(), []);
}

{
  const roster = new TypingRoster(ADA, clock().now);

  truthy("a payload with no user id is ignored", roster.note(undefined) === false);
  truthy("as is an empty one", roster.note("") === false);
  truthy("and a null", roster.note(null) === false);
  eq("none of which crashes or shows a ghost", roster.ids(), []);
}

{
  // Oldest first, so a name does not jump position as somebody else joins in.
  const c = clock();
  const roster = new TypingRoster(ADA, c.now);

  roster.note(RAFA);
  c.advance(100);
  roster.note(MO);

  eq("two people are listed in the order they started", roster.ids(), [RAFA, MO]);

  c.advance(100);
  roster.note(RAFA);
  eq("and refreshing does not reshuffle them", roster.ids(), [RAFA, MO]);

  /*
   * Somebody who stops and starts again is a NEW run, and joins the end.
   *
   * The alternative — keeping the position they had before — means a name
   * reappearing in the middle of a list minutes later, which reads as the list
   * being wrong rather than as somebody resuming.
   */
  c.advance(TYPING_TTL_MS + 1);
  roster.prune();
  roster.note(MO);
  c.advance(10);
  roster.note(RAFA);
  eq("somebody who lapsed and came back joins the end", roster.ids(), [MO, RAFA]);
}

/* ==========================================================================
 * 2 · Forgetting
 * ========================================================================== */

section("Expiry");

{
  /*
   * The reason expiry lives on the RECEIVER.
   *
   * A "stopped typing" broadcast is never sent by somebody who closed the tab
   * mid-word, so an indicator waiting for one stays on screen forever. This is
   * the case that design exists for, and the only way to provoke it is to
   * simply never send the second message.
   */
  const c = clock();
  const roster = new TypingRoster(ADA, c.now);

  roster.note(RAFA);
  c.advance(TYPING_TTL_MS - 1);
  eq("somebody still within the window is shown", roster.ids(), [RAFA]);

  c.advance(1);
  eq("and is gone the moment it lapses", roster.ids(), []);
  truthy("without ever having said they stopped", true);
}

{
  const c = clock();
  const roster = new TypingRoster(ADA, c.now);

  roster.note(RAFA);
  c.advance(TYPING_TTL_MS - 500);
  roster.note(RAFA);

  c.advance(600);
  eq("a refresh keeps somebody who is still going", roster.ids(), [RAFA]);
}

{
  const c = clock();
  const roster = new TypingRoster(ADA, c.now);

  roster.note(RAFA);
  c.advance(1000);
  roster.note(MO);
  c.advance(TYPING_TTL_MS - 1000);

  eq("the one who stopped first drops off first", roster.ids(), [MO]);
}

{
  /*
   * `ids()` must not mutate. A component can render twice in one tick — React
   * does it deliberately in development — and a reader that also expires people
   * would give two different answers to the same question.
   */
  const c = clock();
  const roster = new TypingRoster(ADA, c.now);

  roster.note(RAFA);
  c.advance(TYPING_TTL_MS + 1);

  eq("reading twice gives the same answer", [roster.ids(), roster.ids()], [[], []]);
  truthy("and the sweep is a separate, explicit step", roster.prune() === true);
  truthy("which reports nothing left to do the second time", roster.prune() === false);
}

/* ==========================================================================
 * 3 · One timer, not one per person
 * ========================================================================== */

section("Scheduling");

{
  const c = clock();
  const roster = new TypingRoster(ADA, c.now);

  eq("an empty roster schedules nothing", roster.nextExpiryIn(), null);

  roster.note(RAFA);
  eq("one typist expires a full window from now", roster.nextExpiryIn(), TYPING_TTL_MS);

  c.advance(1000);
  roster.note(MO);
  eq("two typists schedule for whoever lapses first", roster.nextExpiryIn(), TYPING_TTL_MS - 1000);

  c.advance(TYPING_TTL_MS);
  eq("an overdue sweep is scheduled for now, never for the past", roster.nextExpiryIn(), 0);
}

{
  const roster = new TypingRoster(ADA, clock().now);
  roster.note(RAFA);
  roster.note(MO);

  roster.clear();
  eq("leaving the conversation clears everybody", roster.ids(), []);
  eq("and cancels the pending sweep", roster.nextExpiryIn(), null);
}

/* ==========================================================================
 * 4 · How often you announce yourself
 * ========================================================================== */

section("Throttle");

{
  /*
   * Holding a key down fires an input event per repeat. Unthrottled that is
   * sixty broadcasts a second, to everybody in the thread, to say a thing that
   * was already true — and realtime messages are the metered resource on the
   * free tier, so this is a bill rather than a tidiness question.
   */
  const c = clock();
  const throttle = new TypingThrottle(1000, c.now);

  truthy("the first keystroke is announced", throttle.shouldSend());
  truthy("the next one is not", throttle.shouldSend() === false);

  c.advance(999);
  truthy("nor is one a millisecond early", throttle.shouldSend() === false);

  c.advance(1);
  truthy("and the interval reopens exactly on time", throttle.shouldSend());
}

{
  const c = clock();
  const throttle = new TypingThrottle(1000, c.now);

  let sent = 0;
  for (let i = 0; i < 600; i += 1) {
    if (throttle.shouldSend()) sent += 1;
    c.advance(10); // ~100 keystrokes a second for six seconds
  }

  eq("six seconds of held-down key is six broadcasts, not six hundred", sent, 6);
}

{
  const c = clock();
  const throttle = new TypingThrottle(1000, c.now);

  throttle.shouldSend();
  throttle.reset();
  truthy("after a pause, the next keystroke announces immediately", throttle.shouldSend());
}

{
  /*
   * The constraint between the two halves, which is the bug neither class can
   * see on its own: the refresh interval and the expiry window live in
   * different files. A refresh slower than the expiry means a steady typist
   * flickers on and off, and nothing else in the codebase would notice.
   */
  const refresh = BROADCAST_BATCH_MS * 5;

  truthy(
    `refreshing every ${refresh}ms sits safely inside a ${TYPING_TTL_MS}ms window`,
    typingCadenceIsSane(refresh),
    `${refresh}ms against a ${TYPING_TTL_MS}ms expiry — a steady typist would flicker`,
  );

  truthy("a refresh at the expiry is rejected", typingCadenceIsSane(TYPING_TTL_MS) === false);
  truthy("as is one past it", typingCadenceIsSane(TYPING_TTL_MS + 1) === false);
  truthy("and one that never fires", typingCadenceIsSane(0) === false);
}

/* ==========================================================================
 * 5 · The hook actually uses all this
 * ========================================================================== */

section("Wiring");

{
  /*
   * An extraction nothing consumes is worse than no extraction: the suite above
   * goes green while the shipped hook keeps its own copy of the logic. These are
   * source checks rather than behaviour, which is a weaker kind of test — but
   * the thing being guarded against is a file drifting out of use, and that is
   * exactly what source can see and behaviour cannot.
   */
  const hook = readFileSync(
    join(process.cwd(), "src/features/messages/use-conversation-channel.ts"),
    "utf8",
  );

  truthy("the hook imports the roster", /TypingRoster/.test(hook));
  truthy("and the throttle", /TypingThrottle/.test(hook));
  truthy(
    "and keeps no timer map of its own",
    !/typingTimers|new Map<string, number>/.test(hook),
    "the per-person timer map is back",
  );
  truthy(
    "the effect clears its timer on unmount",
    /return \(\) => \{[\s\S]*clearTimeout\(expiryTimer\)/.test(hook),
    "a pending expiry outlives the component",
  );
  truthy(
    "and empties the roster, so reopening a thread starts quiet",
    /roster\.clear\(\)/.test(hook),
  );
}

{
  /*
   * The privacy setting, which is honoured in the only place it CAN be: your own
   * browser's sending. Nothing can stop somebody else broadcasting a keystroke,
   * and receiving is deliberately unaffected — turning yours off does not blind
   * you to other people's, because that is their choice, not yours.
   */
  const thread = readFileSync(
    join(process.cwd(), "src/features/messages/components/message-thread.tsx"),
    "utf8",
  );

  truthy(
    "the composer only broadcasts when the setting allows it",
    /onTyping=\{broadcastTyping \? sendTyping : noop\}/.test(thread),
    "the typing_indicators preference is not gating the broadcast",
  );
  truthy(
    "and the setting does not also hide other people's",
    /typingUserIds/.test(thread) && !/broadcastTyping \?\?? *typingUserIds/.test(thread),
    "turning your own indicator off should not blind you to everyone else's",
  );
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
