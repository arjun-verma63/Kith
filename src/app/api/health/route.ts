import { isSupabaseConfigured } from "@/lib/env/client";
import { serverEnv } from "@/lib/env/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Liveness, and the thing that keeps the database awake.
 *
 * ── Why this handler touches Postgres ────────────────────────────────────────
 *
 * Free-tier Supabase projects pause after a week of inactivity, and a six-person
 * app will absolutely hit that. The plan for it — documented in ARCHITECTURE.md
 * §9 — is a scheduled ping to this endpoint.
 *
 * That plan did not work. This handler used to return a JSON object and nothing
 * else, so the ping kept a Vercel function warm and had no effect whatsoever on
 * Supabase, which pauses on DATABASE inactivity. The keepalive would have run
 * happily every day while the project it was protecting went to sleep, and the
 * failure would have surfaced as "the app is down" a week after launch with a
 * cron job in place that appeared to be doing its job.
 *
 * So the ping now issues a real query. It is deliberately the cheapest possible
 * one: a `head` count against `profiles`, which sends no rows over the wire and
 * — because this runs with the anon key and no session — is refused by Row Level
 * Security anyway. **The refusal is fine.** A query that RLS declines still
 * reaches Postgres, parses, plans and executes, which is the entire point. What
 * is needed is activity, not data.
 *
 * Using the anon key rather than the service role is deliberate too: an
 * unauthenticated endpoint that anyone on the internet can call should not hold
 * a credential that bypasses every policy, however trivial the query.
 *
 * ── What it reports ──────────────────────────────────────────────────────────
 *
 * `database` distinguishes "reachable" from "the ping ran". Without it a
 * monitor watching this endpoint would go green while Postgres was unreachable,
 * which is precisely the outage worth paging about.
 *
 * The response stays deliberately thin. This is public and unauthenticated, so
 * it says whether the lights are on and nothing about what is in the room — no
 * counts, no version, no error text from Supabase.
 */
export const dynamic = "force-dynamic";

/** Beyond this, treat the database as unreachable rather than hanging the ping. */
const DATABASE_TIMEOUT_MS = 5_000;

type DatabaseStatus = "ok" | "unreachable" | "not_configured";

async function pingDatabase(): Promise<DatabaseStatus> {
  // A fresh clone has no Supabase project, and the landing page does not need
  // one. Reporting that honestly beats reporting an outage that is not one.
  if (!isSupabaseConfigured()) return "not_configured";

  try {
    const supabase = await createSupabaseServerClient();

    const query = supabase.from("profiles").select("id", { head: true, count: "exact" });

    const result = await Promise.race([
      query,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), DATABASE_TIMEOUT_MS),
      ),
    ]);

    /*
     * An RLS refusal means the database answered, which is what was being
     * asked. Only a transport failure — project paused, DNS gone, credentials
     * rejected — counts as unreachable.
     */
    const code = result.error?.code;
    if (code && code !== "42501" && code !== "PGRST116") return "unreachable";

    return "ok";
  } catch {
    return "unreachable";
  }
}

export async function GET() {
  const database = await pingDatabase();

  return Response.json(
    {
      status: database === "unreachable" ? "degraded" : "ok",
      environment: serverEnv.NODE_ENV,
      database,
      timestamp: new Date().toISOString(),
    },
    {
      // 503 so a monitor notices without having to parse the body, and so a
      // platform health check fails rather than reporting a healthy instance
      // that cannot serve a single signed-in page.
      status: database === "unreachable" ? 503 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}
