import { defineConfig } from "vitest/config";

// One deterministic test graph across the workspace. Live backends and terminal
// rendering use their explicit root scripts.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
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
