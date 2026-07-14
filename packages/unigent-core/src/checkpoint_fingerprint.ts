import { createHash } from "node:crypto";
import { AgentConfigError } from "./errors.js";

type Normalized = boolean | number | string | null | readonly Normalized[] | NormalizedRecord;
interface NormalizedRecord {
  readonly [key: string]: Normalized;
}

function normalize(value: unknown, seen: Set<object>): Normalized {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AgentConfigError("checkpoint fingerprint contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new AgentConfigError(`checkpoint fingerprint cannot contain ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new AgentConfigError("checkpoint fingerprint contains a cycle");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalize(entry, seen));
    seen.delete(value);
    return normalized;
  }
  const normalized: Record<string, Normalized> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalize(Reflect.get(value, key), seen);
  }
  seen.delete(value);
  return normalized;
}

/** Produce a deterministic SHA-256 identity from output-shaping configuration. */
function checkpointFingerprint(ingredients: unknown): string {
  const serialized = JSON.stringify(normalize(ingredients, new Set()));
  return createHash("sha256").update(serialized).digest("hex");
}

export { checkpointFingerprint };
