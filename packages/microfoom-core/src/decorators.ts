// The public decorator surface: `@foom.config` and `@foom.expose`. Decorators run
// at class-definition time (no instance) and only record metadata (registry.ts);
// they never run prompts. Methods are unreachable by default — only @foom.expose
// makes one agent-callable (F3), and a language-private (#) member can never be
// exposed.

import { FoomConfigError } from "./errors.js";
import type { AgentExposeOptions, AgentOptions, AgentToolOptions } from "./options.js";
import { classMetaForCtor, type ExposeMeta, type ExposureTier, methodMetaFor } from "./registry.js";

/** A decorator usable on a class. */
export type AgentClassDecorator = <T extends abstract new (...args: never[]) => object>(
  value: T,
  context: ClassDecoratorContext<T>,
) => T | undefined;

/** A decorator usable on a method. */
export type AgentMethodDecorator = <This, Args extends readonly unknown[], Return>(
  value: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
) => ((this: This, ...args: Args) => Return) | undefined;

/** Usable on either a class or a method. */
export type AgentDecorator = AgentClassDecorator & AgentMethodDecorator;

/**
 * `@foom.config(options)` — set agent config on a class or a method. On a class
 * it is the widest scope of the cascade ({@link AgentConfig}); on a method it
 * applies whenever that method's body runs an agent turn. Narrower scopes win.
 *
 * @example
 * ```ts
 * @foom.config({ model: "openrouter/deepseek/deepseek-v4-flash", thinking: "medium" })
 * export default class extends Program<typeof Input, number>(Input) {
 *   async main(input: typeof Input._type): Promise<number> { ... }
 * }
 * ```
 */
export type AgentConfigDecorator = (options: AgentOptions) => AgentDecorator;

/**
 * `@foom.expose` (bare) or `@foom.expose(options)` — make a method agent-callable
 * via `foom_call`. Methods are unreachable by default (F3). Three tiers by context
 * cost (see {@link AgentExposeOptions}): bare = silent, `{ announcement }` = named
 * in the prompt, `{ tool }` = full native tool. Private (`#`) members can never be
 * exposed.
 *
 * @example
 * ```ts
 * // Silent: callable, but the agent must discover it via foom_inspect.
 * @foom.expose
 * async randomInt(min: number, max: number): Promise<number> { ... }
 *
 * // Announced: the agent is told the method exists.
 * @foom.expose({ announcement: "Generates a random integer in [min, max]." })
 * async randomInt(min: number, max: number): Promise<number> { ... }
 * ```
 */
export type AgentExposeDecorator = AgentMethodDecorator &
  ((options?: AgentExposeOptions) => AgentMethodDecorator);

/** The module-level decorator namespace. */
export interface AgentDecorators {
  readonly config: AgentConfigDecorator;
  readonly expose: AgentExposeDecorator;
}

type AnyDecoratorContext = DecoratorContext;
type MethodContext = ClassMethodDecoratorContext;

function isDecoratorContext(value: unknown): value is AnyDecoratorContext {
  return typeof value === "object" && value !== null && "kind" in value;
}

function makeConfig(options: AgentOptions): AgentDecorator {
  const decorate = (_value: unknown, context: AnyDecoratorContext): void => {
    if (context.kind === "class") {
      context.addInitializer(function (this: unknown) {
        classMetaForCtor(this as object).config = options;
      });
      return;
    }
    if (context.kind === "method") {
      const name = String(context.name);
      context.addInitializer(function (this: unknown) {
        methodMetaFor(classMetaForCtor(ctorOf(this)), name).config = options;
      });
      return;
    }
    throw new FoomConfigError("@foom.config applies to a class or method only.");
  };
  // The runtime handles both class and method contexts; the public type is the
  // intersection, which no single concrete function signature can express.
  return decorate as unknown as AgentDecorator;
}

function buildExposeMeta(
  name: string,
  tier: ExposureTier,
  options: AgentExposeOptions | undefined,
): ExposeMeta {
  const meta: {
    dispatchName: string;
    tier: ExposureTier;
    announcement?: string;
    tool?: AgentToolOptions;
  } = {
    dispatchName: name,
    tier,
  };
  if (options?.announcement !== undefined) meta.announcement = options.announcement;
  if (options?.tool !== undefined) meta.tool = options.tool;
  return meta;
}

function applyExpose(options: AgentExposeOptions | undefined, context: AnyDecoratorContext): void {
  if (context.kind !== "method") {
    throw new FoomConfigError("@foom.expose applies to methods only.");
  }
  if (context.private) {
    throw new FoomConfigError("Private (#) members can never be exposed to the agent (F3).");
  }
  const tier: ExposureTier =
    options?.tool !== undefined
      ? "tool"
      : options?.announcement !== undefined
        ? "announcement"
        : "silent";
  const name = String(context.name);
  const meta = buildExposeMeta(name, tier, options);
  context.addInitializer(function (this: unknown) {
    methodMetaFor(classMetaForCtor(ctorOf(this)), name).expose = meta;
  });
}

/** The constructor of an instance, as the WeakMap key for its class metadata. */
function ctorOf(instance: unknown): object {
  return (instance as { constructor: object }).constructor;
}

function expose(
  optionsOrValue?: AgentExposeOptions | ((...args: never[]) => unknown),
  maybeContext?: unknown,
): AgentMethodDecorator | undefined {
  if (isDecoratorContext(maybeContext)) {
    // Bare usage: `@foom.expose method() {}` — invoked as the decorator itself.
    applyExpose(undefined, maybeContext);
    return;
  }
  const options = optionsOrValue as AgentExposeOptions | undefined;
  const decorate = (_value: unknown, context: MethodContext): void => applyExpose(options, context);
  return decorate as unknown as AgentMethodDecorator;
}

/**
 * The microfoom decorator namespace. {@link AgentConfigDecorator | `foom.config`}
 * sets agent config on a class or method; {@link AgentExposeDecorator | `foom.expose`}
 * makes a method agent-callable. Both run at class-definition time and only record
 * metadata — they never run prompts.
 *
 * @example
 * ```ts
 * @foom.config({ model: "openrouter/deepseek/deepseek-v4-flash" })
 * export default class extends Program(Input) {
 *   async main() {
 *     return await this.agent.value(z.number())`Pick a number. foom_return it.`;
 *   }
 *
 *   @foom.expose({ announcement: "Generates a random integer in [min, max]." })
 *   async randomInt(min: number, max: number) {
 *     return Math.floor(Math.random() * (max - min + 1)) + min;
 *   }
 * }
 * ```
 */
export const foom: AgentDecorators = {
  config: (options: AgentOptions) => makeConfig(options),
  expose: expose as unknown as AgentExposeDecorator,
};
