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
  FoomtimeHarnessRejectedError,
  FoomtimeHarnessUnavailableError,
  type HarnessSession,
  type NeutralToolDef,
  type OpenSession,
  type SessionTurnRequest,
  type SessionTurnResult,
} from "@microfoom/core";
import { startMcpServer } from "./mcp.js";
import { type ClaudeProcessFactory, type ClaudeSpec, spawnClaude } from "./process.js";
import { applyRename } from "./rename.js";
import { createTurnReader } from "./stream.js";

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
 * Build an OpenSession backed by the `claude` CLI. Pass the result to runProgram's
 * `harnesses`. Models resolve through Claude Code itself (`--model`); auth comes
 * from the user's logged-in CLI.
 */
export function createClaudeCliOpenSession(options: ClaudeCliSessionOptions = {}): OpenSession {
  const factory = options.processFactory ?? spawnClaude;
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const appendSystemPrompt = options.appendSystemPrompt ?? false;

  return ({ model: modelId }): HarnessSession => {
    if (modelId.trim() === "") {
      throw new FoomtimeHarnessRejectedError("no model specified for the claudecli harness");
    }

    // One Claude session id per microfoom session: reused across runTurn calls via
    // `--resume`, so a session() is one continued conversation. A fork() seeds a
    // new HarnessSession that branches from the parent's latest id.
    const makeHarnessSession = (seedSessionId: string | undefined): HarnessSession => {
      let currentSessionId: string | undefined;

      const runTurn = async (request: SessionTurnRequest): Promise<SessionTurnResult> => {
        const names = request.tools.map((tool) => tool.name);

        // Reconcile the prefix: core's tool descriptions + prompts reference bare
        // FOOM names, but the model only ever sees `mcp__<server>__<name>`. Rewrite
        // every reference so the two agree. Tool .name stays canonical (MCP routing).
        const renamedTools: NeutralToolDef[] = request.tools.map((tool) => ({
          ...tool,
          description: applyRename(tool.description, names, serverName),
        }));
        const systemPrompt = applyRename(
          composeSystemPrompt(request.systemPrompt),
          names,
          serverName,
        );
        const prompt = applyRename(request.prompt, names, serverName);

        const server = await startMcpServer(renamedTools, serverName);

        // Session argv: fresh (pin a new id), continue (resume current), or the
        // fork's first turn (resume the seed AND branch).
        const fresh = currentSessionId === undefined && seedSessionId === undefined;
        const newId = fresh ? randomUUID() : undefined;
        const spec: ClaudeSpec = {
          model: modelId,
          systemPrompt,
          prompt,
          mcpUrl: server.url,
          serverName,
          foomTools: names,
          allowedHarnessTools: request.allowedTools,
          effort: request.thinking,
          appendSystemPrompt,
          sessionId: newId,
          resumeSessionId: currentSessionId ?? seedSessionId,
          fork: currentSessionId === undefined && seedSessionId !== undefined,
          extraArgs: options.extraArgs,
          signal: request.signal,
        };

        const reader = createTurnReader(serverName, request.onEvent);
        const proc = factory(spec);
        try {
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
        } finally {
          await server.close();
        }

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

        currentSessionId = reader.sessionId() ?? newId ?? currentSessionId;
        return { assistantText: reader.assistantText(), usage: reader.usage() };
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
