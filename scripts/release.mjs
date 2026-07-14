import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, arguments_) {
  execFileSync(command, arguments_, { cwd: repoRoot, stdio: "inherit" });
}

try {
  run("corepack", ["pnpm", "run", "build"]);
  run("corepack", ["pnpm", "run", "package:check"]);
  run(process.execPath, ["scripts/sync-package-docs.mjs"]);
  for (const packageName of ["@unigent/sdk", "@unigent/cli"]) {
    run("corepack", [
      "pnpm",
      "--config.node-linker=hoisted",
      "--filter",
      packageName,
      "publish",
      "--access",
      "public",
      "--no-git-checks",
    ]);
  }
} finally {
  run(process.execPath, ["scripts/sync-package-docs.mjs", "--clean"]);
}
