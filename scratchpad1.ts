// Prompts are free prose for reasoning and instructions. To affect the program, the agent uses four control tools — FOOMCALL, FOOMRETURN, FOOMTHROW, FOOMINSPECT —
// surfaced via native function-calling, not string-matched from output. Write the verbs however reads clearly; the agent invokes the underlying tool.

// An agent turn produces one of two terminal outputs:
//
// 1. Assistant message (.text)
//    - human-readable, conversational prose
//    - appended to the session history
//    - not schema-validated
//
// 2. Structured return (.value)
//    - machine-readable value
//    - produced via FOOMRETURN
//    - schema-validated against the expected TypeScript return type
//    - used as the TypeScript value
//
// The expected return type is intentionally unconstrained: different users will
// reach for different validators (Zod, or any other library),
// so the API accepts any Standard Schema rather than committing to one.

  // IMPL: a terminal FOOMRETURN leaves a dangling foom_return tool_use; if this session continues afterward, inject a synthetic tool_result ack to close it before the next turn, or the provider rejects the request.
// Execution model: foomtime runs your script from source inside the harness
// (transpile only — no bundling, no mangling), so identifiers are stable at
// runtime. method.name, FOOMCALL dispatch by method name, and load-time param
// derivation all rely on that and Just Work for /run. Minification only happens
// if YOU bundle for deployment — only then do you need the optional foomtime
// transform (see @foom.expose). /run never does.
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { readFile } from "node:fs/promises";

type Duration = `${number}s` | `${number}m` | `${number}h`;

type ThinkingLevel = "low" | "medium" | "high" | (string & {}); // raw strings are provider-passthrough and validated at runtime

// Adjusting the system prompt is optional. Exactly one of `append` / `replace`.
//
// Composition across scopes (harness default → class → method → call):
//   - `append`s ACCUMULATE — each scope concatenates its text onto the prompt
//     inherited from wider scopes.
//   - `replace` RESETS the base at its scope, discarding everything from wider
//     scopes; any `append`s at narrower scopes then accumulate onto that base.
type SystemPrompt = { append: string } | { replace: string };

type AgentConfig = {
  // Merge across scopes (per-call > method > class > harness default). The rule
  // is in the name: `max*` = cap (tightens only — a narrower scope can't loosen
  // it; effective = min(inherited, override)); `systemPrompt` composes (append
  // accumulates, replace resets); everything else = override (closest scope wins).

  // --- override: closest scope wins ---
  model?: string;

  thinking?: ThinkingLevel;

  // Automatic retries for retryable boundary failures (FoomtimeHarnessError with
  // retryable === true: disconnect / 5xx / rate-limit). Exponential backoff,
  // honoring retryAfterMs when the harness provides it; non-retryable failures
  // never retry. 0 = no retry. Default: 2.
  retries?: number;

  // Consecutive FoomtimeValidationError failures (bad FOOMCALL args, bad/missing
  // FOOMRETURN, or unexposed/unknown method) allowed before
  // FoomtimeRepairExhaustedError. All three count — re-prompting with the
  // available methods is itself a repair. Resets to 0 on any valid result. Scoped
  // to a single agent-run (one .text()/.value()), not the session.
  // 0 = no repair (first invalid throws). Default: 3.
  repairAttempts?: number;

  // --- compose: append accumulates, replace resets (see SystemPrompt) ---
  systemPrompt?: SystemPrompt;

  // --- max* = cap: tightens only, never loosens ---

  // Cumulative USD cap; includes all sub-calls and subagents. If set but cost is
  // underivable (provider/pricing unknown → usage.costUsd stays undefined), the
  // loader throws FoomtimeConfigError at setup rather than silently never
  // enforcing it — a silent no-op budget cap is a cost/security footgun.
  maxBudgetUsd?: number;

  maxOutputTokens?: number; // cumulative; includes all sub-calls and subagents

  maxCallDepth?: number; // ceiling on nesting depth of sub-calls/subagents — maxed, not summed

  maxTurnDuration?: Duration; // per-TURN wall-clock cap — hang guard, no single turn runs longer; FoomtimeTimeoutError. (Whole-program bound is Program.maxProgramDuration.)
};

type LLMToken =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "reasoning";
      text: string;
    };

type AgentRuntimeHooks = {
  onToken?: (token: LLMToken) => void;
};

type AgentCancellation = {
  signal?: AbortSignal;
};

// Per-call only — display metadata, not part of the inheritable config cascade.
type AgentTurnMeta = {
  // Instrumentation label for this turn, shown in the run panel/log instead of
  // the raw prompt (e.g. "audit:/login").
  label?: string;
};

type AgentOptions = Partial<AgentConfig> &
  AgentRuntimeHooks &
  AgentCancellation &
  AgentTurnMeta;

type AgentResult<T> = PromiseLike<T> & {
  /**
   * Cancels the underlying agent run if still active. The result settles by
   * rejecting with FoomtimeCancelledError, so an awaiter observes the cancel.
   *
   * If the result was never awaited, abort() does NOT surface a process-level
   * unhandledRejection — the result self-handles its own cancellation rejection.
   * (It can't detect whether you're awaiting, so it always pre-handles; your own
   * await still independently throws FoomtimeCancelledError.)
   */
  abort(reason?: unknown): void;

  /**
   * Per-turn usage — live sync snapshot, read anytime; final once the turn
   * settles (await the result). Same shape and rule as session/program usage.
   */
  readonly usage: AgentUsage;
};

// A streaming text result. `for await` yields chunks; awaiting the result itself
// resolves to the full joined message — even after iterating (chunks are buffered
// and replayed). No `.text` property: await the result, exactly like value().
type AgentTextStream = AgentResult<string> & AsyncIterable<string>;

type AgentClassDecorator = <T extends abstract new (...args: any[]) => any>(
  value: T,
  context: ClassDecoratorContext<T>
) => T | void;

type AgentMethodDecorator = <This, Args extends unknown[], Return>(
  value: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
) => ((this: This, ...args: Args) => Return) | void;

type AgentDecorator = AgentClassDecorator & AgentMethodDecorator;

type AgentTextTemplate = {
  (strings: TemplateStringsArray, ...values: unknown[]): AgentTextStream;
};

type AgentValueResult<T> = AgentResult<T>;

type AgentValueTemplate = {
  <S extends StandardSchemaV1>(
    schema: S
  ): (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => AgentValueResult<StandardSchemaV1.InferOutput<S>>;
};

type AgentRun = {
  text: AgentTextTemplate;
  value: AgentValueTemplate;
};

// A stateful conversation (shared transcript). SINGLE-FLIGHT: starting a turn
// while another is in-flight on the same session throws FoomtimeConcurrencyError
// (a stream counts as in-flight until fully awaited/consumed). Sequential is fine
// — `await` one turn before the next; for parallelism, fork() into independent
// branches. (Contrast the stateless this.agent surface, which is concurrency-safe.)
type AgentSession = AgentRun & {
  /**
   * Same session, with per-turn options layered over the session/class/method/harness options.
   */
  with(options: AgentOptions): AgentSession;

  /**
   * Creates a new session starting from this session's current transcript. Later
   * turns diverge independently — fork() + Promise.all runs branches concurrently.
   */
  fork(): AgentSession;

  /**
   * Cumulative usage for this session branch. Live sync snapshot read at access
   * time — grows as turns settle, final only once the session ends. Same shape
   * and rule as per-turn AgentResult.usage and program usage.
   */
  readonly usage: AgentUsage;
};

type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  reasoningTokens?: number;
  cachedInputTokens?: number;

  costUsd?: number;

  calls: number;
  maxCallDepth: number;

  startedAt?: Date;
  updatedAt?: Date;
  durationMs?: number;
};

type AgentConfigDecorator = {
  /**
   * Class/method config decorator.
   */
  (options: AgentOptions): AgentDecorator;
};

// Structured tool advertisement — the value of @foom.expose({ tool }). Lists the
// method as a first-class tool (vs a plain `announcement` text mention).
type AgentToolOptions = {
  /**
   * Human-readable description of what the tool does.
   */
  description?: string;

  /**
   * Short snippet that may be inserted into the agent prompt/tool manifest.
   */
  promptSnippet?: string;

  /**
   * Extra usage guidance for the agent.
   */
  promptGuidelines?: readonly string[];
};

/**
 * Tool advertisement after the build transform derives `parameters` from the
 * method signature. Internal — the author never writes `parameters`.
 */
type ResolvedAgentToolOptions = AgentToolOptions & {
  /**
   * Schema derived from the method signature at load — TS types are available
   * because /run runs from source. Never authored. Cache per file so each /run
   * doesn't re-derive (a startup-latency note, not a correctness one).
   */
  parameters?: StandardSchemaV1;
};

// Three tiers by context cost, so each agent run advertises only what it needs:
// @expose = silent (0 context, params via FOOMINSPECT) · { announcement } = name+desc
// in the system prompt (params via FOOMINSPECT) · { tool } = native tool with full
// param schema upfront. announcement and tool are different channels (prose vs native
// tool primitive), not richer/poorer — pick by context budget.
type AgentExposeOptions = {
  /**
   * Lightweight advertisement: a text mention added to the system prompt so the
   * agent is told the method exists. Omit for a reachable-but-silent method —
   * callable only when your prompt explicitly names it.
   */
  announcement?: string;

  /**
   * Advertise the method as a native structured tool (description, prompt
   * snippet, usage guidelines; full param schema upfront). A different channel
   * from `announcement` (native tool primitive vs prose) — pick by context budget.
   */
  tool?: AgentToolOptions;
};

/**
 * Expose options after the build transform. Internal — NOT part of the public
 * @foom.expose signature.
 */
type ResolvedAgentExposeOptions = Omit<AgentExposeOptions, "tool"> & {
  /**
   * Dispatch name. Day-1 this is just the method's source name (stable, since
   * /run executes from source). Never authored. Only relevant if you bundle for
   * deployment: the optional foomtime transform injects it as a literal so it
   * survives mangling.
   */
  name?: string;

  /** Tool advertisement with auto-derived parameters. */
  tool?: ResolvedAgentToolOptions;
};

/**
 * Usable bare (`@foom.expose`) or called (`@foom.expose({ announcement })`).
 */
type AgentExposeDecorator = AgentMethodDecorator &
  ((options?: AgentExposeOptions) => AgentMethodDecorator);

// Decorators live under a module-level `foom` namespace: @foom.config / @foom.expose.
// The per-instance run context is `this.agent` (a different word), so there is no
// identifier collision to reason about. Decorators run at class-definition time
// (no instance); they only decorate.
type AgentDecorators = {
  /**
   * Class/method options decorator.
   */
  config: AgentConfigDecorator;

  /**
   * Exposes a public method to the agent. Methods are UNREACHABLE by default;
   * only @foom.expose makes one callable (optionally advertised via its options).
   *
   * Without `announcement` the method is reachable but silent — the agent must be
   * explicitly told to call it. With `announcement` the text is added to the
   * system prompt. private / protected / #private members can never be exposed.
   */
  expose: AgentExposeDecorator;
};

declare const foom: AgentDecorators;

// ───────────────────────────────────────────────────────────────────────────
// foomtime/trace — NOT core.
// This whole tracing surface (AgentScope, AgentEvent, AgentTraceExporter, plus
// the scope() / onEvent() / export() / annotate() members) belongs in a separate
// `foomtime/trace` entrypoint and is contributed onto AgentProgramContext via
// module augmentation. The common case needs NONE of it, so core stays lean —
// you import "foomtime/trace" only when you want spans/handles/export. It is
// shown inline here only because this is a single-file sketch.
// ───────────────────────────────────────────────────────────────────────────

// A scope: the handle you hold for a manually-named span. Same run surface as a
// turn context, plus span operations. Auto-instrumented method/turn spans exist
// without any handle — `scope` is only the API for the ones you name yourself.
type AgentScope = AgentRun & {
  /** Layer per-turn options (e.g. a child's label) over this scope. */
  with(options: AgentOptions): AgentScope;

  /** Nested span under this one. No callback — you hold the child handle. */
  scope(name: string): AgentScope;

  /** Attach structured attributes to this span (rendered on its row). */
  annotate(attributes: Record<string, unknown>): void;

  /** Record an event on this span (rendered as a line under it). */
  log(message: string, level?: "info" | "warn" | "error"): void;
};

// Intrinsic trace events. The built-in run panel and any export() target are
// just subscribers to this stream.
type AgentEvent =
  | { type: "span_start"; span: string; parent?: string; name: string }
  | { type: "span_end"; span: string; durationMs: number; usage: AgentUsage }
  | { type: "turn_start"; span: string; label?: string }
  | { type: "foom_call"; span: string; method: string }
  | { type: "repair"; span: string; attempt: number }
  | { type: "log"; span: string; message: string; level: "info" | "warn" | "error" }
  | { type: "annotate"; span: string; attributes: Record<string, unknown> };

// An OTel-style sink: the runtime feeds it the span tree built from the events.
type AgentTraceExporter = {
  export(event: AgentEvent): void;
};

/**
 * Per-instance run context, injected by the runtime and exposed as `this.agent`
 * inside a FoomtimeProgram. This is the sole surface for executing prompts from
 * a method body: it extends AgentRun (`text` / `value`) and adds program-scoped
 * state and helpers. Stateless — text/value here share no transcript, so
 * concurrent turns (Promise.all) are safe, unlike a session() (single-flight).
 * The decorators (@foom.config / @foom.expose) run at class-definition time and
 * cannot run prompts.
 */
type AgentProgramContext<TProgram extends object> = AgentRun & {
  readonly program: TProgram;

  /**
   * Cumulative usage for the whole program run. Live snapshot read at access
   * time — grows as turns settle, final only when the run ends.
   */
  readonly usage: AgentUsage;

  /**
   * Creates a session attached to this program run.
   */
  session(options?: AgentOptions): AgentSession;

  /**
   * Runtime overrides attached to this program context.
   */
  with(options: AgentOptions): AgentProgramContext<TProgram>;

  // --- Instrumentation — provided by `foomtime/trace`, NOT core (see the trace
  // banner above). These members exist only when you import the trace module,
  // which augments AgentProgramContext. The trace is auto-derived: every method
  // call and turn is a span, named by the method, parented by call structure,
  // cost/timing summed. The common case needs NONE of this. ---

  /**
   * Name a group that isn't its own method. Returns a scope handle (a span you
   * hold); work done on it — and nested scope()s — attributes to that span.
   * Prefer making the group a method (its span is automatic); reach for scope()
   * only for ad-hoc direct prompt calls.
   */
  scope(name: string): AgentScope;

  /** Subscribe to the typed event stream. The run panel is just a built-in subscriber. */
  onEvent(handler: (event: AgentEvent) => void): void;

  /** Pipe the span tree to an exporter — it's a real trace (OTel / Langfuse / ...). */
  export(exporter: AgentTraceExporter): void;
};

// Error taxonomy. Convention: every class is `Foomtime<Thing>Error`.
//
//   FoomtimeError                      base for all of the below
//   ├─ FoomtimeThrowError              deliberate FOOMTHROW in a prompt; ALWAYS carries user `code`
//   ├─ FoomtimeValidationError         repairable; catch-all for the three below (no `code`)
//   │  ├─ FoomtimeArgError             bad FOOMCALL args
//   │  ├─ FoomtimeReturnError          bad/missing FOOMRETURN
//   │  └─ FoomtimeDispatchError        unexposed/unknown method
//   ├─ FoomtimeAbortError              run ended early
//   │  ├─ FoomtimeTimeoutError         exceeded `maxTurnDuration` (turn) or `maxProgramDuration` (program)
//   │  └─ FoomtimeCancelledError       aborted via signal / .abort()
//   ├─ FoomtimeBudgetExceededError     exceeded `maxBudgetUsd`
//   ├─ FoomtimeTokenLimitExceededError exceeded `maxOutputTokens`
//   ├─ FoomtimeCallDepthError          exceeded `maxCallDepth`
//   ├─ FoomtimeRepairExhaustedError    exceeded `repairAttempts` consecutive validation failures
//   ├─ FoomtimeHarnessError            boundary failure; split by retryability (catch on e.retryable)
//   │  ├─ FoomtimeHarnessUnavailableError  transient — disconnect / 5xx / rate-limit (retryable)
//   │  └─ FoomtimeHarnessRejectedError     non-transient — permission / model-not-allowed / overflow
//   ├─ FoomtimeConfigError             bad config (no such model, invalid thinking, ...)
//   ├─ FoomtimeInputError              /run input failed the program's `input` schema
//   └─ FoomtimeConcurrencyError        overlapping turns on one session (programming error)
class FoomtimeError extends Error {
  readonly data?: unknown;
  constructor(message: string, options?: { cause?: unknown; data?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = new.target.name; // each subclass reports its own class name
    this.data = options?.data;
  }
}

/**
 * Raised ONLY by a deliberate FOOMTHROW in a prompt — the agent's program
 * intentionally erroring. ALWAYS carries the user-defined `code` from FOOMTHROW
 * (your namespace, e.g. "123" / "E_TOO_LOW"); it has no runtime meaning.
 *
 * Failures the runtime catches (bad FOOMCALL args, bad FOOMRETURN, unreachable
 * or unknown method) are FoomtimeValidationError, NOT this — they have no
 * `code`. Budget/timeout/depth are their own subclasses. Discriminate with
 * instanceof.
 */
class FoomtimeThrowError extends FoomtimeError {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown; data?: unknown }
  ) {
    super(message, options);
  }
}

/**
 * Repairable failure — the runtime rejected what the agent produced. Base for the
 * three below, so `instanceof FoomtimeValidationError` catches all of them. No
 * `code`; inspect `message` / `data`. All three count toward repairAttempts
 * (re-prompting with the available methods is itself a repair).
 */
class FoomtimeValidationError extends FoomtimeError {}
class FoomtimeArgError extends FoomtimeValidationError {}      // bad FOOMCALL args
class FoomtimeReturnError extends FoomtimeValidationError {}   // bad/missing FOOMRETURN
class FoomtimeDispatchError extends FoomtimeValidationError {} // unexposed/unknown method

class FoomtimeAbortError extends FoomtimeError {}              // run ended early
class FoomtimeTimeoutError extends FoomtimeAbortError {}       // exceeded maxTurnDuration (turn) or maxProgramDuration (program)
class FoomtimeCancelledError extends FoomtimeAbortError {}     // aborted via signal / .abort()
class FoomtimeBudgetExceededError extends FoomtimeError {}     // exceeded maxBudgetUsd
class FoomtimeTokenLimitExceededError extends FoomtimeError {} // exceeded maxOutputTokens
class FoomtimeCallDepthError extends FoomtimeError {}          // exceeded maxCallDepth
class FoomtimeRepairExhaustedError extends FoomtimeError {}    // exceeded repairAttempts consecutive validation failures

// The harness (or its backend) failed to fulfill a turn. foomtime runs inside the
// harness and delegates turns to it, so this is the boundary-failure class —
// origin (provider vs harness internals) is often indistinguishable from here.
abstract class FoomtimeHarnessError extends FoomtimeError {
  /** HTTP-ish status, if the harness surfaced one. */
  readonly status?: number;
  /** True when retrying the same turn may succeed — the only thing a catcher needs. */
  abstract readonly retryable: boolean;
}
// Transient: harness disconnected, model 5xx, rate-limited. Safe to retry.
class FoomtimeHarnessUnavailableError extends FoomtimeHarnessError {
  readonly retryable = true;
  readonly retryAfterMs?: number; // honor a harness/provider backoff hint, if any
}
// Non-transient: permission denied, model not allowed, context overflow, content
// filtered. Retrying as-is won't help.
class FoomtimeHarnessRejectedError extends FoomtimeHarnessError {
  readonly retryable = false;
}

class FoomtimeConfigError extends FoomtimeError {}             // bad config
class FoomtimeInputError extends FoomtimeError {}              // /run input failed the program's input schema
class FoomtimeConcurrencyError extends FoomtimeError {}        // overlapping turns on one session — programming error, not repairable/retryable

// Loader-populated backing store for each program's run context. Module-private:
// users can't reach it, so `this.agent` stays read-only from their side, and the
// getter below can distinguish "not yet wired" from a real context.
const programContexts = new WeakMap<FoomtimeProgram<any, any>, AgentProgramContext<any>>();

/** Internal: the loader calls this after constructing a program, before main(). */
function attachContext<P extends FoomtimeProgram<any, any>>(
  program: P,
  context: AgentProgramContext<P>
): void {
  programContexts.set(program, context);
}

abstract class FoomtimeProgram<I = string[], R = void> {
  /**
   * Entry contract, set for you by Program(schema) — don't assign by hand. The
   * loader JSON-parses the /run input, validates it against this schema, and
   * passes the typed result to main(); a mismatch throws FoomtimeInputError. When
   * absent (you extend FoomtimeProgram directly), main() receives the raw
   * positional CLI args as string[]. One validator story end-to-end.
   */
  static input?: StandardSchemaV1;

  /**
   * Whole-program wall-clock deadline, measured from main() start — the time
   * analog of the cumulative maxBudgetUsd. When it trips, the entire run aborts
   * (FoomtimeTimeoutError). NOT a cascading per-call field; it's the outer bound.
   * Operators can tighten it at launch: `/run x.foom --max-program-duration 10m` →
   * min(static, flag). Distinct from per-turn AgentConfig.maxTurnDuration: that keeps
   * one turn from hanging; this bounds total wall time. (Time can't sum like
   * dollars — parallel turns overlap — so the two can't be one field.)
   */
  static maxProgramDuration?: Duration;

  /**
   * The per-instance run context. Ready ONLY once main() runs — the loader wires
   * it after construction. Accessing it from the constructor or a field
   * initializer throws (below) instead of silently returning undefined.
   */
  protected get agent(): AgentProgramContext<this> {
    const context = programContexts.get(this);
    if (!context) {
      throw new FoomtimeError(
        "this.agent is unavailable until main() runs — do not use it in the " +
          "constructor or field initializers."
      );
    }
    return context as AgentProgramContext<this>;
  }

  /**
   * Program entrypoint, run by the harness; its resolved value is the program
   * result. `input` is typed from the entry schema (via Program(schema)) — no
   * annotation needed — or the raw string[] of CLI args when none is declared.
   */
  abstract main(input: I): Promise<R>;
}

/**
 * Name your input schema, then `extends Program(Input)`:
 *
 *   const Input = z.object({ first: z.string() });
 *   class P extends Program(Input) { async main(input) { input.first; } }
 *
 * main(input) is typed from the schema with NO annotation (no hand-written
 * InferOutput, no silent any), and the loader validates /run input against it.
 * Pass a return type as the second type arg if main resolves a value:
 * `extends Program<typeof Input, string>(Input)`. For a schemaless quick script,
 * extend FoomtimeProgram directly — main receives the raw string[] CLI args.
 */
function Program<S extends StandardSchemaV1, R = void>(
  input: S
): abstract new () => FoomtimeProgram<StandardSchemaV1.InferOutput<S>, R> {
  abstract class BoundProgram extends FoomtimeProgram<
    StandardSchemaV1.InferOutput<S>,
    R
  > {
    static input = input;
  }
  return BoundProgram;
}

// Entry contract: name the schema, then `extends Program(Input)`. The loader
// JSON-parses /run input and validates it against Input (FoomtimeInputError on
// mismatch); main(input) is typed from it with no annotation.
//   /run script.foom '{"first":"a","second":"b"}'
const Input = z.object({ first: z.string(), second: z.string() });
type Input = StandardSchemaV1.InferOutput<typeof Input>;

// Agent options (model, thinking, caps, ...) can be attached at the class level,
// per method, or per call. Their precedence is explained further down.
@foom.config({
    model: "openrouter/deepseek/deepseek-v4-pro",
    thinking: "medium",
    systemPrompt: { append: "You are terse and cite sources." },
    maxTurnDuration: "10m",
    maxBudgetUsd: 5
})
class MyProgram extends Program(Input) {
    // Entrypoint. Not exposed, so the agent can never FOOMCALL it. `input` is
    // typed via the named schema type — one word, no inline InferOutput.
    async main(input: Input)
    {
        // ------------------------------------------------------------
        // Basics: Hello world
        // Runs a stateless turn (no history retained)
        // ------------------------------------------------------------
        await this.agent.text`
            Hi, how are you?
        `;


        // ------------------------------------------------------------
        // Basics: Return a value from the agent
        // FOOMRETURN routes the value through the structured tool channel instead
        // of the chatty assistant message ("Sure! Here's 42..."). Schema sets the
        // shape; FOOMRETURN picks the channel.
        // ------------------------------------------------------------
        let random_number = await this.agent.value(z.number().int())`
            number = generate a random number between 0 and 100.
            FOOMRETURN number   // structured channel — no prose yapping
        `;
        console.log("Agent generated a random number as", random_number);


        // ------------------------------------------------------------
        // Basics: function call inside the agent
        // FOOMCALL is a call into an exposed method, within the current turn.
        // Methods are UNREACHABLE by default. @foom.expose makes a method
        // reachable; without an announcement it is NOT advertised, so you must
        // explicitly instruct the agent to call it (as below).
        // private/protected/secret methods can never be exposed.
        // Calling an unexposed or non-existent method yields the same error.
        // ------------------------------------------------------------
        await this.agent.text`
            FOOMCALL basics_function_call with no arguments
        `;

        // Agent will throw an error for all these because it is unable to proceed further with the execution
        try {
            // basics_function_call_2 is not exposed
            await this.agent.text`
                FOOMCALL basics_function_call_2 with no arguments
            `;
        }
        catch (error) {
            if (error instanceof FoomtimeValidationError) console.error(error.message);
            else throw error;
        }

        try {
            await this.agent.text`
                FOOMCALL private_demo_method with no arguments
            `;
        }
        catch (error) {
            if (error instanceof FoomtimeValidationError) console.error(error.message);
            else throw error;
        }

        try {
            await this.agent.text`
                FOOMCALL protected_demo_method with no arguments
            `;
        }
        catch (error) {
            if (error instanceof FoomtimeValidationError) console.error(error.message);
            else throw error;
        }

        try {
            await this.agent.text`
                FOOMCALL secret_demo_method with no arguments
            `;
        }
        catch (error) {
            if (error instanceof FoomtimeValidationError) console.error(error.message);
            else throw error;
        }

        // ------------------------------------------------------------
        // Basics: return value from a function call inside the agent
        // ------------------------------------------------------------
        let string_value = await this.agent.value(z.string())`
            value = FOOMCALL basics_function_call_with_return_value with no arguments
            FOOMRETURN value
        `;
        console.log("Agent returned a string value as", string_value);


        // ------------------------------------------------------------
        // Basics: recursive function call
        // ⚠ CAPABILITY DEMO, not idiomatic. Deterministic control flow (recursion,
        // arithmetic) inside a prompt is slow, costly, and non-deterministic. Do it
        // in TS (real recursion/loops); use the agent only for the fuzzy parts.
        // ------------------------------------------------------------
        let result = await this.agent.value(z.number().int())`
            value = FOOMCALL fac(n=5)
            FOOMRETURN value
        `;
        console.log("Agent computed factorial of 5 as", result);


        // ------------------------------------------------------------
        // Basics: inspect argument types before calling
        // FOOMINSPECT returns an exposed method's parameter schema, so the agent
        // can check expected arg types before it builds a FOOMCALL.
        // ------------------------------------------------------------
        await this.agent.text`
            FOOMINSPECT generate_random_number
            then FOOMCALL generate_random_number with valid arguments
        `;

        // ------------------------------------------------------------
        // Basics: function argument type-checking (1/3)
        // The runtime automatically type-checks the arguments passed to the function call.
        // This will throw an error because the argument type is invalid
        // ------------------------------------------------------------
        try {
            await this.agent.text`
                FOOMCALL fac(n="sam altman")
            `;
        }
        catch (error) {
            if (error instanceof FoomtimeValidationError) console.error(error.message);
            else throw error;
        }


        // ------------------------------------------------------------
        // Basics: return value type-checking (2/3)
        // this will throw an error because the return value is of invalid type
        // ------------------------------------------------------------
        try {
            await this.demo_function_invalid_return_value();
        }
        catch (error) {
            if (error instanceof FoomtimeValidationError) console.error(error.message);
            else throw error;
        }


        // ------------------------------------------------------------
        // Basics: return value type-checking (3/3)
        // this will throw an error because FOOMCALL fails and the agent is unable to continue execution
        // ------------------------------------------------------------
        try {
            await this.agent.value(z.number().int())`
                my number = FOOMCALL demo_function_invalid_return_value
                my number ++;
                FOOMRETURN my number
            `;
        }
        catch (error) {
            if (error instanceof FoomtimeValidationError) console.error(error.message);
            else throw error;
        }


        // ------------------------------------------------------------
        // Intermediate: agent run configuration & guardrails
        // agent options can be applied to the program class, individual methods or per-call basis
        // agent options are OPTIONAL and can be omitted (defaults to agent harness options)
        // precedence: per-call override > method decorator default > program class decorator default > agent harness default
        // ------------------------------------------------------------
        await this.agent.with({
            model: "openrouter/deepseek/deepseek-v4-flash",
            thinking: "low",
            maxTurnDuration: "1m",
            maxBudgetUsd: 0.5 // in USD
        }).value(z.number().int())`
            FOOMCALL basics_function_call with no arguments
            my number ++;
            FOOMRETURN my number
        `;

        // ------------------------------------------------------------
        // Intermediate: parallel function calls inside the agent
        // ⚠ CAPABILITY DEMO, not idiomatic. For fan-out + sum, do it in TS:
        //   (await Promise.all(maxes.map(m => this.generate_random_number(0, m)))).reduce((a, b) => a + b, 0)
        // Driving parallelism/arithmetic through the LLM is the expensive, flaky way.
        // The tool CAN batch FOOMCALLs in parallel — shown here only to demonstrate that.
        // ------------------------------------------------------------
        let sum = await this.agent.value(z.number().int())`
            max = {5, 50, 100}
            do FOOMCALL generate_random_number(min=0, max= each of max) in parallel
            value = sum all the values
            FOOMRETURN value
        `;
        console.log("Agent generated random numbers and summed them up to", sum);

        // ------------------------------------------------------------
        // Intermediate: parallel agent calls inside the program
        // ------------------------------------------------------------
        const [prd, risks, testPlan] = await Promise.all([
            this.agent.value(z.string())`
              Write a short PRD for a ride-sharing app in 1 paragraph.
              FOOMRETURN the PRD as markdown.
            `,
            this.agent.text`
              Identify top product and engineering risks for a ride-sharing app in 1 paragraph.
              Give the risks as markdown bullets.
            `,
            this.agent.value(z.string())`
              Write a QA test plan for a ride-sharing app in 1 paragraph.
              FOOMRETURN the test plan as markdown.
            `,
          ]);
        console.log(prd);
        console.log(risks);
        console.log(testPlan);

        // ------------------------------------------------------------
        // Intermediate: continued conversation with the agent + using 2 output modes
        // ------------------------------------------------------------
        let chat = this.agent.session();
        let explanation = await chat.text`
            Explain what is a random number.
        `;
        console.log("This is agent's explanation of a random number:", explanation);
        // waits for answer from agent, sends as new user message to the same agent session
        await chat.text`
            Are you sure about that?
        `;
        let rnd = 20 + Math.floor(Math.random() * 100);
        let num = await chat.value(z.number().int())`
            ok, then do this:
            num = random number between 0 and ${rnd}.
            FOOMRETURN num
        `;
        console.log("Agent generated a random number as", num);

        // ------------------------------------------------------------
        // Intermediate: custom error code handling
        // ⚠ CAPABILITY DEMO, not idiomatic. Branch in TS (if (rnd < 50) ...). FOOMTHROW
        // is for errors the agent raises from genuinely fuzzy reasoning, not for
        // deterministic conditionals you could write in TS.
        // ------------------------------------------------------------
        try {
            let rnd = Math.floor(Math.random() * 100);
            await this.agent.value(z.number().int())`
                number = ${rnd}
                if number < 50:
                    FOOMTHROW "Error message 1" with code "123"
                else:
                    FOOMTHROW "Error message 2" with code "456"
            `;
        }
        catch (error) {
            // `code` lives only on FoomtimeThrowError — your FOOMTHROW codes.
            if (error instanceof FoomtimeThrowError) {
                if (error.code === "123") {
                    console.error("Random number was less than 50");
                }
                else {
                    console.error("Random number was greater than or equal to 50");
                }
            }
            // A .value call can also fail for runtime reasons — distinct classes,
            // never `code`. Discriminate by type; don't swallow the unexpected.
            else if (error instanceof FoomtimeBudgetExceededError) {
                console.error("Out of budget");
            }
            else if (error instanceof FoomtimeAbortError) {
                console.error("Run aborted (timeout or cancel):", error.message);
            }
            else {
                throw error;
            }
        }

        // ------------------------------------------------------------
        // Advanced: spawn a subagent via an exposed method (no special primitive)
        // "Subagent" is not a control primitive — it's ordinary library code: an
        // exposed method that loads a prompt from a file and runs a one-shot
        // (stateless) turn. The agent reaches it with a normal FOOMCALL.
        // ------------------------------------------------------------
        await this.agent.text`
            Write a prompt asking for a random number between 0 and 100 to "/tmp/subagent_prompt.txt",
            then FOOMCALL launch_subagent_from_prompt_file(path="/tmp/subagent_prompt.txt").
            Tell me the number the subagent produced.
        `;

        // ------------------------------------------------------------
        // Advanced: fork a session to run branches in parallel
        // A session is SINGLE-FLIGHT — overlapping turns on it throw
        // FoomtimeConcurrencyError. fork() branches the transcript so each runs
        // independently; that's the concurrency primitive for stateful chats.
        // ------------------------------------------------------------
        let base = this.agent.session();
        await base.text`
            Explain what is a random number.
        `;
        const [correct, incorrect] = await Promise.all([
            base.fork().text`Give reasons why your explanation is correct.`,
            base.fork().text`Give reasons why your explanation is incorrect.`,
        ]);
        // Anti-pattern: Promise.all([base.text`a`, base.text`b`]) overlaps two
        // turns on one session → throws FoomtimeConcurrencyError. Fork instead.

        // ------------------------------------------------------------
        // Advanced: agent's token stream
        // ------------------------------------------------------------
        let stream = this.agent.text`
            Explain what is a random number.
        `;
        for await (const chunk of stream) {
            console.log(chunk);
        }
        // alternative
        await this.agent.with({
            onToken: (token) => process.stdout.write(token.text),
          }).text`
            Explain what is a random number.
          `;

        // ------------------------------------------------------------
        // Advanced: tracking agent's usage
        // ------------------------------------------------------------
        let session = this.agent.session();
        await session.text`
            Explain what is a random number.
        `;
        console.log(session.usage.totalTokens);
        console.log(session.usage.costUsd);

        // ------------------------------------------------------------
        // Advanced: tracking usage of the whole program
        // ------------------------------------------------------------
        this.agent.usage.totalTokens;
        this.agent.usage.costUsd;

        // ------------------------------------------------------------
        // Advanced: instrumentation is auto-derived — usually zero calls
        // Every method call and turn is already a span (named by the method,
        // parented by call structure, cost/timing summed), so the common case
        // adds nothing. Use scope() only to name an ad-hoc group of direct
        // prompt calls that isn't its own method.
        // ------------------------------------------------------------
        const audit = this.agent.scope("audit");
        audit.annotate({ routeCount: 3 });
        const routes = ["/login", "/signup", "/reset"];
        const findings = await Promise.all(
            routes.map((route) => audit.with({ label: route }).value(z.string())`
                Audit ${route} for missing auth. FOOMRETURN a one-line finding.
            `)
        );
        audit.log(`${findings.length} routes audited`);

        // Same span tree, anywhere — it's a real trace.
        this.agent.onEvent((event) => console.log(event.type));

        // How the audit scope renders in the run panel at runtime (a scope() node
        // looks like any other span; child rows come from .with({ label }), the
        // attribute from annotate(), the • line from log(); time/cost summed up):
        //
        //   ▼ main                                12.4s  $0.21
        //     ▸ discoverRoutes                     2.1s  $0.02
        //     ▼ audit            routeCount=3      7.8s  $0.16   ← scope() node
        //       ▸ /login                           2.0s  $0.05   ← from .with({ label })
        //       ▸ /signup                          2.4s  $0.06
        //       ▸ /reset                           1.9s  $0.05
        //       • 3 routes audited                                ← log = event line
        //     ▸ writeReport                        2.5s  $0.03

        // ------------------------------------------------------------
        // Advanced: abort agent's execution
        // Fire-and-forget: an un-awaited abort() self-settles its cancellation
        // rejection, so this never surfaces an unhandledRejection.
        // ------------------------------------------------------------
        let abortable_stream = this.agent.text`
            Explain random numbers.
        `;
        abortable_stream.abort();

        // ------------------------------------------------------------
        // Advanced: read stream chunks in real-time and then read full text afterwards
        // ------------------------------------------------------------
        let realtime_stream = this.agent.text`...`;
        for await (const chunk of realtime_stream) {
            process.stdout.write(chunk);
        }
        const full = await realtime_stream; // full message — replays after iteration
        console.log(full);
    }

    @foom.expose
    async basics_function_call(): Promise<void> {
        await this.agent.text`
            I am alive!
        `;
    }

    // Not exposed → unreachable by the agent.
    async basics_function_call_2(): Promise<void> {
        console.log("The agent will never be able to call this method");
    }

    @foom.expose
    async basics_function_call_with_return_value(): Promise<string> {
        // a method can either do work in TypeScript, or do work with another subagent
        if (Math.random() < 0.5) {
            return "Hello, world from TS!";
        }
        else {
            return await this.agent.value(z.string())`
                FOOMRETURN "Hello, world from agent!"
            `;
        }
    }

    private private_demo_method(): void {
        console.log("The agent will never be able to call this method");
    }

    protected protected_demo_method(): void {
        console.log("The agent will never be able to call this method");
    }

    #secret_demo_method(): void {
        console.log("The agent will never be able to call this method");
    }

    @foom.expose
    async demo_function_invalid_return_value(): Promise<number> {
        // Notice the return type is int, but the agent is commanded to return a string
        return await this.agent.value(z.number().int())`
            FOOMRETURN "Hello, world!"
        `;
    }

    // ⚠ CAPABILITY DEMO of in-prompt recursion — NOT how to compute a factorial.
    // Real recursion/arithmetic belongs in TS; let the agent drive only the
    // non-deterministic work.
    @foom.expose
    async fac(n: number): Promise<number> {
        return await this.agent.value(z.number().int())`
            if ${n} is 0:
                FOOMRETURN 1
            else:
                result = FOOMCALL fac(n = ${n - 1})
                FOOMRETURN ${n} * result
        `;
    }

    // Exposed AND announced: the agent is told in the system prompt that this
    // method exists, so it can reach for it without being explicitly instructed.
    @foom.expose({ announcement: "Generates a random integer in [min, max]." })
    async generate_random_number(min: number, max: number): Promise<number> {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    // A subagent is just a one-shot (stateless) turn with a prompt loaded from
    // disk. Spawning one needs no primitive — it's an ordinary exposed method.
    @foom.expose({ announcement: "Runs a subagent from a prompt file; returns its reply." })
    async launch_subagent_from_prompt_file(path: string): Promise<string> {
        const prompt = await readFile(path, "utf8");
        return await this.agent.text`${prompt}`;
    }

    // Advertised as a structured tool via @foom.expose({ tool }). Method arguments
    // are not duplicated — the parameter schema is derived from the signature at
    // load (TS types available since /run runs from source; cached per file).
    @foom.expose({
        tool: {
            description: "Description of the tool",
            promptSnippet: "prompt snippet of the tool",
            promptGuidelines: ["Prompt guidelines of the tool"]
        }
    })
    async custom_agent_tool(arg1: string, arg2: number): Promise<string> {
        return "Hello, world from tool!";
    }
}
