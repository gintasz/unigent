import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { buildVibeRunConfig, parseDecoratorsForFunction } from "thoughtcode-core";

// The decorator registry + config building now live in thoughtcode-core (pure). This module keeps only
// the file-reading resolver and re-exports the pure helpers for back-compat.
export { DECORATOR_REGISTRY, buildVibeRunConfig, type VibeRunConfig } from "thoughtcode-core";

export type ResolvedDecorators =
  | { status: "ok"; config: import("thoughtcode-core").VibeRunConfig }
  | { status: "invalid"; errors: string[] }
  | { status: "unreadable" };

/** Read the program file and resolve a VIBEFUNCTION's decorators into a validated run config. */
export async function resolveDecorators(
  programFilePath: string,
  functionName: string,
  cwd: string | undefined,
): Promise<ResolvedDecorators> {
  let text: string;
  try {
    const absolute = isAbsolute(programFilePath) ? programFilePath : resolve(cwd ?? process.cwd(), programFilePath);
    text = await readFile(absolute, "utf8");
  } catch {
    return { status: "unreadable" };
  }
  const parsed = parseDecoratorsForFunction(text, functionName);
  if (parsed.errors.length > 0) {
    return { status: "invalid", errors: parsed.errors };
  }
  const built = buildVibeRunConfig(parsed.decorators);
  if (built.errors.length > 0) {
    return { status: "invalid", errors: built.errors };
  }
  return { status: "ok", config: built.config };
}
