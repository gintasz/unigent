import { open } from "node:fs/promises";

const SHEBANG_READ_BYTES = 256;
const BUN_SHEBANG = /^#!\s*(?:\/usr\/bin\/env(?:\s+-S)?\s+)?(?:\S*\/)?bun(?:\s|$)/u;
const LINE_BREAK = /\r?\n/u;

type ScriptRuntime = "bun" | "node";

interface RuntimeInvocation {
  readonly kind: ScriptRuntime;
  readonly executable: string;
  readonly arguments: readonly string[];
}

async function detectScriptRuntime(sourceFile: string): Promise<ScriptRuntime> {
  const file = await open(sourceFile, "r").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`script file not found: ${sourceFile}`, { cause: error });
    }
    throw error;
  });
  try {
    const buffer = Buffer.alloc(SHEBANG_READ_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const sourceStart = buffer.toString("utf8", 0, bytesRead);
    const [firstLine = ""] = sourceStart.split(LINE_BREAK, 1);
    return BUN_SHEBANG.test(firstLine) ? "bun" : "node";
  } finally {
    await file.close();
  }
}

function runtimeInvocation(
  runtime: ScriptRuntime,
  nodeExecutable: string,
  typescriptLoader: string,
): RuntimeInvocation {
  return runtime === "bun"
    ? { kind: runtime, executable: "bun", arguments: ["--install=fallback"] }
    : {
        kind: runtime,
        executable: nodeExecutable,
        arguments: ["--import", typescriptLoader],
      };
}

export type { RuntimeInvocation, ScriptRuntime };
export { detectScriptRuntime, runtimeInvocation };
