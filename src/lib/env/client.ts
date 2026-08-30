import {
  clientEnvSchema,
  parseEnv,
  supabasePublicEnvSchema,
  type SupabasePublicEnv,
} from "./schema";

/**
 * Public environment. Safe to import from anywhere, including client components.
 *
 * Each variable must be referenced as a literal `process.env.NEXT_PUBLIC_*`
 * expression — Next.js performs a static text replacement at build time, so
 * dynamic lookups (`process.env[key]`) silently resolve to undefined in the browser.
 */
export const clientEnv = parseEnv(
  clientEnvSchema,
  {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  },
  "client",
);

let supabasePublicEnv: SupabasePublicEnv | undefined;

/**
 * Supabase's public credentials, validated on first use.
 *
 * Called by both the browser client and the cookie-bound server client, so the
 * "did you set this up?" error is identical wherever you hit it. Memoised: the
 * key-role checks in the schema decode a JWT, and there is no reason to do that
 * on every render.
 */
export function getSupabasePublicEnv(): SupabasePublicEnv {
  supabasePublicEnv ??= parseEnv(
    supabasePublicEnvSchema,
    {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    },
    "Supabase public",
  );

  return supabasePublicEnv;
}

/** True when Supabase is configured. For diagnostics — never for authorization. */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
