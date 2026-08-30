#!/usr/bin/env node
/**
 * Scans the built client bundle for server-only secrets.
 *
 * `import "server-only"` already makes a client import of a secret module a
 * build failure, which catches the direct mistake. This catches the indirect
 * ones it cannot see: a secret interpolated into a string, read through a
 * dynamic `process.env` lookup, embedded in a prerendered payload, or leaked by
 * a dependency doing something unwise.
 *
 * Run it after `npm run build`, in CI, on every deploy. It is the last thing
 * standing between a bad refactor and publishing the database.
 *
 *     npm run build && npm run check:bundle
 *
 * A secret that is not set in the environment cannot be searched for, so it is
 * reported as skipped rather than passing quietly — "no secrets configured" and
 * "no secrets leaked" must never look the same.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/** Directories that are served to browsers. */
const CLIENT_DIRS = [".next/static"];

/** Every environment variable whose value must never reach a browser. */
const SECRET_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "TURN_SHARED_SECRET",
  "SMTP_PASSWORD",
];

/** Minimum length worth searching for — short values produce false positives. */
const MIN_SECRET_LENGTH = 12;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const present = [];
const skipped = [];

for (const name of SECRET_VARS) {
  const value = process.env[name];
  if (value && value.length >= MIN_SECRET_LENGTH) present.push({ name, value });
  else skipped.push(name);
}

if (present.length === 0) {
  console.log("check:bundle — no secrets set in this environment, nothing to scan.");
  console.log(`  skipped: ${skipped.join(", ")}`);
  console.log("  In CI this should scan at least SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(0);
}

let scanned = 0;
const leaks = [];

for (const dir of CLIENT_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    let contents;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue; // binary or unreadable — secrets are text
    }

    scanned += 1;

    for (const secret of present) {
      if (contents.includes(secret.value)) {
        leaks.push({ file: relative(ROOT, file), name: secret.name });
      }
    }
  }
}

console.log(`check:bundle — scanned ${scanned} files in ${CLIENT_DIRS.join(", ")}`);
console.log(`  searched for: ${present.map((s) => s.name).join(", ")}`);
if (skipped.length > 0) console.log(`  skipped (not set): ${skipped.join(", ")}`);

if (leaks.length > 0) {
  console.error("\n  SECRET FOUND IN THE CLIENT BUNDLE:\n");
  for (const leak of leaks) console.error(`    ${leak.name}  ->  ${leak.file}`);
  console.error("\n  Do not deploy this build. Rotate the affected credential and");
  console.error("  find the import path that pulled it into a client component.\n");
  process.exit(1);
}

console.log("  clean — no server-only secret appears in the client bundle.");
