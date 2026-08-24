import { serverEnv } from "@/lib/env/server";

/**
 * Liveness endpoint.
 *
 * Also the target for the scheduled keepalive described in docs/ARCHITECTURE.md:
 * Supabase free-tier projects pause after a period of inactivity, and a six-person
 * app will hit that. From Phase 2 this handler also runs a trivial database query
 * so the ping actually keeps the project awake.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "ok",
      environment: serverEnv.NODE_ENV,
      timestamp: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
