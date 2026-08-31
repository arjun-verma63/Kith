/**
 * Timings shared by the client and the database.
 *
 * `RING_TIMEOUT_MS` must match `public.ring_timeout()` in migration 0016. The
 * database is the authority — it catches a ring whose browser has gone away —
 * but a client that waited for the sweep would keep ringing at somebody after
 * the caller had already given up, so both sides run the same clock.
 *
 * Two definitions of one number is a smell. The alternative is a round trip on
 * every call to read a constant, so instead: this comment, and a test that fails
 * if they drift apart.
 */
export const RING_TIMEOUT_MS = 45_000;

/** How often the in-call timer redraws. */
export const CALL_TICK_MS = 1000;

/**
 * How many calls a history page holds.
 *
 * Here rather than in `queries.ts` because the log's "earlier calls" button
 * needs it to know when it has reached the end — and `queries.ts` is
 * `server-only`, so importing a value from it would drag the Supabase server
 * client into the browser bundle. The type import is erased; a constant is not.
 */
export const HISTORY_PAGE_SIZE = 30;
