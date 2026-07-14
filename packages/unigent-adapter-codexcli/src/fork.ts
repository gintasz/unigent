import { randomUUID } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function codexHome(): string {
  // biome-ignore lint/style/noProcessEnv: CODEX_HOME is where the CLI persists resumable sessions.
  return process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

function rolloutFiles(directory: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry): readonly string[] => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return rolloutFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
  });
}

function sessionMetadata(content: string): JsonObject | undefined {
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const record = object(JSON.parse(line) as unknown);
      const payload = object(record?.["payload"]);
      if (record?.["type"] === "session_meta" && payload !== undefined) {
        return payload;
      }
    } catch {
      // Non-JSON rollout lines cannot identify a session.
    }
  }
  return;
}

function rolloutFor(sessionId: string): string | undefined {
  return rolloutFiles(join(codexHome(), "sessions")).find((path) => {
    try {
      return sessionMetadata(readFileSync(path, "utf8"))?.["id"] === sessionId;
    } catch {
      return false;
    }
  });
}

function replacementPath(parent: string, sessionId: string): string {
  return join(
    dirname(parent),
    `rollout-${new Date().toISOString().replaceAll(":", "-")}-${sessionId}.jsonl`,
  );
}

function replacementContent(content: string, sessionId: string, workdir: string): string {
  const lines = content.split("\n");
  let replaced = false;
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const record = object(JSON.parse(line) as unknown);
      const payload = object(record?.["payload"]);
      if (record?.["type"] === "session_meta" && payload !== undefined) {
        if (replaced) {
          throw new Error("Codex rollout contains multiple session_meta records");
        }
        payload["id"] = sessionId;
        payload["cwd"] = workdir;
        lines[index] = JSON.stringify(record);
        replaced = true;
      }
    } catch (error) {
      if (line.includes('"session_meta"')) {
        throw new Error("Codex rollout contains invalid session metadata", { cause: error });
      }
    }
  }
  if (!replaced) {
    throw new Error("Codex rollout has no session_meta record");
  }
  return lines.join("\n");
}

/** Copy a persisted Codex rollout so the child session can resume independently. */
export function forkCodexSession(parentSessionId: string, workdir: string): string {
  const parent = rolloutFor(parentSessionId);
  if (parent === undefined) {
    throw new Error(`Codex session ${parentSessionId} rollout was not found`);
  }
  const sessionId = randomUUID();
  const content = readFileSync(parent, "utf8");
  writeFileSync(
    replacementPath(parent, sessionId),
    replacementContent(content, sessionId, workdir),
  );
  return sessionId;
}
