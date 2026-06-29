// The Claude Code CLI harness adapter: binds core's harness port
// (OpenSession/HarnessSession) to the `claude` CLI in non-interactive `--print`
// mode. Named `claudecli` to leave room for a future SDK-based adapter; the CLI
// path is what lets a run use the user's Claude subscription (OAuth) instead of an
// API key.
//
// Each microfoom turn is one `claude -p` subprocess. Its loop owns the model calls
// and runs the FOOM tools by calling back into an in-process HTTP MCP server (mcp.ts)
// — so a tool's `execute` is the real core closure over the live program. A turn
// runs to natural completion (the model stops after foom_return's tool result), so
// the terminal `result` event carries exact usage + cost. A `session()` threads one
// Claude session id across turns via `--resume`; `fork()` branches it with
// `--fork-session`.

import { randomUUID } from "node:crypto";
import {
  FoomtimeConfigError,
  FoomtimeHarnessRejectedError,
  FoomtimeHarnessUnavailableError,
  type HarnessSession,
  type HarnessSessionOptions,
  type NeutralToolDef,
  type OpenSession,
  type SessionTurnRequest,
  type SessionTurnResult,
} from "@microfoom/core";
import { startMcpServer } from "./mcp.js";
import {
  type ClaudeProcess,
  type ClaudeProcessFactory,
  type ClaudeSpec,
  spawnClaude,
} from "./process.js";
import { applyRename } from "./rename.js";
import { createTurnReader, type TurnReader } from "./stream.js";

// The subprocess seam is public: a caller can inject a custom launcher (tests,
// sandboxing, a different binary path) via ClaudeCliSessionOptions.processFactory.
export type { ClaudeProcess, ClaudeProcessFactory, ClaudeSpec } from "./process.js";

export const CLAUDECLI_HARNESS_VERSION = "0.1.0";

/** Default MCP server name → tool prefix `mcp__foom__`. */
const DEFAULT_SERVER_NAME = "foom";

export interface ClaudeCliSessionOptions {
  /**
   * Inject the per-turn subprocess launcher (tests). Default: spawn the real
   * `claude` binary. A fake can replay a scripted model against the live MCP
   * server, keeping the adapter offline + deterministic.
   */
  readonly processFactory?: ClaudeProcessFactory;
  /**
   * Append the program prompt to Claude Code's own system prompt (keeping its
   * coding persona + built-in tools) instead of replacing it. Default false: the
   * harness sends ONLY microfoom's prompt, for a controlled session.
   */
  readonly appendSystemPrompt?: boolean;
  /** MCP server name; changes the tool prefix. Default `foom`. */
  readonly serverName?: string;
  /** Extra `claude` args appended to every turn (escape hatch). */
  readonly extraArgs?: readonly string[];
}

/** Compose Claude's base prompt with the program prompt (append mode); in replace
 *  mode there is no base, so the program prompt is sent verbatim. */
function composeSystemPrompt(programPrompt: string): string {
  return programPrompt;
}

/**
 * Reconcile core's bare FOOM tool names with the prefixed `mcp__<server>__<name>`
 * the model actually sees: rewrite every reference (tool descriptions, system
 * prompt, prompt) so the two agree. Each tool's `.name` stays canonical for MCP
 * routing.
 */
function renameForModel(
  request: SessionTurnRequest,
  serverName: string,
): { names: string[]; renamedTools: NeutralToolDef[]; systemPrompt: string; prompt: string } {
  const names = request.tools.map((tool) => tool.name);
  const renamedTools: NeutralToolDef[] = request.tools.map((tool) => ({
    ...tool,
    description: applyRename(tool.description, names, serverName),
  }));
  return {
    names,
    renamedTools,
    systemPrompt: applyRename(composeSystemPrompt(request.systemPrompt), names, serverName),
    prompt: applyRename(request.prompt, names, serverName),
  };
}

/**
 * Resolve the Claude session argv for this turn: a fresh session pins a new id; a
 * continued session resumes the current id; a fork's first turn resumes the seed
 * id AND branches from it.
 */
function resolveSessionArgs(
  currentSessionId: string | undefined,
  seedSessionId: string | undefined,
): { newId: string | undefined; resumeSessionId: string | undefined; fork: boolean } {
  const fresh = currentSessionId === undefined && seedSessionId === undefined;
  return {
    newId: fresh ? randomUUID() : undefined,
    resumeSessionId: currentSessionId ?? seedSessionId,
    fork: currentSessionId === undefined && seedSessionId !== undefined,
  };
}

/** Drain the subprocess's JSONL stdout into the reader, tolerating non-JSON noise. */
async function drainTurnStream(proc: ClaudeProcess, reader: TurnReader): Promise<void> {
  for await (const line of proc.lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // tolerate any non-JSON noise on the stream
    }
    reader.handle(event);
  }
}

/**
 * Validate the drained turn and produce its result, mapping a reported harness
 * failure or a missing `result` event to the right typed error.
 */
function resolveTurnResult(reader: TurnReader, proc: ClaudeProcess): SessionTurnResult {
  const failure = reader.error();
  if (failure !== undefined) {
    throw failure.retryable
      ? new FoomtimeHarnessUnavailableError(failure.message)
      : new FoomtimeHarnessRejectedError(failure.message);
  }
  if (!reader.resultSeen()) {
    const detail = proc.stderr().trim();
    throw new FoomtimeHarnessUnavailableError(
      detail.length > 0 ? detail : "claude produced no result",
    );
  }
  return { assistantText: reader.assistantText(), usage: reader.usage() };
}

/** Claude Code session scoping derived from a microfoom session's skills/plugins. */
export interface ClaudeSessionControls {
  /** Settings to inject via `--settings` (e.g. `enabledPlugins`); absent = none. */
  readonly settings?: Record<string, unknown>;
  /** Disable ALL skills (`--disable-slash-commands`). */
  readonly disableSlashCommands: boolean;
}

/**
 * Map a session's `skills`/`plugins` (opaque, tri-state — see core's `AgentConfig`)
 * onto Claude Code session controls. The session runs hermetic
 * (`--setting-sources ""`), so nothing is enabled by ambient config; these only ever
 * turn chosen plugins ON and skills OFF.
 *
 *  - `plugins`: `undefined`/`[]` → no plugins (the hermetic default); a list →
 *    `enabledPlugins` enabling exactly those (ids are Claude's `name@marketplace`).
 *  - `skills`: `undefined` → Claude's default skills; `[]` → all skills off. A
 *    by-name allow-list throws — Claude skills default to "on", so allowing only N
 *    would require enumerating every skill to turn the rest off (unsupported here).
 */
export function buildSessionControls(
  skills: readonly string[] | undefined,
  plugins: readonly string[] | undefined,
): ClaudeSessionControls {
  const settings: Record<string, unknown> = {};
  if (plugins !== undefined && plugins.length > 0) {
    settings["enabledPlugins"] = Object.fromEntries(plugins.map((id) => [id, true]));
  }
  let disableSlashCommands = false;
  if (skills !== undefined) {
    if (skills.length === 0) {
      disableSlashCommands = true;
    } else {
      throw new FoomtimeConfigError(
        "the claudecli harness cannot allow-list skills by name (Claude Code skills default to on); use [] to disable all skills, or leave skills unset",
      );
    }
  }
  return {
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    disableSlashCommands,
  };
}

/**
 * Build an OpenSession backed by the `claude` CLI. Pass the result to runProgram's
 * `harnesses`. Models resolve through Claude Code itself (`--model`); auth comes
 * from the user's logged-in CLI.
 */
export function createClaudeCliOpenSession(options: ClaudeCliSessionOptions = {}): OpenSession {
  const factory = options.processFactory ?? spawnClaude;
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const appendSystemPrompt = options.appendSystemPrompt ?? false;

  return ({ model: modelId, skills, plugins }: HarnessSessionOptions): HarnessSession => {
    if (modelId.trim() === "") {
      throw new FoomtimeHarnessRejectedError("no model specified for the claudecli harness");
    }
    // Resolve skills/plugins scoping once per session — throws on unsupported config.
    const controls = buildSessionControls(skills, plugins);

    // One Claude session id per microfoom session: reused across runTurn calls via
    // `--resume`, so a session() is one continued conversation. A fork() seeds a
    // new HarnessSession that branches from the parent's latest id.
    const makeHarnessSession = (seedSessionId: string | undefined): HarnessSession => {
      let currentSessionId: string | undefined;

      const runTurn = async (request: SessionTurnRequest): Promise<SessionTurnResult> => {
        const { names, renamedTools, systemPrompt, prompt } = renameForModel(request, serverName);
        const server = await startMcpServer(renamedTools, serverName);
        const { newId, resumeSessionId, fork } = resolveSessionArgs(
          currentSessionId,
          seedSessionId,
        );
        const spec: ClaudeSpec = {
          model: modelId,
          systemPrompt,
          prompt,
          mcpUrl: server.url,
          serverName,
          foomTools: names,
          allowedHarnessTools: request.allowedTools,
          effort: request.thinking,
          // Per-turn omit (request.omitBasePrompt) wins; else the construction default.
          // omit → don't append Claude's base; keep → append it.
          appendSystemPrompt:
            request.omitBasePrompt === undefined ? appendSystemPrompt : !request.omitBasePrompt,
          sessionId: newId,
          resumeSessionId,
          fork,
          extraArgs: options.extraArgs,
          ...(controls.settings !== undefined ? { settings: controls.settings } : {}),
          disableSlashCommands: controls.disableSlashCommands,
          signal: request.signal,
        };

        const reader = createTurnReader(serverName, request.onEvent);
        const proc = factory(spec);
        try {
          await drainTurnStream(proc, reader);
        } finally {
          await server.close();
        }

        const result = resolveTurnResult(reader, proc);
        currentSessionId = reader.sessionId() ?? newId ?? currentSessionId;
        return result;
      };

      return {
        systemPrompt(programPrompt: string): string {
          return composeSystemPrompt(programPrompt);
        },
        runTurn,
        fork(): HarnessSession {
          return makeHarnessSession(currentSessionId ?? seedSessionId);
        },
      };
    };

    return makeHarnessSession(undefined);
  };
}
