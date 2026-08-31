"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { fromPostgrestError } from "@/lib/supabase/errors";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";
import type { FormState } from "@/lib/forms";

/**
 * Friend mutations.
 *
 * Every one of these uses the cookie-bound client, never the admin client, and
 * that is the design rather than a convenience. Read the RLS policies in
 * migration 0003 alongside this file: the rules are already there, and these
 * functions do not re-implement them.
 *
 *   - You cannot befriend yourself: a CHECK constraint.
 *   - You cannot have two friendships with the same person: a primary key on
 *     the canonical `(low, high)` pair.
 *   - You cannot open a second pending request in either direction: a partial
 *     unique index on the unordered pair.
 *   - You cannot accept a request addressed to somebody else, and you cannot
 *     accept your OWN request: two separate UPDATE policies with different
 *     permitted target states.
 *
 * If any check below were deleted, the database would still refuse. What the
 * checks here buy is a message a person can act on instead of a 500.
 */

type State = FormState;

const uuid = z.uuid("That is not a valid id.");

function fail(message: string): State {
  return { status: "error", message };
}

/** Every friend surface is derived from the same three lists. */
function revalidateFriends(): void {
  revalidatePath("/friends");
}

/* ========================================================================== */

export async function sendFriendRequestAction(_prev: State, formData: FormData): Promise<State> {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in again to send a request.");

  const target = uuid.safeParse(formData.get("userId"));
  if (!target.success) return fail("That person could not be found.");

  // Checked here for the message, enforced by `friend_requests_no_self`.
  if (target.data === user.id) return fail("You cannot add yourself.");

  const message = formData.get("message");
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.from("friend_requests").insert({
    requester_id: user.id,
    addressee_id: target.data,
    ...(typeof message === "string" && message.trim() !== ""
      ? { message: message.trim().slice(0, 200) }
      : {}),
  });

  if (error) {
    // The partial unique index on the unordered pair. Hit when a request is
    // already open in EITHER direction, which is why the message does not
    // assume the caller is the one who sent it.
    if (error.code === "23505") {
      return fail("There is already a request open between you two.");
    }
    // The WITH CHECK clause refused it: already friends, or blocked. Not
    // distinguished, because "you are blocked" is not something to announce.
    if (error.code === "42501") {
      return fail("That request could not be sent.");
    }
    return { ...fromPostgrestError(error, "sendFriendRequest").error, status: "error" } as State;
  }

  revalidateFriends();
  return { status: "success", message: "Request sent." };
}

/**
 * Accepting.
 *
 * The friendship row is NOT created here. A trigger on `friend_requests` creates
 * it in the same transaction as the status change, so the pair either both
 * happen or neither does — a crash between two client round trips cannot leave
 * an accepted request with no friendship behind it.
 */
export async function acceptFriendRequestAction(_prev: State, formData: FormData): Promise<State> {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in again to respond.");

  const request = uuid.safeParse(formData.get("requestId"));
  if (!request.success) return fail("That request could not be found.");

  const supabase = await createSupabaseServerClient();

  // No `.eq("addressee_id", user.id)` here on purpose. `friend_requests_respond`
  // already restricts this to the addressee, and adding a second copy of the
  // rule invites the two to disagree later. A request that is not yours simply
  // matches no rows.
  const { data, error } = await supabase
    .from("friend_requests")
    .update({ status: "accepted" })
    .eq("id", request.data)
    .select("id");

  if (error) {
    return { ...fromPostgrestError(error, "acceptFriendRequest").error, status: "error" } as State;
  }

  if (!data || data.length === 0) {
    return fail("That request is no longer open.");
  }

  revalidateFriends();
  return { status: "success", message: "You are friends." };
}

export async function declineFriendRequestAction(_prev: State, formData: FormData): Promise<State> {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in again to respond.");

  const request = uuid.safeParse(formData.get("requestId"));
  if (!request.success) return fail("That request could not be found.");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("friend_requests")
    .update({ status: "declined" })
    .eq("id", request.data)
    .select("id");

  if (error) {
    return { ...fromPostgrestError(error, "declineFriendRequest").error, status: "error" } as State;
  }

  if (!data || data.length === 0) return fail("That request is no longer open.");

  revalidateFriends();
  return { status: "success", message: "Request declined." };
}

/**
 * Cancelling your own outgoing request.
 *
 * A separate policy from declining, and a separate action, because the
 * permitted target state differs. One policy allowing both would let a requester
 * write `accepted` — and befriend anybody by sending a request and accepting it
 * themselves.
 */
export async function cancelFriendRequestAction(_prev: State, formData: FormData): Promise<State> {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in again to cancel.");

  const request = uuid.safeParse(formData.get("requestId"));
  if (!request.success) return fail("That request could not be found.");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("friend_requests")
    .update({ status: "cancelled" })
    .eq("id", request.data)
    .select("id");

  if (error) {
    return { ...fromPostgrestError(error, "cancelFriendRequest").error, status: "error" } as State;
  }

  if (!data || data.length === 0) return fail("That request is no longer open.");

  revalidateFriends();
  return { status: "success", message: "Request withdrawn." };
}

/**
 * Unfriending.
 *
 * Symmetric: either side may end it, without the other's agreement. The row is
 * addressed by the canonical pair rather than by an id, which is also how the
 * primary key finds it — one index probe, and no way to delete somebody else's
 * friendship by guessing a uuid.
 */
export async function removeFriendAction(_prev: State, formData: FormData): Promise<State> {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in again to make that change.");

  const target = uuid.safeParse(formData.get("userId"));
  if (!target.success) return fail("That person could not be found.");

  const [low, high] = [user.id, target.data].sort();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("friendships")
    .delete()
    .eq("user_low", low as string)
    .eq("user_high", high as string)
    .select("user_low");

  if (error) {
    return { ...fromPostgrestError(error, "removeFriend").error, status: "error" } as State;
  }

  if (!data || data.length === 0) return fail("You are not friends with them.");

  revalidateFriends();
  return { status: "success", message: "Removed." };
}
