/** `@unigent/sdk` — one typed API for the official Unigent harnesses. */

import { piAgent as createPiAgent } from "@unigent/adapter-pi";
import type { Backend } from "@unigent/core";

/** Pi machine-resource policy. Clean keeps auth/models/native tools but omits prompt/plugins/skills. */
type PiBase = "clean" | "machine";

/** Stable Pi configuration exposed by the harness-neutral SDK facade. */
interface PiAgentOptions {
  /** Resource baseline loaded from the machine. */
  readonly base?: PiBase;
  /** Native Pi tools to expose; an empty list disables all native tools. */
  readonly nativeTools?: readonly string[];
  /** Machine plugin names to load. */
  readonly plugins?: readonly string[];
  /** Machine skill names to load. */
  readonly skills?: readonly string[];
  /** System prompt prepended before Unigent's run prompt. */
  readonly basePrompt?: string;
  /** Explicit identity for checkpoint invalidation when injected resources change. */
  readonly checkpointKey?: string;
}

/** Create the Pi backend without leaking Pi vendor types through the SDK declaration surface. */
function piAgent(options: PiAgentOptions = {}): Backend {
  return createPiAgent(options);
}

export type { ClaudeBase, ClaudeCliOptions } from "@unigent/adapter-claude-cli";
export { claudeCli } from "@unigent/adapter-claude-cli";
export type { CodexBase, CodexCliOptions } from "@unigent/adapter-codex-cli";
export { codexCli } from "@unigent/adapter-codex-cli";
export type {
  Agent,
  AgentEvent,
  AgentLimits,
  AgentOptions,
  AgentOverrides,
  AgentRun,
  AgentRunResult,
  AgentScope,
  AgentScopeOptions,
  AgentSession,
  AgentTool,
  AgentTrace,
  AgentUsage,
  Backend,
  BackendCapabilities,
  BackendEvent,
  BackendSession,
  BackendSessionOptions,
  BackendTool,
  BackendToolResult,
  BackendTurnRequest,
  BackendTurnResult,
  BackendUsage,
  CheckpointRecord,
  CheckpointStore,
  CheckpointValue,
  Done,
  Duration,
  EventEnvelope,
  JsonSchema,
  OutputSchema,
  SourceToolFunction,
  SystemPrompt,
  ToolDefinition,
  ToolOptions,
} from "@unigent/core";
export {
  AgentBackendError,
  AgentBackendRejectedError,
  AgentBackendUnavailableError,
  AgentBudgetExceededError,
  AgentCancelledError,
  AgentConcurrencyError,
  AgentConfigError,
  AgentError,
  AgentInputError,
  AgentRaisedError,
  AgentRepairExhaustedError,
  AgentTimeoutError,
  agent,
  combineUsage,
  createFileCheckpointStore,
  createMemoryCheckpointStore,
  done,
  tool,
} from "@unigent/core";
export type { ArgsOptions, InputPair } from "@unigent/core/args";
export { args, parseArgs } from "@unigent/core/args";
export type { FailTool } from "@unigent/core/tools";
export { fail } from "@unigent/core/tools";
export type { PiAgentOptions, PiBase };
export { piAgent };
