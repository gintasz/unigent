// The public facade (F6). A program extends Program(schema); `this.agent` runs
// prompts. The harness owns the model loop (ADR-0002 rev) — this facade resolves
// the config cascade (F5), builds the per-run dispatch context + tool semantics
// (tools.ts), opens a harness session per stateless turn (or once per session()),
// runs the shared coordinator, folds usage, and surfaces failures as the thrown
// public taxonomy (F7). Plain Promise/async throughout; no effect-system layer.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConcurrencyGate, type ConcurrencyLease } from "./concurrency.js";
import { type AgentConfig, durationToMs, mergeConfigChain } from "./config.js";
import {
  FoomCancelledError,
  FoomConcurrencyError,
  FoomConfigError,
  FoomDispatchError,
  FoomError,
  FoomInputError,
  FoomTimeoutError,
} from "./errors.js";
import type { AgentEvent, AgentTraceExporter } from "./events.js";
import type { AgentOptions } from "./options.js";
import { type ExposeMeta, exposedMethods, readClassMeta } from "./registry.js";
import { type AgentResult, type AgentTextStream, makeResult, makeTextStream } from "./result.js";
import { type DerivedParameters, deriveMethodParameters } from "./schema_derive.js";
import type { HarnessSession, HarnessSessionOptions, OpenSession } from "./session.js";
import { standardInputJsonSchema } from "./standard_schema.js";
import type { TurnStore } from "./store.js";
import {
  type ProgramTurnContext,
  type ResolvedCaps,
  type RunTurnParams,
  runProgramTurn,
  type TurnMode,
  type TurnOutcome,
} from "./tools.js";
import {
  type AgentUsage,
  combineUsage,
  emptyUsage,
  toAgentUsage,
  type UsageAccount,
} from "./usage.js";

/**
 * A streaming prose turn from a template literal — freeform natural language.
 * Awaiting yields the full message; `for await` streams chunks.
 *
 * @example
 * ```ts
 * await this.agent.prose`Briefly explain ${topic}.`;
 * ```
 */
type AgentProseTemplate = (strings: TemplateStringsArray, ...values: unknown[]) => AgentTextStream;

/**
 * A structured-value turn: pass a Standard Schema, then tag a template literal.
 * The agent must `foom_return` a value; it is validated against the schema and the
 * awaited result is typed as the schema's output.
 *
 * @example
 * ```ts
 * const n = await this.agent.value(z.number().int())`
 *   Pick a number between 0 and 100, then foom_return it.`;
 * ```
 */
type AgentValueTemplate = <S extends StandardSchemaV1>(
  schema: S,
) => (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => AgentResult<StandardSchemaV1.InferOutput<S>>;

/**
 * An act turn — do the work (via tools), return nothing. The cheap default for
 * instructions whose payload you don't need (no schema, no final prose).
 *
 * @example
 * ```ts
 * await this.agent.do`Read the failing test and fix the bug it covers.`;
 * ```
 */
type AgentDoTemplate = (strings: TemplateStringsArray, ...values: unknown[]) => AgentResult<void>;

/** The output modes available wherever prompts run: act (`do`), `prose`, `value`. */
interface AgentRun {
  /** Act turn: run instructions for their side effects, resolve to `void`. The
   *  cheapest mode — no schema, no final message. See {@link AgentDoTemplate}. */
  readonly do: AgentDoTemplate;
  /** Prose turn: freeform natural-language text, streamable. See
   *  {@link AgentProseTemplate}. */
  readonly prose: AgentProseTemplate;
  /** Value turn: schema-validated structured result via `foom_return`. See
   *  {@link AgentValueTemplate}. */
  readonly value: AgentValueTemplate;
}

/** A stateful conversation (shared transcript). Single-flight; fork() to branch. */
interface AgentSession extends AgentRun {
  with: (options: AgentOptions) => AgentSession;
  fork: () => AgentSession;
  readonly usage: AgentUsage;
}

/** Per-instance run context, injected as `this.agent`. Stateless text/value. */
interface AgentProgramContext<TProgram extends object> extends AgentRun {
  readonly program: TProgram;
  readonly usage: AgentUsage;
  session: (options?: AgentOptions) => AgentSession;
  with: (options: AgentOptions) => AgentProgramContext<TProgram>;
}

/**
 * A named span handle (trace surface, F8). Surfaced on the context only when
 * `@microfoom/core/trace` is imported (which augments AgentProgramContext); the
 * methods exist at runtime.
 */
interface AgentScope extends AgentRun {
  with: (options: AgentOptions) => AgentScope;
  scope: (name: string) => AgentScope;
  annotate: (attributes: Record<string, unknown>) => void;
  log: (message: string, level?: "info" | "warn" | "error") => void;
}

/** The trace members added to the context (gated behind the trace entry). */
interface TraceContext {
  scope: (name: string) => AgentScope;
  onEvent: (handler: (event: AgentEvent) => void) => void;
  export: (exporter: AgentTraceExporter) => void;
}

// ─── Program base + Program(schema) ──────────────────────────────────────────

const contexts = new WeakMap<object, AgentProgramContext<object>>();

/** Internal: the runner wires `this.agent` after constructing a program. */
function attachContext<P extends object>(program: P, context: AgentProgramContext<P>): void {
  contexts.set(program, context);
}

/** The program base class. Extend via Program(schema) for a typed input. */
abstract class FoomProgram<I = string[], R = unknown> {
  public static input?: StandardSchemaV1;
  public static maxProgramDuration?: string;

  protected get agent(): AgentProgramContext<this> {
    const context = contexts.get(this);
    if (context === undefined) {
      throw new FoomError(
        "this.agent is unavailable until main() runs — do not use it in the constructor or field initializers.",
      );
    }
    return context as AgentProgramContext<this>;
  }

  public abstract main(input: I): Promise<R>;
}

/**
 * Name an input schema, then `extends Program(Input)`; `main(input)` is typed from
 * it. The return type is taken from your `main` (inferred by `runProgram`), so the
 * common case needs no type arguments at all — just `extends Program(schema)`.
 *
 * @param input - A Standard Schema validating the program's `/run` input. `main`'s
 *   parameter is typed as this schema's output.
 * @returns An abstract base class to extend; implement `async main(input)`.
 * @example
 * ```ts
 * const Input = z.object({ topic: z.string() });
 *
 * @foom.config({ model: "openrouter/deepseek/deepseek-v4-flash" })
 * export default class extends Program<typeof Input, number>(Input) {
 *   async main(input: typeof Input._type): Promise<number> {
 *     return await this.agent.value(z.number().int())`Pick a number for ${input.topic}.`;
 *   }
 * }
 * ```
 */
function Program<S extends StandardSchemaV1, R = unknown>(
  input: S,
): abstract new () => FoomProgram<StandardSchemaV1.InferOutput<S>, R> {
  abstract class BoundProgram extends FoomProgram<StandardSchemaV1.InferOutput<S>, R> {
    public static override input = input;
  }
  return BoundProgram;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/** Options for running a program: the harness registry, model, source. */
interface RunProgramOptions {
  /** Named harness ports — each name opens sessions on one harness. A sole entry
   *  is the default; with several, set `defaultHarness` or select per scope via
   *  `@foom.config({ harness })` / `.with({ harness })`. */
  readonly harnesses: Record<string, OpenSession>;
  /** Widest-scope harness name. Needed only when `harnesses` has 2+ entries and
   *  no narrower scope selects one. Must be a key of `harnesses`. */
  readonly defaultHarness?: string;
  readonly model: string;
  /** Program source path — required for `foom_call` parameter derivation (ADR-0003). */
  readonly sourceFile?: string;
  /** Class name in the source file, for derivation. Defaults to the constructor name. */
  readonly className?: string;
  /** Harness-default config, the widest cascade scope. */
  readonly defaults?: AgentOptions;
  readonly signal?: AbortSignal;
  /**
   * Subscribe to the run's intrinsic event stream from outside the program (a CLI
   * or harness renderer). Attached before `main()` runs, so the auto span tree
   * (F8) is emitted from the first turn; when absent, nothing is emitted (zero
   * cost on the common path).
   */
  readonly onEvent?: (event: AgentEvent) => void;
  /**
   * Turn-result store for resume after termination: completed stateless turns are
   * recorded by a content hash of their inputs and recalled on a later run instead
   * of re-invoking the model. Omit to disable (nothing is persisted; the default).
   * Use {@link createFileTurnStore} for durable on-disk resume.
   */
  readonly store?: TurnStore;
}

// Delimiters that mark runtime-injected text (not the dev's task input). The whole
// runtime contribution — the intro AND the foom_call announcements — lives inside
// one begin/end block, so a reader (and the panel) can see exactly what microfoom
// added vs. what the program authored.
const NOTICE_BEGIN = "<!-- microfoom:begin -->";
const NOTICE_END = "<!-- microfoom:end -->";
const PROTOCOL_INTRO = "You are running inside a microfoom runtime.";

/** Wrap runtime-injected lines in one begin/end block. */
function noticeBlock(body: string): string {
  return [NOTICE_BEGIN, body, NOTICE_END].join("\n");
}

// Appended to a value turn's prompt (only). A delimited meta-notice nudging the
// model to actually terminate the turn with foom_return.
const VALUE_TURN_NOTICE = noticeBlock(
  "The user instruction expected you to end this turn with a foom_return tool call passing the result; If you cannot complete the task as the user instruction expects, or the instructions are defective or contradictory, call foom_throw instead as a last resort option.",
);

// Appended to a `do` turn's prompt: terminate with a no-arg foom_return once the
// work is done, and do NOT write a final summary (the program ignores prose here).
const DO_TURN_NOTICE = noticeBlock(
  "When the task is complete, end this turn by calling the foom_return tool with NO arguments. Do not write a summary or explanation — the program does not read it. If you cannot complete the task, or the instructions are defective or contradictory, call foom_throw instead.",
);

function pickConfig(options: AgentOptions): AgentConfig {
  // Strip the runtime-only fields (hooks, cancellation, label, store controls); the
  // rest is the inheritable config cascade.
  const {
    onToken: _onToken,
    signal: _signal,
    label: _label,
    storeKey: _storeKey,
    store: _store,
    ...config
  } = options;
  return config;
}

/** Validation failures tolerated before a turn gives up (AgentConfig default). */
const DEFAULT_REPAIR_ATTEMPTS = 3;

function resolveCaps(config: AgentConfig): ResolvedCaps {
  const caps: { -readonly [K in keyof ResolvedCaps]: ResolvedCaps[K] } = {
    repairAttempts: config.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS,
  };
  if (config.maxBudgetUsd !== undefined) {
    caps.maxBudgetUsd = config.maxBudgetUsd;
  }
  if (config.maxOutputTokens !== undefined) {
    caps.maxOutputTokens = config.maxOutputTokens;
  }
  if (config.maxCallDepth !== undefined) {
    caps.maxCallDepth = config.maxCallDepth;
  }
  if (config.maxTurnDuration !== undefined) {
    const ms = durationToMs(config.maxTurnDuration);
    if (ms === undefined) {
      throw new FoomConfigError(`invalid maxTurnDuration: ${config.maxTurnDuration}`);
    }
    caps.maxTurnDurationMs = ms;
  }
  return caps;
}

interface Runtime {
  readonly instance: object;
  readonly harnesses: Record<string, OpenSession>;
  defaults: AgentConfig;
  readonly classConfig: AgentConfig;
  readonly exposed: Map<string, ExposeMeta>;
  readonly derivations: Map<string, DerivedParameters>;
  readonly sourceFile?: string;
  readonly className: string;
  usage: UsageAccount;
  readonly listeners: Set<(event: AgentEvent) => void>;
  readonly nextSpan: () => string;
  depth: number;
  methodConfig: AgentConfig | undefined;
  readonly spanALS: AsyncLocalStorage<string | undefined>;
  /** Program-level abort signal (RunProgramOptions.signal), combined into every
   *  turn's signal so an external abort cancels the whole run. */
  readonly signal?: AbortSignal;
  readonly concurrency: ConcurrencyGate;
  /** Turn-result store for resume-after-termination; undefined → turns never stored. */
  readonly store?: TurnStore;
}

function emitAll(runtime: Runtime, event: AgentEvent): void {
  for (const listener of runtime.listeners) {
    listener(event);
  }
}

/**
 * Run `fn` inside an auto-instrumented span (F8): emits span_start/span_end with
 * wall-clock duration and parents by call structure via AsyncLocalStorage, so a
 * method invoked mid-turn nests under that turn. A no-op passthrough when nothing
 * subscribes — the common path allocates no span and touches no async storage.
 * Non-turn spans carry empty usage; the tree projection rolls usage up from the
 * turn leaves (the real harness deltas).
 */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- deliberately non-async: the no-listener fast path returns fn() untouched, with no extra microtask on the hot path.
function withSpan<T>(
  runtime: Runtime,
  name: string,
  kind: "program" | "method",
  fn: () => Promise<T>,
): Promise<T> {
  if (runtime.listeners.size === 0) {
    return fn();
  }
  const span = runtime.nextSpan();
  const parent = runtime.spanALS.getStore();
  emitAll(runtime, {
    type: "span_start",
    span,
    name,
    kind,
    ...(parent === undefined ? {} : { parent }),
  });
  const startedAt = Date.now();
  return runtime.spanALS.run(span, async () => {
    try {
      return await fn();
    } finally {
      emitAll(runtime, {
        type: "span_end",
        span,
        durationMs: Date.now() - startedAt,
        usage: toAgentUsage(emptyUsage),
      });
    }
  });
}

function deriveFor(runtime: Runtime, method: string): DerivedParameters | undefined {
  if (runtime.sourceFile === undefined) {
    return;
  }
  const cached = runtime.derivations.get(method);
  if (cached !== undefined) {
    return cached;
  }
  const derived = deriveMethodParameters(runtime.sourceFile, runtime.className, method);
  runtime.derivations.set(method, derived);
  return derived;
}

function methodConfigOf(runtime: Runtime, method: string): AgentConfig | undefined {
  const config = readClassMeta(runtime.instance)?.methods.get(method)?.config;
  return config === undefined ? undefined : pickConfig(config);
}

function buildContext(runtime: Runtime): ProgramTurnContext {
  const toolTier: Array<{
    name: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: readonly string[];
  }> = [];
  for (const [name, meta] of runtime.exposed) {
    if (meta.tier === "tool") {
      toolTier.push({
        name,
        description: meta.tool?.description ?? `Method ${name}.`,
        ...(meta.tool?.promptSnippet === undefined
          ? {}
          : { promptSnippet: meta.tool.promptSnippet }),
        ...(meta.tool?.promptGuidelines === undefined
          ? {}
          : { promptGuidelines: meta.tool.promptGuidelines }),
      });
    }
  }
  return {
    isExposed: (method: string): boolean => runtime.exposed.has(method),
    paramSchema: (method: string) => deriveFor(runtime, method)?.jsonSchema,
    toolTierMethods: toolTier,
    depth: (): number => runtime.depth,
    validateArgs: async (method: string, args: unknown) => {
      const derived = deriveFor(runtime, method);
      if (derived === undefined) {
        return;
      }
      const result = await Promise.resolve(derived.schema["~standard"].validate(args));
      return result.issues;
    },
    invoke: async (method: string, args: unknown) => {
      const derived = deriveFor(runtime, method);
      const record = (typeof args === "object" && args !== null ? args : {}) as Record<
        string,
        unknown
      >;
      const positional =
        derived === undefined ? [record] : derived.paramNames.map((name) => record[name]);
      const fn = (runtime.instance as Record<string, ((...a: unknown[]) => unknown) | undefined>)[
        method
      ];
      if (typeof fn !== "function") {
        throw new FoomDispatchError(`method "${method}" is missing`);
      }
      const previousDepth = runtime.depth;
      const previousMethodConfig = runtime.methodConfig;
      runtime.depth = previousDepth + 1;
      runtime.methodConfig = methodConfigOf(runtime, method);
      try {
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- Promise.resolve normalizes a possibly-synchronous method result; the exposed method may be sync or async.
        const result = await withSpan(runtime, method, "method", () =>
          Promise.resolve(fn.apply(runtime.instance, positional)),
        );
        return result === undefined ? "" : JSON.stringify(result);
      } finally {
        runtime.depth = previousDepth;
        runtime.methodConfig = previousMethodConfig;
      }
    },
  };
}

interface Prepared {
  readonly model: string;
  readonly systemPrompt: string;
  readonly caps: ResolvedCaps;
  readonly maxConcurrentTurns?: number;
  readonly thinking?: string;
  readonly tools?: readonly string[];
  readonly omitBasePrompt?: boolean;
  readonly retries?: number;
}

/**
 * Identity fixed when a session() opens: the composed program system prompt and the
 * base-prompt omission. Frozen at open and re-applied verbatim to every turn of the
 * session, so a later method scope or `.with()` can't drift it mid-conversation — the
 * per-harness mid-session-identity footgun (pi re-applies a changed prompt, claudecli
 * silently keeps the original via --resume). Stateless turns pass no frozen identity:
 * each opens a fresh session, so they vary freely.
 */
interface FrozenIdentity {
  readonly systemPrompt: string;
  readonly omitBasePrompt?: boolean;
}

/** Compose the program system prompt: the runtime notice block (intro + foom_call
 *  announcements) plus the dev's own systemPrompt from the merged cascade. The dev's
 *  prompt stays OUTSIDE the begin/end notice block. */
function composeProgramSystemPrompt(runtime: Runtime, merged: AgentConfig): string {
  const announcements: string[] = [];
  for (const [name, meta] of runtime.exposed) {
    if (meta.tier === "announcement" && meta.announcement !== undefined) {
      announcements.push(`- ${name}: ${meta.announcement}`);
    }
  }
  let userPrompt: string;
  if (merged.systemPrompt === undefined) {
    userPrompt = "";
  } else if ("append" in merged.systemPrompt) {
    userPrompt = merged.systemPrompt.append;
  } else {
    userPrompt = merged.systemPrompt.replace;
  }
  const runtimeBody =
    announcements.length > 0
      ? `${PROTOCOL_INTRO}\n\nMethods you may call via foom_call:\n${announcements.join("\n")}`
      : PROTOCOL_INTRO;
  return [noticeBlock(runtimeBody), userPrompt].filter((part) => part.length > 0).join("\n\n");
}

/**
 * Merge the cascade for one turn. When `frozen` is present (a stateful session) it
 * supplies the session-locked systemPrompt/omitBasePrompt verbatim; otherwise they
 * are composed from this turn's merged config (a stateless turn opens a fresh session,
 * so its identity is this turn's cascade). The per-turn fields (thinking, tools, caps,
 * retries) always come from the live merge — they are free to vary on a session.
 */
function prepare(runtime: Runtime, options: AgentOptions, frozen?: FrozenIdentity): Prepared {
  const scopes = [
    runtime.defaults,
    runtime.classConfig,
    runtime.methodConfig,
    pickConfig(options),
  ].filter((c): c is AgentConfig => c !== undefined);
  const merged = mergeConfigChain(scopes);
  if (merged.model === undefined) {
    throw new FoomConfigError("no model configured (set it via run options or @foom.config)");
  }
  const systemPrompt =
    frozen === undefined ? composeProgramSystemPrompt(runtime, merged) : frozen.systemPrompt;
  const omitBasePrompt =
    frozen === undefined ? merged.omitHarnessBasePrompt : frozen.omitBasePrompt;
  if (
    merged.maxConcurrentTurns !== undefined &&
    (!Number.isSafeInteger(merged.maxConcurrentTurns) || merged.maxConcurrentTurns < 1)
  ) {
    throw new FoomConfigError(
      `maxConcurrentTurns must be a positive integer, got ${merged.maxConcurrentTurns}`,
    );
  }
  const prepared: Prepared = {
    model: merged.model,
    systemPrompt,
    caps: resolveCaps(merged),
    ...(merged.maxConcurrentTurns === undefined
      ? {}
      : { maxConcurrentTurns: merged.maxConcurrentTurns }),
    ...(merged.thinking === undefined ? {} : { thinking: merged.thinking }),
    ...(merged.tools === undefined ? {} : { tools: merged.tools }),
    ...(omitBasePrompt === undefined ? {} : { omitBasePrompt }),
    ...(merged.retries === undefined ? {} : { retries: merged.retries }),
  };
  return prepared;
}

/**
 * Freeze a session's identity at open: compose its systemPrompt and capture
 * omitHarnessBasePrompt from the scope chain live AT THIS MOMENT — so the method
 * scope active when session() is called is baked in, and nothing applied afterward
 * (a later method dispatch, or a per-turn .with()) can change it.
 */
function freezeIdentity(runtime: Runtime, options: AgentOptions): FrozenIdentity {
  const scopes = [
    runtime.defaults,
    runtime.classConfig,
    runtime.methodConfig,
    pickConfig(options),
  ].filter((c): c is AgentConfig => c !== undefined);
  const merged = mergeConfigChain(scopes);
  return {
    systemPrompt: composeProgramSystemPrompt(runtime, merged),
    ...(merged.omitHarnessBasePrompt === undefined
      ? {}
      : { omitBasePrompt: merged.omitHarnessBasePrompt }),
  };
}

/**
 * Config fields fixed when a session() opens. A per-turn `.with()` on a session handle
 * that sets any of these is a typed error: the transcript was produced under this
 * identity, so swapping it mid-conversation diverges per harness and invalidates the
 * cached prompt prefix. Vary them by opening a new session() or via a stateless
 * this.agent turn instead.
 */
const SESSION_LOCKED_FIELDS: ReadonlyArray<keyof AgentOptions> = [
  "model",
  "harness",
  "systemPrompt",
  "omitHarnessBasePrompt",
  "skills",
  "plugins",
];

/** Reject a session `.with()` that tries to change any session-locked field. */
function assertNoLockedChange(extra: AgentOptions): void {
  const locked = SESSION_LOCKED_FIELDS.filter((field) => extra[field] !== undefined);
  if (locked.length === 0) {
    return;
  }
  const [subject, object] = locked.length === 1 ? ["it is", "it"] : ["they are", "them"];
  throw new FoomConfigError(
    `cannot change ${locked.join(", ")} mid-session — ${subject} fixed when session() opens. ` +
      `Open a new session(), or use a stateless this.agent turn, to vary ${object}.`,
  );
}

function render(strings: TemplateStringsArray, values: readonly unknown[]): string {
  let out = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    out += String(values[index]) + (strings[index + 1] ?? "");
  }
  return out.trim();
}

function readUsage(runtime: Runtime): AgentUsage {
  return toAgentUsage(runtime.usage);
}

/** How a run channel sources its session (fresh per turn, or one persistent). */
interface SessionSource {
  readonly get: () => Promise<HarnessSession>;
  readonly guard?: { inFlight: boolean };
}

// A value/do turn must terminate with foom_return; nudge the model at the end of
// its prompt. Prose turns just stream text, so they need no notice.
function buildTurnPrompt(mode: TurnMode, prompt: string): string {
  if (mode.kind === "value") {
    return `${prompt}\n\n${VALUE_TURN_NOTICE}`;
  }
  if (mode.kind === "do") {
    return `${prompt}\n\n${DO_TURN_NOTICE}`;
  }
  return prompt;
}

/** Emit the turn's span_start + turn_start, parenting under the pinned span or the
 *  ambient call-structure span. */
function emitTurnStart(
  runtime: Runtime,
  span: string,
  mode: TurnMode,
  options: AgentOptions,
  parentSpan: string | undefined,
): void {
  const parent = parentSpan ?? runtime.spanALS.getStore();
  emitAll(runtime, {
    type: "span_start",
    span,
    name: options.label ?? mode.kind,
    kind: "turn",
    ...(parent === undefined ? {} : { parent }),
  });
  emitAll(
    runtime,
    options.label === undefined
      ? { type: "turn_start", span }
      : { type: "turn_start", span, label: options.label },
  );
}

/** Emit the turn's span_end carrying its duration and folded usage. */
function emitTurnEnd(
  runtime: Runtime,
  span: string,
  startedAt: number,
  turnDelta: UsageAccount,
): void {
  emitAll(runtime, {
    type: "span_end",
    span,
    durationMs: Date.now() - startedAt,
    usage: toAgentUsage(turnDelta),
  });
}

function emitTurnMeta(
  runtime: Runtime,
  traced: boolean,
  span: string,
  session: HarnessSession,
  systemPrompt: string,
): void {
  if (!traced) {
    return;
  }
  emitAll(runtime, {
    type: "turn_meta",
    span,
    systemPrompt: session.systemPrompt?.(systemPrompt) ?? systemPrompt,
  });
}

/** Marshal the RunTurnParams for one turn: the per-turn fold/emit wiring plus the
 *  optional fields added only when set (so an absent value never overrides a
 *  resolved scope default). */
function buildRunTurnParams(args: {
  session: HarnessSession;
  prepared: ReturnType<typeof prepare>;
  turnPrompt: string;
  mode: TurnMode;
  runtime: Runtime;
  span: string;
  traced: boolean;
  options: AgentOptions;
  onStreamChunk: ((chunk: string) => void) | undefined;
  signal: AbortSignal;
  capacityLease: ConcurrencyLease;
  fold: (delta: UsageAccount) => UsageAccount;
}): RunTurnParams {
  const { prepared, runtime, span, traced, options, onStreamChunk } = args;
  return {
    session: args.session,
    systemPrompt: prepared.systemPrompt,
    prompt: args.turnPrompt,
    mode: args.mode,
    ctx: buildContext(runtime),
    caps: prepared.caps,
    fold: args.fold,
    ...(traced ? { emit: (event: AgentEvent) => emitAll(runtime, event) } : {}),
    span,
    ...(prepared.thinking === undefined ? {} : { thinking: prepared.thinking }),
    ...(prepared.tools === undefined ? {} : { tools: prepared.tools }),
    ...(prepared.omitBasePrompt === undefined ? {} : { omitBasePrompt: prepared.omitBasePrompt }),
    ...(prepared.retries === undefined ? {} : { retries: prepared.retries }),
    ...(options.onToken === undefined ? {} : { onToken: options.onToken }),
    ...(onStreamChunk === undefined ? {} : { onStreamChunk }),
    signal: args.signal,
    capacityLease: args.capacityLease,
  };
}

// `parentSpan` pins this channel's turns under a specific span (a scope's own
// span). When absent, the parent is taken from the call-structure (AsyncLocalStorage)
// — the right default for `this.agent` turns inside main or a method.
/** Everything a single turn needs from its owning run. */
interface DriveDeps {
  readonly runtime: Runtime;
  readonly options: AgentOptions;
  readonly source: SessionSource;
  readonly parentSpan: string | undefined;
  /** A stateful session's locked identity; undefined for stateless turns. */
  readonly frozen: FrozenIdentity | undefined;
}

/**
 * Content hash identifying a turn for the store: everything that determines what
 * the model produces — mode (+ a value turn's JSON schema when derivable), the
 * rendered prompt, the composed system prompt, model, harness, thinking, allowed
 * tools, base-prompt omission, the output-token cap — plus an optional `storeKey`
 * salt to force distinct records for deliberately-identical turns. Position is NOT
 * included: a turn recalls its result wherever it sits in main(). Excluded: usage,
 * timestamps, and abort-only caps (budget/duration), which don't shape the output.
 */
function turnFingerprint(
  prepared: Prepared,
  mode: TurnMode,
  prompt: string,
  harness: string,
  storeKey: string | undefined,
): string {
  const ingredients = {
    mode: mode.kind,
    schema: mode.kind === "value" ? (standardInputJsonSchema(mode.schema) ?? null) : null,
    prompt,
    systemPrompt: prepared.systemPrompt,
    model: prepared.model,
    harness,
    thinking: prepared.thinking ?? null,
    tools: prepared.tools ?? null,
    omitBasePrompt: prepared.omitBasePrompt ?? null,
    maxOutputTokens: prepared.caps.maxOutputTokens ?? null,
    storeKey: storeKey ?? null,
  };
  return createHash("sha256").update(JSON.stringify(ingredients)).digest("hex");
}

/** Rebuild the internal usage account from a recalled turn's stored projection, so a
 *  recalled turn folds the same usage a freshly-run turn would (a resumed run totals
 *  what a clean run totals). Absent optional fields stay undefined ("not reported"). */
function agentUsageToAccount(usage: AgentUsage): UsageAccount {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
    costUsd: usage.costUsd,
    calls: usage.calls,
    maxCallDepth: usage.maxCallDepth,
  };
}

/** The store this turn uses, or undefined to bypass: no store configured, the turn
 *  opted out (`store: false`), or it belongs to a stateful session (frozen identity)
 *  whose shared transcript can't be reconstructed on recall. */
function turnStore(deps: DriveDeps): TurnStore | undefined {
  if (
    deps.runtime.store === undefined ||
    deps.options.store === false ||
    deps.frozen !== undefined
  ) {
    return;
  }
  return deps.runtime.store;
}

/** The store and this turn's content hash, paired — present only when the turn is
 *  storable (see {@link turnStore}). Built once so recall and record agree on both. */
interface TurnStoreCtx {
  readonly store: TurnStore;
  readonly hash: string;
}

/** Resolve the store context for a turn, or undefined when it isn't storable. */
function turnStoreCtx(
  deps: DriveDeps,
  prepared: Prepared,
  mode: TurnMode,
  prompt: string,
): TurnStoreCtx | undefined {
  const store = turnStore(deps);
  if (store === undefined) {
    return;
  }
  const harness = optionsHarness(deps.runtime, deps.options);
  return { store, hash: turnFingerprint(prepared, mode, prompt, harness, deps.options.storeKey) };
}

/** A recalled turn: its stored outcome and the usage account to re-fold, or undefined
 *  on a miss. Folds the recalled usage into the run total so a resumed run accounts
 *  for the same work a clean run did. */
function recallTurn(
  ctx: TurnStoreCtx,
  runtime: Runtime,
): { readonly outcome: TurnOutcome; readonly account: UsageAccount } | undefined {
  const hit = ctx.store.get(ctx.hash);
  if (hit === undefined) {
    return;
  }
  const account = agentUsageToAccount(hit.usage);
  runtime.usage = combineUsage(runtime.usage, account);
  return { outcome: hit.outcome, account };
}

/** Run one turn: open the session, emit the span, fold usage, settle the guard. */
async function driveTurn(
  deps: DriveDeps,
  mode: TurnMode,
  prompt: string,
  turnSignal: AbortSignal,
  onStreamChunk?: (chunk: string) => void,
): Promise<TurnOutcome> {
  const { runtime, options, source, parentSpan, frozen } = deps;
  const signal =
    runtime.signal === undefined ? turnSignal : AbortSignal.any([turnSignal, runtime.signal]);
  let turnDelta = emptyUsage;
  let capacityLease: ConcurrencyLease | undefined;
  let span: string | undefined;
  let traced = false,
    startedAt = 0;
  try {
    const prepared = prepare(runtime, options, frozen);
    // Resolve the store + content hash up front: a hit short-circuits the model.
    const storeCtx = turnStoreCtx(deps, prepared, mode, prompt);
    capacityLease = await runtime.concurrency.acquire(prepared.maxConcurrentTurns, signal);
    span = runtime.nextSpan();
    traced = runtime.listeners.size > 0;
    if (traced) {
      emitTurnStart(runtime, span, mode, options, parentSpan);
    }
    const turnPrompt = buildTurnPrompt(mode, prompt);
    startedAt = Date.now();
    // Covers harnesses that don't honour the signal mid-stream.
    if (signal.aborted) {
      throw new FoomCancelledError("the agent run was aborted");
    }
    // Recall a previously-completed turn: return its stored outcome without opening a
    // session or invoking the model. Runs live within a run too, so identical turns
    // (same hash) collapse and a crashed run and a clean run compute the same result.
    const recalled = storeCtx === undefined ? undefined : recallTurn(storeCtx, runtime);
    if (recalled !== undefined) {
      turnDelta = recalled.account;
      return recalled.outcome;
    }
    const session = await source.get();
    emitTurnMeta(runtime, traced, span, session, prepared.systemPrompt);
    const fold = (delta: UsageAccount): UsageAccount => {
      turnDelta = combineUsage(turnDelta, delta);
      runtime.usage = combineUsage(runtime.usage, delta);
      return runtime.usage;
    };
    // Run the turn body under this span so a method the agent foom_calls
    // mid-turn (and its own turns) nest beneath it.
    const activeSpan = span;
    const activeCapacityLease = capacityLease;
    const outcome = await runtime.spanALS.run(activeSpan, async () =>
      runProgramTurn(
        buildRunTurnParams({
          session,
          prepared,
          turnPrompt,
          mode,
          runtime,
          span: activeSpan,
          traced,
          options,
          onStreamChunk,
          signal,
          capacityLease: activeCapacityLease,
          fold,
        }),
      ),
    );
    // Record the completed turn for resume (only after it settled successfully).
    if (storeCtx !== undefined) {
      await storeCtx.store.set(storeCtx.hash, { outcome, usage: toAgentUsage(turnDelta) });
    }
    return outcome;
  } catch (error) {
    if (error instanceof FoomCancelledError) {
      throw error;
    }
    if (signal.aborted) {
      throw new FoomCancelledError("the agent run was aborted", { cause: error });
    }
    throw error;
  } finally {
    if (traced && span !== undefined) {
      emitTurnEnd(runtime, span, startedAt, turnDelta);
    }
    capacityLease?.dispose();
    if (source.guard !== undefined) {
      source.guard.inFlight = false;
    }
  }
}

function makeRun(
  runtime: Runtime,
  options: AgentOptions,
  source: SessionSource,
  parentSpan?: string,
  frozen?: FrozenIdentity,
): AgentRun {
  const deps: DriveDeps = { runtime, options, source, parentSpan, frozen };
  // Reject overlapping turns on a stateful session before the turn starts;
  // driveTurn clears the in-flight flag when it settles.
  const begin = (): void => {
    if (source.guard !== undefined) {
      if (source.guard.inFlight) {
        throw new FoomConcurrencyError("overlapping turns on one session");
      }
      source.guard.inFlight = true;
    }
  };

  const prose: AgentProseTemplate = (strings: TemplateStringsArray, ...values: unknown[]) => {
    begin();
    const prompt = render(strings, values);
    const { stream, sink } = makeTextStream({
      run: async (signal: AbortSignal) => {
        try {
          const outcome = await driveTurn(deps, { kind: "text" }, prompt, signal, (chunk) =>
            sink.push(chunk),
          );
          sink.end();
          return outcome.kind === "text" ? outcome.text : "";
        } catch (error) {
          sink.fail(error);
          throw error;
        }
      },
      usage: () => readUsage(runtime),
    });
    return stream;
  };

  const act: AgentDoTemplate = (strings: TemplateStringsArray, ...values: unknown[]) => {
    begin();
    const prompt = render(strings, values);
    return makeResult<void>({
      run: async (signal: AbortSignal) => {
        await driveTurn(deps, { kind: "do" }, prompt, signal);
      },
      usage: () => readUsage(runtime),
    });
  };

  const value: AgentValueTemplate =
    <S extends StandardSchemaV1>(schema: S) =>
    (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): AgentResult<StandardSchemaV1.InferOutput<S>> => {
      begin();
      const prompt = render(strings, values);
      return makeResult<StandardSchemaV1.InferOutput<S>>({
        run: async (signal: AbortSignal): Promise<StandardSchemaV1.InferOutput<S>> => {
          const outcome = await driveTurn(deps, { kind: "value", schema }, prompt, signal);
          return outcome.kind === "value" ? outcome.value : undefined;
        },
        usage: (): AgentUsage => readUsage(runtime),
      });
    };

  return { do: act, prose, value };
}

function statelessSource(runtime: Runtime, model: string, options: AgentOptions): SessionSource {
  // Each stateless turn gets its own fresh session (no shared transcript). The
  // harness is resolved per turn, so a method's @foom.config({ harness }) (live in
  // runtime.methodConfig while it runs) takes effect for turns it makes.
  return {
    get: async () =>
      harnessPort(runtime, optionsHarness(runtime, options))(openOptions(runtime, model, options)),
  };
}

// A lazily-opened, single-flight session source over one harness session: the
// underlying session opens on first use and is reused across turns (continued
// transcript). `.with()` handles share this source (and its guard); `.fork()`
// builds a fresh source over a branched session.
function makeSource(open: () => Promise<HarnessSession>): SessionSource {
  let opened: Promise<HarnessSession> | undefined;
  return {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- returns the cached promise by identity (single-flight); `async` would allocate a fresh wrapper each call.
    get: () => {
      opened ??= open();
      return opened;
    },
    guard: { inFlight: false },
  };
}

function sessionHandle(
  runtime: Runtime,
  options: AgentOptions,
  source: SessionSource,
  frozen: FrozenIdentity,
): AgentSession {
  const run = makeRun(runtime, options, source, undefined, frozen);
  return {
    do: run.do,
    prose: run.prose,
    value: run.value,
    // Same transcript, options layered: share the source (and its single-flight guard)
    // and the identity frozen at open. A .with() that tries to change a session-locked
    // field is rejected — only the per-turn fields (thinking, tools, label, caps) layer.
    with: (extra: AgentOptions): AgentSession => {
      assertNoLockedChange(extra);
      return sessionHandle(runtime, { ...options, ...extra }, source, frozen);
    },
    // Branch the transcript into an independent session. Resolved on the fork's
    // first turn from the parent's transcript as it then stands; an unsupported
    // harness surfaces FoomConfigError. The branch inherits the parent's frozen
    // identity (a fork continues the same persona; open a new session() for a new one).
    fork: () =>
      sessionHandle(
        runtime,
        options,
        makeSource(async () => {
          const parent = await source.get();
          if (parent.fork === undefined) {
            throw new FoomConfigError("the active harness does not support session fork()");
          }
          return parent.fork();
        }),
        frozen,
      ),
    get usage(): AgentUsage {
      return readUsage(runtime);
    },
  };
}

function makeSession(runtime: Runtime, options: AgentOptions): AgentSession {
  const model = optionsModel(runtime, options);
  // A session is one provider thread bound to one harness; resolve both once at
  // creation (a session never switches harness mid-conversation).
  const port = harnessPort(runtime, optionsHarness(runtime, options));
  // Freeze the session's identity (systemPrompt + base-prompt omission) at open, so
  // every turn re-applies the SAME prompt — no mid-session drift across harnesses.
  const frozen = freezeIdentity(runtime, options);
  return sessionHandle(
    runtime,
    options,
    makeSource(async () => port(openOptions(runtime, model, options))),
    frozen,
  );
}

function optionsModel(runtime: Runtime, options: AgentOptions): string {
  const merged = mergeConfigChain([runtime.defaults, runtime.classConfig, pickConfig(options)]);
  if (merged.model === undefined) {
    throw new FoomConfigError("no model configured");
  }
  return merged.model;
}

/**
 * Session-open options for a scope: the resolved model plus the merged session-level
 * resources (skills/plugins). Resolved with the SAME scope chain as the model, so a
 * method/per-call `@foom.config({ skills })` takes effect for the session that scope
 * opens (fresh per stateless turn; once per stateful session).
 */
function openOptions(
  runtime: Runtime,
  model: string,
  options: AgentOptions,
): HarnessSessionOptions {
  const merged = mergeConfigChain([runtime.defaults, runtime.classConfig, pickConfig(options)]);
  return {
    model,
    ...(merged.skills === undefined ? {} : { skills: merged.skills }),
    ...(merged.plugins === undefined ? {} : { plugins: merged.plugins }),
  };
}

/** Look up a registered harness port by name; an unknown name is a typed error. */
function harnessPort(runtime: Runtime, name: string): OpenSession {
  const port = runtime.harnesses[name];
  if (port === undefined) {
    const known = Object.keys(runtime.harnesses);
    throw new FoomConfigError(
      `unknown harness "${name}"; registered: ${known.length > 0 ? known.join(", ") : "none"}`,
    );
  }
  return port;
}

/**
 * Effective harness name for a turn/session, from the full cascade (harness
 * default → class → method → call). No selection anywhere is a typed error — the
 * runtime never guesses a positional default.
 */
function optionsHarness(runtime: Runtime, options: AgentOptions): string {
  const merged = mergeConfigChain(
    [runtime.defaults, runtime.classConfig, runtime.methodConfig, pickConfig(options)].filter(
      (c): c is AgentConfig => c !== undefined,
    ),
  );
  if (merged.harness === undefined) {
    throw new FoomConfigError(
      "no harness selected (set defaultHarness in run options, or @foom.config({ harness }), or .with({ harness }))",
    );
  }
  return merged.harness;
}

function makeScope(
  runtime: Runtime,
  options: AgentOptions,
  name: string,
  spanId: string,
  parentSpan?: string,
): AgentScope {
  if (runtime.listeners.size > 0) {
    // Parent the scope under the enclosing span: a nested scope passes it
    // explicitly; a top-level scope() reads the live call-structure (main/method).
    const parent = parentSpan ?? runtime.spanALS.getStore();
    emitAll(runtime, {
      type: "span_start",
      span: spanId,
      name,
      kind: "scope",
      ...(parent === undefined ? {} : { parent }),
    });
  }
  // Turns on this scope (and `.with({ label })` variants) nest under the scope's
  // own span; a per-call label overrides the scope name on the turn row.
  const run = makeRun(
    runtime,
    { ...options, label: options.label ?? name },
    statelessSource(runtime, optionsModel(runtime, options), options),
    spanId,
  );
  return {
    do: run.do,
    prose: run.prose,
    value: run.value,
    with: (extra: AgentOptions): AgentScope =>
      makeScope(runtime, { ...options, ...extra }, name, spanId, parentSpan),
    scope: (child: string): AgentScope =>
      makeScope(runtime, options, child, runtime.nextSpan(), spanId),
    annotate: (attributes: Record<string, unknown>): void =>
      emitAll(runtime, { type: "annotate", span: spanId, attributes }),
    log: (message: string, level: "info" | "warn" | "error" = "info"): void =>
      emitAll(runtime, { type: "log", span: spanId, message, level }),
  };
}

function makeContext<P extends object>(
  runtime: Runtime,
  options: AgentOptions,
): AgentProgramContext<P> {
  // Resolve the model from the full cascade (defaults → class → options), like
  // makeScope/makeSession do — so a per-turn `this.agent.with({ model })` (or
  // `.with({ harness, model })`) actually re-targets the stateless turn's session.
  // Threading runtime.defaults.model here instead silently dropped the override.
  const run = makeRun(
    runtime,
    options,
    statelessSource(runtime, optionsModel(runtime, options), options),
  );
  const context: AgentProgramContext<P> & TraceContext = {
    do: run.do,
    prose: run.prose,
    value: run.value,
    program: runtime.instance as P,
    get usage(): AgentUsage {
      return readUsage(runtime);
    },
    session: (sessionOptions?: AgentOptions): AgentSession =>
      makeSession(runtime, { ...options, ...sessionOptions }),
    with: (extra: AgentOptions): AgentProgramContext<P> =>
      makeContext<P>(runtime, { ...options, ...extra }),
    scope: (name: string): AgentScope => makeScope(runtime, options, name, runtime.nextSpan()),
    onEvent: (handler: (event: AgentEvent) => void): void => {
      runtime.listeners.add(handler);
    },
    export: (exporter: AgentTraceExporter): void => {
      runtime.listeners.add((event: AgentEvent): void => exporter.export(event));
    },
  };
  return context;
}

/**
 * Construct, wire `this.agent`, and run a program to its result (the facade). The
 * result type is inferred from the program's `main` return, so callers need not
 * (and the class need not) declare it.
 *
 * @param ProgramClass - A class extending `Program(schema)` (or `FoomProgram`).
 * @param rawInput - Input for the program; validated against the class's input
 *   schema before `main` runs.
 * @param options - Harness registry, model, and source — see {@link RunProgramOptions}.
 * @returns The value `main` resolves to.
 * @throws {@link FoomInputError} when `rawInput` fails the input schema.
 * @throws {@link FoomConfigError} on bad config (e.g. no model, unknown harness).
 * @throws {@link FoomRepairExhaustedError} when the agent's output can't be
 *   repaired, {@link FoomThrowError} on a deliberate `foom_throw`, and other
 *   {@link FoomError} subclasses on caps/aborts/harness failures (F7).
 * @example
 * ```ts
 * import { runProgram } from "@microfoom/core";
 * import { createPiOpenSession } from "@microfoom/pi-adapter";
 *
 * const result = await runProgram(MyProgram, { topic: "tides" }, {
 *   harnesses: { pi: createPiOpenSession() },
 *   model: "openrouter/deepseek/deepseek-v4-flash",
 *   sourceFile: "./my-program.ts",
 * });
 * ```
 */
/** Validate raw program input against the program's optional input schema (the
 *  static `input` on the class), returning the parsed value (or the raw input when
 *  no schema is declared). */
async function validateProgramInput(
  ProgramClass: abstract new () => FoomProgram<never, unknown>,
  rawInput: unknown,
): Promise<unknown> {
  const inputSchema = (ProgramClass as unknown as { input?: StandardSchemaV1 }).input;
  if (inputSchema === undefined) {
    return rawInput;
  }
  const validated = await Promise.resolve(inputSchema["~standard"].validate(rawInput));
  if (validated.issues !== undefined) {
    throw new FoomInputError("program input failed its schema", { data: validated.issues });
  }
  return validated.value;
}

/** Resolve the default harness: an explicit name wins (and must be registered); a
 *  sole registered harness is unambiguous; otherwise undefined, so an unselected
 *  harness fails loudly rather than guessing. Throws if none are registered. */
function resolveDefaultHarness(options: RunProgramOptions): string | undefined {
  const harnessNames = Object.keys(options.harnesses);
  if (harnessNames.length === 0) {
    throw new FoomConfigError("no harnesses registered (run options.harnesses is empty)");
  }
  const explicit = options.defaultHarness;
  if (explicit !== undefined && options.harnesses[explicit] === undefined) {
    throw new FoomConfigError(
      `defaultHarness "${explicit}" is not a registered harness (have: ${harnessNames.join(", ")})`,
    );
  }
  if (explicit !== undefined) {
    return explicit;
  }
  return harnessNames.length === 1 ? harnessNames[0] : undefined;
}

/** Race main() against the program's maxProgramDuration, always clearing the timer. */
async function runWithProgramTimeout<T>(main: Promise<T>, maxDuration: string): Promise<T> {
  const ms = durationToMs(maxDuration as Parameters<typeof durationToMs>[0]);
  if (ms === undefined) {
    throw new FoomConfigError(`invalid maxProgramDuration: ${maxDuration}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new FoomTimeoutError(`program exceeded ${maxDuration}`)), ms);
  });
  try {
    return await Promise.race([main, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Run a program to completion: validate `rawInput` against the program's declared
 * input schema, instantiate it, wire the configured harness(es) and any trace
 * listener, and return `main()`'s result. The top-level entry point the CLI and
 * embedders call.
 */
async function runProgram<P extends FoomProgram<never, unknown>>(
  ProgramClass: abstract new () => P,
  rawInput: unknown,
  options: RunProgramOptions,
): Promise<Awaited<ReturnType<P["main"]>>> {
  type Result = Awaited<ReturnType<P["main"]>>;
  const Ctor = ProgramClass as unknown as new () => FoomProgram<unknown, Result>;
  const instance = new Ctor();

  const input = await validateProgramInput(ProgramClass, rawInput);
  const classMeta = readClassMeta(instance);
  const defaultHarness = resolveDefaultHarness(options);

  const defaults = options.defaults === undefined ? {} : pickConfig(options.defaults);
  defaults.model ??= options.model;
  if (defaults.harness === undefined && defaultHarness !== undefined) {
    defaults.harness = defaultHarness;
  }

  const runtime: Runtime = {
    instance,
    harnesses: options.harnesses,
    defaults,
    classConfig: classMeta?.config === undefined ? {} : pickConfig(classMeta.config),
    exposed: exposedMethods(instance),
    derivations: new Map(),
    ...(options.sourceFile === undefined ? {} : { sourceFile: options.sourceFile }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    className: options.className ?? instance.constructor.name,
    usage: emptyUsage,
    listeners: new Set(),
    nextSpan: ((): (() => string) => {
      let n = 0;
      return () => {
        n += 1;
        return `span-${n}`;
      };
    })(),
    depth: 0,
    methodConfig: undefined,
    spanALS: new AsyncLocalStorage<string | undefined>(),
    concurrency: new ConcurrencyGate(),
    ...(options.store === undefined ? {} : { store: options.store }),
  };

  // Wire an external subscriber (CLI/harness renderer) before main() runs, so the
  // auto span tree is emitted from the first turn (F8).
  if (options.onEvent !== undefined) {
    runtime.listeners.add(options.onEvent);
  }

  attachContext(instance, makeContext(runtime, {}));

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- passes the program's main() promise through untouched; `async` rewraps and breaks the generic ReturnType<P["main"]> inference (TS2322).
  const main = withSpan(runtime, "main", "program", () => instance.main(input as never));
  const maxDuration = (ProgramClass as unknown as { maxProgramDuration?: string })
    .maxProgramDuration;
  return maxDuration === undefined ? main : runWithProgramTimeout(main, maxDuration);
}

export type {
  AgentDoTemplate,
  AgentProgramContext,
  AgentProseTemplate,
  AgentRun,
  AgentScope,
  AgentSession,
  AgentValueTemplate,
  RunProgramOptions,
};
export { attachContext, FoomProgram, Program, runProgram };
