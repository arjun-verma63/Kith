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
import { dirname, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolvePath(process.cwd(), "src");
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function firstExisting(base) {
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const found = firstExisting(resolvePath(SRC, specifier.slice(2)));
    if (found) return nextResolve(pathToFileURL(found).href, context);
    return nextResolve(specifier, context);
  }

  /*
   * Extensionless relative imports.
   *
   * `./schema` is valid TypeScript and the bundler resolves it; Node's ESM
   * resolver does not, so a module using one was simply not importable from a
   * test. Applying the same extension search here keeps the suites able to
   * exercise the shipped file rather than a copy of it — which is the whole
   * reason this loader exists.
   */
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
