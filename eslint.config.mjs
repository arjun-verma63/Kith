import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Architectural boundaries.
 *
 * These are the import rules from docs/ARCHITECTURE.md, made mechanical. They are cheap
 * to enforce now and very expensive to retrofit once the dependency graph has set.
 */
const noDeepRelative = {
  group: ["../../*"],
  message: "Use the '@/' alias instead of reaching up more than one directory.",
};

/** Every vertical slice under src/features. Adding one means adding it here. */
const FEATURE_SLICES = [
  "auth",
  "calls",
  "friends",
  "landing",
  "messages",
  "notifications",
  "profile",
];

const noFeatureImports = {
  group: ["@/features", "@/features/*"],
  message:
    "Generic layers must not depend on feature slices — dependencies point inward (app -> features -> lib/components).",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"]),

  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-restricted-imports": ["error", { patterns: [noDeepRelative] }],
    },
  },

  {
    // Route files orchestrate; they never talk to a data provider directly.
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noDeepRelative,
            {
              group: ["@supabase/*"],
              message:
                "Do not use a Supabase client directly in a route. Go through @/lib/supabase or a feature slice.",
            },
          ],
        },
      ],
    },
  },

  /*
   * A feature never imports another feature.
   *
   * The README has claimed this since Phase 1 and it was quietly false: friends
   * reached into profile for presence, and three slices reached into auth for
   * form state. Both moved to `lib/`. Stating a boundary without enforcing it
   * just means finding out later that it never held.
   *
   * One config block per slice, because the rule has to allow a slice to import
   * ITSELF — and `no-restricted-imports` matches the specifier, not the importer,
   * so it cannot express "any feature but my own" in a single pattern. Adding a
   * slice means adding it here, which is the intended friction.
   */
  ...FEATURE_SLICES.map((slice) => ({
    files: [`src/features/${slice}/**/*.{ts,tsx}`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noDeepRelative,
            {
              // Every OTHER slice, listed explicitly. Negation patterns
              // (`!@/features/self/**`) do not reliably un-match here, and a
              // boundary that silently fails open is worse than none.
              group: FEATURE_SLICES.filter((other) => other !== slice).flatMap((other) => [
                `@/features/${other}`,
                `@/features/${other}/**`,
              ]),
              message:
                "A feature may not import another feature. Move the shared piece into lib/ or components/.",
            },
          ],
        },
      ],
    },
  })),

  {
    // Design-system primitives stay generic and reusable.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noDeepRelative, noFeatureImports] }],
    },
  },

  {
    // Build scripts and the database test suite. Their stdout is the deliverable,
    // not a stray debug statement, and neither runs inside the application.
    files: ["scripts/**/*.{mjs,js,ts}", "supabase/tests/**/*.{mjs,js}"],
    rules: {
      "no-console": "off",
    },
  },

  {
    // lib/ is the bottom of the stack.
    files: ["src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noDeepRelative,
            noFeatureImports,
            {
              group: ["@/components", "@/components/*"],
              message:
                "lib/ is UI-agnostic. Move anything that renders into components/ or a feature.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
