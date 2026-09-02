/**
 * Lets a Next.js server action be imported outside Next.js.
 *
 * `alias-loader.mjs` resolves `@/` so the suites can import the shipped source.
 * That is enough for a pure module and not enough for a server action, which
 * imports `next/navigation` (whose `redirect` throws by design), the
 * cookie-bound Supabase client (which reads `cookies()`), and the service-role
 * client (which is `server-only` and demands a key that is not set in CI).
 *
 * Importing `actions.ts` therefore threw, which is why the file had no tests
 * despite being the front door to the whole application.
 *
 * This layers a small substitution on top: three specifiers resolve to doubles
 * in `stubs/`, and everything else — the zod schemas, the invite hashing, the
 * order of operations, every branch and every sentence shown to a person — is
 * the real file. The doubles record what they were called with, so a test can
 * assert that a password reset signs other devices out rather than asserting
 * that the source contains the string "signOut".
 *
 * Deliberately narrow. Substituting `@/features/auth/schema` would make the
 * tests pass while the real validation was broken, which is the failure mode
 * this whole approach exists to avoid — so only the three things that cannot
 * physically run here are replaced.
 */

import { existsSync } from "node:fs";
import { dirname, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolvePath(process.cwd(), "src");
const STUBS = resolvePath(process.cwd(), "supabase/tests/stubs");
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/**
 * The three that cannot run outside a request, and nothing else.
 *
 * `server-only` is a package whose entire job is to throw when imported from a
 * client bundle. Node has no opinion about bundles, but it also cannot resolve
 * the export map the package ships, so it is mapped to an empty module.
 */
const SUBSTITUTIONS = new Map([
  ["next/navigation", "next-navigation.mjs"],
  ["next/headers", "next-headers.mjs"],
  ["@/lib/supabase/server", "supabase-server.mjs"],
  ["@/lib/supabase/admin", "supabase-admin.mjs"],
  ["server-only", "empty.mjs"],
]);

function firstExisting(base) {
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  const substitute = SUBSTITUTIONS.get(specifier);
  if (substitute) {
    return nextResolve(pathToFileURL(resolvePath(STUBS, substitute)).href, context);
  }

  if (specifier.startsWith("@/")) {
    const found = firstExisting(resolvePath(SRC, specifier.slice(2)));
    if (found) return nextResolve(pathToFileURL(found).href, context);
    return nextResolve(specifier, context);
  }

  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !extname(specifier)) {
    const parent = context.parentURL;
    if (parent?.startsWith("file:")) {
      const base = resolvePath(dirname(fileURLToPath(parent)), specifier);
      const found = firstExisting(base);
      if (found) return nextResolve(pathToFileURL(found).href, context);
    }
  }

  return nextResolve(specifier, context);
}
