import "server-only";

import { z } from "zod";

import { legacyKeyRole, parseEnv, serverEnvSchema } from "./schema";

/**
 * Private environment.
 *
 * The `server-only` import above is the guard: if any client component ever
 * imports this module — directly or through a chain — the build fails instead
 * of quietly shipping a secret to the browser. Every module that touches a
 * secret (the Supabase admin client, the TURN credential minter) starts with
 * that same line.
 */
export const serverEnv = parseEnv(serverEnvSchema, process.env, "server");

export const isProduction = serverEnv.NODE_ENV === "production";
export const isDevelopment = serverEnv.NODE_ENV === "development";

/**
 * Service role key. Bypasses Row Level Security completely.
 *
 * Defined in this module rather than alongside the public schema because Zod
 * schemas cannot be tree-shaken — anything in the shared schema file ends up in
 * the browser bundle. Behind `server-only`, it cannot.
 */
const secretKey = z
  .string()
  .min(20, "Looks too short to be a Supabase key.")
  .refine((key) => !key.startsWith("sb_publishable_"), {
    message: "This is the publishable key. The service-role/secret key is required here.",
  })
  .refine((key) => legacyKeyRole(key) !== "anon", {
    message: "This is the anon key. The service-role key is required here.",
  });

export const supabaseSecretEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: secretKey,
});

export type SupabaseSecretEnv = z.infer<typeof supabaseSecretEnvSchema>;

let supabaseSecretEnv: SupabaseSecretEnv | undefined;

/**
 * The service-role key, validated on first use.
 *
 * Reached only by `lib/supabase/admin.ts`. If you find yourself calling this
 * from anywhere else, the thing you are about to write almost certainly belongs
 * behind a Row Level Security policy instead.
 */
export function getSupabaseSecretEnv(): SupabaseSecretEnv {
  supabaseSecretEnv ??= parseEnv(
    supabaseSecretEnvSchema,
    {
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
    "Supabase secret",
  );

  return supabaseSecretEnv;
}
