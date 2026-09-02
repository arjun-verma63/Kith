/**
 * Runs a Next command with a localhost origin allowed.
 *
 *     node scripts/local-production.mjs build
 *     node scripts/local-production.mjs start
 *
 * A production build refuses a loopback `NEXT_PUBLIC_SITE_URL`, because unset in
 * a real deployment it would mail every new member a confirmation link pointing
 * at the deploying machine (see src/lib/env/schema.ts).
 *
 * Smoke-testing a real bundle locally is a different thing, and localhost is the
 * correct origin for it. This sets the opt-out.
 *
 * ── Why `start` needs it too, which was not obvious ──────────────────────────
 *
 * `NEXT_PUBLIC_*` values are inlined into the CLIENT bundle at build time, so it
 * is tempting to think a build-time opt-out is enough. It is not: `env/client.ts`
 * parses at module scope on the SERVER as well, and `next start` re-reads
 * `process.env` at runtime. Without this, `npm run build:local` succeeded and
 * then every route 500'd — there was no way to run a local production server at
 * all, which the production smoke test found by failing against one.
 *
 * On Vercel neither opt-out applies: the real variable is present at build time
 * and at runtime, which is exactly the arrangement the guard is checking for.
 *
 * A script rather than an inline `VAR=1 next build`, because that syntax is a
 * shell feature and this project is developed on Windows.
 */

import { spawn } from "node:child_process";

const command = process.argv[2];

if (!["build", "start"].includes(command)) {
  console.error("Usage: node scripts/local-production.mjs <build|start>");
  process.exit(2);
}

const child = spawn("npx", ["next", command, ...process.argv.slice(3)], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, KITH_ALLOW_LOCAL_ORIGIN: "1" },
});

child.on("exit", (code) => process.exit(code ?? 1));
