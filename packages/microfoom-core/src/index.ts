// Public surface of the microfoom generic core (harness-agnostic). One curated
// barrel (A2) — `export *` is banned (L3); re-exports are explicit.

/**
 * `@microfoom/core` — typed building blocks for coordination engineering:
 * coordination a single prompt can't express. Your TypeScript owns the control
 * flow; the model is invoked only for the genuinely fuzzy parts.
 *
 * Write a program by extending {@link Program} and driving `this.agent`
 * ({@link AgentRun}: `do` / `prose` / `value`); expose methods to the agent with
 * {@link foom}; run it with {@link runProgram}. Failures surface as the
 * {@link FoomError} taxonomy.
 *
 * @packageDocumentation
 */

/** The version of `@microfoom/core` this build was published at. */
export const CORE_VERSION = "0.1.0";

// Config + options
export type { AgentConfig, Duration, SystemPrompt, ThinkingLevel } from "./config.js";
export { durationToMs, mergeConfig, mergeConfigChain } from "./config.js";
// Decorators
export type {
  AgentClassDecorator,
  AgentConfigDecorator,
  AgentDecorator,
  AgentDecorators,
  AgentExposeDecorator,
  AgentMethodDecorator,
} from "./decorators.js";
export { foom } from "./decorators.js";
// Error taxonomy (F7)
export type { FoomErrorOptions, RepairChannel } from "./errors.js";
export {
  FoomAbortError,
  FoomBudgetExceededError,
  FoomCallDepthError,
  FoomCancelledError,
  FoomConcurrencyError,
  FoomConfigError,
  FoomDispatchError,
  FoomError,
  FoomHarnessError,
  FoomHarnessRejectedError,
  FoomHarnessUnavailableError,
  FoomInputError,
  FoomRepairExhaustedError,
  FoomThrowError,
  FoomTimeoutError,
  FoomTokenLimitExceededError,
} from "./errors.js";
// Run events (the AgentEvent payload of RunProgramOptions.onEvent)
export type { AgentEvent } from "./events.js";
export type {
  AgentCancellation,
  AgentExposeOptions,
  AgentOptions,
  AgentRunHooks,
  AgentStoreOptions,
  AgentToolOptions,
  AgentTurnMeta,
  LLMToken,
} from "./options.js";
// Program + run context
export type {
  AgentDoTemplate,
  AgentProgramContext,
  AgentProseTemplate,
  AgentRun,
  AgentSession,
  AgentValueTemplate,
  RunProgramOptions,
} from "./program.js";
export { attachContext, FoomProgram, Program, runProgram } from "./program.js";
// Protocol (control-tool names, for harness/tooling authors)
export type { ControlToolName } from "./protocol.js";
export { CONTROL_TOOLS, isControlTool } from "./protocol.js";
// Results
export type { AgentResult, AgentTextStream } from "./result.js";
// Parameter-schema derivation (ADR-0003)
export type { DerivedParameters } from "./schema_derive.js";
export { deriveMethodParameters, deriveProgramInput } from "./schema_derive.js";
// Harness session contract (for harness authors)
export type {
  HarnessSession,
  HarnessSessionOptions,
  JsonSchema,
  NeutralToolDef,
  OpenSession,
  SessionTurnRequest,
  SessionTurnResult,
  StreamEvent,
  ToolExecResult,
  UsageDelta,
} from "./session.js";
// Standard Schema helper (build a validator without committing to a vendor)
export { makeStandardSchema } from "./standard_schema.js";
// Turn-result store (resume after termination)
export type { TurnRecord, TurnStore } from "./store.js";
export { createFileTurnStore, createMemoryTurnStore } from "./store.js";
// A turn's settled outcome (the value carried in a TurnRecord)
export type { TurnOutcome } from "./tools.js";

// Usage
export type { AgentUsage } from "./usage.js";
