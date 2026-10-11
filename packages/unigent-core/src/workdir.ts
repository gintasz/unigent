import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { AgentConfigError } from "./errors.js";

/** Resolve and validate an adapter working directory once during setup. */
function resolveWorkdir(workdir: string | undefined): string {
  if (workdir !== undefined && workdir.trim().length === 0) {
    throw new AgentConfigError("workdir must be non-empty");
  }
  const resolved = resolve(workdir ?? process.cwd());
  let canonical: string;
  let isDirectory: boolean;
  try {
    canonical = realpathSync(resolved);
    isDirectory = statSync(canonical).isDirectory();
  } catch (error) {
    throw new AgentConfigError(`workdir is not accessible: ${resolved}`, { cause: error });
  }
  if (!isDirectory) {
    throw new AgentConfigError(`workdir is not a directory: ${canonical}`);
  }
  return canonical;
}

export { resolveWorkdir };
