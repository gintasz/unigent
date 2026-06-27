// Public surface of the microfoom generic core (harness-agnostic). One curated
// barrel (A2) — `export *` is banned (L3); re-exports are explicit.

export const CORE_VERSION = "0.0.0";

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
export type { FoomtimeErrorOptions } from "./errors.js";
export {
  FoomtimeAbortError,
  FoomtimeArgError,
  FoomtimeBudgetExceededError,
  FoomtimeCallDepthError,
  FoomtimeCancelledError,
  FoomtimeConcurrencyError,
  FoomtimeConfigError,
  FoomtimeDispatchError,
  FoomtimeError,
  FoomtimeHarnessError,
  FoomtimeHarnessRejectedError,
  FoomtimeHarnessUnavailableError,
  FoomtimeInputError,
  FoomtimeRepairExhaustedError,
  FoomtimeReturnError,
  FoomtimeThrowError,
  FoomtimeTimeoutError,
  FoomtimeTokenLimitExceededError,
  FoomtimeValidationError,
} from "./errors.js";
export type {
  AgentCancellation,
  AgentExposeOptions,
  AgentOptions,
  AgentRuntimeHooks,
  AgentToolOptions,
  AgentTurnMeta,
  LLMToken,
} from "./options.js";
// Program + run context
export type {
  AgentProgramContext,
  AgentRun,
  AgentSession,
  AgentTextTemplate,
  AgentValueTemplate,
  RunProgramOptions,
} from "./program.js";
export { attachContext, FoomtimeProgram, Program, runProgram } from "./program.js";
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

// Usage
export type { AgentUsage } from "./usage.js";
