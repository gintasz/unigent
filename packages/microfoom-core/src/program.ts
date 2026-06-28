// The public facade (F6). A program extends Program(schema); `this.agent` runs
// prompts. The harness owns the model loop (ADR-0002 rev) — this facade resolves
// the config cascade (F5), builds the per-run dispatch context + tool semantics
// (tools.ts), opens a harness session per stateless turn (or once per session()),
// runs the shared coordinator, folds usage, and surfaces failures as the thrown
// public taxonomy (F7). Plain Promise/async throughout; no effect-system layer.

import { AsyncLocalStorage } from "node:async_hooks";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type AgentConfig, durationToMs, mergeConfigChain } from "./config.js";
import {
  FoomtimeCancelledError,
  FoomtimeConcurrencyError,
  FoomtimeConfigError,
  FoomtimeDispatchError,
  FoomtimeError,
  FoomtimeInputError,
  FoomtimeTimeoutError,
} from "./errors.js";
import type { AgentEvent, AgentTraceExporter } from "./events.js";
import type { AgentOptions } from "./options.js";
import { type ExposeMeta, exposedMethods, readClassMeta } from "./registry.js";
import { type AgentResult, type AgentTextStream, makeResult, makeTextStream } from "./result.js";
import { type DerivedParameters, deriveMethodParameters } from "./schema_derive.js";
import type { HarnessSession, HarnessSessionOptions, OpenSession } from "./session.js";
import {
  type ProgramTurnContext,
  type ResolvedCaps,
  runProgramTurn,
  type TurnMode,
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
export type AgentProseTemplate = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => AgentTextStream;

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
export type AgentValueTemplate = <S extends StandardSchemaV1>(
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
export type AgentDoTemplate = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => AgentResult<void>;

/** The output modes available wherever prompts run: act (`do`), `prose`, `value`. */
export interface AgentRun {
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
export interface AgentSession extends AgentRun {
  with(options: AgentOptions): AgentSession;
  fork(): AgentSession;
  readonly usage: AgentUsage;
}

/** Per-instance run context, injected as `this.agent`. Stateless text/value. */
export interface AgentProgramContext<TProgram extends object> extends AgentRun {
  readonly program: TProgram;
  readonly usage: AgentUsage;
  session(options?: AgentOptions): AgentSession;
  with(options: AgentOptions): AgentProgramContext<TProgram>;
}

/**
 * A named span handle (trace surface, F8). Surfaced on the context only when
 * `@microfoom/core/trace` is imported (which augments AgentProgramContext); the
 * methods exist at runtime.
 */
export interface AgentScope extends AgentRun {
  with(options: AgentOptions): AgentScope;
  scope(name: string): AgentScope;
  annotate(attributes: Record<string, unknown>): void;
  log(message: string, level?: "info" | "warn" | "error"): void;
}

/** The trace members added to the context (gated behind the trace entry). */
export interface TraceContext {
  scope(name: string): AgentScope;
  onEvent(handler: (event: AgentEvent) => void): void;
  export(exporter: AgentTraceExporter): void;
}

// ─── Program base + Program(schema) ──────────────────────────────────────────

const contexts = new WeakMap<object, AgentProgramContext<object>>();

/** Internal: the runner wires `this.agent` after constructing a program. */
export function attachContext<P extends object>(program: P, context: AgentProgramContext<P>): void {
  contexts.set(program, context as AgentProgramContext<object>);
}

/** The program base class. Extend via Program(schema) for a typed input. */
export abstract class FoomtimeProgram<I = string[], R = unknown> {
  static input?: StandardSchemaV1;
  static maxProgramDuration?: string;

  protected get agent(): AgentProgramContext<this> {
    const context = contexts.get(this);
    if (context === undefined) {
      throw new FoomtimeError(
        "this.agent is unavailable until main() runs — do not use it in the constructor or field initializers.",
      );
    }
    return context as AgentProgramContext<this>;
  }

  abstract main(input: I): Promise<R>;
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
export function Program<S extends StandardSchemaV1, R = unknown>(
  input: S,
): abstract new () => FoomtimeProgram<StandardSchemaV1.InferOutput<S>, R> {
  abstract class BoundProgram extends FoomtimeProgram<StandardSchemaV1.InferOutput<S>, R> {
    static override input = input;
  }
  return BoundProgram;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/** Options for running a program: the harness registry, model, source. */
export interface RunProgramOptions {
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
  "You must end this turn by calling the foom_return tool with the result; If you cannot complete the task as the user instruction expects, or the instructions are defective or contradictory, call foom_throw instead.",
);

// Appended to a `do` turn's prompt: terminate with a no-arg foom_return once the
// work is done, and do NOT write a final summary (the program ignores prose here).
const DO_TURN_NOTICE = noticeBlock(
  "When the task is complete, end this turn by calling the foom_return tool with NO arguments. Do not write a summary or explanation — the program does not read it. If you cannot complete the task, or the instructions are defective or contradictory, call foom_throw instead.",
);

function pickConfig(options: AgentOptions): AgentConfig {
  const { onToken, signal, label, ...config } = options;
  void onToken;
  void signal;
  void label;
  return config;
}

function resolveCaps(config: AgentConfig): ResolvedCaps {
  const caps: { -readonly [K in keyof ResolvedCaps]: ResolvedCaps[K] } = {
    repairAttempts: config.repairAttempts ?? 3,
  };
  if (config.maxBudgetUsd !== undefined) caps.maxBudgetUsd = config.maxBudgetUsd;
  if (config.maxOutputTokens !== undefined) caps.maxOutputTokens = config.maxOutputTokens;
  if (config.maxCallDepth !== undefined) caps.maxCallDepth = config.maxCallDepth;
  if (config.maxTurnDuration !== undefined) {
    const ms = durationToMs(config.maxTurnDuration);
    if (ms === undefined)
      throw new FoomtimeConfigError(`invalid maxTurnDuration: ${config.maxTurnDuration}`);
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
}

function emitAll(runtime: Runtime, event: AgentEvent): void {
  for (const listener of runtime.listeners) listener(event);
}

/**
 * Run `fn` inside an auto-instrumented span (F8): emits span_start/span_end with
 * wall-clock duration and parents by call structure via AsyncLocalStorage, so a
 * method invoked mid-turn nests under that turn. A no-op passthrough when nothing
 * subscribes — the common path allocates no span and touches no async storage.
 * Non-turn spans carry empty usage; the tree projection rolls usage up from the
 * turn leaves (the real harness deltas).
 */
function withSpan<T>(
  runtime: Runtime,
  name: string,
  kind: "program" | "method",
  fn: () => Promise<T>,
): Promise<T> {
  if (runtime.listeners.size === 0) return fn();
  const span = runtime.nextSpan();
  const parent = runtime.spanALS.getStore();
  emitAll(runtime, {
    type: "span_start",
    span,
    name,
    kind,
    ...(parent !== undefined ? { parent } : {}),
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
  if (runtime.sourceFile === undefined) return undefined;
  const cached = runtime.derivations.get(method);
  if (cached !== undefined) return cached;
  const derived = deriveMethodParameters(runtime.sourceFile, runtime.className, method);
  runtime.derivations.set(method, derived);
  return derived;
}

function methodConfigOf(runtime: Runtime, method: string): AgentConfig | undefined {
  const config = readClassMeta(runtime.instance)?.methods.get(method)?.config;
  return config !== undefined ? pickConfig(config) : undefined;
}

function buildContext(runtime: Runtime): ProgramTurnContext {
  const toolTier: Array<{
    name: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: readonly string[];
  }> = [];
  for (const [name, meta] of runtime.exposed) {
    if (meta.tier === "tool")
      toolTier.push({
        name,
        description: meta.tool?.description ?? `Method ${name}.`,
        ...(meta.tool?.promptSnippet !== undefined
          ? { promptSnippet: meta.tool.promptSnippet }
          : {}),
        ...(meta.tool?.promptGuidelines !== undefined
          ? { promptGuidelines: meta.tool.promptGuidelines }
          : {}),
      });
  }
  return {
    isExposed: (method) => runtime.exposed.has(method),
    paramSchema: (method) => deriveFor(runtime, method)?.jsonSchema,
    toolTierMethods: toolTier,
    depth: () => runtime.depth,
    validateArgs: async (method, args) => {
      const derived = deriveFor(runtime, method);
      if (derived === undefined) return undefined;
      const result = await Promise.resolve(derived.schema["~standard"].validate(args));
      return result.issues === undefined ? undefined : result.issues;
    },
    invoke: async (method, args) => {
      const derived = deriveFor(runtime, method);
      const record = (typeof args === "object" && args !== null ? args : {}) as Record<
        string,
        unknown
      >;
      const positional =
        derived !== undefined ? derived.paramNames.map((name) => record[name]) : [record];
      const fn = (runtime.instance as Record<string, ((...a: unknown[]) => unknown) | undefined>)[
        method
      ];
      if (typeof fn !== "function")
        throw new FoomtimeDispatchError(`method "${method}" is missing`);
      const previousDepth = runtime.depth;
      const previousMethodConfig = runtime.methodConfig;
      runtime.depth = previousDepth + 1;
      runtime.methodConfig = methodConfigOf(runtime, method);
      try {
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
  readonly thinking?: string;
  readonly allowedTools?: readonly string[];
}

function prepare(runtime: Runtime, options: AgentOptions): Prepared {
  const scopes = [
    runtime.defaults,
    runtime.classConfig,
    runtime.methodConfig,
    pickConfig(options),
  ].filter((c): c is AgentConfig => c !== undefined);
  const merged = mergeConfigChain(scopes);
  if (merged.model === undefined) {
    throw new FoomtimeConfigError("no model configured (set it via run options or @foom.config)");
  }
  const announcements: string[] = [];
  for (const [name, meta] of runtime.exposed) {
    if (meta.tier === "announcement" && meta.announcement !== undefined) {
      announcements.push(`- ${name}: ${meta.announcement}`);
    }
  }
  const userPrompt =
    merged.systemPrompt === undefined
      ? ""
      : "append" in merged.systemPrompt
        ? merged.systemPrompt.append
        : merged.systemPrompt.replace;
  // The runtime block: intro + (when any) the foom_call announcements, all inside
  // one begin/end notice. The dev's own systemPrompt stays OUTSIDE the block.
  const runtimeBody =
    announcements.length > 0
      ? `${PROTOCOL_INTRO}\n\nMethods you may call via foom_call:\n${announcements.join("\n")}`
      : PROTOCOL_INTRO;
  const systemPrompt = [noticeBlock(runtimeBody), userPrompt]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const prepared: Prepared = {
    model: merged.model,
    systemPrompt,
    caps: resolveCaps(merged),
    ...(merged.thinking !== undefined ? { thinking: merged.thinking } : {}),
    ...(merged.tools !== undefined ? { allowedTools: merged.tools } : {}),
  };
  return prepared;
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

// `parentSpan` pins this channel's turns under a specific span (a scope's own
// span). When absent, the parent is taken from the call-structure (AsyncLocalStorage)
// — the right default for `this.agent` turns inside main or a method.
function makeRun(
  runtime: Runtime,
  options: AgentOptions,
  source: SessionSource,
  parentSpan?: string,
): AgentRun {
  const begin = () => {
    if (source.guard !== undefined) {
      if (source.guard.inFlight)
        throw new FoomtimeConcurrencyError("overlapping turns on one session");
      source.guard.inFlight = true;
    }
  };
  const end = () => {
    if (source.guard !== undefined) source.guard.inFlight = false;
  };

  const drive = async (
    mode: TurnMode,
    prompt: string,
    signal: AbortSignal,
    onStreamChunk?: (chunk: string) => void,
  ) => {
    const prepared = prepare(runtime, options);
    const span = runtime.nextSpan();
    const traced = runtime.listeners.size > 0;
    // A turn is a span leaf: its usage is the real harness delta(s) folded here.
    let turnDelta = emptyUsage;
    if (traced) {
      const parent = parentSpan ?? runtime.spanALS.getStore();
      emitAll(runtime, {
        type: "span_start",
        span,
        name: options.label ?? mode.kind,
        kind: "turn",
        ...(parent !== undefined ? { parent } : {}),
      });
      emitAll(
        runtime,
        options.label !== undefined
          ? { type: "turn_start", span, label: options.label }
          : { type: "turn_start", span },
      );
    }
    // A value/do turn must terminate with foom_return; nudge the model at the end of
    // its prompt (prose turns just stream text, so they need no notice).
    const turnPrompt =
      mode.kind === "value"
        ? `${prompt}\n\n${VALUE_TURN_NOTICE}`
        : mode.kind === "do"
          ? `${prompt}\n\n${DO_TURN_NOTICE}`
          : prompt;
    const startedAt = Date.now();
    try {
      const session = await source.get();
      // The exact system prompt the model saw this turn, sourced from the session
      // (so a harness that prepends its own base prompt shows the composed whole).
      if (traced) {
        emitAll(runtime, {
          type: "turn_meta",
          span,
          systemPrompt: session.systemPrompt?.(prepared.systemPrompt) ?? prepared.systemPrompt,
        });
      }
      // Run the turn body under this span so a method the agent foom_calls
      // mid-turn (and its own turns) nest beneath it.
      return await runtime.spanALS.run(span, () =>
        runProgramTurn({
          session,
          systemPrompt: prepared.systemPrompt,
          prompt: turnPrompt,
          mode,
          ctx: buildContext(runtime),
          caps: prepared.caps,
          fold: (delta) => {
            if (traced) turnDelta = combineUsage(turnDelta, delta);
            runtime.usage = combineUsage(runtime.usage, delta);
            return runtime.usage;
          },
          ...(traced ? { emit: (event: AgentEvent) => emitAll(runtime, event) } : {}),
          span,
          ...(prepared.thinking !== undefined ? { thinking: prepared.thinking } : {}),
          ...(prepared.allowedTools !== undefined ? { allowedTools: prepared.allowedTools } : {}),
          ...(options.onToken !== undefined ? { onToken: options.onToken } : {}),
          ...(onStreamChunk !== undefined ? { onStreamChunk } : {}),
          signal,
        }),
      );
    } catch (error) {
      if (signal.aborted) throw new FoomtimeCancelledError("the agent run was aborted");
      throw error;
    } finally {
      if (traced) {
        emitAll(runtime, {
          type: "span_end",
          span,
          durationMs: Date.now() - startedAt,
          usage: toAgentUsage(turnDelta),
        });
      }
      end();
    }
  };

  const prose: AgentProseTemplate = (strings, ...values) => {
    begin();
    const prompt = render(strings, values);
    const { stream, sink } = makeTextStream({
      run: async (signal) => {
        try {
          const outcome = await drive({ kind: "text" }, prompt, signal, (chunk) =>
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

  const act: AgentDoTemplate = (strings, ...values) => {
    begin();
    const prompt = render(strings, values);
    return makeResult<void>({
      run: async (signal) => {
        await drive({ kind: "do" }, prompt, signal);
      },
      usage: () => readUsage(runtime),
    });
  };

  const value: AgentValueTemplate =
    (schema) =>
    (strings, ...values) => {
      begin();
      const prompt = render(strings, values);
      return makeResult({
        run: async (signal) => {
          const outcome = await drive({ kind: "value", schema }, prompt, signal);
          return outcome.kind === "value"
            ? (outcome.value as StandardSchemaV1.InferOutput<typeof schema>)
            : (undefined as StandardSchemaV1.InferOutput<typeof schema>);
        },
        usage: () => readUsage(runtime),
      });
    };

  return { do: act, prose, value };
}

function statelessSource(runtime: Runtime, model: string, options: AgentOptions): SessionSource {
  // Each stateless turn gets its own fresh session (no shared transcript). The
  // harness is resolved per turn, so a method's @foom.config({ harness }) (live in
  // runtime.methodConfig while it runs) takes effect for turns it makes.
  return {
    get: () =>
      Promise.resolve(
        harnessPort(
          runtime,
          optionsHarness(runtime, options),
        )(openOptions(runtime, model, options)),
      ),
  };
}

// A lazily-opened, single-flight session source over one harness session: the
// underlying session opens on first use and is reused across turns (continued
// transcript). `.with()` handles share this source (and its guard); `.fork()`
// builds a fresh source over a branched session.
function makeSource(open: () => Promise<HarnessSession>): SessionSource {
  let opened: Promise<HarnessSession> | undefined;
  return {
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
): AgentSession {
  const run = makeRun(runtime, options, source);
  return {
    do: run.do,
    prose: run.prose,
    value: run.value,
    // Same transcript, options layered: share the source (and its single-flight guard).
    with: (extra) => sessionHandle(runtime, { ...options, ...extra }, source),
    // Branch the transcript into an independent session. Resolved on the fork's
    // first turn from the parent's transcript as it then stands; an unsupported
    // harness surfaces FoomtimeConfigError.
    fork: () =>
      sessionHandle(
        runtime,
        options,
        makeSource(async () => {
          const parent = await source.get();
          if (parent.fork === undefined) {
            throw new FoomtimeConfigError("the active harness does not support session fork()");
          }
          return parent.fork();
        }),
      ),
    get usage() {
      return readUsage(runtime);
    },
  };
}

function makeSession(runtime: Runtime, options: AgentOptions): AgentSession {
  const model = optionsModel(runtime, options);
  // A session is one provider thread bound to one harness; resolve both once at
  // creation (a session never switches harness mid-conversation).
  const port = harnessPort(runtime, optionsHarness(runtime, options));
  return sessionHandle(
    runtime,
    options,
    makeSource(() => Promise.resolve(port(openOptions(runtime, model, options)))),
  );
}

function optionsModel(runtime: Runtime, options: AgentOptions): string {
  const merged = mergeConfigChain(
    [runtime.defaults, runtime.classConfig, pickConfig(options)].filter(
      (c): c is AgentConfig => c !== undefined,
    ),
  );
  if (merged.model === undefined) throw new FoomtimeConfigError("no model configured");
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
  const merged = mergeConfigChain(
    [runtime.defaults, runtime.classConfig, pickConfig(options)].filter(
      (c): c is AgentConfig => c !== undefined,
    ),
  );
  return {
    model,
    ...(merged.skills !== undefined ? { skills: merged.skills } : {}),
    ...(merged.plugins !== undefined ? { plugins: merged.plugins } : {}),
  };
}

/** Look up a registered harness port by name; an unknown name is a typed error. */
function harnessPort(runtime: Runtime, name: string): OpenSession {
  const port = runtime.harnesses[name];
  if (port === undefined) {
    const known = Object.keys(runtime.harnesses);
    throw new FoomtimeConfigError(
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
    throw new FoomtimeConfigError(
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
      ...(parent !== undefined ? { parent } : {}),
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
    with: (extra) => makeScope(runtime, { ...options, ...extra }, name, spanId, parentSpan),
    scope: (child) => makeScope(runtime, options, child, runtime.nextSpan(), spanId),
    annotate: (attributes) => emitAll(runtime, { type: "annotate", span: spanId, attributes }),
    log: (message, level = "info") =>
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
    get usage() {
      return readUsage(runtime);
    },
    session: (sessionOptions) => makeSession(runtime, { ...options, ...sessionOptions }),
    with: (extra) => makeContext<P>(runtime, { ...options, ...extra }),
    scope: (name) => makeScope(runtime, options, name, runtime.nextSpan()),
    onEvent: (handler) => {
      runtime.listeners.add(handler);
    },
    export: (exporter) => {
      runtime.listeners.add((event) => exporter.export(event));
    },
  };
  return context;
}

/**
 * Construct, wire `this.agent`, and run a program to its result (the facade). The
 * result type is inferred from the program's `main` return, so callers need not
 * (and the class need not) declare it.
 *
 * @param ProgramClass - A class extending `Program(schema)` (or `FoomtimeProgram`).
 * @param rawInput - Input for the program; validated against the class's input
 *   schema before `main` runs.
 * @param options - Harness registry, model, and source — see {@link RunProgramOptions}.
 * @returns The value `main` resolves to.
 * @throws {@link FoomtimeInputError} when `rawInput` fails the input schema.
 * @throws {@link FoomtimeConfigError} on bad config (e.g. no model, unknown harness).
 * @throws {@link FoomtimeRepairExhaustedError} when the agent's output can't be
 *   repaired, {@link FoomtimeThrowError} on a deliberate `foom_throw`, and other
 *   {@link FoomtimeError} subclasses on caps/aborts/harness failures (F7).
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
export async function runProgram<P extends FoomtimeProgram<never, unknown>>(
  ProgramClass: abstract new () => P,
  rawInput: unknown,
  options: RunProgramOptions,
): Promise<Awaited<ReturnType<P["main"]>>> {
  type Result = Awaited<ReturnType<P["main"]>>;
  const Ctor = ProgramClass as unknown as new () => FoomtimeProgram<unknown, Result>;
  const instance = new Ctor();

  const inputSchema = (ProgramClass as unknown as { input?: StandardSchemaV1 }).input;
  let input: unknown = rawInput;
  if (inputSchema !== undefined) {
    const validated = await Promise.resolve(inputSchema["~standard"].validate(rawInput));
    if (validated.issues !== undefined) {
      throw new FoomtimeInputError("program input failed its schema", { data: validated.issues });
    }
    input = validated.value;
  }

  const classMeta = readClassMeta(instance);

  // Resolve the default harness once: an explicit name wins (and must exist); a
  // sole registered harness is unambiguous; otherwise leave it unset so an
  // unselected harness fails loudly rather than guessing a positional default.
  const harnessNames = Object.keys(options.harnesses);
  if (harnessNames.length === 0) {
    throw new FoomtimeConfigError("no harnesses registered (run options.harnesses is empty)");
  }
  let defaultHarness = options.defaultHarness;
  if (defaultHarness !== undefined && options.harnesses[defaultHarness] === undefined) {
    throw new FoomtimeConfigError(
      `defaultHarness "${defaultHarness}" is not a registered harness (have: ${harnessNames.join(", ")})`,
    );
  }
  if (defaultHarness === undefined && harnessNames.length === 1) defaultHarness = harnessNames[0];

  const defaults = options.defaults !== undefined ? pickConfig(options.defaults) : {};
  if (defaults.model === undefined) defaults.model = options.model;
  if (defaults.harness === undefined && defaultHarness !== undefined) {
    defaults.harness = defaultHarness;
  }

  const runtime: Runtime = {
    instance,
    harnesses: options.harnesses,
    defaults,
    classConfig: classMeta?.config !== undefined ? pickConfig(classMeta.config) : {},
    exposed: exposedMethods(instance),
    derivations: new Map(),
    ...(options.sourceFile !== undefined ? { sourceFile: options.sourceFile } : {}),
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
  };

  // Wire an external subscriber (CLI/harness renderer) before main() runs, so the
  // auto span tree is emitted from the first turn (F8).
  if (options.onEvent !== undefined) runtime.listeners.add(options.onEvent);

  attachContext(instance, makeContext(runtime, {}));

  const main = withSpan(runtime, "main", "program", () => instance.main(input as never));
  const maxDuration = (ProgramClass as unknown as { maxProgramDuration?: string })
    .maxProgramDuration;
  if (maxDuration === undefined) return main;

  const ms = durationToMs(maxDuration as Parameters<typeof durationToMs>[0]);
  if (ms === undefined) throw new FoomtimeConfigError(`invalid maxProgramDuration: ${maxDuration}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new FoomtimeTimeoutError(`program exceeded ${maxDuration}`)),
      ms,
    );
  });
  try {
    return await Promise.race([main, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
