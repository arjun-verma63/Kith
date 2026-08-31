"use server";

import { searchProfiles, type SearchResult } from "@/features/friends/queries";
import { getCurrentUser } from "@/lib/supabase/server";

/**
 * The search entry point for the client.
 *
 * A server action rather than a route handler: it needs the session cookie, it
 * returns typed data, and there is nothing about it that wants a URL. It also
 * means the search query never appears in a browser history entry or a server
 * access log, which for "who is looking up whom" in a six-person room is worth
 * the difference.
 *
 * In its own file because `"use server"` marks EVERY export in a module as a
 * remotely-callable endpoint. Putting this beside the query helpers would
 * publish those as endpoints too.
 */
export async function searchAction(query: string): Promise<SearchResult[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  return searchProfiles(query);
}
