import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE_PREFIX = /^@/u;
const TYPESCRIPT_DECLARATION = /\.d\.ts(?:\.map)?$/u;
const packagesRoot = join(repoRoot, "packages");
const canonicalReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
const EXPECTED_PUBLIC_PACKAGES = [
  "@unigent/adapter-claude-cli",
  "@unigent/adapter-codex-cli",
  "@unigent/adapter-pi",
  "@unigent/cli",
  "@unigent/core",
  "@unigent/sdk",
  "@unigent/test",
];

function run(command, args, cwd = repoRoot) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function readManifest(directory) {
  return JSON.parse(readFileSync(join(repoRoot, directory, "package.json"), "utf8"));
}

const packageDirectories = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name))
  .filter((directory) => readManifest(directory).private !== true)
  .sort();

const publicPackages = packageDirectories.map((directory) => readManifest(directory).name).sort();
if (JSON.stringify(publicPackages) !== JSON.stringify(EXPECTED_PUBLIC_PACKAGES)) {
  throw new Error(
    `public package set must be ${EXPECTED_PUBLIC_PACKAGES.join(", ")}; received ${publicPackages.join(", ")}`,
  );
}

function archiveName(manifest) {
  const stem = manifest.name.replace(SCOPE_PREFIX, "").replace("/", "-");
  return `${stem}-${manifest.version}.tgz`;
}

function packedManifest(archive) {
  return JSON.parse(run("tar", ["-xOf", archive, "package/package.json"]));
}

function archiveEntries(archive) {
  return new Set(run("tar", ["-tf", archive]).trim().split("\n"));
}

function assertPackedDocumentation(archive, packageName) {
  const entries = archiveEntries(archive);
  for (const required of ["package/README.md", "package/LICENSE"]) {
    if (!entries.has(required)) {
      throw new Error(`${packageName} tarball is missing ${required.slice("package/".length)}`);
    }
  }
  const packedReadme = run("tar", ["-xOf", archive, "package/README.md"]);
  if (packedReadme !== canonicalReadme) {
    throw new Error(`${packageName} tarball README.md differs from the root README.md`);
  }
}

function assertPortableReadme() {
  const markdownTargets = [...canonicalReadme.matchAll(/!?\[[^\]]*\]\(([^)\s]+)[^)]*\)/gu)].map(
    (match) => match[1],
  );
  const htmlTargets = [...canonicalReadme.matchAll(/\b(?:href|src)="([^"]+)"/gu)].map(
    (match) => match[1],
  );
  const relativeTarget = [...markdownTargets, ...htmlTargets].find(
    (target) =>
      target !== undefined &&
      !target.startsWith("https://") &&
      !target.startsWith("http://") &&
      !target.startsWith("mailto:") &&
      !target.startsWith("#"),
  );
  if (relativeTarget !== undefined) {
    throw new Error(`README link is not portable to npm: ${relativeTarget}`);
  }
}

function assertCliArtifactProfile(archive) {
  const entries = archiveEntries(archive);
  const declarations = [...entries].filter(
    (entry) => entry.startsWith("package/dist/") && TYPESCRIPT_DECLARATION.test(entry),
  );
  if (declarations.length > 0) {
    throw new Error(`@unigent/cli publishes unused declarations: ${declarations.join(", ")}`);
  }
  const sourceMaps = [...entries].filter(
    (entry) => entry.startsWith("package/dist/") && entry.endsWith(".js.map"),
  );
  if (sourceMaps.length === 0) {
    throw new Error("@unigent/cli publishes no JavaScript source maps");
  }
  for (const sourceMap of sourceMaps) {
    const contents = JSON.parse(run("tar", ["-xOf", archive, sourceMap])).sourcesContent;
    if (
      !Array.isArray(contents) ||
      contents.length === 0 ||
      contents.some((content) => typeof content !== "string")
    ) {
      throw new Error(`${sourceMap} does not embed its TypeScript source`);
    }
  }
}

function assertPublishedManifest(manifest) {
  if (JSON.stringify(manifest).includes("workspace:")) {
    throw new Error(`${manifest.name} contains an unresolved workspace dependency`);
  }
  if ((manifest.bundledDependencies?.length ?? 0) > 0) {
    throw new Error(
      `${manifest.name} must use published dependencies instead of bundling packages`,
    );
  }
}

function assertReleasePolicy(manifests) {
  for (const manifest of manifests.values()) {
    if (manifest.type !== "module") {
      throw new Error(`${manifest.name} must remain ESM-only`);
    }
    if (typeof manifest.author !== "string" || manifest.author.includes("@")) {
      throw new Error(`${manifest.name} must publish an author name without an email address`);
    }
    if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
      throw new Error(`${manifest.name} must publish npm search keywords`);
    }
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      const internalManifest = manifests.get(dependency);
      if (internalManifest !== undefined && version !== internalManifest.version) {
        throw new Error(
          `${manifest.name} must pin ${dependency} to the exact release version ${internalManifest.version}`,
        );
      }
    }
  }
}

function installedPackagePath(root, name) {
  return join(root, "node_modules", ...name.split("/"));
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "unigent-package-contract-"));

try {
  assertPortableReadme();
  run(process.execPath, ["scripts/sync-package-docs.mjs"]);
  const archives = new Map();
  const manifests = new Map();
  for (const directory of packageDirectories) {
    const manifest = readManifest(directory);
    run(
      "corepack",
      ["pnpm", "--config.node-linker=hoisted", "pack", "--pack-destination", temporaryRoot],
      join(repoRoot, directory),
    );
    const archive = join(temporaryRoot, archiveName(manifest));
    if (!readdirSync(temporaryRoot).includes(archiveName(manifest))) {
      throw new Error(`pnpm pack did not create ${archive}`);
    }
    const publishedManifest = packedManifest(archive);
    assertPublishedManifest(publishedManifest);
    assertPackedDocumentation(archive, manifest.name);
    if (manifest.name === "@unigent/cli") {
      assertCliArtifactProfile(archive);
    }
    run("publint", [archive, "--strict"]);
    if (publishedManifest.exports !== undefined) {
      run("attw", [archive, "--profile", "esm-only"]);
    }
    archives.set(manifest.name, archive);
    manifests.set(manifest.name, publishedManifest);
  }
  assertReleasePolicy(manifests);

  const consumer = join(temporaryRoot, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');

  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      ...archives.values(),
      "typescript@5.9.3",
      "@types/node@24.13.2",
    ],
    consumer,
  );
  run("npm", ["install", "--no-audit", "--no-fund", "is-number@7.0.0"], consumer);

  writeFileSync(
    join(consumer, "index.mjs"),
    `import { agent, claudeCli, codexCli, done, piAgent } from "@unigent/sdk";
import { parseArgs } from "@unigent/sdk/args";
import { startMcpToolServer } from "@unigent/sdk/mcp";
import { createScriptedBackend } from "@unigent/sdk/test";
import { fail } from "@unigent/sdk/tools";
import { TraceProjection } from "@unigent/sdk/trace";

const values = [
  agent,
  parseArgs,
  startMcpToolServer,
  TraceProjection,
  createScriptedBackend,
];
if (values.some((value) => typeof value !== "function") || fail === undefined || done === undefined) {
  throw new Error("core facade exports are incomplete");
}
const names = [
  piAgent().name,
  claudeCli({ nativeTools: [] }).name,
  codexCli({ nativeTools: [] }).name,
];
if (names.join(",") !== "pi,claude-cli,codex-cli") {
  throw new Error(\`unexpected adapter names: \${names.join(",")}\`);
}
`,
  );

  run(process.execPath, ["index.mjs"], consumer);
  writeFileSync(
    join(consumer, "strict-consumer.ts"),
    `import { agent, type AgentRunResult } from "@unigent/sdk";
import { createScriptedBackend } from "@unigent/sdk/test";

const backend = createScriptedBackend([{ text: "typed-ok" }]);
const result: AgentRunResult<string> = await agent({
  name: "strict-consumer",
  backend,
  model: "fake",
}).run("offline");

if (result.output !== "typed-ok") {
  throw new Error(\`unexpected output: \${result.output}\`);
}
`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2024",
          types: ["node"],
        },
        files: ["strict-consumer.ts"],
      },
      undefined,
      2,
    )}\n`,
  );
  run(
    process.execPath,
    [join(installedPackagePath(consumer, "typescript"), "bin", "tsc")],
    consumer,
  );
  const cliManifest = manifests.get("@unigent/cli");
  if (cliManifest?.bin?.unigent !== "./dist/cli.js") {
    throw new Error("@unigent/cli does not publish the unigent executable");
  }
  const cliHelp = run(
    process.execPath,
    [join(installedPackagePath(consumer, "@unigent/cli"), "dist/cli.js"), "--help"],
    consumer,
  );
  if (!cliHelp.includes("unigent — run and inspect a Unigent script")) {
    throw new Error("packed @unigent/cli executable did not print its help");
  }

  const globalRoot = join(temporaryRoot, "global");
  mkdirSync(globalRoot);
  run("npm", [
    "install",
    "--global",
    "--prefix",
    globalRoot,
    "--no-audit",
    "--no-fund",
    ...archives.values(),
  ]);
  const globalCli = join(globalRoot, "bin", "unigent");
  if (run(globalCli, ["--version"], consumer).trim() !== cliManifest.version) {
    throw new Error("globally installed @unigent/cli reported the wrong version");
  }
  if (
    !run(globalCli, ["--help"], consumer).includes("unigent — run and inspect a Unigent script")
  ) {
    throw new Error("globally installed @unigent/cli did not print its help");
  }
  process.stdout.write(
    "package validation passed (publint, attw, strict consumer, repeat install, runtime, global CLI)\n",
  );
} finally {
  run(process.execPath, ["scripts/sync-package-docs.mjs", "--clean"]);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
