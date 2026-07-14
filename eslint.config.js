// ESLint exists here for type-aware rules that need the full TS type graph, which
// Biome 2.5 cannot do (it uses shallow inference). Biome remains the primary
// linter/formatter — do NOT add rules here that Biome already enforces; duplicating
// them makes two linters fight.
//
// A small set of NON-type-aware rules also live here because they have no Biome
// equivalent at all: max-lines-per-function, array-type (array-simple has no Biome
// mode), consistent-type-assertions, ban-ts-comment, and the eslint-comments
// disable-governance. They are grouped and labelled below.
import comments from "@eslint-community/eslint-plugin-eslint-comments";
import vitest from "@vitest/eslint-plugin";
import tsdoc from "eslint-plugin-tsdoc";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/worktrees/**",
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
    plugins: {
      "@eslint-community/eslint-comments": comments,
      tsdoc,
    },
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
      // Type-aware. strict-boolean forces explicit nullish/empty handling;
      // no-unnecessary-condition flags dead conditions — which here means either
      // genuine slop (redundant checks on non-nullable values) or a cast-lie
      // upstream that hid a real runtime check (fix the cast, not the guard).
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      // Type-aware correctness guards (Biome has no equivalent).
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/await-thenable": "error",
      // Catch callbacks bind their arg as `any` by default — the one any-hole the
      // no-unsafe-* family can't see. Force `unknown` so a `.catch(e => …)` must
      // narrow before use, same as a `try/catch` already does under our config.
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-misused-spread": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // Adding a union variant must break any switch meant to handle it. An
      // explicit `default` counts as exhaustive (intentional subset-dispatch over
      // a large event union stays clean); a switch that forgets a catch-all fails.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      // Type-aware clarity rules (Biome has no equivalent).
      // `||` vs `??` differ on 0/"" — force the explicit nullish intent.
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
      // Locks in already-practiced discipline: every exported function keeps its
      // explicit return type, so a future careless export cannot ship untyped.
      // Boundary-only — does NOT touch internal functions (that would be the
      // bloat we rejected in Biome's useExplicitType).
      "@typescript-eslint/explicit-module-boundary-types": "error",
      // Flags use of any `@deprecated`-tagged symbol (yours or upstream). Type-aware;
      // pairs with X1 (no deprecation scaffolding kept around).
      "@typescript-eslint/no-deprecated": "error",
      // A private class field never reassigned must be `readonly` (S2 immutability).
      "@typescript-eslint/prefer-readonly": "error",
      // Bans the genuinely-confusing `return voidCall()` form. Arrow-shorthand handlers
      // (`() => setState(x)`) are idiomatic here, so they stay allowed.
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      // Promise-returning functions are declared `async` (one shape for the reader).
      // Combinators (`new Promise`), memoized/single-flight closures, and union
      // returns carry a justified eslint-disable — these are NOT in the disable
      // governance list precisely because per-site exceptions are the design.
      "@typescript-eslint/promise-function-async": "error",
      // An `async` with no `await` must be intentional (interface conformance) and
      // say so via a justified disable; otherwise it is an accidental async.
      "@typescript-eslint/require-await": "error",

      // TSDoc comment syntax must parse — upstream of the api-extractor + typedoc gates.
      "tsdoc/syntax": "error",

      // --- Non-type-aware, but no Biome equivalent exists ---
      // Length signal: extract by responsibility when a function exceeds this,
      // do not compress. Complements Biome's cognitive-complexity gate, which a
      // long-but-flat function can pass.
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      // One array syntax: `T[]` for simple elements, `Array<T>` for complex.
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      // One index-collection syntax: `Record<K, V>`, never `{ [k: K]: V }`.
      "@typescript-eslint/consistent-indexed-object-style": ["error", "record"],
      // Ban `{...} as T` object-literal assertions (they silently skip excess-property
      // checks). Other assertion forms stay allowed — the codebase needs irreducible
      // boundary casts (TS compiler API, decorator machinery, generic erasure).
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
      // Ban silent ts-suppression directives; @ts-expect-error must carry a reason.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
      // Disable-governance: the critical correctness rules above cannot be silently
      // switched off, and any permitted disable must carry a reason. (Biome already
      // mandates a reason in its own `// biome-ignore lint/x: reason` syntax.)
      "@eslint-community/eslint-comments/no-restricted-disable": [
        "error",
        "@typescript-eslint/no-unsafe-assignment",
        "@typescript-eslint/no-unsafe-call",
        "@typescript-eslint/no-unsafe-member-access",
        "@typescript-eslint/no-unsafe-return",
        "@typescript-eslint/no-unsafe-argument",
        "@typescript-eslint/strict-boolean-expressions",
        "@typescript-eslint/no-unnecessary-condition",
        "@typescript-eslint/only-throw-error",
        "@typescript-eslint/await-thenable",
        "@typescript-eslint/use-unknown-in-catch-callback-variable",
        "@typescript-eslint/no-base-to-string",
        "@typescript-eslint/restrict-template-expressions",
        "@typescript-eslint/switch-exhaustiveness-check",
        "@typescript-eslint/explicit-module-boundary-types",
        "@typescript-eslint/no-deprecated",
      ],
      "@eslint-community/eslint-comments/require-description": [
        "error",
        { ignore: ["eslint-enable"] },
      ],
    },
  },
  {
    // Tests interface with `any`-typed mocks and vitest asymmetric matchers
    // (expect.stringContaining, etc.). The no-unsafe-* family guards production
    // type-flow; in tests it only flags idiomatic matcher usage. src stays strict.
    files: ["packages/*/test/**/*.ts", "packages/*/test/**/*.tsx"],
    plugins: { vitest },
    rules: {
      // Test-suite hygiene (no Biome equivalent). A committed `.only` silently
      // skips the rest of the file in CI — the highest-value catch here.
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/no-identical-title": "error",
      "vitest/valid-expect": "error",
      // valid-title intentionally omitted: it rejects computed `it(fixture.name)`
      // titles used by table-driven contract suites.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Tests favour expressiveness over the production-surface contracts: long
      // table-driven cases, inline return types, and ad-hoc disables are fine.
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/promise-function-async": "off",
      "@typescript-eslint/require-await": "off",
      "max-lines-per-function": "off",
      "@eslint-community/eslint-comments/no-restricted-disable": "off",
      "@eslint-community/eslint-comments/require-description": "off",
    },
  },
  {
    // React 19's `ReactNode` type includes `Promise<ReactNode>`, so every JSX-returning
    // render callback (`rows.map((r) => <Row/>)`) reads to the type checker as
    // "returns a promise" and trips promise-function-async. These are synchronous
    // render functions, not async — scope the rule off for the TUI render layer
    // (mirrors the TUI-specific relaxations already in biome.json).
    files: ["packages/unigent-cli/src/tui.tsx", "packages/unigent-cli/src/tui/**"],
    rules: {
      "@typescript-eslint/promise-function-async": "off",
    },
  },
);
