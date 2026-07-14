import { type ChildProcessByStdio, spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import { Readable, type Writable } from "node:stream";

const MAXIMUM_STDERR_CHARACTERS = 65_536;

/** Settlement metadata for a harness CLI child process. */
interface AdapterProcessCompletion {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Harness CLI process with replay-safe diagnostics and explicit lifecycle control. */
interface AdapterProcess {
  readonly lines: AsyncIterable<string>;
  readonly stderr: () => string;
  readonly completion: Promise<AdapterProcessCompletion>;
  readonly kill: () => void;
}

/** Complete launch request for a harness CLI child process. */
interface AdapterProcessOptions {
  readonly binary: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly stdin: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** Spawn one harness CLI with bounded stderr and a completion signal that waits for pipe closure. */
function spawnAdapterProcess(options: AdapterProcessOptions): AdapterProcess {
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  let stderr = "";
  try {
    child = spawn(options.binary, [...options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
      // biome-ignore lint/style/noProcessEnv: child must inherit the authenticated CLI environment.
      env: { ...process.env, ...options.environment },
    });
    child.stdin.end(options.stdin);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      lines: createInterface({ input: Readable.from([]) }),
      stderr: () => message,
      completion: Promise.resolve({ exitCode: null, signal: null }),
      kill: () => undefined,
    };
  }
  const appendStderr = (text: string): void => {
    stderr = `${stderr}${text}`.slice(-MAXIMUM_STDERR_CHARACTERS);
  };
  child.on("error", (error) => appendStderr(error.message));
  child.stderr.on("data", (chunk: Buffer) => appendStderr(chunk.toString()));
  const completion = new Promise<AdapterProcessCompletion>((resolve) => {
    child.once("close", (exitCode, closeSignal) => resolve({ exitCode, signal: closeSignal }));
  });
  return {
    lines: createInterface({ input: child.stdout }),
    stderr: () => stderr,
    completion,
    kill: (): void => {
      child.kill();
    },
  };
}

export type { AdapterProcess, AdapterProcessCompletion, AdapterProcessOptions };
export { spawnAdapterProcess };
