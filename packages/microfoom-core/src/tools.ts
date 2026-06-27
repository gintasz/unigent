// The FOOM tool semantics + the one turn coordinator, shared by every harness
// (ADR-0002 rev). The harness loop calls these tools' execute(); core decides
// what they do: foom_call dispatches an exposed method, foom_return validates and
// captures the value, foom_throw aborts with a code, foom_inspect returns a
// parameter schema. Errors are repairable (returned as error tool-results so the
// model corrects) or terminal (captured and thrown after the turn). Public errors
// are used directly — this is the harness seam, past the internal core.

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  FoomtimeBudgetExceededError,
  FoomtimeCallDepthError,
  FoomtimeError,
  FoomtimeRepairExhaustedError,
  FoomtimeReturnError,
  FoomtimeThrowError,
  FoomtimeTimeoutError,
  FoomtimeTokenLimitExceededError,
} from "./errors.js";
import type { AgentEvent } from "./events.js";
import type { LLMToken } from "./options.js";
import { CONTROL_TOOLS } from "./protocol.js";
import type {
  HarnessSession,
  JsonSchema,
  NeutralToolDef,
  SessionTurnRequest,
  StreamEvent,
  ToolExecResult,
} from "./session.js";
import { formatIssues } from "./standard_schema.js";
import { accountFromDelta, type UsageAccount } from "./usage.js";

/** Per-run dispatch surface the coordinator needs (built by the program facade). */
export interface ProgramTurnContext {
  /** Invoke an exposed method with a raw args object; throws on method failure. */
  readonly invoke: (method: string, args: unknown) => Promise<string>;
  /** True if the method is exposed (agent-callable). */
  readonly isExposed: (method: string) => boolean;
  /** JSON Schema of a method's parameters (for foom_inspect and the {tool} tier). */
  readonly paramSchema: (method: string) => JsonSchema | undefined;
  /** Validate a raw args object against a method's derived schema (undefined → no schema). */
  readonly validateArgs: (
    method: string,
    args: unknown,
  ) => Promise<readonly StandardSchemaV1.Issue[] | undefined>;
  /** Exposed methods advertised as their own native tool ({tool} tier). */
  readonly toolTierMethods: ReadonlyArray<{ name: string; description: string }>;
  /** Current nesting depth (for usage accounting). */
  readonly depth: () => number;
}

/** Whether the turn ends in prose or a schema-validated value. */
export type TurnMode =
  | { readonly kind: "text" }
  | { readonly kind: "value"; readonly schema: StandardSchemaV1 };

/** What a turn produced. */
export type TurnOutcome =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly value: unknown };

/** Effective caps for a turn (already cascaded/resolved). */
export interface ResolvedCaps {
  readonly maxBudgetUsd?: number;
  readonly maxOutputTokens?: number;
  readonly maxCallDepth?: number;
  readonly maxTurnDurationMs?: number;
  readonly repairAttempts: number;
}

/** Optional trace emission for a turn. */
interface Emitter {
  readonly emit?: (event: AgentEvent) => void;
  readonly span: string;
}

interface Capture {
  has: boolean;
  value?: unknown;
  thrown?: { message: string; code: string };
  fatal?: FoomtimeError;
}

const ok = (content: string): ToolExecResult => ({ content, isError: false });
const fail = (content: string): ToolExecResult => ({ content, isError: true });
const stop = (content: string): ToolExecResult => ({ content, isError: false, terminate: true });

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

function buildTurnTools(
  ctx: ProgramTurnContext,
  mode: TurnMode,
  capture: Capture,
  repair: { count: number },
  repairAttempts: number,
  emitter: Emitter,
): NeutralToolDef[] {
  // Count a repairable miss; on exhaustion, capture a terminal error and stop.
  const repairableThenMaybeStop = (content: string): ToolExecResult => {
    repair.count += 1;
    emitter.emit?.({ type: "repair", span: emitter.span, attempt: repair.count });
    if (repair.count > repairAttempts) {
      capture.fatal = new FoomtimeRepairExhaustedError("too many consecutive invalid attempts");
      capture.has = true;
      return stop(content);
    }
    return fail(content);
  };

  const dispatch = async (method: string, args: unknown): Promise<ToolExecResult> => {
    if (!ctx.isExposed(method)) {
      return repairableThenMaybeStop(`Method "${method}" is not exposed.`);
    }
    const issues = await ctx.validateArgs(method, args);
    if (issues !== undefined) {
      return repairableThenMaybeStop(`Invalid arguments: ${formatIssues(issues)}`);
    }
    emitter.emit?.({ type: "foom_call", span: emitter.span, method });
    try {
      return ok(await ctx.invoke(method, args));
    } catch (error) {
      if (error instanceof FoomtimeThrowError) {
        capture.thrown = { message: error.message, code: error.code };
        capture.has = true;
        return stop("Program raised an error.");
      }
      if (error instanceof FoomtimeError) {
        capture.fatal = error;
        capture.has = true;
        return stop("Program failed.");
      }
      throw error;
    }
  };

  const tools: NeutralToolDef[] = [
    {
      name: CONTROL_TOOLS.call,
      description:
        "Invoke an exposed program method by name. `arguments` is an object of its parameters.",
      parameters: objectSchema({ method: { type: "string" }, arguments: { type: "object" } }, [
        "method",
      ]),
      execute: async (args) => {
        const method = field(args, "method");
        if (typeof method !== "string")
          return repairableThenMaybeStop("foom_call needs a string `method`.");
        return dispatch(method, field(args, "arguments") ?? {});
      },
    },
    {
      name: CONTROL_TOOLS.inspect,
      description:
        "Return the parameter schema of an exposed method so you can build a valid foom_call.",
      parameters: objectSchema({ method: { type: "string" } }, ["method"]),
      execute: async (args) => {
        const method = field(args, "method");
        if (typeof method !== "string")
          return repairableThenMaybeStop("foom_inspect needs a string `method`.");
        if (!ctx.isExposed(method))
          return repairableThenMaybeStop(`Method "${method}" is not exposed.`);
        return ok(JSON.stringify(ctx.paramSchema(method) ?? { type: "object" }));
      },
    },
    {
      name: CONTROL_TOOLS.throw,
      description: "Abort the program with a deliberate error and a caller-defined code.",
      parameters: objectSchema({ message: { type: "string" }, code: { type: "string" } }, [
        "message",
        "code",
      ]),
      execute: async (args) => {
        const message = field(args, "message");
        const code = field(args, "code");
        if (typeof message !== "string" || typeof code !== "string") {
          return repairableThenMaybeStop("foom_throw needs string `message` and `code`.");
        }
        capture.thrown = { message, code };
        capture.has = true;
        return stop("Program raised an error.");
      },
    },
  ];

  if (mode.kind === "value") {
    const schema = mode.schema;
    tools.push({
      name: CONTROL_TOOLS.return,
      description:
        "Return the final structured result of this turn through the machine-readable channel.",
      parameters: objectSchema({ value: {} }, ["value"]),
      execute: async (args) => {
        const result = await Promise.resolve(schema["~standard"].validate(field(args, "value")));
        if (result.issues !== undefined) {
          return repairableThenMaybeStop(`Invalid return value: ${formatIssues(result.issues)}`);
        }
        capture.value = result.value;
        capture.has = true;
        return stop("Returned.");
      },
    });
  }

  for (const method of ctx.toolTierMethods) {
    tools.push({
      name: method.name,
      description: method.description,
      parameters: ctx.paramSchema(method.name) ?? { type: "object" },
      execute: (args) => dispatch(method.name, args),
    });
  }

  return tools;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FoomtimeTimeoutError(`turn exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

function enforceCaps(caps: ResolvedCaps, usage: UsageAccount): void {
  if (caps.maxBudgetUsd !== undefined) {
    if (usage.costUsd === undefined) {
      throw new FoomtimeBudgetExceededError(
        "maxBudgetUsd is set but the model cost is underivable",
      );
    }
    if (usage.costUsd > caps.maxBudgetUsd) {
      throw new FoomtimeBudgetExceededError(
        `cost $${usage.costUsd} exceeds cap $${caps.maxBudgetUsd}`,
      );
    }
  }
  if (caps.maxOutputTokens !== undefined && usage.outputTokens > caps.maxOutputTokens) {
    throw new FoomtimeTokenLimitExceededError(
      `output tokens ${usage.outputTokens} exceeds cap ${caps.maxOutputTokens}`,
    );
  }
}

/** Parameters for one coordinated turn. */
export interface RunTurnParams {
  readonly session: HarnessSession;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly mode: TurnMode;
  readonly ctx: ProgramTurnContext;
  readonly caps: ResolvedCaps;
  readonly fold: (delta: UsageAccount) => UsageAccount;
  readonly thinking?: string;
  readonly onToken?: (token: LLMToken) => void;
  readonly onStreamChunk?: (chunk: string) => void;
  readonly signal?: AbortSignal;
  readonly emit?: (event: AgentEvent) => void;
  readonly span?: string;
}

/**
 * Run one text/value turn over a harness session. The harness owns the loop and
 * executes the FOOM tools; this interprets the captured outcome. Shared by the pi
 * session and the faux test session.
 */
export async function runProgramTurn(params: RunTurnParams): Promise<TurnOutcome> {
  if (params.caps.maxCallDepth !== undefined && params.ctx.depth() > params.caps.maxCallDepth) {
    throw new FoomtimeCallDepthError(
      `call depth ${params.ctx.depth()} exceeds maxCallDepth ${params.caps.maxCallDepth}`,
    );
  }
  const capture: Capture = { has: false };
  const repair = { count: 0 };
  const emitter: Emitter = {
    span: params.span ?? "turn",
    ...(params.emit !== undefined ? { emit: params.emit } : {}),
  };
  const tools = buildTurnTools(
    params.ctx,
    params.mode,
    capture,
    repair,
    params.caps.repairAttempts,
    emitter,
  );

  const request: {
    -readonly [K in keyof SessionTurnRequest]: SessionTurnRequest[K];
  } = { systemPrompt: params.systemPrompt, prompt: params.prompt, tools };
  if (params.thinking !== undefined) request.thinking = params.thinking;
  if (params.caps.maxOutputTokens !== undefined)
    request.maxOutputTokens = params.caps.maxOutputTokens;
  if (params.signal !== undefined) request.signal = params.signal;
  const onToken = params.onToken;
  const onStreamChunk = params.onStreamChunk;
  if (onToken !== undefined || onStreamChunk !== undefined) {
    request.onEvent = (event: StreamEvent) => {
      if (event.type === "text") onStreamChunk?.(event.delta);
      onToken?.({ type: event.type, text: event.delta });
    };
  }

  // The harness loop repairs invalid tool calls within a turn (an error tool-result
  // makes the model retry). A value turn that ends with NO foom_return is repaired
  // here: re-prompt the same session (transcript continues) up to repairAttempts.
  let assistantText = "";
  for (let attempt = 0; ; attempt += 1) {
    const turnPromise = params.session.runTurn(request);
    const result =
      params.caps.maxTurnDurationMs === undefined
        ? await turnPromise
        : await withTimeout(turnPromise, params.caps.maxTurnDurationMs);
    assistantText = result.assistantText;
    enforceCaps(params.caps, params.fold(accountFromDelta(result.usage, params.ctx.depth())));

    if (capture.fatal !== undefined) throw capture.fatal;
    if (capture.thrown !== undefined) {
      throw new FoomtimeThrowError(capture.thrown.message, capture.thrown.code);
    }
    if (params.mode.kind === "text") return { kind: "text", text: assistantText };
    if (capture.has) return { kind: "value", value: capture.value };

    if (attempt >= params.caps.repairAttempts) {
      throw new FoomtimeReturnError("the agent produced no foom_return value");
    }
    emitter.emit?.({ type: "repair", span: emitter.span, attempt: attempt + 1 });
    request.prompt = "You did not call foom_return. Call foom_return now with the final value.";
  }
}
