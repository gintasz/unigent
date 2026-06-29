// Architecture rules (A3/A4/F6/F8/Q4). Dependencies flow specific → generic;
// the generic core never imports a harness or the cli; no cycles; no deep
// imports into another package's internals (cross-package only via dist barrel).
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "No dependency cycles, ever (A3).",
      from: {},
      to: { circular: true },
    },
    {
      name: "core-stays-generic",
      severity: "error",
      comment: "The generic core must never import an adapter or a frontend (A3/F6).",
      from: { path: "^packages/microfoom-core/src" },
      to: {
        path: "^packages/(adapter-base|pi-adapter|claudecli-adapter|codexcli-adapter|microfoom-cli)/",
      },
    },
    {
      name: "adapter-base-stays-generic",
      severity: "error",
      comment:
        "The shared adapter base must not import a concrete adapter or the cli — only core (A3).",
      from: { path: "^packages/adapter-base/src" },
      to: { path: "^packages/(pi-adapter|claudecli-adapter|codexcli-adapter|microfoom-cli)/" },
    },
    {
      name: "no-adapter-importing-cli",
      severity: "error",
      comment: "The pi harness adapter must not depend on the cli frontend (A3).",
      from: { path: "^packages/pi-adapter/src" },
      to: { path: "^packages/microfoom-cli/" },
    },
    {
      name: "core-not-depend-on-trace",
      severity: "error",
      comment: "The core must not import the opt-in trace surface (F8).",
      from: {
        path: "^packages/microfoom-core/src",
        pathNot: "^packages/microfoom-core/src/trace/",
      },
      to: { path: "^packages/microfoom-core/src/trace/" },
    },
    {
      name: "no-deep-cross-package-imports",
      severity: "error",
      comment:
        "Cross-package access is via the public surface only — no reaching into another package's src (A4).",
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
