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
  /** Canonical origin. Used for metadata, absolute links and (later) auth redirects. */
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
});

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Phase 2 adds SUPABASE_SERVICE_ROLE_KEY and friends here. They are validated
   * in this schema — never read straight off `process.env` at a call site.
   */
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

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
      `Invalid ${scope} environment variables:\n${detail}\n\nSee .env.example for the expected shape.`,
    );
  }

  return result.data;
}
