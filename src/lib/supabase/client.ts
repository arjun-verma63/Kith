import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabasePublicEnv } from "@/lib/env/client";
import type { Database } from "@/types/database";

/**
 * The browser client. One per tab, for the lifetime of the tab.
 *
 * The singleton is not a micro-optimisation. Every `createBrowserClient` call
 * builds a fresh auth state machine and, once channels are subscribed, its own
 * Realtime WebSocket. Two of them in one page means two sockets, duplicated
 * `onAuthStateChange` listeners, and token refreshes racing each other to write
 * the same cookie. The architecture calls for exactly one connection multiplexed
 * across channels, and this is where that starts.
 *
 * Authenticates as the signed-in user (or anonymously), so **every query is
 * subject to Row Level Security**. That is the security model: the anon key is
 * public by design and confers no privileges of its own.
 */

export type KithSupabaseClient = SupabaseClient<Database>;

let browserClient: KithSupabaseClient | undefined;

export function getSupabaseBrowserClient(): KithSupabaseClient {
  if (browserClient) return browserClient;

  const env = getSupabasePublicEnv();

  browserClient = createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      realtime: {
        // Caps outbound broadcast messages per second per client. ICE trickle
        // during call setup and per-tick game input are the two things capable
        // of burning the free tier's monthly message allowance, so the ceiling
        // is set here once rather than remembered at each call site.
        params: { eventsPerSecond: 20 },
      },
    },
  );

  return browserClient;
}

/**
 * Drops the memoised client. Only for tests — application code should never
 * need a second client, and reaching for this in a component is a sign that
 * something is being constructed in the wrong place.
 */
export function resetSupabaseBrowserClient(): void {
  browserClient = undefined;
}
