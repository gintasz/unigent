// Copies the canonical root README.md + LICENSE into every publishable package
// (default), or removes those copies (--clean). One source of truth: the repo root.
//
// Why not a per-package `prepack` hook? pnpm computes a package's publish file list
// BEFORE running prepack, so a prepack-generated README never lands in the tarball
// (LICENSE survives only via pnpm's always-bundle special case). So the copies must
// already exist when publish runs. This script is invoked by the `release` script
// (build -> sync -> pnpm publish -> sync --clean), not as a lifecycle hook.
// The copies are deliberately NOT gitignored: an ignore rule makes pnpm drop the
// README again, so they are removed by the --clean pass instead.

import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");
const clean = process.argv.includes("--clean");
const FILES = ["README.md", "LICENSE"];

for (const name of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, name, "package.json");
  if (!existsSync(manifestPath)) {
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private === true) {
    continue; // skip non-published packages (e.g. e2e)
  }
  for (const file of FILES) {
    const dest = join(packagesDir, name, file);
    if (clean) {
      rmSync(dest, { force: true });
    } else {
      copyFileSync(join(repoRoot, file), dest);
    }
  }
}
