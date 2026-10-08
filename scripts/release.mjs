import { spawnSync } from "node:child_process";
import process from "node:process";
import { releasePackages, releaseVersion, run } from "./release-packages.mjs";

const REGISTRY_ROOT = "https://registry.npmjs.org";
const STAGED_VERSION_TIMEOUT_MILLISECONDS = 15 * 60_000;
const STAGED_VERSION_POLL_MILLISECONDS = 10_000;
const STAGED_VERSION_CONFLICT_PATTERN = /previously staged version|cannot publish over/i;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchPackument(packageName) {
  const response = await fetch(
    `${REGISTRY_ROOT}/${encodeURIComponent(packageName)}?release=${releaseVersion}-${Date.now()}`,
    { cache: "no-store", headers: { accept: "application/json" } },
  );
  if (response.status === 404) {
    return;
  }
  if (!response.ok) {
    throw new Error(`registry lookup failed for ${packageName}: HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForStagedVersion(packageName) {
  const deadline = Date.now() + STAGED_VERSION_TIMEOUT_MILLISECONDS;
  while (true) {
    const packument = await fetchPackument(packageName);
    if (packument?.versions?.[releaseVersion] !== undefined) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `staged ${packageName}@${releaseVersion} did not become readable within 15 minutes`,
      );
    }
    await sleep(STAGED_VERSION_POLL_MILLISECONDS);
  }
}

async function publishPackage(packageName) {
  const result = spawnSync(
    "corepack",
    [
      "pnpm",
      "--config.node-linker=hoisted",
      "--filter",
      packageName,
      "publish",
      "--access",
      "public",
      "--tag",
      "latest",
      "--no-git-checks",
    ],
    { encoding: "utf8" },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status === 0) {
    return;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!STAGED_VERSION_CONFLICT_PATTERN.test(output)) {
    throw new Error(`publishing ${packageName}@${releaseVersion} failed`);
  }

  process.stdout.write(
    `publish: ${packageName}@${releaseVersion} is staged; waiting for registry processing\n`,
  );
  await waitForStagedVersion(packageName);
}

run("corepack", ["pnpm", "run", "build"]);
run("corepack", ["pnpm", "run", "package:check"]);

try {
  run(process.execPath, ["scripts/sync-package-docs.mjs"]);
  for (const packageName of releasePackages) {
    const packument = await fetchPackument(packageName);
    if (packument?.versions?.[releaseVersion] !== undefined) {
      process.stdout.write(`publish: ${packageName}@${releaseVersion} already exists\n`);
      continue;
    }
    await publishPackage(packageName);
  }
} finally {
  run(process.execPath, ["scripts/sync-package-docs.mjs", "--clean"]);
}

run(process.execPath, ["scripts/verify-release.mjs", "--latest"]);
