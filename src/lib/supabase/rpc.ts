import "server-only";

import type { KithSupabaseClient } from "@/lib/supabase/client";

/**
 * Typed database function calls.
 *
 * `src/types/database.ts` is generated from a live project, and it is currently
 * the empty schema because the migrations have never been applied to one. Until
 * `npm run db:types` can run, `supabase.rpc()` has no idea these functions
 * exist and types every name as `never`.
 *
 * So the signatures the application depends on are declared here, by hand, in
 * ONE place with ONE cast — rather than scattering `as never` through the call
 * sites where they would quietly outlive the problem. Two consequences worth
 * being clear about:
 *
 *   - This file is a temporary bridge. The day `database.ts` is regenerated,
 *     `callRpc` collapses into a plain `client.rpc(...)` and this module is
 *     deleted. It is one import to find, not twelve.
 *
 *   - These declarations are checked by nothing. They are asserted to match
 *     `supabase/migrations/20260825001000_invite_redemption.sql`, and the RLS
 *     test suite is what proves the functions behave as described — but the
 *     TypeScript here and the SQL there can drift, which is precisely why this
 *     is a stopgap and not a design.
 */

interface RpcSignatures {
  /**
   * Atomically claims one use of an invite code.
   * Returns the invite id, or null when the room was empty and no code was
   * needed. Raises `invalid_invite` / `invite_required` otherwise.
   */
  consume_invite: {
    args: { p_code_hash: string };
    returns: string | null;
  };

  /** Hands a claimed use back when account creation fails afterwards. */
  release_invite: {
    args: { p_invite_id: string };
    returns: null;
  };

  /** Records who was let in by which invitation. */
  record_invite_redemption: {
    args: { p_invite_id: string; p_user_id: string };
    returns: null;
  };

  /** True when nobody currently holds that username, case-insensitively. */
  is_username_available: {
    args: { p_username: string };
    returns: boolean;
  };
}

export async function callRpc<K extends keyof RpcSignatures>(
  client: KithSupabaseClient,
  fn: K,
  args: RpcSignatures[K]["args"],
): Promise<{ data: RpcSignatures[K]["returns"] | null; error: { message: string } | null }> {
  // The single cast. `rpc` is typed from the generated schema, which does not
  // yet know about these functions.
  const rpc = client.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const { data, error } = await rpc(fn, args);

  return {
    data: (data ?? null) as RpcSignatures[K]["returns"] | null,
    error,
  };
}
