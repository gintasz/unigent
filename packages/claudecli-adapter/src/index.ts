/**
 * `@microfoom/claudecli-adapter` — drives the `claude` CLI (non-interactive `--print`)
 * as a microfoom harness, so a run can use the user's Claude subscription. FOOM tools
 * execute via an in-process MCP server.
 *
 * @packageDocumentation
 */

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
  drainTurnStream,
  resolveTurnResult,
  startMcpServer,
  toolDescription,
} from "@microfoom/adapter-base";
import {
  FoomHarnessRejectedError,
  type HarnessSession,
  type HarnessSessionOptions,
  type NeutralToolDef,
  type OpenSession,
  type SessionTurnRequest,
  type SessionTurnResult,
} from "@microfoom/core";
import { buildSessionControls } from "./controls.js";
import { type ClaudeProcessFactory, type ClaudeSpec, spawnClaude } from "./process.js";
import { applyRename } from "./rename.js";
import { createTurnReader } from "./stream.js";

const CLAUDECLI_VERSION = "0.1.0";

/** Default MCP server name → tool prefix `mcp__foom__`. */
const DEFAULT_SERVER_NAME = "foom";

/** Options for {@link createClaudeCliOpenSession} — the `claude`-CLI-backed harness. */

interface ClaudeCliSessionOptions {
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

/**
 * Build an OpenSession backed by the `claude` CLI. Pass the result to runProgram's
 * `harnesses`. Models resolve through Claude Code itself (`--model`); auth comes
 * from the user's logged-in CLI.
 */
function createClaudeCliOpenSession(options: ClaudeCliSessionOptions = {}): OpenSession {
  const factory = options.processFactory ?? spawnClaude;
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const appendSystemPrompt = options.appendSystemPrompt ?? false;

  return ({ model: modelId, skills, plugins }: HarnessSessionOptions): HarnessSession => {
    if (modelId.trim() === "") {
      throw new FoomHarnessRejectedError("no model specified for the claudecli harness");
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
        const server = await startMcpServer(renamedTools, serverName, (tool) =>
          applyRename(toolDescription(tool), names, serverName),
        );
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
          ...(controls.settings === undefined ? {} : { settings: controls.settings }),
          disableSlashCommands: controls.disableSlashCommands,
          signal: request.signal,
        };

        const reader = createTurnReader(serverName, request.onEvent);
        const proc = factory(spec);
        try {
          await drainTurnStream(proc, reader.handle);
        } finally {
          await server.close();
        }

        const result = resolveTurnResult(reader, proc, "claude");
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

// The subprocess seam is public: a caller can inject a custom launcher (tests,
// sandboxing, a different binary path) via ClaudeCliSessionOptions.processFactory.
export type { ClaudeProcess, ClaudeProcessFactory, ClaudeSpec } from "./process.js";
export type { ClaudeCliSessionOptions };
export { CLAUDECLI_VERSION, createClaudeCliOpenSession };
