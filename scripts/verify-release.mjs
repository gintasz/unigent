import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { releasePackages, releaseVersion, run } from "./release-packages.mjs";

const REGISTRY_ROOT = "https://registry.npmjs.org";
const PROPAGATION_TIMEOUT_MILLISECONDS = 60_000;
const PROPAGATION_POLL_MILLISECONDS = 5000;
const RELEASE_AGE_CLOCK_SKEW_MILLISECONDS = 5000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchPackument(packageName) {
  const cacheBuster = `${releaseVersion}-${Date.now()}`;
  const response = await fetch(
    `${REGISTRY_ROOT}/${encodeURIComponent(packageName)}?release=${cacheBuster}`,
    {
      cache: "no-store",
      headers: { accept: "application/json" },
    },
  );
  if (!response.ok) {
    return;
  }
  return response.json();
}

async function waitForManifests() {
  const deadline = Date.now() + PROPAGATION_TIMEOUT_MILLISECONDS;
  while (true) {
    const packuments = await Promise.all(releasePackages.map(fetchPackument));
    const manifests = packuments.map((packument) => packument?.versions?.[releaseVersion]);
    if (manifests.every((manifest) => manifest !== undefined)) {
      return new Map(releasePackages.map((packageName, index) => [packageName, manifests[index]]));
    }
    if (Date.now() >= deadline) {
      const missing = releasePackages.filter((_, index) => manifests[index] === undefined);
      throw new Error(`registry propagation timed out for ${missing.join(", ")}`);
    }
    await sleep(PROPAGATION_POLL_MILLISECONDS);
  }
}

async function waitForLatestTags() {
  const deadline = Date.now() + PROPAGATION_TIMEOUT_MILLISECONDS;
  while (true) {
    const packuments = await Promise.all(releasePackages.map(fetchPackument));
    const current = packuments.map((packument) => packument?.["dist-tags"]?.latest);
    if (current.every((version) => version === releaseVersion)) {
      return;
    }
    if (Date.now() >= deadline) {
      const stale = releasePackages.filter((_, index) => current[index] !== releaseVersion);
      throw new Error(`latest tag propagation timed out for ${stale.join(", ")}`);
    }
    await sleep(PROPAGATION_POLL_MILLISECONDS);
  }
}

function assertManifestGraph(manifests) {
  const internalPackages = new Set(releasePackages);
  for (const [packageName, manifest] of manifests) {
    if (manifest.version !== releaseVersion) {
      throw new Error(`${packageName} published ${manifest.version}; expected ${releaseVersion}`);
    }
    if ((manifest.bundledDependencies?.length ?? 0) > 0) {
      throw new Error(`${packageName} published bundled dependencies`);
    }
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (internalPackages.has(dependency) && version !== releaseVersion) {
        throw new Error(
          `${packageName} depends on ${dependency}@${version}; expected ${releaseVersion}`,
        );
      }
    }
  }
}

function writeConsumerFiles(consumer) {
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  writeFileSync(
    join(consumer, "runtime-smoke.mjs"),
    `import assert from "node:assert/strict";
import { agent, claudeCli, codexCli, piAgent } from "unigent-sdk";
import { createScriptedBackend } from "unigent-sdk/test";

const backend = createScriptedBackend([{ text: "offline-ok" }]);
const result = await agent({ name: "registry-smoke", backend, model: "fake" }).run("offline");
assert.equal(result.output, "offline-ok");
assert.equal(backend.requests.length, 1);
assert.equal(piAgent().name, "pi");
assert.equal(claudeCli({ nativeTools: [] }).name, "claude-cli");
assert.equal(codexCli({ nativeTools: [] }).name, "codex-cli");
`,
  );
  writeFileSync(
    join(consumer, "strict-consumer.ts"),
    `import { agent, type AgentRunResult } from "unigent-sdk";
import { createScriptedBackend } from "unigent-sdk/test";

const backend = createScriptedBackend([{ text: "typed-ok" }]);
const result: AgentRunResult<string> = await agent({
  name: "strict-registry-smoke",
  backend,
  model: "fake",
}).run("offline");
if (result.output !== "typed-ok") throw new Error(\`unexpected output: \${result.output}\`);
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
}

function verifyConsumerInstall(releaseRoot, verifyLatest) {
  const consumer = join(releaseRoot, "consumer");
  const npmCache = join(releaseRoot, "npm-cache");
  mkdirSync(consumer);
  writeConsumerFiles(consumer);
  run(
    "npm",
    [
      "install",
      "--cache",
      npmCache,
      "--min-release-age=0",
      "--no-fund",
      "--prefer-online",
      "--save-exact",
      verifyLatest ? "unigent-sdk" : `unigent-sdk@${releaseVersion}`,
      "typescript@5.9.3",
      "@types/node@24.13.2",
    ],
    { cwd: consumer },
  );
  const installedSdk = JSON.parse(
    readFileSync(join(consumer, "node_modules", "unigent-sdk", "package.json"), "utf8"),
  );
  if (installedSdk.version !== releaseVersion) {
    throw new Error(`installed SDK is ${installedSdk.version}; expected ${releaseVersion}`);
  }
  run(
    "npm",
    [
      "install",
      "--cache",
      npmCache,
      "--min-release-age=0",
      "--no-fund",
      "--prefer-online",
      "is-number@7.0.0",
    ],
    { cwd: consumer },
  );
  run(process.execPath, ["runtime-smoke.mjs"], { cwd: consumer });
  run(process.execPath, [join(consumer, "node_modules", "typescript", "bin", "tsc")], {
    cwd: consumer,
  });
  run("npm", ["audit", "--audit-level=high"], { cwd: consumer });
}

function verifyGlobalCli(releaseRoot, verifyLatest) {
  const globalRoot = join(releaseRoot, "global");
  const npmCache = join(releaseRoot, "npm-cache");
  mkdirSync(globalRoot);
  run("npm", [
    "install",
    "--cache",
    npmCache,
    "--global",
    "--prefix",
    globalRoot,
    "--min-release-age=0",
    "--no-fund",
    "--prefer-online",
    verifyLatest ? "unigent-cli" : `unigent-cli@${releaseVersion}`,
  ]);
  const executable = join(globalRoot, "bin", "unigent");
  const version = run(executable, ["--version"], { stdio: "pipe" }).trim();
  if (version !== releaseVersion) {
    throw new Error(`global CLI reported ${version}; expected ${releaseVersion}`);
  }
  const help = run(executable, ["--help"], { stdio: "pipe" });
  if (!help.includes("unigent — run and inspect a Unigent script")) {
    throw new Error("global CLI help smoke failed");
  }
}

async function retryFreshCacheVerification(releaseRoot, label, operation) {
  const deadline = Date.now() + PROPAGATION_TIMEOUT_MILLISECONDS;
  while (true) {
    const attemptRoot = mkdtempSync(join(releaseRoot, `${label}-`));
    try {
      operation(attemptRoot);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      process.stdout.write(
        `${label} verification has not propagated; retrying with a fresh cache\n`,
      );
      await sleep(PROPAGATION_POLL_MILLISECONDS);
    } finally {
      rmSync(attemptRoot, { recursive: true, force: true });
    }
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "unigent-registry-release-"));
try {
  const verifyLatest = process.argv.includes("--latest");
  if (verifyLatest) {
    await waitForLatestTags();
  }
  const manifests = await waitForManifests();
  assertManifestGraph(manifests);
  await sleep(RELEASE_AGE_CLOCK_SKEW_MILLISECONDS);
  await retryFreshCacheVerification(temporaryRoot, "consumer install", (attemptRoot) =>
    verifyConsumerInstall(attemptRoot, verifyLatest),
  );
  await retryFreshCacheVerification(temporaryRoot, "global CLI install", (attemptRoot) =>
    verifyGlobalCli(attemptRoot, verifyLatest),
  );
  process.stdout.write(
    `${verifyLatest ? "latest" : "exact"} registry verification passed for ${releaseVersion}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
