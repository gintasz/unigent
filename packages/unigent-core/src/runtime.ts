import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  Backend,
  BackendEvent,
  BackendSession,
  BackendTool,
  BackendTurnRequest,
  BackendTurnResult,
} from "./backend.js";
import type { CheckpointRecord, CheckpointStore, CheckpointValue } from "./checkpoint.js";
import { checkpointFingerprint } from "./checkpoint_fingerprint.js";
import type { Done } from "./completion.js";
import {
  AgentBackendUnavailableError,
  AgentBudgetExceededError,
  AgentCancelledError,
  AgentConcurrencyError,
  AgentConfigError,
  AgentRaisedError,
  AgentRepairExhaustedError,
  AgentTimeoutError,
} from "./errors.js";
import { type AgentEvent, type AgentTrace, EventLog, publishRunControl } from "./events.js";
import { type OutputSchema, optionalJsonSchema, parseSchema } from "./schema.js";
import { compileSourceTools } from "./source_tools.js";
import {
  type CompiledTool,
  compilePortableTool,
  type SourceToolFunction,
  type ToolDefinition,
} from "./tool.js";
import type { FailTool } from "./tools.js";
import { type AgentUsage, emptyUsage, UsageAccount, usageFromBackend } from "./usage.js";

/** Wall-clock duration accepted by Unigent limits. */
type Duration = `${number}s` | `${number}m` | `${number}h`;

/** Scoped system-prompt contribution. */
type SystemPrompt = { readonly append: string } | { readonly replace: string };

/** Limits enforced by the generic runtime. */
interface AgentLimits {
  /** Best-effort cumulative cap; concurrent turns can settle beyond it before accounting folds. */
  readonly budgetUsd?: number;
  /** Wall-clock cap applied independently to each backend turn. */
  readonly turnDuration?: Duration;
  readonly nestedAgentDepth?: number;
}

/** Tool values accepted by an agent. */
type AgentTool = SourceToolFunction | ToolDefinition | FailTool;

/** Initial agent definition. */
interface AgentOptions {
  readonly name: string;
  readonly source?: string;
  readonly backend: Backend;
  readonly model: string;
  readonly thinking?: string;
  readonly systemPrompt?: SystemPrompt;
  readonly tools?: readonly AgentTool[];
  readonly retries?: number;
  readonly repairAttempts?: number;
  readonly limits?: AgentLimits;
  readonly checkpoint?: CheckpointStore;
  readonly checkpointKey?: string;
}

/** Immutable overrides applied through `with()` or `scope()`. */
interface AgentOverrides {
  readonly backend?: Backend;
  readonly model?: string;
  readonly thinking?: string;
  readonly systemPrompt?: SystemPrompt;
  readonly retries?: number;
  readonly repairAttempts?: number;
  readonly limits?: AgentLimits;
  readonly checkpoint?: CheckpointStore | false;
  readonly checkpointKey?: string;
}

/** Workflow-boundary controls accepted only by `scope()`. */
interface AgentScopeOptions extends AgentOverrides {
  readonly signal?: AbortSignal;
  readonly duration?: Duration;
  /** Maximum completed root traces retained by this explicit scope (default: 50). */
  readonly retainTraces?: number;
}

/** Final value and telemetry produced by an awaited run. */
interface AgentRunResult<Output> {
  readonly output: Output;
  readonly usage: AgentUsage;
  readonly trace: AgentTrace;
}

/** Immediately-started, awaitable agent execution. */
interface AgentRun<Output> extends PromiseLike<AgentRunResult<Output>> {
  readonly events: AsyncIterable<AgentEvent>;
  readonly usage: AgentUsage;
  readonly trace: AgentTrace;
  abort: (reason?: unknown) => void;
}

/** Stateful single-flight conversation. */
interface AgentSession {
  run: {
    (prompt: string): AgentRun<string>;
    (prompt: string, completion: Done): AgentRun<void>;
    <Output>(prompt: string, schema: OutputSchema<Output>): AgentRun<Output>;
  };
  fork: () => AgentSession;
  readonly usage: AgentUsage;
}

/** Reusable immutable agent handle. */
interface Agent {
  with: (overrides: AgentOverrides) => Agent;
  scope: (name: string, options?: AgentScopeOptions) => AgentScope;
  session: () => AgentSession;
  run: {
    (prompt: string): AgentRun<string>;
    (prompt: string, completion: Done): AgentRun<void>;
    <Output>(prompt: string, schema: OutputSchema<Output>): AgentRun<Output>;
  };
}

/** Long-lived aggregation scope; each child run owns one complete trace. */
interface AgentScope extends Agent {
  readonly name: string;
  readonly path: readonly string[];
  readonly usage: AgentUsage;
  readonly traces: readonly AgentTrace[];
  abort: (reason?: unknown) => void;
  annotate: (attributes: Readonly<Record<string, unknown>>) => void;
  log: (message: string, level?: "info" | "warn" | "error") => void;
}

interface ResolvedConfig {
  readonly name: string;
  readonly backend: Backend;
  readonly model: string;
  readonly thinking: string | undefined;
  readonly systemPrompt: SystemPrompt | undefined;
  readonly compiledTools: readonly CompiledTool[];
  readonly hasFailTool: boolean;
  readonly retries: number;
  readonly repairAttempts: number;
  readonly limits: AgentLimits;
  readonly checkpoint: CheckpointStore | undefined;
  readonly checkpointKey: string | undefined;
}

type ScopeObservation =
  | { readonly type: "annotate"; readonly attributes: Readonly<Record<string, unknown>> }
  | { readonly type: "log"; readonly message: string; readonly level: "info" | "warn" | "error" };

interface ScopeState {
  readonly name: string;
  readonly path: readonly string[];
  readonly parent: ScopeState | undefined;
  readonly usage: UsageAccount;
  readonly traces: EventLog[];
  readonly retainTraces: number;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly timeout: AbortSignal | undefined;
  readonly duration: Duration | undefined;
  readonly activeTargets: Map<EventLog, string>;
  readonly pendingObservations: ScopeObservation[];
  lastTarget: { readonly log: EventLog; readonly spanId: string } | undefined;
}

interface ExecutionContext {
  readonly eventLog: EventLog;
  readonly spanId: string;
  readonly usage: UsageAccount;
  readonly scope: ScopeState;
  readonly signal: AbortSignal;
  readonly depth: number;
}

interface ToolExecutionState {
  repairFailures: number;
  completedUserTool: boolean;
  output: unknown;
  hasOutput: boolean;
  fatalError: Error | undefined;
}

interface RunLifecycle {
  readonly log: EventLog;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly started: number;
  readonly usage: UsageAccount;
  readonly scope: ScopeState;
  readonly parent: ExecutionContext | undefined;
  readonly isRoot: boolean;
  readonly signal: AbortSignal;
  readonly onFinalize: ((usage: AgentUsage) => void) | undefined;
}

interface BackendSessionState {
  opened: BackendSession | undefined;
  opening: Promise<BackendSession> | undefined;
}

type Completion<Output> =
  | { readonly kind: "prose" }
  | { readonly kind: "done" }
  | { readonly kind: "schema"; readonly schema: OutputSchema<Output> };

interface CheckpointContext {
  readonly store: CheckpointStore;
  readonly key: string;
}

interface SettleRunRequest<Output> {
  readonly config: ResolvedConfig;
  readonly prompt: string;
  readonly completion: Completion<Output>;
  readonly sessionFactory: SessionFactory;
  readonly canRetrySession: boolean;
  readonly context: ExecutionContext;
  readonly lifecycle: RunLifecycle;
  readonly checkpointEnabled: boolean;
}

interface CreateRunRequest<Output> {
  readonly config: ResolvedConfig;
  readonly scope: ScopeState;
  readonly prompt: string;
  readonly completion: Completion<Output>;
  readonly sessionFactory: SessionFactory;
  readonly canRetrySession: boolean;
  readonly checkpointEnabled: boolean;
  readonly onFinalize?: (usage: AgentUsage) => void;
}

type SessionFactory = () => BackendSession | Promise<BackendSession>;

const executionContext = new AsyncLocalStorage<ExecutionContext>();
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h)$/;
const DURATION_MULTIPLIER = { s: 1000, m: 60_000, h: 3_600_000 } as const;
const DEFAULT_REPAIR_ATTEMPTS = 3;
const DEFAULT_NESTED_DEPTH = 8;
const DEFAULT_RETAINED_TRACES = 50;
const CURRENCY_DECIMALS = 4;
const RETURN_TOOL_NAME = "unigent_return";
const FAIL_TOOL_NAME = "unigent_fail";
const RESERVED_TOOL_PREFIX = "unigent_";
const UNIGENT_NOTICE_BEGIN = "<!-- unigent:begin -->";
const UNIGENT_NOTICE_END = "<!-- unigent:end -->";
const checkpointFlights = new WeakMap<CheckpointStore, Map<string, Promise<CheckpointRecord>>>();

function durationMilliseconds(duration: Duration): number {
  const match = DURATION_PATTERN.exec(duration);
  const value = match?.[1];
  const unit = match?.[2] as keyof typeof DURATION_MULTIPLIER | undefined;
  if (value === undefined || unit === undefined) {
    throw new AgentConfigError(`invalid duration: ${duration}`);
  }
  return Number(value) * DURATION_MULTIPLIER[unit];
}

function tighterNumber(
  wider: number | undefined,
  narrower: number | undefined,
): number | undefined {
  if (wider === undefined) {
    return narrower;
  }
  if (narrower === undefined) {
    return wider;
  }
  return Math.min(wider, narrower);
}

function tighterDuration(
  wider: Duration | undefined,
  narrower: Duration | undefined,
): Duration | undefined {
  if (wider === undefined) {
    return narrower;
  }
  if (narrower === undefined) {
    return wider;
  }
  return durationMilliseconds(wider) <= durationMilliseconds(narrower) ? wider : narrower;
}

function mergeLimits(wider: AgentLimits, narrower: AgentLimits | undefined): AgentLimits {
  if (narrower === undefined) {
    return wider;
  }
  const budgetUsd = tighterNumber(wider.budgetUsd, narrower.budgetUsd);
  const turnDuration = tighterDuration(wider.turnDuration, narrower.turnDuration);
  const nestedAgentDepth = tighterNumber(wider.nestedAgentDepth, narrower.nestedAgentDepth);
  return {
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(turnDuration === undefined ? {} : { turnDuration }),
    ...(nestedAgentDepth === undefined ? {} : { nestedAgentDepth }),
  };
}

function mergeSystemPrompt(
  wider: SystemPrompt | undefined,
  narrower: SystemPrompt | undefined,
): SystemPrompt | undefined {
  if (narrower === undefined || "replace" in narrower) {
    return narrower ?? wider;
  }
  if (wider === undefined) {
    return narrower;
  }
  if ("replace" in wider) {
    return { replace: `${wider.replace}\n${narrower.append}` };
  }
  return { append: `${wider.append}\n${narrower.append}` };
}

function mergeCheckpoint(
  configured: CheckpointStore | undefined,
  override: CheckpointStore | false | undefined,
): CheckpointStore | undefined {
  if (override === undefined) {
    return configured;
  }
  return override === false ? undefined : override;
}

function mergeConfig(config: ResolvedConfig, overrides: AgentOverrides): ResolvedConfig {
  return validateResolvedConfig({
    ...config,
    backend: overrides.backend ?? config.backend,
    model: overrides.model ?? config.model,
    thinking: overrides.thinking ?? config.thinking,
    systemPrompt: mergeSystemPrompt(config.systemPrompt, overrides.systemPrompt),
    retries: overrides.retries ?? config.retries,
    repairAttempts: overrides.repairAttempts ?? config.repairAttempts,
    limits: mergeLimits(config.limits, overrides.limits),
    checkpoint: mergeCheckpoint(config.checkpoint, overrides.checkpoint),
    checkpointKey: overrides.checkpointKey ?? config.checkpointKey,
  });
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentConfigError(`${name} must be a non-negative safe integer`);
  }
}

function validateResolvedConfig(config: ResolvedConfig): ResolvedConfig {
  validateNonNegativeInteger("retries", config.retries);
  validateNonNegativeInteger("repairAttempts", config.repairAttempts);
  if (config.limits.nestedAgentDepth !== undefined) {
    validateNonNegativeInteger("limits.nestedAgentDepth", config.limits.nestedAgentDepth);
  }
  if (
    config.limits.budgetUsd !== undefined &&
    (!Number.isFinite(config.limits.budgetUsd) || config.limits.budgetUsd < 0)
  ) {
    throw new AgentConfigError("limits.budgetUsd must be a non-negative finite number");
  }
  if (config.limits.turnDuration !== undefined) {
    durationMilliseconds(config.limits.turnDuration);
  }
  return config;
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  const serialized = JSON.stringify([output]);
  return serialized.slice(1, -1);
}

function throwFatalError(state: ToolExecutionState): void {
  const fatalError: Error | undefined = state.fatalError;
  if (fatalError !== undefined) {
    throw fatalError;
  }
}

function recordRepairFailure(
  state: ToolExecutionState,
  config: ResolvedConfig,
  message: string,
): { readonly content: string; readonly isError: true; readonly terminate?: true } {
  state.repairFailures += 1;
  const context = executionContext.getStore();
  context?.eventLog.emit({
    type: "repair",
    spanId: context.spanId,
    attempt: state.repairFailures,
    error: message,
  });
  if (state.repairFailures > config.repairAttempts) {
    state.fatalError = new AgentRepairExhaustedError(message);
    return { content: message, isError: true, terminate: true };
  }
  return { content: message, isError: true };
}

async function executeUserTool(
  tool: CompiledTool,
  input: unknown,
  config: ResolvedConfig,
  state: ToolExecutionState,
): Promise<{ readonly content: string; readonly isError: boolean; readonly terminate?: true }> {
  const parent = executionContext.getStore();
  if (parent === undefined) {
    throw new AgentConfigError("tool executed outside an active Unigent run");
  }
  state.completedUserTool = true;
  const spanId = randomUUID();
  const started = performance.now();
  let outcome: "succeeded" | "failed" = "succeeded";
  let errorMessage: string | undefined;
  parent.eventLog.emit({
    type: "span_start",
    spanId,
    parentSpanId: parent.spanId,
    name: tool.name,
    kind: "tool",
  });
  try {
    const output = await executionContext.run(
      { ...parent, spanId },
      async (): Promise<unknown> => tool.invoke(input),
    );
    state.repairFailures = 0;
    return { content: stringifyToolOutput(output), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = "failed";
    errorMessage = message;
    return recordRepairFailure(state, config, message);
  } finally {
    parent.eventLog.emit({
      type: "span_end",
      spanId,
      parentSpanId: parent.spanId,
      durationMs: performance.now() - started,
      usage: emptyUsage(),
      outcome,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    });
  }
}

function buildTools<Output>(
  config: ResolvedConfig,
  completion: Completion<Output>,
  state: ToolExecutionState,
): BackendTool[] {
  const tools: BackendTool[] = config.compiledTools.map((compiled) => ({
    name: compiled.name,
    description: compiled.description,
    ...(compiled.promptSnippet === undefined ? {} : { promptSnippet: compiled.promptSnippet }),
    ...(compiled.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: compiled.promptGuidelines }),
    parameters: compiled.parameters,
    execute: async (input: unknown) => executeUserTool(compiled, input, config, state),
  }));
  if (config.hasFailTool) {
    tools.push({
      name: FAIL_TOOL_NAME,
      description: "Terminate the current run with a deliberate typed failure.",
      parameters: {
        type: "object",
        properties: { message: { type: "string" }, code: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
        const record = typeof input === "object" && input !== null ? input : {};
        const message = "message" in record ? String(record.message) : "agent raised a failure";
        const code = "code" in record ? String(record.code) : undefined;
        state.fatalError = new AgentRaisedError(message, code);
        return await Promise.resolve({ content: message, isError: true, terminate: true });
      },
    });
  }
  if (completion.kind !== "prose") {
    const outputSchema =
      completion.kind === "schema" ? (optionalJsonSchema(completion.schema) ?? {}) : undefined;
    tools.push({
      name: RETURN_TOOL_NAME,
      description:
        completion.kind === "done"
          ? "Signal that all requested side effects are complete and terminate without prose."
          : "Return the structured result and terminate the current run.",
      parameters:
        outputSchema === undefined
          ? { type: "object", additionalProperties: false }
          : {
              type: "object",
              properties: { value: outputSchema },
              required: ["value"],
              additionalProperties: false,
            },
      execute: async (input: unknown) => {
        if (completion.kind === "done") {
          state.output = undefined;
          state.hasOutput = true;
          return {
            content: "Completion accepted. Stop now without writing a prose response.",
            isError: false,
            terminate: true,
          };
        }
        const value =
          typeof input === "object" && input !== null && "value" in input ? input.value : undefined;
        const parsed = await parseSchema(completion.schema, value);
        if (parsed.error !== undefined) {
          return recordRepairFailure(state, config, parsed.error);
        }
        state.output = parsed.value;
        state.hasOutput = true;
        return { content: "structured result accepted", isError: false, terminate: true };
      },
    });
  }
  return tools;
}

function unigentSystemPrompt(config: ResolvedConfig): string {
  const failure = config.hasFailTool
    ? ` If ${FAIL_TOOL_NAME} is available, call it only when you cannot complete the user's instructions. Do not use it for recoverable tool errors or uncertainty.`
    : "";
  const instruction = `When ${RETURN_TOOL_NAME} is available and you have fully completed the user's instructions, you MUST call it with the requested result or completion signal because the caller reads that tool call rather than your prose and omitting it fails the task; when it is unavailable, respond directly.${failure}`;
  const protocol = [UNIGENT_NOTICE_BEGIN, instruction, UNIGENT_NOTICE_END].join("\n");
  const authored = config.systemPrompt;
  let text = "";
  if (authored !== undefined) {
    text = "replace" in authored ? authored.replace : authored.append;
  }
  const snippets = config.compiledTools.flatMap((tool): string[] =>
    tool.promptSnippet === undefined ? [] : [`- ${tool.name}: ${tool.promptSnippet}`],
  );
  const guidelines = config.compiledTools.flatMap(
    (tool): string[] => tool.promptGuidelines?.map((guideline) => `- ${guideline}`) ?? [],
  );
  const promptMetadata = [
    ...(snippets.length === 0 ? [] : ["Available Unigent tools:", ...snippets]),
    ...(guidelines.length === 0 ? [] : ["Unigent tool guidelines:", ...guidelines]),
  ].join("\n");
  return [protocol, promptMetadata, text].filter((part) => part.length > 0).join("\n\n");
}

function emitBackendEvent(log: EventLog, spanId: string, event: BackendEvent): void {
  log.emit({ ...event, spanId });
}

function validateCapabilities(config: ResolvedConfig): void {
  if (config.limits.budgetUsd !== undefined && !config.backend.capabilities.reportsCost) {
    throw new AgentConfigError(
      `${config.backend.name} cannot enforce budgetUsd because it reports no cost`,
    );
  }
}

async function oneBackendTurn(
  session: BackendSession,
  request: BackendTurnRequest,
  context: ExecutionContext,
  turnDuration: Duration | undefined,
): Promise<BackendTurnResult> {
  if (request.signal.aborted) {
    throw new AgentCancelledError("run was cancelled");
  }
  const timeout =
    turnDuration === undefined
      ? undefined
      : AbortSignal.timeout(durationMilliseconds(turnDuration));
  const turnSignal =
    timeout === undefined ? request.signal : AbortSignal.any([request.signal, timeout]);
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    const error =
      timeout?.aborted === true && !request.signal.aborted
        ? new AgentTimeoutError(`turn exceeded ${turnDuration}`)
        : new AgentCancelledError("run was cancelled");
    rejectAbort?.(error);
  };
  turnSignal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      executionContext.run(
        context,
        async (): Promise<BackendTurnResult> => session.runTurn({ ...request, signal: turnSignal }),
      ),
      aborted,
    ]);
  } finally {
    turnSignal.removeEventListener("abort", onAbort);
  }
}

async function driveRun<Output>(
  config: ResolvedConfig,
  prompt: string,
  completion: Completion<Output>,
  sessionFactory: SessionFactory,
  canRetrySession: boolean,
  context: ExecutionContext,
): Promise<Output | string> {
  validateCapabilities(config);
  const currentCost =
    config.limits.budgetUsd === undefined ? undefined : knownCost(context.scope.usage.snapshot());
  if (
    config.limits.budgetUsd !== undefined &&
    currentCost !== undefined &&
    currentCost >= config.limits.budgetUsd
  ) {
    throw new AgentBudgetExceededError("scope budget is already exhausted");
  }
  const state: ToolExecutionState = {
    repairFailures: 0,
    completedUserTool: false,
    output: undefined,
    hasOutput: false,
    fatalError: undefined,
  };
  const tools = buildTools(config, completion, state);
  const systemPrompt = unigentSystemPrompt(config);
  const request = (turnPrompt: string): BackendTurnRequest => ({
    systemPrompt,
    systemPromptMode:
      config.systemPrompt !== undefined && "replace" in config.systemPrompt ? "replace" : "append",
    prompt: turnPrompt,
    tools,
    ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
    signal: context.signal,
    onEvent: (event: BackendEvent): void =>
      emitBackendEvent(context.eventLog, context.spanId, event),
  });
  const initial = await runWithRetries(
    config,
    prompt,
    sessionFactory,
    canRetrySession,
    context,
    state,
    request,
  );
  const { result, session } = initial;
  context.usage.add(usageFromBackend(result.usage));
  throwFatalError(state);
  if (completion.kind === "prose") {
    return result.text;
  }
  for (let repair = 0; !state.hasOutput && repair < config.repairAttempts; repair += 1) {
    const repaired = await oneBackendTurn(
      session,
      request(`You did not call ${RETURN_TOOL_NAME}. Call it now with the required result.`),
      context,
      config.limits.turnDuration,
    );
    context.usage.add(usageFromBackend(repaired.usage));
    throwFatalError(state);
  }
  if (!state.hasOutput) {
    throw new AgentRepairExhaustedError(`agent never called ${RETURN_TOOL_NAME}`);
  }
  return state.output as Output;
}

function knownCost(usage: AgentUsage): number {
  if (usage.calls === 0) {
    return 0;
  }
  if (usage.costUsd === undefined) {
    throw new AgentConfigError("scope cost is unknown because a nested backend reported no cost");
  }
  return usage.costUsd;
}

function checkpointContext<Output>(
  config: ResolvedConfig,
  prompt: string,
  completion: Completion<Output>,
  enabled: boolean,
): CheckpointContext | undefined {
  if (!enabled || config.checkpoint === undefined) {
    return;
  }
  const schema = completion.kind === "schema" ? optionalJsonSchema(completion.schema) : undefined;
  if (completion.kind === "schema" && schema === undefined) {
    throw new AgentConfigError(
      "checkpointed structured output requires a Standard JSON Schema projection",
    );
  }
  const tools = config.compiledTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
    checkpointKey: tool.checkpointKey,
  }));
  return {
    store: config.checkpoint,
    key: checkpointFingerprint({
      mode: completion.kind,
      schema,
      prompt,
      systemPrompt: unigentSystemPrompt(config),
      systemPromptMode:
        config.systemPrompt !== undefined && "replace" in config.systemPrompt
          ? "replace"
          : "append",
      backend: config.backend.checkpointKey ?? config.backend.name,
      model: config.model,
      thinking: config.thinking,
      tools,
      failTool: config.hasFailTool,
      checkpointKey: config.checkpointKey,
    }),
  };
}

function emitCheckpoint(
  context: ExecutionContext,
  key: string,
  action: "hit" | "miss" | "wait" | "write",
): void {
  context.eventLog.emit({ type: "checkpoint", spanId: context.spanId, key, action });
}

function checkpointValue<Output>(
  completion: Completion<Output>,
  output: Output | string,
): CheckpointValue {
  return completion.kind === "done" ? { kind: "done" } : { kind: "output", value: output };
}

function outputFromCheckpoint<Output>(
  completion: Completion<Output>,
  record: CheckpointRecord,
): Output | string {
  if (completion.kind === "done" && record.value.kind === "done") {
    return undefined as Output;
  }
  if (completion.kind !== "done" && record.value.kind === "output") {
    return record.value.value as Output | string;
  }
  throw new AgentConfigError("checkpoint record does not match the requested completion mode");
}

function flightsFor(store: CheckpointStore): Map<string, Promise<CheckpointRecord>> {
  const existing = checkpointFlights.get(store);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, Promise<CheckpointRecord>>();
  checkpointFlights.set(store, created);
  return created;
}

async function runCheckpointed<Output>(
  config: ResolvedConfig,
  prompt: string,
  completion: Completion<Output>,
  sessionFactory: SessionFactory,
  canRetrySession: boolean,
  context: ExecutionContext,
  enabled: boolean,
): Promise<Output | string> {
  const checkpoint = checkpointContext(config, prompt, completion, enabled);
  if (checkpoint === undefined) {
    return await driveRun(config, prompt, completion, sessionFactory, canRetrySession, context);
  }
  let hit: CheckpointRecord | undefined;
  try {
    hit = await checkpoint.store.get(checkpoint.key);
  } catch {
    hit = undefined;
  }
  if (hit !== undefined) {
    emitCheckpoint(context, checkpoint.key, "hit");
    context.usage.add(hit.usage);
    return outputFromCheckpoint(completion, hit);
  }
  const flights = flightsFor(checkpoint.store);
  const active = flights.get(checkpoint.key);
  if (active !== undefined) {
    emitCheckpoint(context, checkpoint.key, "wait");
    const record = await active;
    context.usage.add(record.usage);
    return outputFromCheckpoint(completion, record);
  }
  emitCheckpoint(context, checkpoint.key, "miss");
  const execute = async (): Promise<CheckpointRecord> => {
    const output = await driveRun(
      config,
      prompt,
      completion,
      sessionFactory,
      canRetrySession,
      context,
    );
    const record: CheckpointRecord = {
      version: 1,
      value: checkpointValue(completion, output),
      usage: context.usage.snapshot(),
    };
    try {
      await checkpoint.store.set(checkpoint.key, record);
      emitCheckpoint(context, checkpoint.key, "write");
    } catch {
      // Checkpoints are an optimization; completed agent output remains authoritative.
    }
    return record;
  };
  const flight = execute();
  flights.set(checkpoint.key, flight);
  try {
    const record = await flight;
    return outputFromCheckpoint(completion, record);
  } finally {
    flights.delete(checkpoint.key);
  }
}

async function runWithRetries(
  config: ResolvedConfig,
  prompt: string,
  sessionFactory: SessionFactory,
  canRetrySession: boolean,
  context: ExecutionContext,
  state: ToolExecutionState,
  request: (prompt: string) => BackendTurnRequest,
): Promise<{ readonly result: BackendTurnResult; readonly session: BackendSession }> {
  let session = await sessionFactory();
  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
    try {
      const result = await oneBackendTurn(
        session,
        request(prompt),
        context,
        config.limits.turnDuration,
      );
      return { result, session };
    } catch (error) {
      const retryable =
        error instanceof AgentBackendUnavailableError &&
        !state.completedUserTool &&
        canRetrySession &&
        attempt < config.retries;
      if (!retryable) {
        throw error;
      }
      session = await sessionFactory();
    }
  }
  throw new AgentBackendUnavailableError("backend produced no result");
}

function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  const [only] = signals;
  return signals.length === 1 && only !== undefined ? only : AbortSignal.any([...signals]);
}

function createSignal(controller: AbortController, parents: readonly AbortSignal[]): AbortSignal {
  return combineSignals([controller.signal, ...parents]);
}

function createScopeState(
  name: string,
  path: readonly string[],
  parent: ScopeState | undefined,
  options: Pick<AgentScopeOptions, "signal" | "duration" | "retainTraces"> = {},
): ScopeState {
  if (name.trim().length === 0) {
    throw new AgentConfigError("scope name must be non-empty");
  }
  if (
    options.retainTraces !== undefined &&
    (!Number.isSafeInteger(options.retainTraces) || options.retainTraces < 0)
  ) {
    throw new AgentConfigError("scope retainTraces must be a non-negative safe integer");
  }
  const controller = new AbortController();
  const timeout =
    options.duration === undefined
      ? undefined
      : AbortSignal.timeout(durationMilliseconds(options.duration));
  const inherited = [parent?.signal, options.signal, timeout].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return {
    name,
    path,
    parent,
    usage: new UsageAccount(),
    traces: [],
    retainTraces: options.retainTraces ?? (path.length === 0 ? 0 : DEFAULT_RETAINED_TRACES),
    controller,
    signal: combineSignals([controller.signal, ...inherited]),
    timeout,
    duration: options.duration,
    activeTargets: new Map(),
    pendingObservations: [],
    lastTarget: undefined,
  };
}

function scopeAncestors(scope: ScopeState): readonly ScopeState[] {
  const scopes: ScopeState[] = [];
  let current: ScopeState | undefined = scope;
  while (current !== undefined) {
    scopes.push(current);
    current = current.parent;
  }
  return scopes;
}

function emitScopeObservation(log: EventLog, spanId: string, observation: ScopeObservation): void {
  if (observation.type === "annotate") {
    log.emit({ type: "annotate", spanId, attributes: observation.attributes });
  } else {
    log.emit({
      type: "log",
      spanId,
      message: observation.message,
      level: observation.level,
    });
  }
}

function observeScope(scope: ScopeState, observation: ScopeObservation): void {
  if (scope.activeTargets.size > 0) {
    for (const [log, spanId] of scope.activeTargets) {
      emitScopeObservation(log, spanId, observation);
    }
    return;
  }
  if (scope.lastTarget !== undefined) {
    emitScopeObservation(scope.lastTarget.log, scope.lastTarget.spanId, observation);
    return;
  }
  scope.pendingObservations.push(observation);
}

function registerScopeTarget(scope: ScopeState, log: EventLog, spanId: string): void {
  for (const candidate of scopeAncestors(scope)) {
    candidate.activeTargets.set(log, spanId);
    for (const observation of candidate.pendingObservations.splice(0)) {
      emitScopeObservation(log, spanId, observation);
    }
  }
}

function unregisterScopeTarget(scope: ScopeState, log: EventLog, spanId: string): void {
  for (const candidate of scopeAncestors(scope)) {
    candidate.activeTargets.delete(log);
    candidate.lastTarget = { log, spanId };
  }
}

function registerScopeTrace(scope: ScopeState, log: EventLog): void {
  for (const candidate of scopeAncestors(scope)) {
    if (candidate.retainTraces === 0) {
      continue;
    }
    candidate.traces.push(log);
    if (candidate.traces.length > candidate.retainTraces) {
      candidate.traces.splice(0, candidate.traces.length - candidate.retainTraces);
    }
  }
}

function addScopeUsageOutside(
  scope: ScopeState,
  usage: AgentUsage,
  excluded: ReadonlySet<ScopeState>,
): void {
  for (const candidate of scopeAncestors(scope)) {
    if (!excluded.has(candidate)) {
      candidate.usage.add(usage);
    }
  }
}

function addScopeUsage(scope: ScopeState, usage: AgentUsage): void {
  for (const candidate of scopeAncestors(scope)) {
    candidate.usage.add(usage);
  }
}

function attachRun<Output>(
  promise: Promise<AgentRunResult<Output>>,
  controller: AbortController,
  events: AsyncIterable<AgentEvent>,
  usage: UsageAccount,
  log: EventLog,
): AgentRun<Output> {
  promise.catch(() => undefined);
  return {
    // biome-ignore lint/suspicious/noThenProperty: AgentRun deliberately implements PromiseLike.
    then: promise.then.bind(promise),
    events,
    get usage(): AgentUsage {
      return usage.snapshot();
    },
    get trace(): AgentTrace {
      return log.snapshot();
    },
    abort: (reason?: unknown): void => controller.abort(reason),
  };
}

function finalizeRun(
  lifecycle: RunLifecycle,
  outcome: "succeeded" | "failed" | "cancelled",
  error: string | undefined,
): void {
  const snapshot = lifecycle.usage.snapshot();
  if (lifecycle.parent === undefined) {
    addScopeUsage(lifecycle.scope, snapshot);
  } else {
    lifecycle.parent.usage.add(snapshot);
    if (lifecycle.scope !== lifecycle.parent.scope) {
      addScopeUsageOutside(
        lifecycle.scope,
        snapshot,
        new Set(scopeAncestors(lifecycle.parent.scope)),
      );
    }
  }
  lifecycle.onFinalize?.(snapshot);
  lifecycle.log.emit({
    type: "span_end",
    spanId: lifecycle.spanId,
    ...(lifecycle.parentSpanId === undefined ? {} : { parentSpanId: lifecycle.parentSpanId }),
    durationMs: performance.now() - lifecycle.started,
    usage: snapshot,
    outcome,
    ...(error === undefined ? {} : { error }),
  });
  if (lifecycle.isRoot) {
    unregisterScopeTarget(lifecycle.scope, lifecycle.log, lifecycle.spanId);
    lifecycle.log.end();
    publishRunControl({
      type: "run_end",
      traceId: lifecycle.log.traceId,
      spanId: lifecycle.spanId,
    });
  }
}

function normalizedRunError(error: unknown, lifecycle: RunLifecycle): unknown {
  const timedOutScope = scopeAncestors(lifecycle.scope).find(
    (scope) => scope.timeout?.aborted === true,
  );
  if (timedOutScope?.duration !== undefined) {
    return new AgentTimeoutError(
      `scope ${timedOutScope.path.join("/")} exceeded ${timedOutScope.duration}`,
      { cause: error },
    );
  }
  if (lifecycle.signal.aborted) {
    return new AgentCancelledError("run was cancelled", { cause: error });
  }
  return error;
}

async function settleRun<Output>(
  request: SettleRunRequest<Output>,
): Promise<AgentRunResult<Output>> {
  const { config, context, lifecycle } = request;
  let outcome:
    | { readonly ok: true; readonly output: Output }
    | { readonly ok: false; readonly error: unknown };
  try {
    const output = await runCheckpointed(
      config,
      request.prompt,
      request.completion,
      request.sessionFactory,
      request.canRetrySession,
      context,
      request.checkpointEnabled,
    );
    const snapshot = lifecycle.usage.snapshot();
    const projectedCost =
      config.limits.budgetUsd === undefined
        ? undefined
        : knownCost(context.scope.usage.snapshot()) + knownCost(snapshot);
    if (
      config.limits.budgetUsd !== undefined &&
      projectedCost !== undefined &&
      projectedCost > config.limits.budgetUsd
    ) {
      throw new AgentBudgetExceededError(
        `scope cost $${projectedCost.toFixed(CURRENCY_DECIMALS)} exceeded $${config.limits.budgetUsd.toFixed(CURRENCY_DECIMALS)}`,
      );
    }
    outcome = { ok: true, output: output as Output };
  } catch (error) {
    outcome = { ok: false, error: normalizedRunError(error, lifecycle) };
  }
  let finalOutcome: "succeeded" | "failed" | "cancelled" = "succeeded";
  let message: string | undefined;
  if (!outcome.ok) {
    finalOutcome = outcome.error instanceof AgentCancelledError ? "cancelled" : "failed";
    message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  }
  finalizeRun(lifecycle, finalOutcome, message);
  if (!outcome.ok) {
    throw outcome.error;
  }
  return {
    output: outcome.output,
    usage: lifecycle.usage.snapshot(),
    trace: lifecycle.log.snapshot(),
  };
}

function emitRunOpening(
  log: EventLog,
  spanId: string,
  parentSpanId: string | undefined,
  config: ResolvedConfig,
  scope: ScopeState,
  prompt: string,
): void {
  const parent = parentSpanId === undefined ? {} : { parentSpanId };
  const scopedName = parentSpanId === undefined ? scope.path.at(-1) : undefined;
  log.emit({
    type: "span_start",
    spanId,
    ...parent,
    name: scopedName ?? config.name,
    kind: "run",
    backend: config.backend.name,
    model: config.model,
    agent: config.name,
    ...(scope.path.length === 0 ? {} : { scopePath: scope.path }),
  });
  log.emit({
    type: "system_prompt",
    spanId,
    ...parent,
    text: unigentSystemPrompt(config),
  });
  log.emit({ type: "user_prompt", spanId, ...parent, text: prompt });
}

function publishRootRunControl(
  isRoot: boolean,
  log: EventLog,
  spanId: string,
  controller: AbortController,
): void {
  if (isRoot) {
    publishRunControl({
      type: "run_start",
      traceId: log.traceId,
      spanId,
      abort: (reason?: unknown): void => controller.abort(reason),
    });
  }
}

function createRun<Output>(request: CreateRunRequest<Output>): AgentRun<Output> {
  const { config } = request;
  const parent = executionContext.getStore();
  const isRoot = parent === undefined;
  const effectiveScope =
    parent !== undefined && request.scope.path.length === 0 ? parent.scope : request.scope;
  const depth = (parent?.depth ?? -1) + 1;
  const maxDepth = config.limits.nestedAgentDepth ?? DEFAULT_NESTED_DEPTH;
  if (depth > maxDepth) {
    throw new AgentConfigError(`nested agent depth ${depth} exceeds limit ${maxDepth}`);
  }
  const log = parent?.eventLog ?? new EventLog(randomUUID());
  if (isRoot) {
    registerScopeTrace(effectiveScope, log);
  }
  const spanId = randomUUID();
  const parentSpanId = parent?.spanId;
  const usage = new UsageAccount();
  const controller = new AbortController();
  const signal = createSignal(
    controller,
    [parent?.signal, effectiveScope.signal].filter(
      (candidateSignal): candidateSignal is AbortSignal => candidateSignal !== undefined,
    ),
  );
  const context: ExecutionContext = {
    eventLog: log,
    spanId,
    usage,
    scope: effectiveScope,
    signal,
    depth,
  };
  const started = performance.now();
  emitRunOpening(log, spanId, parentSpanId, config, effectiveScope, request.prompt);
  if (isRoot) {
    registerScopeTarget(effectiveScope, log, spanId);
  }
  const lifecycle: RunLifecycle = {
    log,
    spanId,
    parentSpanId,
    started,
    usage,
    scope: effectiveScope,
    parent,
    isRoot,
    signal,
    onFinalize: request.onFinalize,
  };
  publishRootRunControl(isRoot, log, spanId, controller);
  const promise = settleRun({
    config,
    prompt: request.prompt,
    completion: request.completion,
    sessionFactory: request.sessionFactory,
    canRetrySession: request.canRetrySession,
    context,
    lifecycle,
    checkpointEnabled: request.checkpointEnabled,
  });
  return attachRun(promise, controller, log.iterable(spanId), usage, log);
}

function rejectedRun<Output>(error: unknown): AgentRun<Output> {
  const controller = new AbortController();
  const log = new EventLog(randomUUID());
  const usage = new UsageAccount();
  log.end();
  return attachRun(Promise.reject(error), controller, log.iterable(), usage, log);
}

async function openedSession(
  config: ResolvedConfig,
  state: BackendSessionState,
): Promise<BackendSession> {
  if (state.opened !== undefined) {
    return state.opened;
  }
  const pending =
    state.opening ??
    Promise.resolve(config.backend.openSession({ model: config.model })).then((session) => {
      state.opened = session;
      return session;
    });
  state.opening = pending;
  try {
    return await pending;
  } catch (error) {
    if (state.opening === pending) {
      state.opening = undefined;
    }
    throw error;
  }
}

function makeSession(
  config: ResolvedConfig,
  scope: ScopeState,
  seed?: BackendSession,
): AgentSession {
  const state: BackendSessionState = { opened: seed, opening: undefined };
  let busy = false;
  const usage = new UsageAccount();
  const run = <Output>(
    prompt: string,
    requested?: OutputSchema<Output> | Done,
  ): AgentRun<Output | string | undefined> => {
    if (busy) {
      throw new AgentConcurrencyError(
        "stateful sessions are single-flight; fork before parallel turns",
      );
    }
    let completion: Completion<Output>;
    try {
      completion = resolveCompletion(requested);
    } catch (error) {
      return rejectedRun(error);
    }
    busy = true;
    try {
      return createRun({
        config: { ...config, retries: 0 },
        scope,
        prompt,
        completion,
        sessionFactory: async () => await openedSession(config, state),
        canRetrySession: false,
        checkpointEnabled: false,
        onFinalize: (runUsage: AgentUsage): void => {
          usage.add(runUsage);
          busy = false;
        },
      });
    } catch (error) {
      busy = false;
      return rejectedRun(error);
    }
  };
  return {
    run,
    fork: (): AgentSession => {
      if (busy) {
        throw new AgentConcurrencyError("cannot fork a session during an active turn");
      }
      if (state.opened === undefined) {
        throw new AgentConfigError("run at least one session turn before forking");
      }
      if (state.opened.fork === undefined) {
        throw new AgentConfigError(`${config.backend.name} does not support session forks`);
      }
      return makeSession(config, scope, state.opened.fork());
    },
    get usage(): AgentUsage {
      return usage.snapshot();
    },
  };
}

function isDone(requested: object): requested is Done {
  return "kind" in requested && requested.kind === "done";
}

function isOutputSchema<Output>(requested: object): requested is OutputSchema<Output> {
  return "~standard" in requested;
}

function resolveCompletion<Output>(requested?: unknown): Completion<Output> {
  if (requested === undefined) {
    return { kind: "prose" };
  }
  if (typeof requested !== "object" || requested === null || Array.isArray(requested)) {
    throw new AgentConfigError("run completion must be done or a Standard Schema object");
  }
  if (isDone(requested)) {
    return { kind: "done" };
  }
  if (!isOutputSchema<Output>(requested)) {
    throw new AgentConfigError("run completion must be done or a Standard Schema object");
  }
  return { kind: "schema", schema: requested };
}

function makeAgent(config: ResolvedConfig, scope?: ScopeState, scoped = false): Agent {
  const ownScope = scope ?? createScopeState(config.name, [], undefined);
  const run = <Output>(
    prompt: string,
    requested?: OutputSchema<Output> | Done,
  ): AgentRun<Output | string | undefined> => {
    try {
      return createRun({
        config,
        scope: ownScope,
        prompt,
        completion: resolveCompletion(requested),
        sessionFactory: async () => await config.backend.openSession({ model: config.model }),
        canRetrySession: true,
        checkpointEnabled: true,
      });
    } catch (error) {
      return rejectedRun(error);
    }
  };
  return {
    with: (overrides: AgentOverrides): Agent =>
      makeAgent(mergeConfig(config, overrides), ownScope, scoped),
    scope: (name: string, options: AgentScopeOptions = {}): AgentScope => {
      const parent = scoped ? ownScope : undefined;
      const path = parent === undefined ? [name] : [...parent.path, name];
      const scopedState = createScopeState(name, path, parent, options);
      return makeScope(mergeConfig(config, options), scopedState);
    },
    session: (): AgentSession => makeSession(config, ownScope),
    run,
  };
}

function makeScope(config: ResolvedConfig, scope: ScopeState): AgentScope {
  const handle = makeAgent(config, scope, true);
  return {
    ...handle,
    name: scope.name,
    path: scope.path,
    abort: (reason?: unknown): void => scope.controller.abort(reason),
    annotate: (attributes: Readonly<Record<string, unknown>>): void =>
      observeScope(scope, { type: "annotate", attributes }),
    log: (message: string, level: "info" | "warn" | "error" = "info"): void =>
      observeScope(scope, { type: "log", message, level }),
    get usage(): AgentUsage {
      return scope.usage.snapshot();
    },
    get traces(): readonly AgentTrace[] {
      return scope.traces.map((trace) => trace.snapshot());
    },
  };
}

function isPortableTool(value: AgentTool): value is ToolDefinition {
  return typeof value !== "function" && value.kind === "tool";
}

function isFailTool(value: AgentTool): value is FailTool {
  return typeof value !== "function" && value.kind === "fail";
}

function resolveTools(options: AgentOptions): {
  readonly compiledTools: readonly CompiledTool[];
  readonly hasFailTool: boolean;
} {
  const tools = options.tools ?? [];
  const functions = tools.filter(
    (value): value is SourceToolFunction => typeof value === "function",
  );
  if (functions.length > 0 && options.source === undefined) {
    throw new AgentConfigError("source is required when exposing source-derived function tools");
  }
  const sourceTools =
    options.source === undefined ? [] : compileSourceTools(options.source, functions);
  const portableTools = tools.filter(isPortableTool).map(compilePortableTool);
  const compiledTools = [...sourceTools, ...portableTools];
  const names = new Set<string>();
  for (const compiled of compiledTools) {
    if (compiled.name.startsWith(RESERVED_TOOL_PREFIX)) {
      throw new AgentConfigError(
        `tool name uses reserved ${RESERVED_TOOL_PREFIX} namespace: ${compiled.name}`,
      );
    }
    if (names.has(compiled.name)) {
      throw new AgentConfigError(`duplicate tool name: ${compiled.name}`);
    }
    names.add(compiled.name);
  }
  return { compiledTools, hasFailTool: tools.some(isFailTool) };
}

/** Create an immutable universal agent handle. */
function agent(options: AgentOptions): Agent {
  if (options.name.trim().length === 0 || options.model.trim().length === 0) {
    throw new AgentConfigError("agent name and model must be non-empty");
  }
  const compiled = resolveTools(options);
  return makeAgent(
    validateResolvedConfig({
      name: options.name,
      backend: options.backend,
      model: options.model,
      thinking: options.thinking,
      systemPrompt: options.systemPrompt,
      ...compiled,
      retries: options.retries ?? 0,
      repairAttempts: options.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS,
      limits: options.limits ?? {},
      checkpoint: options.checkpoint,
      checkpointKey: options.checkpointKey,
    }),
  );
}

export type {
  Agent,
  AgentLimits,
  AgentOptions,
  AgentOverrides,
  AgentRun,
  AgentRunResult,
  AgentScope,
  AgentScopeOptions,
  AgentSession,
  AgentTool,
  Duration,
  SystemPrompt,
};
export { agent };
