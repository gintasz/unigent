import process from "node:process";
import {
  type AdapterProcess,
  type AdapterProcessCompletion,
  spawnAdapterProcess,
} from "@unigent/core";

/** Running Claude subprocess. */
export type ClaudeProcess = AdapterProcess;

/** Settlement metadata for a Claude subprocess. */
export type ClaudeProcessCompletion = AdapterProcessCompletion;

/** Injectable process launcher used by integration tests. */
export type ClaudeProcessFactory = (
  args: readonly string[],
  signal: AbortSignal,
  prompt: string,
  environment: Readonly<Record<string, string>>,
) => ClaudeProcess;

/** Launch Claude and expose its stream-json stdout as lines. */
export function spawnClaude(
  args: readonly string[],
  signal: AbortSignal,
  prompt: string,
  environment: Readonly<Record<string, string>>,
  binary = process.platform === "win32" ? "claude.cmd" : "claude",
): ClaudeProcess {
  return spawnAdapterProcess({ binary, args, signal, stdin: prompt, environment });
}
