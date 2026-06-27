// The public facade (F6). A program extends Program(schema); `this.agent` runs
// prompts. The harness owns the model loop (ADR-0002 rev) — this facade resolves
// the config cascade (F5), builds the per-run dispatch context + tool semantics
// (tools.ts), opens a harness session per stateless turn (or once per session()),
// runs the shared coordinator, folds usage, and surfaces failures as the thrown
// public taxonomy (F7). Plain Promise/async throughout; no effect-system layer.

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
import type { HarnessSession, OpenSession } from "./session.js";
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

// ─── Public surface types (mirrors docs/design/api-sketch.ts) ────────────────

/** A streaming text turn from a template literal. */
export type AgentTextTemplate = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => AgentTextStream;

/** A structured-value turn: pick a schema, then a template literal. */
export type AgentValueTemplate = <S extends StandardSchemaV1>(
  schema: S,
) => (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => AgentResult<StandardSchemaV1.InferOutput<S>>;

/** The two output modes available wherever prompts run. */
export interface AgentRun {
  readonly text: AgentTextTemplate;
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
export abstract class FoomtimeProgram<I = string[], R = void> {
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

/** Name an input schema, then `extends Program(Input)`; main(input) is typed. */
export function Program<S extends StandardSchemaV1, R = void>(
  input: S,
): abstract new () => FoomtimeProgram<StandardSchemaV1.InferOutput<S>, R> {
  abstract class BoundProgram extends FoomtimeProgram<StandardSchemaV1.InferOutput<S>, R> {
    static override input = input;
  }
  return BoundProgram;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/** Options for running a program: the harness (opens sessions), model, source. */
export interface RunProgramOptions {
  readonly openSession: OpenSession;
  readonly model: string;
  /** Program source path — required for FOOMCALL parameter derivation (ADR-0003). */
  readonly sourceFile?: string;
  /** Class name in the source file, for derivation. Defaults to the constructor name. */
  readonly className?: string;
  /** Harness-default config, the widest cascade scope. */
  readonly defaults?: AgentOptions;
  readonly signal?: AbortSignal;
}

const PROTOCOL_PREAMBLE = [
  "You drive a TypeScript program through structured tools — never describe an action in prose, perform it with the tool:",
  "- foom_call: invoke an exposed program method by name.",
  "- foom_inspect: read a method's parameter schema before calling it.",
  "- foom_return: return the final structured value (only on a value turn).",
  "- foom_throw: abort with a deliberate error and a caller-defined code.",
].join("\n");

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
  readonly openSession: OpenSession;
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
}

function emitAll(runtime: Runtime, event: AgentEvent): void {
  for (const listener of runtime.listeners) listener(event);
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
  const toolTier: Array<{ name: string; description: string }> = [];
  for (const [name, meta] of runtime.exposed) {
    if (meta.tier === "tool")
      toolTier.push({ name, description: meta.tool?.description ?? `Method ${name}.` });
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
        const result = await fn.apply(runtime.instance, positional);
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
  const systemPrompt = [
    PROTOCOL_PREAMBLE,
    announcements.length > 0
      ? `Methods you may call via foom_call:\n${announcements.join("\n")}`
      : "",
    userPrompt,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const prepared: Prepared = {
    model: merged.model,
    systemPrompt,
    caps: resolveCaps(merged),
    ...(merged.thinking !== undefined ? { thinking: merged.thinking } : {}),
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

function makeRun(runtime: Runtime, options: AgentOptions, source: SessionSource): AgentRun {
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
    if (runtime.listeners.size > 0) {
      emitAll(
        runtime,
        options.label !== undefined
          ? { type: "turn_start", span, label: options.label }
          : { type: "turn_start", span },
      );
    }
    try {
      const session = await source.get();
      return await runProgramTurn({
        session,
        systemPrompt: prepared.systemPrompt,
        prompt,
        mode,
        ctx: buildContext(runtime),
        caps: prepared.caps,
        fold: (delta) => {
          runtime.usage = combineUsage(runtime.usage, delta);
          return runtime.usage;
        },
        ...(runtime.listeners.size > 0
          ? { emit: (event: AgentEvent) => emitAll(runtime, event) }
          : {}),
        span,
        ...(prepared.thinking !== undefined ? { thinking: prepared.thinking } : {}),
        ...(options.onToken !== undefined ? { onToken: options.onToken } : {}),
        ...(onStreamChunk !== undefined ? { onStreamChunk } : {}),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new FoomtimeCancelledError("the agent run was aborted");
      throw error;
    } finally {
      end();
    }
  };

  const text: AgentTextTemplate = (strings, ...values) => {
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

  return { text, value };
}

function statelessSource(runtime: Runtime, model: string): SessionSource {
  // Each stateless turn gets its own fresh session (no shared transcript).
  return { get: () => Promise.resolve(runtime.openSession({ model })) };
}

function makeSession(runtime: Runtime, options: AgentOptions): AgentSession {
  const model = optionsModel(runtime, options);
  let opened: Promise<HarnessSession> | undefined;
  const source: SessionSource = {
    get: () => {
      opened ??= Promise.resolve(runtime.openSession({ model }));
      return opened;
    },
    guard: { inFlight: false },
  };
  const run = makeRun(runtime, options, source);
  return {
    text: run.text,
    value: run.value,
    with: (extra) => makeSession(runtime, { ...options, ...extra }),
    fork: () => makeSession(runtime, options),
    get usage() {
      return readUsage(runtime);
    },
  };
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

function makeScope(
  runtime: Runtime,
  options: AgentOptions,
  name: string,
  spanId: string,
): AgentScope {
  if (runtime.listeners.size > 0) emitAll(runtime, { type: "span_start", span: spanId, name });
  const run = makeRun(
    runtime,
    { ...options, label: name },
    statelessSource(runtime, optionsModel(runtime, options)),
  );
  return {
    text: run.text,
    value: run.value,
    with: (extra) => makeScope(runtime, { ...options, ...extra }, name, spanId),
    scope: (child) => makeScope(runtime, options, child, runtime.nextSpan()),
    annotate: (attributes) => emitAll(runtime, { type: "annotate", span: spanId, attributes }),
    log: (message, level = "info") =>
      emitAll(runtime, { type: "log", span: spanId, message, level }),
  };
}

function makeContext<P extends object>(
  runtime: Runtime,
  options: AgentOptions,
): AgentProgramContext<P> {
  const run = makeRun(runtime, options, statelessSource(runtime, runtime.defaults.model ?? ""));
  const context: AgentProgramContext<P> & TraceContext = {
    text: run.text,
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

/** Construct, wire `this.agent`, and run a program to its result (the facade). */
export async function runProgram<R>(
  ProgramClass: abstract new () => FoomtimeProgram<never, R>,
  rawInput: unknown,
  options: RunProgramOptions,
): Promise<R> {
  const Ctor = ProgramClass as unknown as new () => FoomtimeProgram<unknown, R>;
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
  const defaults = options.defaults !== undefined ? pickConfig(options.defaults) : {};
  if (defaults.model === undefined) defaults.model = options.model;

  const runtime: Runtime = {
    instance,
    openSession: options.openSession,
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
  };

  attachContext(instance, makeContext(runtime, {}));

  const main = instance.main(input as never);
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
