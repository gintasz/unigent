// Branch a Codex session. Codex `exec` has no `--fork-session` flag (only the
// interactive `codex fork`, which drops into a TUI), so we replicate a fork the
// way Codex itself does: copy the parent session's rollout file to a fresh id and
// resume the copy. The parent keeps its own file, so the two diverge independently.
//
// Codex persists each session as a JSONL "rollout" under
// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, whose first line is a
// `session_meta` record carrying the session `id` and the `cwd`. We copy that file,
// rewrite `id` to the new branch id and `cwd` to the turn's working directory (so
// `exec resume` — which filters by cwd — can locate it), and hand back the new id.

import { randomUUID } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** The Codex home (sessions + auth live here). */
function codexHome(): string {
  // biome-ignore lint/style/noProcessEnv: CODEX_HOME is where the Codex CLI persists sessions + auth; reading it directly is the intent (it is not adapter config to route through an env module).
  return process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

/** Recursively collect every `*.jsonl` rollout path under a sessions directory. */
function listRollouts(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listRollouts(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

/** Find the rollout file whose name ends with `-<sessionId>.jsonl`. */
function findRollout(sessionId: string): string | undefined {
  const sessionsDir = join(codexHome(), "sessions");
  const suffix = `-${sessionId}.jsonl`;
  return listRollouts(sessionsDir).find((path) => path.endsWith(suffix));
}

/** Build a `rollout-<ts>-<id>.jsonl` path beside the parent's date folder. */
function branchPath(parentPath: string, newId: string): string {
  const dir = parentPath.slice(0, Math.max(0, parentPath.lastIndexOf("/")));
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return join(dir, `rollout-${stamp}-${newId}.jsonl`);
}

/** Rewrite the `session_meta` first line's `id` and `cwd`. Other lines pass through
 *  unchanged — only the meta keys the session for `exec resume`. */
function rewriteMeta(content: string, newId: string, workdir: string): string {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined || raw.trim() === "") {
      continue;
    }
    const record = JSON.parse(raw) as { type?: string; payload?: Record<string, unknown> };
    if (record.type === "session_meta" && record.payload !== undefined) {
      record.payload["id"] = newId;
      record.payload["cwd"] = workdir;
      lines[i] = JSON.stringify(record);
    }
    break; // session_meta is always the first non-empty line
  }
  return lines.join("\n");
}

/**
 * Copy `parentSessionId`'s rollout to a fresh id rooted at `workdir`, and return
 * the new id (to `exec resume`). Throws if the parent rollout can't be found —
 * the caller maps that to a retryable harness error so a fork on an unsupported
 * setup degrades to a skip rather than a hard failure.
 */
function forkRolloutSession(parentSessionId: string, workdir: string): string {
  const parentPath = findRollout(parentSessionId);
  if (parentPath === undefined) {
    throw new Error(`codex session ${parentSessionId} rollout not found to fork`);
  }
  const newId = randomUUID();
  const content = readFileSync(parentPath, "utf8");
  writeFileSync(branchPath(parentPath, newId), rewriteMeta(content, newId, workdir));
  return newId;
}

export { forkRolloutSession };
