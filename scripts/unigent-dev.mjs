#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const cliSource = fileURLToPath(new URL("../packages/unigent-cli/src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const child = spawn(
  process.execPath,
  ["--import", tsxLoader, cliSource, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);

try {
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  });
  if (signal === null) {
    process.exitCode = code ?? 1;
  } else {
    process.kill(process.pid, signal);
  }
} catch (error) {
  process.stderr.write(
    `unigent: failed to start the development CLI: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
