// The FOOM tool semantics + the one turn coordinator, shared by every harness
// (ADR-0002 rev). The harness loop calls these tools' execute(); core decides
// what they do: foom_call dispatches an exposed method, foom_return validates and
// captures the value, foom_throw aborts with a code, foom_inspect returns a
// parameter schema. Errors are repairable (returned as error tool-results so the
// model corrects) or terminal (captured and thrown after the turn). Public errors
// are used directly — this is the harness seam, past the internal core.

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RepairChannel } from "./errors.js";
import {
  FoomtimeBudgetExceededError,
  FoomtimeCallDepthError,
  FoomtimeConfigError,
  FoomtimeError,
  FoomtimeRepairExhaustedError,
  FoomtimeThrowError,
  FoomtimeTimeoutError,
  FoomtimeTokenLimitExceededError,
} from "./errors.js";
import type { AgentEvent } from "./events.js";
import type { LLMToken } from "./options.js";
import {
  CONTROL_TOOL_DESCRIPTIONS,
  CONTROL_TOOL_GUIDELINES,
  CONTROL_TOOL_SNIPPETS,
  CONTROL_TOOLS,
  DEFAULT_THROW_CODE,
  DONE_RETURN_DESCRIPTION,
  TOOL_RESULTS,
} from "./protocol.js";
import type {
  HarnessSession,
  JsonSchema,
  NeutralToolDef,
  SessionTurnRequest,
  StreamEvent,
  ToolExecResult,
} from "./session.js";
import { formatIssues, standardInputJsonSchema } from "./standard_schema.js";
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
  readonly toolTierMethods: ReadonlyArray<{
    name: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: readonly string[];
  }>;
  /** Current nesting depth (for usage accounting). */
  readonly depth: () => number;
}

/** How a turn ends: streamed prose (`text`), a schema-validated value, or `do` —
 *  act via tools and terminate with a no-arg foom_return (no value, cheap). */
export type TurnMode =
  | { readonly kind: "text" }
  | { readonly kind: "value"; readonly schema: StandardSchemaV1 }
  | { readonly kind: "do" };

/** What a turn produced. */
export type TurnOutcome =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "do" };

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
  // `channel` records which fault exhausted the loop (surfaced on the thrown error).
  const repairableThenMaybeStop = (content: string, channel: RepairChannel): ToolExecResult => {
    repair.count += 1;
    emitter.emit?.({ type: "repair", span: emitter.span, attempt: repair.count });
    if (repair.count > repairAttempts) {
      capture.fatal = new FoomtimeRepairExhaustedError(
        "too many consecutive invalid attempts",
        channel,
      );
      capture.has = true;
      return stop(content);
    }
    return fail(content);
  };

  const dispatch = async (method: string, args: unknown): Promise<ToolExecResult> => {
    if (!ctx.isExposed(method)) {
      return repairableThenMaybeStop(TOOL_RESULTS.notExposed(method), "dispatch");
    }
    const issues = await ctx.validateArgs(method, args);
    if (issues !== undefined) {
      // Show the expected schema alongside the issues so the model can correct in
      // one repair instead of guessing (foom_call's `arguments` is generic, so the
      // per-method schema isn't advertised upfront). Only when a schema exists.
      const schema = ctx.paramSchema(method);
      const detail =
        schema !== undefined
          ? `${formatIssues(issues)}. Expected schema: ${JSON.stringify(schema)}`
          : formatIssues(issues);
      return repairableThenMaybeStop(TOOL_RESULTS.invalidArguments(detail), "args");
    }
    emitter.emit?.({ type: "foom_call", span: emitter.span, method });
    try {
      return ok(await ctx.invoke(method, args));
    } catch (error) {
      if (error instanceof FoomtimeThrowError) {
        capture.thrown = { message: error.message, code: error.code };
        capture.has = true;
        return stop(TOOL_RESULTS.raised);
      }
      if (error instanceof FoomtimeError) {
        capture.fatal = error;
        capture.has = true;
        return stop(TOOL_RESULTS.failed);
      }
      throw error;
    }
  };

  const tools: NeutralToolDef[] = [
    {
      name: CONTROL_TOOLS.call,
      description: CONTROL_TOOL_DESCRIPTIONS[CONTROL_TOOLS.call],
      promptSnippet: CONTROL_TOOL_SNIPPETS[CONTROL_TOOLS.call],
      promptGuidelines: CONTROL_TOOL_GUIDELINES[CONTROL_TOOLS.call],
      parameters: objectSchema({ method: { type: "string" }, arguments: { type: "object" } }, [
        "method",
      ]),
      execute: async (args) => {
        const method = field(args, "method");
        if (typeof method !== "string")
          return repairableThenMaybeStop(
            TOOL_RESULTS.invalidArguments("`method` must be a string"),
            "args",
          );
        return dispatch(method, field(args, "arguments") ?? {});
      },
    },
    {
      name: CONTROL_TOOLS.inspect,
      description: CONTROL_TOOL_DESCRIPTIONS[CONTROL_TOOLS.inspect],
      promptSnippet: CONTROL_TOOL_SNIPPETS[CONTROL_TOOLS.inspect],
      promptGuidelines: CONTROL_TOOL_GUIDELINES[CONTROL_TOOLS.inspect],
      parameters: objectSchema({ method: { type: "string" } }, ["method"]),
      execute: async (args) => {
        const method = field(args, "method");
        if (typeof method !== "string")
          return repairableThenMaybeStop(
            TOOL_RESULTS.invalidArguments("`method` must be a string"),
            "args",
          );
        if (!ctx.isExposed(method))
          return repairableThenMaybeStop(TOOL_RESULTS.notExposed(method), "dispatch");
        return ok(JSON.stringify(ctx.paramSchema(method) ?? { type: "object" }));
      },
    },
    {
      name: CONTROL_TOOLS.throw,
      description: CONTROL_TOOL_DESCRIPTIONS[CONTROL_TOOLS.throw],
      promptSnippet: CONTROL_TOOL_SNIPPETS[CONTROL_TOOLS.throw],
      promptGuidelines: CONTROL_TOOL_GUIDELINES[CONTROL_TOOLS.throw],
      parameters: objectSchema({ message: { type: "string" }, code: { type: "string" } }, [
        "message",
      ]),
      execute: async (args) => {
        const message = field(args, "message");
        const code = field(args, "code");
        if (typeof message !== "string") {
          return repairableThenMaybeStop(
            TOOL_RESULTS.invalidArguments("`message` must be a string"),
            "args",
          );
        }
        if (code !== undefined && typeof code !== "string") {
          return repairableThenMaybeStop(
            TOOL_RESULTS.invalidArguments("`code` must be a string"),
            "args",
          );
        }
        // `code` is optional: omitted → the default (`foom_throw` always carries one, F7).
        capture.thrown = { message, code: code ?? DEFAULT_THROW_CODE };
        capture.has = true;
        return stop(TOOL_RESULTS.raised);
      },
    },
  ];

  if (mode.kind === "value") {
    const schema = mode.schema;
    // Advertise the expected return shape when the validator can produce one
    // (Standard JSON Schema); otherwise leave it open and rely on repair.
    const valueSchema = standardInputJsonSchema(schema) ?? {};
    tools.push({
      name: CONTROL_TOOLS.return,
      description: CONTROL_TOOL_DESCRIPTIONS[CONTROL_TOOLS.return],
      promptSnippet: CONTROL_TOOL_SNIPPETS[CONTROL_TOOLS.return],
      promptGuidelines: CONTROL_TOOL_GUIDELINES[CONTROL_TOOLS.return],
      parameters: objectSchema({ value: valueSchema }, ["value"]),
      execute: async (args) => {
        const result = await Promise.resolve(schema["~standard"].validate(field(args, "value")));
        if (result.issues !== undefined) {
          return repairableThenMaybeStop(
            TOOL_RESULTS.invalidReturn(formatIssues(result.issues)),
            "return",
          );
        }
        capture.value = result.value;
        capture.has = true;
        return stop(TOOL_RESULTS.returned);
      },
    });
  } else if (mode.kind === "do") {
    // A `do` turn carries no value: foom_return takes no arguments and merely
    // terminates the turn (mirrors `return;`). The cheap exit that avoids a final
    // prose essay — same mechanism as value mode, minus the payload + validation.
    tools.push({
      name: CONTROL_TOOLS.return,
      description: DONE_RETURN_DESCRIPTION,
      parameters: objectSchema({}, []),
      execute: async () => {
        capture.has = true;
        return stop(TOOL_RESULTS.returned);
      },
    });
  }

  for (const method of ctx.toolTierMethods) {
    tools.push({
      name: method.name,
      description: method.description,
      ...(method.promptSnippet !== undefined ? { promptSnippet: method.promptSnippet } : {}),
      ...(method.promptGuidelines !== undefined
        ? { promptGuidelines: method.promptGuidelines }
        : {}),
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
      // The cap is unenforceable, not exceeded — a misconfiguration (no pricing for
      // this model), surfaced the moment usage is known rather than silently never
      // enforcing it (a cost/security footgun).
      throw new FoomtimeConfigError(
        "maxBudgetUsd is set but the model cost is underivable (no pricing) — the cap cannot be enforced",
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
  readonly allowedTools?: readonly string[];
  readonly onToken?: (token: LLMToken) => void;
  readonly onStreamChunk?: (chunk: string) => void;
  readonly signal?: AbortSignal;
  readonly emit?: (event: AgentEvent) => void;
  readonly span?: string;
}

/**
 * Run one text/value turn over a harness session. The harness owns the loop and
 * executes the FOOM tools; this interprets the captured outcome. Shared by the pi
 * session and the fake test session.
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
  if (params.allowedTools !== undefined) request.allowedTools = params.allowedTools;
  if (params.caps.maxOutputTokens !== undefined)
    request.maxOutputTokens = params.caps.maxOutputTokens;
  if (params.signal !== undefined) request.signal = params.signal;
  // Bridge the harness's per-turn stream into the run's neutral event stream: token
  // deltas reach onToken/onStreamChunk as before, and every chunk also folds into a
  // transcript event (assistant prose/reasoning, tool calls) tagged with this span.
  const onToken = params.onToken;
  const onStreamChunk = params.onStreamChunk;
  const emit = emitter.emit;
  const span = emitter.span;
  request.onEvent = (event: StreamEvent) => {
    switch (event.type) {
      case "text":
        onStreamChunk?.(event.delta);
        onToken?.({ type: "text", text: event.delta });
        emit?.({ type: "msg_text", span, delta: event.delta });
        break;
      case "reasoning":
        onToken?.({ type: "reasoning", text: event.delta });
        emit?.({ type: "msg_thinking", span, delta: event.delta });
        break;
      case "message_start":
        emit?.({ type: "msg_start", span });
        break;
      case "message_end":
        emit?.({ type: "msg_end", span });
        break;
      case "tool_call":
        emit?.({
          type: "tool_start",
          span,
          callId: event.callId,
          name: event.name,
          args: event.args,
        });
        break;
      case "tool_result":
        emit?.({
          type: "tool_end",
          span,
          callId: event.callId,
          content: event.content,
          isError: event.isError,
        });
        break;
    }
  };

  // The harness loop repairs invalid tool calls within a turn (an error tool-result
  // makes the model retry). A value turn that ends with NO foom_return is repaired
  // here: re-prompt the same session (transcript continues) up to repairAttempts.
  let assistantText = "";
  for (let attempt = 0; ; attempt += 1) {
    emit?.({ type: "user_prompt", span, text: request.prompt });
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
    if (capture.has) {
      return params.mode.kind === "do" ? { kind: "do" } : { kind: "value", value: capture.value };
    }

    if (attempt >= params.caps.repairAttempts) {
      throw new FoomtimeRepairExhaustedError(
        params.mode.kind === "do"
          ? "the agent did not signal completion (no foom_return)"
          : "the agent produced no foom_return value",
        "return",
      );
    }
    emitter.emit?.({ type: "repair", span: emitter.span, attempt: attempt + 1 });
    request.prompt =
      params.mode.kind === "do" ? TOOL_RESULTS.missingDone : TOOL_RESULTS.missingReturn;
  }
}
