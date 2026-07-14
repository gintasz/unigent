import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AgentConfigError } from "./errors.js";
import type { AgentUsage } from "./usage.js";

/** Serializable output retained for one successful stateless run. */
type CheckpointValue =
  | { readonly kind: "output"; readonly value: unknown }
  | { readonly kind: "done" };

/** One successful stateless run retained for restart and live deduplication. */
interface CheckpointRecord {
  readonly version: 1;
  readonly value: CheckpointValue;
  readonly usage: AgentUsage;
}

/** Content-addressed checkpoint boundary. */
interface CheckpointStore {
  readonly get: (
    key: string,
  ) => CheckpointRecord | undefined | Promise<CheckpointRecord | undefined>;
  readonly set: (key: string, record: CheckpointRecord) => void | Promise<void>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value: unknown): value is AgentUsage {
  const optionalNumbersAreValid =
    typeof value === "object" &&
    value !== null &&
    (!("cachedInputTokens" in value) || isFiniteNumber(value.cachedInputTokens)) &&
    (!("reasoningTokens" in value) || isFiniteNumber(value.reasoningTokens)) &&
    (!("costUsd" in value) || isFiniteNumber(value.costUsd));
  return (
    typeof value === "object" &&
    value !== null &&
    "inputTokens" in value &&
    isFiniteNumber(value.inputTokens) &&
    "outputTokens" in value &&
    isFiniteNumber(value.outputTokens) &&
    "totalTokens" in value &&
    isFiniteNumber(value.totalTokens) &&
    "calls" in value &&
    isFiniteNumber(value.calls) &&
    optionalNumbersAreValid
  );
}

function isCheckpointValue(value: unknown): value is CheckpointValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (("kind" in value && value.kind === "done") ||
      ("kind" in value && value.kind === "output" && "value" in value))
  );
}

function parseRecord(value: unknown): CheckpointRecord | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("value" in value) ||
    !isCheckpointValue(value.value) ||
    !("usage" in value) ||
    !isUsage(value.usage)
  ) {
    return;
  }
  return { version: 1, value: value.value, usage: value.usage };
}

function parseLine(line: string): readonly [string, CheckpointRecord] | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || !("key" in parsed)) {
      return;
    }
    const record = "record" in parsed ? parseRecord(parsed.record) : undefined;
    return typeof parsed.key === "string" && record !== undefined
      ? [parsed.key, record]
      : undefined;
  } catch {
    return;
  }
}

/** Create an ephemeral checkpoint store. */
function createMemoryCheckpointStore(): CheckpointStore {
  const records = new Map<string, CheckpointRecord>();
  return {
    get: (key: string): CheckpointRecord | undefined => records.get(key),
    set: (key: string, record: CheckpointRecord): void => {
      records.set(key, record);
    },
  };
}

/** Create a crash-tolerant JSONL checkpoint store. */
function createFileCheckpointStore(filePath: string): CheckpointStore {
  mkdirSync(dirname(filePath), { recursive: true });
  const records = new Map<string, CheckpointRecord>();
  if (existsSync(filePath)) {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      const entry = parseLine(line);
      if (entry !== undefined) {
        records.set(entry[0], entry[1]);
      }
    }
  }
  let tail: Promise<void> = Promise.resolve();
  return {
    get: (key: string): CheckpointRecord | undefined => records.get(key),
    set: async (key: string, record: CheckpointRecord): Promise<void> => {
      let line: string;
      try {
        line = `${JSON.stringify({ key, record })}\n`;
      } catch (error) {
        throw new AgentConfigError("checkpoint output is not JSON serializable", { cause: error });
      }
      const write = tail.then(async (): Promise<void> => {
        await appendFile(filePath, line);
      });
      tail = write.catch(() => undefined);
      await write;
      records.set(key, record);
    },
  };
}

export type { CheckpointRecord, CheckpointStore, CheckpointValue };
export { createFileCheckpointStore, createMemoryCheckpointStore };
