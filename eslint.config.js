// ESLint exists here for ONE job: the type-aware `no-unsafe-*` family that Biome
// 2.5 cannot do (Biome uses shallow inference; these need the full TS type graph).
// Biome remains the primary linter/formatter — do NOT add stylistic, complexity,
// promise, or import rules here; those are Biome's and duplicating them makes two
// linters fight. This is a thin type-flow safety net, run in pre-push (it builds
// the type graph and is too slow for pre-commit).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "docs-website/**",
      "examples/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
    ],
  },
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    // base registers the parser + plugin with NO rules, so we opt in explicitly.
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        // Explicit project list (not projectService): test files live only in
        // tsconfig.test.json, a non-standard name projectService won't discover.
        project: ["./packages/*/tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
    },
  },
);
