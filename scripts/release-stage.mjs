import { execFileSync } from "node:child_process";
import process from "node:process";
import { releasePackages, releaseVersion, repoRoot, run } from "./release-packages.mjs";

function isPublished(packageName) {
  try {
    const published = execFileSync(
      "npm",
      ["view", `${packageName}@${releaseVersion}`, "version", "--json", "--prefer-online"],
      { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
    );
    return JSON.parse(published) === releaseVersion;
  } catch {
    return false;
  }
}

try {
  run(process.execPath, ["scripts/sync-package-docs.mjs"]);
  for (const packageName of releasePackages) {
    if (isPublished(packageName)) {
      process.stdout.write(`stage: ${packageName}@${releaseVersion} already exists\n`);
      continue;
    }
    run("corepack", [
      "pnpm",
      "--config.node-linker=hoisted",
      "--filter",
      packageName,
      "publish",
      "--access",
      "public",
      "--tag",
      "next",
      "--no-git-checks",
    ]);
  }
} finally {
  run(process.execPath, ["scripts/sync-package-docs.mjs", "--clean"]);
}
