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

  {
    // Design-system primitives stay generic and reusable.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noDeepRelative, noFeatureImports] }],
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
