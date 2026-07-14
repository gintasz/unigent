// Dependencies flow specific → generic. Unigent core imports no facade, harness, or CLI;
// adapters import no facade or frontend; packages use only public cross-package surfaces.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "No dependency cycles, ever (V1/V16).",
      from: {},
      to: { circular: true },
    },
    {
      name: "unigent-core-stays-generic",
      severity: "error",
      comment:
        "Unigent core must never import the facade, a harness adapter, or frontend (ID7/V1).",
      from: { path: "^packages/unigent-core/src" },
      to: {
        path: "^packages/unigent($|/)|^packages/unigent-(adapter-pi|adapter-claudecli|adapter-codexcli|cli)/",
      },
    },
    {
      name: "unigent-adapters-do-not-import-frontends",
      severity: "error",
      comment:
        "Unigent adapters translate harness events and never depend on the facade or a frontend (ID7/V1).",
      from: { path: "^packages/unigent-adapter-(pi|claudecli|codexcli)/src" },
      to: { path: "^packages/unigent($|/)|^packages/unigent-cli/" },
    },
    {
      name: "unigent-test-support-stays-generic",
      severity: "error",
      comment: "Reusable Unigent test fixtures depend only on the universal core (ID7/V1).",
      from: { path: "^packages/unigent-test/src" },
      to: {
        path: "^packages/unigent($|/)|^packages/unigent-(adapter-pi|adapter-claudecli|adapter-codexcli|cli)/",
      },
    },
    {
      name: "no-deep-cross-package-imports",
      severity: "error",
      comment: "Cross-package access is via the curated public surface only (J3/V16).",
      from: { path: "^packages/([^/]+)/src" },
      to: {
        path: "^packages/([^/]+)/src",
        pathNot: [
          "^packages/$1/src", // same package: fine
          "node_modules",
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(/dist/|\\.test\\.ts$)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types"] },
    includeOnly: "^packages/[^/]+/src/",
  },
};
