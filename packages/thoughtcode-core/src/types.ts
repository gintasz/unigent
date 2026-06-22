// The ThoughtCode type system: ArkType-backed value/annotation checks. Pure.

import { type } from "arktype";

export type ReturnTypeCheck = { ok: true } | { ok: false; message: string };

/**
 * Coerce a ThoughtCode type annotation into an ArkType definition. Structural types (objects/tuples)
 * are JSON and parse to a JS structure; scalar/expression types are bare ArkType strings and pass
 * through. No bespoke parser — JSON.parse plus ArkType.
 */
function toArkDefinition(annotation: string): unknown {
  try {
    return JSON.parse(annotation);
  } catch {
    return annotation;
  }
}

/** VIBERETURN values arrive as strings; JSON-decode so numbers/objects validate, else keep raw. */
function toValue(rawValue: string): unknown {
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

/** True if the annotation compiles to a usable ArkType validator. */
export function isParsableReturnType(annotation: string): boolean {
  try {
    type(toArkDefinition(annotation) as never);
    return true;
  } catch {
    return false;
  }
}

/** Validate an already-decoded value against an ArkType annotation (malformed annotation = no constraint). */
export function validateValue(value: unknown, annotation: string): ReturnTypeCheck {
  let validator: (data: unknown) => unknown;
  try {
    validator = type(toArkDefinition(annotation) as never) as unknown as (data: unknown) => unknown;
  } catch {
    return { ok: true };
  }
  const out = validator(value);
  if (out instanceof type.errors) {
    return { ok: false, message: out.summary };
  }
  return { ok: true };
}

/** Validate a VIBERETURN value (a string) against a declared return-type annotation. */
export function checkReturnValue(rawValue: string, annotation: string): ReturnTypeCheck {
  return validateValue(toValue(rawValue), annotation);
}
