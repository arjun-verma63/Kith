/**
 * Who is typing, and how often to say that you are.
 *
 * Both halves of the typing indicator, pulled out of `useConversationChannel`
 * so they can be tested. They were four lines each inside a `useEffect`, which
 * is a fine place for four lines right up until you want to know whether they
 * are correct — and this is the one feature in KITH with no server side at all,
 * so there was nothing else to assert against.
 *
 * Neither class knows about React, Supabase or the DOM. The clock is injected
 * rather than read from `window`, which is what makes an expiry test a matter of
 * advancing a number instead of waiting four real seconds.
 *
 * ── Why a typing indicator expires on the RECEIVER ───────────────────────────
 *
 * The obvious design is a `typing` broadcast and a `stopped-typing` broadcast.
 * It does not work: somebody who closes the tab mid-word never sends the second
 * one, and their name stays on screen forever. So the sender repeats a single
 * message while they are typing, and the receiver forgets anybody it has not
 * heard from lately. A missing "stop" then costs four seconds, not a permanent
 * lie about somebody who has gone.
 */

/** How long a typing indicator survives without a refresh. */
export const TYPING_TTL_MS = 4000;

/** Injected so a test can advance time rather than wait for it. */
export type Clock = () => number;

/**
 * The people currently typing in one conversation.
 *
 * Holds a last-heard timestamp per person rather than a timer per person: with
 * timers, five people typing means five pending callbacks to cancel on unmount,
 * and forgetting one leaks a `setState` into an unmounted component. Here the
 * expiry is a comparison, and the only scheduled work is a single repaint.
 */
export class TypingRoster {
  /*
   * Two timestamps per person, not one.
   *
   * `lastHeard` decides whether to show them; `startedAt` decides where in the
   * list. Sorting by `lastHeard` seems equivalent and is not — it reorders the
   * list on every keystroke, so two people typing at once swap places several
   * times a second. Caught by the test that claimed refreshing does not
   * reshuffle, against a first version that sorted by the wrong one.
   */
  private readonly typists = new Map<string, { startedAt: number; lastHeard: number }>();

  /** Broadcasts from this id are ignored — you are not typing at yourself. */
  private readonly selfId: string;
  private readonly now: Clock;
  private readonly ttlMs: number;

  /*
   * Fields assigned in the body rather than declared as constructor parameter
   * properties. Those are the tidier spelling, and Node's strip-only TypeScript
   * cannot run them — parameter properties emit assignments, and strip-only
   * removes types without emitting anything. The test suites import this file
   * directly through Node, so the tidier spelling would be untestable, which is
   * the opposite of why it was extracted.
   */
  constructor(selfId: string, now: Clock = Date.now, ttlMs: number = TYPING_TTL_MS) {
    this.selfId = selfId;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  /**
   * Records that somebody is typing.
   *
   * Returns whether the visible set changed, so a caller can skip a re-render
   * for the second, third and fourth keystroke of the same person — which is
   * most of them.
   */
  note(userId: string | null | undefined): boolean {
    if (!userId || userId === this.selfId) return false;

    const now = this.now();
    const existing = this.typists.get(userId);
    const wasVisible = existing !== undefined && now - existing.lastHeard < this.ttlMs;

    this.typists.set(userId, {
      // Somebody who lapsed and came back starts a new run, so they take their
      // place at the end rather than reclaiming a position from minutes ago.
      startedAt: wasVisible ? existing.startedAt : now,
      lastHeard: now,
    });

    return !wasVisible;
  }

  /**
   * Drops everybody who has gone quiet, and reports whether anybody went.
   *
   * Separate from `ids()` because reading should not mutate: a component that
   * renders twice in one tick must not get different answers.
   */
  prune(): boolean {
    const cutoff = this.now() - this.ttlMs;
    let removed = false;

    for (const [userId, seen] of this.typists) {
      if (seen.lastHeard <= cutoff) {
        this.typists.delete(userId);
        removed = true;
      }
    }

    return removed;
  }

  /** Who to show, in the order they started, so the list does not reshuffle. */
  ids(): string[] {
    const cutoff = this.now() - this.ttlMs;
    return [...this.typists.entries()]
      .filter(([, seen]) => seen.lastHeard > cutoff)
      .sort((a, b) => a[1].startedAt - b[1].startedAt)
      .map(([userId]) => userId);
  }

  /**
   * When the next person falls off, or null if nobody is typing.
   *
   * One timer for the whole roster: the caller schedules a single prune for this
   * moment instead of one per person.
   */
  nextExpiryIn(): number | null {
    if (this.typists.size === 0) return null;

    // The one heard from least recently, which is not necessarily the one who
    // started first — that distinction is the whole reason for two timestamps.
    const quietest = Math.min(...[...this.typists.values()].map((seen) => seen.lastHeard));
    return Math.max(0, quietest + this.ttlMs - this.now());
  }

  /** Leaving the conversation. Nobody is typing in a thread you cannot see. */
  clear(): void {
    this.typists.clear();
  }
}

/**
 * How often this browser announces that its owner is typing.
 *
 * Holding a key down fires an input event per repeat. Without this, that is
 * sixty broadcasts a second to everybody in the thread, to say a thing that was
 * already true — and realtime messages are the metered resource on the free
 * tier, so it is a real cost rather than a tidiness one.
 *
 * The interval must stay comfortably under `TYPING_TTL_MS` or a steady typist
 * flickers: their indicator expires on the receiver before the next refresh
 * arrives. `assertTypingCadenceIsSane` below is that constraint, written down.
 */
export class TypingThrottle {
  private lastSentAt = 0;

  private readonly intervalMs: number;
  private readonly now: Clock;

  constructor(intervalMs: number, now: Clock = Date.now) {
    this.intervalMs = intervalMs;
    this.now = now;
  }

  /** True if the caller should broadcast now. */
  shouldSend(): boolean {
    const now = this.now();
    if (now - this.lastSentAt < this.intervalMs) return false;

    this.lastSentAt = now;
    return true;
  }

  /** Stopped typing — the next keystroke should announce immediately. */
  reset(): void {
    this.lastSentAt = 0;
  }
}

/**
 * The relationship between the two halves.
 *
 * Exported rather than left as a comment because the two numbers live in
 * different files (`BROADCAST_BATCH_MS` is in the realtime config) and nothing
 * else would notice if one of them moved. A refresh interval at or above the
 * expiry means every typist flickers.
 */
export function typingCadenceIsSane(intervalMs: number, ttlMs: number = TYPING_TTL_MS): boolean {
  // Half the window, so one dropped broadcast still does not cause a flicker.
  return intervalMs > 0 && intervalMs <= ttlMs / 2;
}
