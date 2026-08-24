import "server-only";

import { parseEnv, serverEnvSchema } from "./schema";

/**
 * Private environment.
 *
 * The `server-only` import above is the guard: if any client component ever
 * imports this module — directly or through a chain — the build fails instead
 * of quietly shipping a secret to the browser. Every future module that touches
 * a secret (the Supabase admin client, the TURN credential minter) starts with
 * that same line.
 */
export const serverEnv = parseEnv(serverEnvSchema, process.env, "server");

export const isProduction = serverEnv.NODE_ENV === "production";
export const isDevelopment = serverEnv.NODE_ENV === "development";
