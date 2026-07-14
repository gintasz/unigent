import type { AgentEvent } from "@unigent/core";

const PROTOCOL_VERSION = 1;
const MAX_STRING_LENGTH = 32_768;
const MAX_ARRAY_LENGTH = 100;

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

interface TraceRecord {
  readonly version: typeof PROTOCOL_VERSION;
  readonly event: AgentEvent;
}

function normalizeTraceScalar(value: unknown): unknown {
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}… [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
  }
  return value;
}

function traceReplacer(): (key: string, value: unknown) => unknown {
  const ancestors: object[] = [];
  const replacementSources = new WeakMap<object, object>();
  return function traceValue(this: object, _key: string, value: unknown): unknown {
    const normalizedValue = normalizeTraceScalar(value);
    if (typeof normalizedValue !== "object" || normalizedValue === null) {
      return normalizedValue;
    }
    const parent = replacementSources.get(this) ?? this;
    while (ancestors.length > 0 && ancestors.at(-1) !== parent) {
      ancestors.pop();
    }
    if (ancestors.includes(normalizedValue)) {
      return "[Circular]";
    }
    ancestors.push(normalizedValue);
    if (isUnknownArray(normalizedValue) && normalizedValue.length > MAX_ARRAY_LENGTH) {
      const truncated = [
        ...normalizedValue.slice(0, MAX_ARRAY_LENGTH),
        `[truncated ${normalizedValue.length - MAX_ARRAY_LENGTH} items]`,
      ];
      replacementSources.set(truncated, normalizedValue);
      return truncated;
    }
    return normalizedValue;
  };
}

function serializeTraceEvent(event: AgentEvent): string {
  return `${JSON.stringify({ version: PROTOCOL_VERSION, event }, traceReplacer())}\n`;
}

function isTraceRecord(value: unknown): value is TraceRecord {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1) {
    return false;
  }
  if (!("event" in value) || typeof value.event !== "object" || value.event === null) {
    return false;
  }
  const { event } = value;
  return (
    "type" in event &&
    typeof event.type === "string" &&
    "traceId" in event &&
    typeof event.traceId === "string" &&
    "spanId" in event &&
    typeof event.spanId === "string"
  );
}

function parseTraceRecord(line: string): TraceRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isTraceRecord(value) ? value : undefined;
  } catch {
    return;
  }
}

const TRACE_TRANSPORT_ENVIRONMENT_VARIABLE = "UNIGENT_TRACE_FILE_DESCRIPTOR";

export { parseTraceRecord, serializeTraceEvent, TRACE_TRANSPORT_ENVIRONMENT_VARIABLE };
