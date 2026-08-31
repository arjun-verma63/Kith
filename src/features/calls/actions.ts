"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  getActiveCall,
  listCallHistory,
  type ActiveCall,
  type CallHistoryEntry,
} from "@/features/calls/queries";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * Call mutations.
 *
 * Every one of these is a thin wrapper over an RPC, and that is the whole point:
 * the lifecycle is a state machine in migration 0016, and nothing here re-decides
 * any of it. There is no "if the call is ringing then…" in this file, because a
 * second copy of the rules in application code is a second copy that can be
 * wrong — and this particular set of rules governs whether somebody is told they
 * missed a call.
 *
 * The client cannot write to `calls` at all: INSERT, UPDATE and DELETE are
 * revoked from `authenticated`. These functions are the only door, and each one
 * checks who is knocking.
 */

const uuid = z.uuid();

export type CallResult =
  | { ok: true; call: ActiveCall | null }
  | { ok: false; reason: "unauthenticated" | "not_permitted" | "busy" | "gone" | "unknown" };

/**
 * Turns a Postgres error into something the UI can say out loud.
 *
 * The RPCs raise named conditions rather than returning codes, so this is the
 * one place that translation happens.
 */
function toReason(message: string | undefined, code: string | undefined): CallResult {
  const text = message ?? "";

  if (text.includes("already_in_call")) return { ok: false, reason: "busy" };
  if (text.includes("call_expired") || text.includes("call_not_live")) {
    return { ok: false, reason: "gone" };
  }
  if (text.includes("not_permitted") || text.includes("cannot_answer_own_call")) {
    return { ok: false, reason: "not_permitted" };
  }
  if (code === "42501") return { ok: false, reason: "not_permitted" };

  return { ok: false, reason: "unknown" };
}

export async function startCallAction(conversationId: string): Promise<CallResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "unauthenticated" };

  const parsed = uuid.safeParse(conversationId);
  if (!parsed.success) return { ok: false, reason: "not_permitted" };

  const supabase = await createSupabaseServerClient();
  // Audio only. `p_kind` exists because the column does, but nothing offers
  // video yet and this is the only caller.
  const { error } = await supabase.rpc("start_call", {
    p_conversation_id: parsed.data,
    p_kind: "audio",
  });

  if (error) return toReason(error.message, error.code);

  return { ok: true, call: await getActiveCall() };
}

export async function answerCallAction(callId: string): Promise<CallResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "unauthenticated" };

  const parsed = uuid.safeParse(callId);
  if (!parsed.success) return { ok: false, reason: "not_permitted" };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("answer_call", { p_call_id: parsed.data });

  if (error) return toReason(error.message, error.code);

  return { ok: true, call: await getActiveCall() };
}

/**
 * Hang up, decline, cancel, or give up on a ring.
 *
 * `reason` is a hint. The database decides what actually happened from the state
 * of the call — a callee hanging up on a ringing call is a decline whatever they
 * send, and only a call that ended while ringing can ever become "missed". That
 * is deliberate: an end reason a client could name is an end reason a client
 * could forge, and this one drives a notification.
 */
export async function endCallAction(
  callId: string,
  reason: "hung_up" | "declined" | "expired" | "failed" = "hung_up",
): Promise<CallResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "unauthenticated" };

  const parsed = uuid.safeParse(callId);
  if (!parsed.success) return { ok: false, reason: "not_permitted" };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("end_call", {
    p_call_id: parsed.data,
    p_reason: reason,
  });

  if (error) return toReason(error.message, error.code);

  revalidatePath("/calls");
  return { ok: true, call: null };
}

/**
 * Publishes what this participant is sending, for anybody who joins late.
 *
 * The authoritative copy travels on the call's broadcast channel; this is the
 * fallback for a browser that arrives after the last broadcast. Stored whole
 * rather than as a patch — a half-written state is how an icon ends up
 * describing a state nobody is in.
 */
export async function setCallMediaStateAction(
  callId: string,
  state: { micEnabled: boolean; cameraEnabled?: boolean; screenSharing?: boolean },
): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;

  const parsed = uuid.safeParse(callId);
  if (!parsed.success) return;

  const supabase = await createSupabaseServerClient();
  await supabase.rpc("set_call_media_state", {
    p_call_id: parsed.data,
    p_state: state,
  });
}

/**
 * Re-reads the live call.
 *
 * The broadcast payload is deliberately small — it has to be, it is sent to
 * every participant on every transition — so it carries names but not a signed
 * avatar URL, which only a server can mint. The incoming UI renders immediately
 * from the broadcast and fills in the photograph when this returns.
 */
export async function refreshActiveCallAction(): Promise<ActiveCall | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return getActiveCall();
}

/**
 * The next page of call history.
 *
 * A server action rather than a route: the keyset cursor is a timestamp the
 * client already holds, and `list_calls` filters by `auth.uid()` in the database,
 * so there is nothing here to get wrong.
 */
export async function loadMoreCallsAction(before: string): Promise<CallHistoryEntry[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  return listCallHistory(before);
}

/**
 * Relay credentials for one call.
 *
 * ── Why this is an action and not a constant ─────────────────────────────────
 *
 * TURN credentials cannot be inlined into the bundle: a relay password in
 * client JavaScript is an open bandwidth proxy for anybody who opens devtools.
 * They are minted per user, per call, with a short expiry, and delivered through
 * this authenticated call.
 *
 * ── Why it checks the call ───────────────────────────────────────────────────
 *
 * Being signed in is not enough. `is_call_participant` is the same gate that
 * guards the signalling channel, so a credential is issued only to somebody who
 * is demonstrably on a call — which bounds abuse to people who could already
 * relay media by simply making a call, and makes the relay's logs meaningful.
 *
 * ── Why it never fails ───────────────────────────────────────────────────────
 *
 * An empty list is a working answer: the call proceeds on STUN, exactly as it
 * did before TURN existed. A relay outage or a typo in an environment variable
 * must degrade a call, never prevent one.
 */
export async function getIceServersAction(callId: string): Promise<{
  iceServers: RTCIceServer[];
  expiresAt: string | null;
  source: "hmac" | "static" | "none";
}> {
  const empty = { iceServers: [], expiresAt: null, source: "none" as const };

  const user = await getCurrentUser();
  if (!user) return empty;

  const parsed = uuid.safeParse(callId);
  if (!parsed.success) return empty;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("is_call_participant", {
      target_call: parsed.data,
    });

    if (error || data !== true) return empty;

    const { getTurnCredential } = await import("@/lib/server/turn");
    const credential = getTurnCredential(user.id);

    return {
      iceServers: credential.iceServers,
      expiresAt: credential.expiresAt,
      source: credential.source,
    };
  } catch (error) {
    console.error("[turn] could not issue relay credentials; the call will use STUN", error);
    return empty;
  }
}
