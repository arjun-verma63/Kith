import { NextResponse } from "next/server";

import { endCallAction } from "@/features/calls/actions";

/**
 * The last thing a closing tab does.
 *
 * `navigator.sendBeacon` is the only request that reliably survives a tab being
 * closed — a server action would be cancelled in flight — and it can only POST
 * to a URL. Hence a route rather than an action.
 *
 * There is no authorization here because there is none to do: the beacon carries
 * the session cookie, `end_call` checks that the caller is on the call, and a
 * request naming somebody else's call is refused by the database. This route
 * cannot do anything the person could not already do by pressing hang up.
 *
 * Best-effort by design. If the beacon is lost, the other side's peer connection
 * fails, they hang up, and `end_call` ends the call for both.
 */
export async function POST(request: Request) {
  let callId: unknown;

  try {
    const body: unknown = await request.json();
    callId = (body as { callId?: unknown } | null)?.callId;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  if (typeof callId !== "string") {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  // The beacon's response is discarded by a closing tab, but reporting the real
  // outcome keeps this debuggable — a route that always says "ok" tells you
  // nothing when a call will not end.
  const result = await endCallAction(callId, "hung_up");
  return NextResponse.json(result, { status: result.ok ? 200 : 403 });
}
