/**
 * `next build` with a localhost origin allowed.
 *
 * A production build refuses a loopback `NEXT_PUBLIC_SITE_URL`, because unset in
 * a real deployment it would mail every new member a confirmation link pointing
 * at the deploying machine (see src/lib/env/schema.ts).
 *
 * Building locally to smoke-test a real bundle is a different thing, and
 * `http://localhost:3000` is the correct origin for it. This sets the opt-out.
 *
 * A script rather than an inline `VAR=1 next build`, because that syntax is a
 * shell feature and this project is developed on Windows, where npm runs scripts
 * through cmd.
 *
 *     npm run build:local
 */

import { spawn } from "node:child_process";

const child = spawn("npx", ["next", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, KITH_ALLOW_LOCAL_ORIGIN: "1" },
});

child.on("exit", (code) => process.exit(code ?? 1));
