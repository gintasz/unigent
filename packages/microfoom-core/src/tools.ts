// The FOOM tool semantics + the one turn coordinator, shared by every harness
// (ADR-0002 rev). The harness loop calls these tools' execute(); core decides
// what they do: foom_call dispatches an exposed method, foom_return validates and
// captures the value, foom_throw aborts with a code, foom_inspect returns a
// parameter schema. Errors are repairable (returned as error tool-results so the
// model corrects) or terminal (captured and thrown after the turn). Public errors
// are used directly — this is the harness seam, past the internal core.

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ConcurrencyLease } from "./concurrency.js";
import type { RepairChannel } from "./errors.js";
import {
  FoomBudgetExceededError,
  FoomCallDepthError,
  FoomCancelledError,
  FoomConfigError,
  FoomError,
  FoomHarnessUnavailableError,
  FoomRepairExhaustedError,
  FoomThrowError,
  FoomTimeoutError,
  FoomTokenLimitExceededError,
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
  SessionTurnResult,
  StreamEvent,
  ToolExecResult,
} from "./session.js";
import { formatIssues, standardInputJsonSchema } from "./standard_schema.js";
import { accountFromDelta, type UsageAccount } from "./usage.js";

/** Per-run dispatch surface the coordinator needs (built by the program facade). */
interface ProgramTurnContext {
  /** Invoke an exposed method with a raw args object; throws on method failure. */
  readonly invoke: (method: string, args: unknown) => Promise<string>;
  /** True if the method is exposed (agent-callable). */
  readonly isExposed: (method: string) => boolean;
  /** JSON Schema of a method's parameters (for foom_inspect and the `{tool}` tier). */
  readonly paramSchema: (method: string) => JsonSchema | undefined;
  /** Validate a raw args object against a method's derived schema (undefined → no schema). */
  readonly validateArgs: (
    method: string,
    args: unknown,
  ) => Promise<readonly StandardSchemaV1.Issue[] | undefined>;
  /** Exposed methods advertised as their own native tool (`{tool}` tier). */
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
type TurnMode =
  | { readonly kind: "text" }
  | { readonly kind: "value"; readonly schema: StandardSchemaV1 }
  | { readonly kind: "do" };

/** What a turn produced. */
type TurnOutcome =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "do" };

/** Effective caps for a turn (already cascaded/resolved). */
interface ResolvedCaps {
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
  fatal?: FoomError;
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

/** Shared dependencies the control-tool factories close over. */
interface ToolDeps {
  readonly ctx: ProgramTurnContext;
  readonly capture: Capture;
  readonly dispatch: (method: string, args: unknown) => Promise<ToolExecResult>;
  /** repairableThenMaybeStop: count a repairable miss, stop once exhausted. */
  readonly miss: (content: string, channel: RepairChannel) => ToolExecResult;
}

/** foom_call: dispatch an exposed method with a generic arguments object. */
function callTool(d: ToolDeps): NeutralToolDef {
  return {
    name: CONTROL_TOOLS.call,
    description: CONTROL_TOOL_DESCRIPTIONS[CONTROL_TOOLS.call],
    promptSnippet: CONTROL_TOOL_SNIPPETS[CONTROL_TOOLS.call],
    promptGuidelines: CONTROL_TOOL_GUIDELINES[CONTROL_TOOLS.call],
    parameters: objectSchema({ method: { type: "string" }, arguments: { type: "object" } }, [
      "method",
    ]),
    execute: async (args: unknown): Promise<ToolExecResult> => {
      const method = field(args, "method");
      if (typeof method !== "string") {
        return d.miss(TOOL_RESULTS.invalidArguments("`method` must be a string"), "args");
      }
      return d.dispatch(method, field(args, "arguments") ?? {});
    },
  };
}

/** foom_inspect: return a method's parameter schema (no dispatch, no repair cost). */
function inspectTool(d: ToolDeps): NeutralToolDef {
  return {
    name: CONTROL_TOOLS.inspect,
    description: CONTROL_TOOL_DESCRIPTIONS[CONTROL_TOOLS.inspect],
    promptSnippet: CONTROL_TOOL_SNIPPETS[CONTROL_TOOLS.inspect],
    promptGuidelines: CONTROL_TOOL_GUIDELINES[CONTROL_TOOLS.inspect],
    parameters: objectSchema({ method: { type: "string" } }, ["method"]),
    // eslint-disable-next-line @typescript-eslint/require-await -- async satisfies the Tool `execute` port (Promise<ToolExecResult>); foom_inspect is synchronous.
    execute: async (args: unknown): Promise<ToolExecResult> => {
      const method = field(args, "method");
      if (typeof method !== "string") {
        return d.miss(TOOL_RESULTS.invalidArguments("`method` must be a string"), "args");
      }
      if (!d.ctx.isExposed(method)) {
        return d.miss(TOOL_RESULTS.notExposed(method), "dispatch");
      }
      return ok(JSON.stringify(d.ctx.paramSchema(method) ?? { type: "object" }));
    },
  };
}

/** foom_throw: abort the turn with a message and an optional code (F7). */
function throwTool(d: ToolDeps): NeutralToolDef {
  return {
    name: CONTROL_TOOLS.throw,
    description: CONTROL_TOOL_DESCRIPTIONS[CONTROL_TOOLS.throw],
    promptSnippet: CONTROL_TOOL_SNIPPETS[CONTROL_TOOLS.throw],
    promptGuidelines: CONTROL_TOOL_GUIDELINES[CONTROL_TOOLS.throw],
    parameters: objectSchema({ message: { type: "string" }, code: { type: "string" } }, [
      "message",
    ]),
    // eslint-disable-next-line @typescript-eslint/require-await -- async satisfies the Tool `execute` port (Promise<ToolExecResult>); foom_throw is synchronous.
    execute: async (args: unknown): Promise<ToolExecResult> => {
      const message = field(args, "message");
      const code = field(args, "code");
      if (typeof message !== "string") {
        return d.miss(TOOL_RESULTS.invalidArguments("`message` must be a string"), "args");
      }
      if (code !== undefined && typeof code !== "string") {
        return d.miss(TOOL_RESULTS.invalidArguments("`code` must be a string"), "args");
      }
      // `code` is optional: omitted → the default (`foom_throw` always carries one, F7).
      d.capture.thrown = { message, code: code ?? DEFAULT_THROW_CODE };
      d.capture.has = true;
      return stop(TOOL_RESULTS.raised);
    },
  };
}

/** foom_return for a value turn: validate the payload against the turn schema. */
function valueReturnTool(schema: StandardSchemaV1, d: ToolDeps): NeutralToolDef {
  // Advertise the expected return shape when the validator can produce one
  // (Standard JSON Schema); otherwise leave it open and rely on repair.
  const valueSchema = standardInputJsonSchema(schema) ?? {};
  return {
    name: CONTROL_TOOLS.return,
    description: CONTROL_TOOL_DESCRIPTIONS[CONTROL_TOOLS.return],
    promptSnippet: CONTROL_TOOL_SNIPPETS[CONTROL_TOOLS.return],
    promptGuidelines: CONTROL_TOOL_GUIDELINES[CONTROL_TOOLS.return],
    parameters: objectSchema({ value: valueSchema }, ["value"]),
    execute: async (args: unknown): Promise<ToolExecResult> => {
      const result = await Promise.resolve(schema["~standard"].validate(field(args, "value")));
      if (result.issues !== undefined) {
        return d.miss(TOOL_RESULTS.invalidReturn(formatIssues(result.issues)), "return");
      }
      d.capture.value = result.value;
      d.capture.has = true;
      return stop(TOOL_RESULTS.returned);
    },
  };
}

/** foom_return for a `do` turn: no payload, just terminates (mirrors `return;`). */
function doReturnTool(d: ToolDeps): NeutralToolDef {
  return {
    name: CONTROL_TOOLS.return,
    description: DONE_RETURN_DESCRIPTION,
    parameters: objectSchema({}, []),
    // eslint-disable-next-line @typescript-eslint/require-await -- async satisfies the Tool `execute` port; foom_return just flips a capture flag synchronously.
    execute: async () => {
      d.capture.has = true;
      return stop(TOOL_RESULTS.returned);
    },
  };
}

/** Each exposed `{tool}`-tier method advertised as its own native tool. */
function tierTools(d: ToolDeps): NeutralToolDef[] {
  return d.ctx.toolTierMethods.map((method) => ({
    name: method.name,
    description: method.description,
    ...(method.promptSnippet === undefined ? {} : { promptSnippet: method.promptSnippet }),
    ...(method.promptGuidelines === undefined ? {} : { promptGuidelines: method.promptGuidelines }),
    parameters: d.ctx.paramSchema(method.name) ?? { type: "object" },
    execute: async (args: unknown): Promise<ToolExecResult> => d.dispatch(method.name, args),
  }));
}

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
      capture.fatal = new FoomRepairExhaustedError(
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
        schema === undefined
          ? formatIssues(issues)
          : `${formatIssues(issues)}. Expected schema: ${JSON.stringify(schema)}`;
      return repairableThenMaybeStop(TOOL_RESULTS.invalidArguments(detail), "args");
    }
    emitter.emit?.({ type: "foom_call", span: emitter.span, method });
    try {
      return ok(await ctx.invoke(method, args));
    } catch (error) {
      if (error instanceof FoomThrowError) {
        capture.thrown = { message: error.message, code: error.code };
        capture.has = true;
        return stop(TOOL_RESULTS.raised);
      }
      if (error instanceof FoomError) {
        capture.fatal = error;
        capture.has = true;
        return stop(TOOL_RESULTS.failed);
      }
      throw error;
    }
  };

  const deps: ToolDeps = { ctx, capture, dispatch, miss: repairableThenMaybeStop };
  const tools = [callTool(deps), inspectTool(deps), throwTool(deps)];
  if (mode.kind === "value") {
    tools.push(valueReturnTool(mode.schema, deps));
  } else if (mode.kind === "do") {
    tools.push(doReturnTool(deps));
  }
  tools.push(...tierTools(deps));
  return tools;
}

/**
 * Settle a harness turn against the two reasons to stop waiting for it before it
 * finishes naturally: an external abort (`signal`) and the per-turn timeout (`ms`).
 * Either rejects the awaiter *immediately* — decoupling "stop waiting" (here) from
 * "stop working" (the adapter honouring `request.signal` to tear the turn down).
 * Without this, abort latency is the downstream's teardown latency: a child that
 * traps SIGTERM, a server that finishes the run first, or a harness that ignores
 * the signal entirely all make the turn run to completion before the awaiter
 * unblocks. The loser promise keeps running (its work is being cancelled via the
 * signal); we swallow its late settlement so it can't surface as an unhandled
 * rejection.
 */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- builds timing/abort plumbing via `new Promise`; `async` would wrap a promise in a promise for nothing.
function settleTurn<T>(
  promise: Promise<T>,
  ms: number | undefined,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer =
      ms === undefined
        ? undefined
        : setTimeout(() => reject(new FoomTimeoutError(`turn exceeded ${ms}ms`)), ms);
    const onAbort = (): void => reject(new FoomCancelledError("the agent run was aborted"));
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    promise.then(resolve, reject).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

function enforceCaps(caps: ResolvedCaps, usage: UsageAccount): void {
  if (caps.maxBudgetUsd !== undefined) {
    if (usage.costUsd === undefined) {
      // The cap is unenforceable, not exceeded — a misconfiguration (no pricing for
      // this model), surfaced the moment usage is known rather than silently never
      // enforcing it (a cost/security footgun).
      throw new FoomConfigError(
        "maxBudgetUsd is set but the model cost is underivable (no pricing) — the cap cannot be enforced",
      );
    }
    if (usage.costUsd > caps.maxBudgetUsd) {
      throw new FoomBudgetExceededError(`cost $${usage.costUsd} exceeds cap $${caps.maxBudgetUsd}`);
    }
  }
  if (caps.maxOutputTokens !== undefined && usage.outputTokens > caps.maxOutputTokens) {
    throw new FoomTokenLimitExceededError(
      `output tokens ${usage.outputTokens} exceeds cap ${caps.maxOutputTokens}`,
    );
  }
}

/** Parameters for one coordinated turn. */
interface RunTurnParams {
  readonly session: HarnessSession;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly mode: TurnMode;
  readonly ctx: ProgramTurnContext;
  readonly caps: ResolvedCaps;
  readonly fold: (delta: UsageAccount) => UsageAccount;
  readonly thinking?: string;
  readonly tools?: readonly string[];
  readonly omitBasePrompt?: boolean;
  /** Re-run a turn on a transient harness failure up to this many times (default 0). */
  readonly retries?: number;
  readonly onToken?: (token: LLMToken) => void;
  readonly onStreamChunk?: (chunk: string) => void;
  readonly signal?: AbortSignal;
  readonly capacityLease?: ConcurrencyLease;
  readonly emit?: (event: AgentEvent) => void;
  readonly span?: string;
}

/** A writable SessionTurnRequest the coordinator builds up and re-prompts. */
type MutableTurnRequest = { -readonly [K in keyof SessionTurnRequest]: SessionTurnRequest[K] };

/** Assemble the harness turn request, adding the optional fields only when set
 *  (so an absent value never overrides a harness/scope default). */
function buildTurnRequest(
  params: RunTurnParams,
  tools: ReturnType<typeof buildTurnTools>,
): MutableTurnRequest {
  const request: MutableTurnRequest = {
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
    tools,
  };
  if (params.thinking !== undefined) {
    request.thinking = params.thinking;
  }
  if (params.tools !== undefined) {
    request.allowedTools = params.tools;
  }
  if (params.omitBasePrompt !== undefined) {
    request.omitBasePrompt = params.omitBasePrompt;
  }
  if (params.caps.maxOutputTokens !== undefined) {
    request.maxOutputTokens = params.caps.maxOutputTokens;
  }
  if (params.signal !== undefined) {
    request.signal = params.signal;
  }
  return request;
}

function releaseCapacityDuringTool(
  tool: NeutralToolDef,
  lease: ConcurrencyLease | undefined,
): NeutralToolDef {
  if (lease === undefined) {
    return tool;
  }
  return {
    ...tool,
    execute: async (args: unknown): Promise<ToolExecResult> => {
      lease.release();
      try {
        return await tool.execute(args);
      } finally {
        await lease.reacquire();
      }
    },
  };
}

/** Bridge the harness's per-turn stream into the run's neutral event stream: token
 *  deltas reach onToken/onStreamChunk, and every chunk also folds into a transcript
 *  event (assistant prose/reasoning, tool calls/results) tagged with `span`. */
function makeTurnEventForwarder(
  span: string,
  emit: Emitter["emit"],
  onToken: RunTurnParams["onToken"],
  onStreamChunk: RunTurnParams["onStreamChunk"],
): (event: StreamEvent) => void {
  return (event: StreamEvent) => {
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
}

/** Interpret one completed attempt's captured state: rethrow a fatal/`foom_throw`,
 *  return the terminal outcome for a text turn or a captured value/done, or return
 *  undefined to signal "no result yet — repair and retry". */
function settleOutcome(
  capture: Capture,
  mode: RunTurnParams["mode"],
  assistantText: string,
): TurnOutcome | undefined {
  if (capture.fatal !== undefined) {
    throw capture.fatal;
  }
  if (capture.thrown !== undefined) {
    throw new FoomThrowError(capture.thrown.message, capture.thrown.code);
  }
  if (mode.kind === "text") {
    return { kind: "text", text: assistantText };
  }
  if (capture.has) {
    return mode.kind === "do" ? { kind: "do" } : { kind: "value", value: capture.value };
  }
  return;
}

/**
 * Run one harness turn, re-running it on a *transient* harness failure
 * ({@link FoomHarnessUnavailableError}) up to `params.retries` times (default 0).
 * The model's own in-turn tool repair is separate; this only covers the harness
 * itself failing (provider/network/no-result). A deliberate rejection or an aborted
 * signal is never retried. The per-turn timeout applies to each attempt.
 */
async function runHarnessTurn(
  params: RunTurnParams,
  request: MutableTurnRequest,
): Promise<SessionTurnResult> {
  const max = params.retries ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const turnPromise = params.session.runTurn(request);
      return await settleTurn(turnPromise, params.caps.maxTurnDurationMs, params.signal);
    } catch (error) {
      if (
        attempt < max &&
        params.signal?.aborted !== true &&
        error instanceof FoomHarnessUnavailableError
      ) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * The repair loop: run the turn, interpret the outcome, and on a value/`do` turn
 * with no foom_return re-prompt the same session (transcript continues) up to
 * repairAttempts. The harness already repairs invalid tool calls within a turn.
 */
async function runTurnWithRepair(
  params: RunTurnParams,
  request: MutableTurnRequest,
  capture: Capture,
  emitter: Emitter,
): Promise<TurnOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    emitter.emit?.({ type: "user_prompt", span: emitter.span, text: request.prompt });
    const result = await runHarnessTurn(params, request);
    enforceCaps(params.caps, params.fold(accountFromDelta(result.usage, params.ctx.depth())));

    const outcome = settleOutcome(capture, params.mode, result.assistantText);
    if (outcome !== undefined) {
      return outcome;
    }

    if (attempt >= params.caps.repairAttempts) {
      throw new FoomRepairExhaustedError(
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

/**
 * Run one text/value turn over a harness session. The harness owns the loop and
 * executes the FOOM tools; this interprets the captured outcome. Shared by the pi
 * session and the fake test session.
 */
async function runProgramTurn(params: RunTurnParams): Promise<TurnOutcome> {
  if (params.caps.maxCallDepth !== undefined && params.ctx.depth() > params.caps.maxCallDepth) {
    throw new FoomCallDepthError(
      `call depth ${params.ctx.depth()} exceeds maxCallDepth ${params.caps.maxCallDepth}`,
    );
  }
  const capture: Capture = { has: false };
  const repair = { count: 0 };
  const emitter: Emitter = {
    span: params.span ?? "turn",
    ...(params.emit === undefined ? {} : { emit: params.emit }),
  };
  const tools = buildTurnTools(
    params.ctx,
    params.mode,
    capture,
    repair,
    params.caps.repairAttempts,
    emitter,
  ).map((tool) => releaseCapacityDuringTool(tool, params.capacityLease));

  const request = buildTurnRequest(params, tools);
  request.onEvent = makeTurnEventForwarder(
    emitter.span,
    emitter.emit,
    params.onToken,
    params.onStreamChunk,
  );

  return runTurnWithRepair(params, request, capture, emitter);
}

export type { ProgramTurnContext, ResolvedCaps, RunTurnParams, TurnMode, TurnOutcome };
export { runProgramTurn };
