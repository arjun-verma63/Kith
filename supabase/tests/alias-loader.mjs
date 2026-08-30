/**
 * Resolves the `@/` path alias for the test suites.
 *
 * The alternative is a `tsconfig` alias that only TypeScript understands, and
 * tests that import a hand-copied duplicate of the module they claim to test —
 * which passes happily while the real file is broken. This maps `@/x` to
 * `src/x` exactly as the bundler does, so the suites exercise the shipped code.
 *
 * Registered by harness.mjs before any dynamic import runs.
 */

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = resolvePath(process.cwd(), "src");
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  const base = resolvePath(SRC, specifier.slice(2));

  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) {
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  }

  return nextResolve(specifier, context);
}
