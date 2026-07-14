import process from "node:process";
import { run } from "./release-packages.mjs";

run("corepack", ["pnpm", "run", "build"]);
run("corepack", ["pnpm", "run", "package:check"]);
run(process.execPath, ["scripts/release-stage.mjs"]);
run(process.execPath, ["scripts/release-promote.mjs"]);
