#!/usr/bin/env node
/**
 * Fails if `src/types/database.ts` has drifted from the migrations.
 *
 * A stale generated type is worse than no generated type: it type-checks code
 * against a schema that no longer exists, so the compiler confidently approves a
 * query the database will reject. This runs in CI so drift is a red build rather
 * than a runtime error somebody finds later.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = "src/types/database.ts";
const before = readFileSync(TARGET, "utf8");

execFileSync(process.execPath, ["scripts/generate-database-types.mjs"], { stdio: "pipe" });

const after = readFileSync(TARGET, "utf8");

if (before !== after) {
  // Leave the working tree as it was; this script reports, it does not fix.
  writeFileSync(TARGET, before, "utf8");
  console.error(
    `\n${TARGET} is out of date with supabase/migrations/.\n` +
      "Run `npm run db:types` and commit the result.\n",
  );
  process.exit(1);
}

console.log(`${TARGET} is up to date with the migrations.`);
