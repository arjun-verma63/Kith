import { z } from "zod";

/**
 * Environment schemas.
 *
 * Split by trust boundary, not by convenience:
 *   client — inlined into the browser bundle at build time. Public by definition.
 *   server — never leaves the server. Secrets live here and only here.
 *
 * Adding a variable means adding it in three places: here, in `.env.example`,
 * and in the Vercel project settings for each environment.
 */

export const clientEnvSchema = z.object({
  /** Canonical origin. Used for metadata, absolute links and auth redirects. */
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
});

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/* ========================================================================== */
/*  Supabase                                                                  */
/* ========================================================================== */

/**
 * Supabase credentials are validated separately and **lazily**, at the moment a
 * client is first constructed, rather than at module load.
 *
 * The reason is deliberate: the marketing route legitimately has no database in
 * it, and `npm run build` should not require a Supabase project to render a page
 * that never touches one. The schemas below are strict — nothing is optional —
 * only the *timing* is deferred. Anything that actually reaches for Supabase
 * fails immediately and says exactly which variable is missing.
 */

/**
 * Reads the `role` claim out of a legacy Supabase JWT key.
 *
 * Supabase issues two key formats: legacy JWTs (`eyJ...`, role in the payload)
 * and the newer prefixed keys (`sb_publishable_...` / `sb_secret_...`). This
 * handles the first; the prefix check handles the second.
 */
export function legacyKeyRole(key: string): string | null {
  const payload = key.split(".")[1];
  if (!payload) return null;

  try {
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as unknown;

    if (typeof json === "object" && json !== null && "role" in json) {
      const role = (json as { role: unknown }).role;
      return typeof role === "string" ? role : null;
    }
  } catch {
    // Not a JWT, or not one we can read. The prefix checks still apply.
  }

  return null;
}

/**
 * The single most damaging configuration mistake available in a Supabase app is
 * pasting the service-role key into `NEXT_PUBLIC_SUPABASE_ANON_KEY`. It works
 * perfectly — every query succeeds, because RLS is bypassed — and it publishes
 * full read/write access to the entire database in the browser bundle.
 *
 * Nothing about the app's behaviour would reveal it. So we refuse to boot.
 */
const publishableKey = z
  .string()
  .min(20, "Looks too short to be a Supabase key.")
  .refine((key) => !key.startsWith("sb_secret_"), {
    message:
      "This is a Supabase SECRET key. It must never be given to a NEXT_PUBLIC_ variable — that publishes it in the browser bundle. Use the publishable/anon key here.",
  })
  .refine((key) => legacyKeyRole(key) !== "service_role", {
    message:
      "This is the SERVICE ROLE key. It bypasses Row Level Security and must never be given to a NEXT_PUBLIC_ variable. Use the anon key here.",
  });

export const supabasePublicEnvSchema = z.object({
  /** Project API URL, e.g. https://abcdefgh.supabase.co */
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  /**
   * Publishable (anon) key. Safe in the browser **by design** — it carries no
   * privileges of its own. Row Level Security is what protects the data, which
   * is why every table gets a policy before it gets a feature.
   */
  NEXT_PUBLIC_SUPABASE_ANON_KEY: publishableKey,
});

export type SupabasePublicEnv = z.infer<typeof supabasePublicEnvSchema>;

/*
 * The service-role schema deliberately does NOT live here.
 *
 * A Zod schema is a top-level `z.object(...)` call, which a bundler must assume
 * is side-effectful and therefore cannot tree-shake. Anything defined in this
 * module ships to the browser, because `env/client.ts` imports from it. No key
 * value would leak — the value only exists in `process.env` on the server — but
 * shipping the secret variable's name and validation rules to every visitor is
 * pointless weight and the wrong instinct. It lives in `env/server.ts`, behind
 * `import "server-only"`, where it cannot follow anything into a browser.
 */

/* ========================================================================== */

/** Fails loudly and readably at boot rather than mysteriously at 2am. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: unknown,
  scope: string,
): z.infer<T> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid ${scope} environment variables:\n${detail}\n\nSee .env.example and docs/SUPABASE.md for where each credential belongs.`,
    );
  }

  return result.data;
}
