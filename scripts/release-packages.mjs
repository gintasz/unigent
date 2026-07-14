import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const releasePackages = [
  "@unigent/core",
  "@unigent/test",
  "@unigent/adapter-claude-cli",
  "@unigent/adapter-codex-cli",
  "@unigent/adapter-pi",
  "@unigent/sdk",
  "@unigent/cli",
];

const releaseVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

function run(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
}

export { releasePackages, releaseVersion, repoRoot, run };
