import { clientEnvSchema, parseEnv } from "./schema";

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
