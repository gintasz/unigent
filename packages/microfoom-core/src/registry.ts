// Decorator metadata store (internal). @foom.config / @foom.expose record
// per-class and per-method metadata; the runtime reads it back to build the config
// cascade and the dispatch table.
//
// Keyed by the class constructor in a module WeakMap, populated through decorator
// initializers (context.addInitializer) — deliberately NOT via Symbol.metadata,
// whose runtime emission differs between tsc and the test transformer. Method
// metadata is therefore complete once an instance has been constructed, which the
// runtime always does before reading.

import type { AgentOptions, AgentToolOptions } from "./options.js";

/** Advertisement tier of an exposed method (F3). */
export type ExposureTier = "silent" | "announcement" | "tool";

/** What `@foom.expose` recorded for one method. */
export interface ExposeMeta {
  readonly dispatchName: string;
  readonly tier: ExposureTier;
  readonly announcement?: string;
  readonly tool?: AgentToolOptions;
}

/** Per-method metadata: its scoped config and (if exposed) its exposure. */
export interface MethodMeta {
  config?: AgentOptions;
  expose?: ExposeMeta;
}

/** Per-class metadata: class-scoped config and the method table. */
export interface ClassMeta {
  config?: AgentOptions;
  readonly methods: Map<string, MethodMeta>;
}

const store = new WeakMap<object, ClassMeta>();

/** Get (or create) the metadata for a class constructor. */
export function classMetaForCtor(ctor: object): ClassMeta {
  let meta = store.get(ctor);
  if (meta === undefined) {
    meta = { methods: new Map() };
    store.set(ctor, meta);
  }
  return meta;
}

/** Get (or create) the per-method metadata within a class. */
export function methodMetaFor(classMeta: ClassMeta, name: string): MethodMeta {
  let meta = classMeta.methods.get(name);
  if (meta === undefined) {
    meta = {};
    classMeta.methods.set(name, meta);
  }
  return meta;
}

/** Read the metadata for a constructed program instance, if any decorator ran. */
export function readClassMeta(instance: object): ClassMeta | undefined {
  return store.get(instance.constructor);
}

/** The exposed methods of an instance, by dispatch name. */
export function exposedMethods(instance: object): Map<string, ExposeMeta> {
  const result = new Map<string, ExposeMeta>();
  const meta = readClassMeta(instance);
  if (meta === undefined) return result;
  for (const method of meta.methods.values()) {
    if (method.expose !== undefined) result.set(method.expose.dispatchName, method.expose);
  }
  return result;
}
