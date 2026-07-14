import { execFileSync } from "node:child_process";
import process from "node:process";
import { releasePackages, releaseVersion, repoRoot, run } from "./release-packages.mjs";

run(process.execPath, ["scripts/verify-release.mjs"]);

for (const packageName of releasePackages) {
  run("npm", ["dist-tag", "add", `${packageName}@${releaseVersion}`, "latest"]);
}

for (const packageName of releasePackages) {
  const latest = execFileSync("npm", ["view", packageName, "dist-tags.latest", "--prefer-online"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (latest !== releaseVersion) {
    throw new Error(`${packageName} latest is ${latest}; expected ${releaseVersion}`);
  }
}
