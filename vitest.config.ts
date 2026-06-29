import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// One test graph across the workspace (L1). The default transformer (oxc) does
// not lower TC39 decorators, so SWC transforms test/source files — @foom.config /
// @foom.expose rely on standard decorators + addInitializer. The deterministic
// suite excludes e2e.test.ts (real-LLM, run via test:e2e); see Q2.
export default defineConfig({
  // SWC owns the transform; disable the default Oxc transform to avoid double work.
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { decoratorVersion: "2022-03" },
        target: "es2022",
        keepClassNames: true,
      },
    }),
  ],
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    testTimeout: 15_000,
    coverage: {
      // Report-only (not a gate): prints a text summary to stdout, writes nothing
      // to disk, and never fails the build. To turn it back into a ratchet gate,
      // add a `thresholds` block (e.g. statements/branches/functions/lines floors
      // just below current) — vitest then exits non-zero when coverage drops.
      provider: "v8",
      include: ["packages/*/src/**"],
      exclude: ["**/*.d.ts"],
      reporter: ["text-summary"],
    },
  },
});
