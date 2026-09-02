/**
 * Loads `.env.local` for scripts that Next.js does not start.
 *
 * `npm run dev` and `npm run build` read `.env.local` because Next does it.
 * `node scripts/invite.mjs` does not — it is a plain Node process, so
 * `process.env.SUPABASE_SERVICE_ROLE_KEY` is simply undefined and the script
 * fails while telling you to put the value in the file it is not reading.
 *
 * `process.loadEnvFile` is Node's own reader (20.6+). Existing environment
 * variables win, so `SUPABASE_SERVICE_ROLE_KEY=... npm run invite -- ada`
 * still points at whatever you exported — which is how you run one of these
 * against production without editing a file.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export function loadEnvLocal() {
  for (const name of [".env.local", ".env"]) {
    const path = join(process.cwd(), name);
    if (!existsSync(path)) continue;

    try {
      process.loadEnvFile(path);
    } catch {
      // A malformed file should not take the script down with a stack trace;
      // the caller's own "did you set this?" message is the better error.
    }
    return name;
  }
  return null;
}
