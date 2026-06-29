/**
 * `@microfoom/codexcli-adapter` — drives the OpenAI Codex CLI (`codex exec --json`)
 * as a microfoom harness, so a run can use the user's Codex/ChatGPT subscription.
 * FOOM tools execute via an in-process MCP server.
 *
 * @packageDocumentation
 */

// The Codex CLI harness adapter: binds core's harness port
// (OpenSession/HarnessSession) to the `codex exec` non-interactive CLI. Named
// `codexcli` to mirror `claudecli` and leave room for an SDK-based adapter; the CLI
// path lets a run use the user's Codex login (ChatGPT auth) instead of an API key.
//
// Each microfoom turn is one `codex exec` subprocess. Its loop owns the model calls
// and runs the FOOM tools by calling back into an in-process HTTP MCP server (mcp.ts)
// — so a tool's `execute` is the real core closure over the live program. A turn
// runs to natural completion (the terminal `turn.completed` event carries usage). A
// session threads one Codex thread id across turns via `exec resume`; `fork()`
// branches it by copying the session's rollout file (fork.ts).

import process from "node:process";
import { drainTurnStream, resolveTurnResult, startMcpServer } from "@microfoom/adapter-base";
import {
  FoomHarnessRejectedError,
  FoomHarnessUnavailableError,
  type HarnessSession,
  type HarnessSessionOptions,
  type OpenSession,
  type SessionTurnRequest,
  type SessionTurnResult,
} from "@microfoom/core";
import { forkRolloutSession } from "./fork.js";
import { type CodexProcessFactory, type CodexSpec, freshSessionId, spawnCodex } from "./process.js";
import { discoverSkills, skillsToDisable } from "./skills.js";
import { createTurnReader } from "./stream.js";

const CODEXCLI_VERSION = "0.1.0";

/** Default MCP server name → Codex config key `mcp_servers.foom`. */
const DEFAULT_SERVER_NAME = "foom";

/** Branch a session: copy a parent's rollout to a fresh id and return it. */
type BranchSession = (parentSessionId: string, workdir: string) => string;

/** Options for {@link createCodexCliOpenSession} — the Codex-CLI-backed harness. */
interface CodexCliSessionOptions {
  /**
   * Inject the per-turn subprocess launcher (tests). Default: spawn the real
   * `codex` binary. A fake can replay a scripted model against the live MCP
   * server, keeping the adapter offline + deterministic.
   */
  readonly processFactory?: CodexProcessFactory;
  /**
   * Branch a session for `fork()`. Default: copy the Codex rollout file
   * (fork.ts). When a `processFactory` is injected (tests), the default instead
   * mints a fresh in-memory id — no rollout files exist offline.
   */
  readonly branchSession?: BranchSession;
  /** MCP server name; changes the Codex config key. Default `foom`. */
  readonly serverName?: string;
  /** Working directory Codex runs in (pinned so a forked session resumes cleanly).
   *  Default: the process's cwd. */
  readonly workdir?: string;
  /** Extra `codex` args appended to every turn (escape hatch). */
  readonly extraArgs?: readonly string[];
}

/** Codex replaces its base instructions with the turn's system prompt, so the full
 *  system prompt IS the program prompt — sent verbatim. */
function composeSystemPrompt(programPrompt: string): string {
  return programPrompt;
}

/** Resolve which session id a turn resumes: our own once established; else a fresh
 *  branch off the fork seed (copying the parent's rollout); else undefined for a
 *  brand-new session. Hoisted (not a closure) to keep the session factory simple. */
function resolveResumeId(
  currentSessionId: string | undefined,
  seedSessionId: string | undefined,
  branchSession: BranchSession,
  workdir: string,
): string | undefined {
  if (currentSessionId !== undefined) {
    return currentSessionId;
  }
  if (seedSessionId === undefined) {
    return;
  }
  try {
    return branchSession(seedSessionId, workdir);
  } catch (error) {
    throw new FoomHarnessUnavailableError(
      `codex fork failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Build an OpenSession backed by the Codex CLI. Pass the result to runProgram's
 * `harnesses`. Models resolve through Codex itself (`-m`); auth comes from the
 * user's logged-in CLI (CODEX_HOME).
 */
function createCodexCliOpenSession(options: CodexCliSessionOptions = {}): OpenSession {
  const factory = options.processFactory ?? spawnCodex;
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const workdir = options.workdir ?? process.cwd();
  // Real rollout-file copy when driving the real binary; a fresh id offline.
  const branchSession: BranchSession =
    options.branchSession ??
    (options.processFactory === undefined ? forkRolloutSession : (): string => freshSessionId());

  // `plugins` is intentionally ignored: Codex has no per-invocation plugin
  // enable/disable, so the cap is inert (not an error) rather than honored.
  return ({ model: modelId, skills }: HarnessSessionOptions): HarnessSession => {
    if (modelId.trim() === "") {
      throw new FoomHarnessRejectedError("no model specified for the codexcli harness");
    }
    // Resolve the skills tri-state once per session. Only scan the skill roots when
    // skills are actually constrained (the common unset case keeps all, no scan).
    const skillDisablePaths =
      skills === undefined ? undefined : skillsToDisable(discoverSkills(workdir), skills);

    // One Codex thread id per microfoom session: reused across runTurn calls via
    // `exec resume`, so a session() is one continued conversation. A fork() seeds a
    // new HarnessSession that branches from the parent's latest id on its first turn.
    const makeHarnessSession = (seedSessionId: string | undefined): HarnessSession => {
      let currentSessionId: string | undefined;

      const runTurn = async (request: SessionTurnRequest): Promise<SessionTurnResult> => {
        const resumeSessionId = resolveResumeId(
          currentSessionId,
          seedSessionId,
          branchSession,
          workdir,
        );
        // Pin a fork's freshly-branched id so a follow-up turn resumes the branch.
        if (currentSessionId === undefined && resumeSessionId !== undefined) {
          currentSessionId = resumeSessionId;
        }
        const server = await startMcpServer(request.tools, serverName);
        const spec: CodexSpec = {
          model: modelId,
          systemPrompt: composeSystemPrompt(request.systemPrompt),
          prompt: request.prompt,
          mcpUrl: server.url,
          serverName,
          workdir,
          effort: request.thinking,
          skillDisablePaths,
          resumeSessionId,
          extraArgs: options.extraArgs,
          signal: request.signal,
        };

        const reader = createTurnReader(request.onEvent);
        const proc = factory(spec);
        try {
          await drainTurnStream(proc, reader.handle);
        } finally {
          await server.close();
        }

        const result = resolveTurnResult(reader, proc, "codex");
        currentSessionId = reader.sessionId() ?? resumeSessionId ?? currentSessionId;
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
// sandboxing, a different binary path) via CodexCliSessionOptions.processFactory.
export type { CodexProcess, CodexProcessFactory, CodexSpec } from "./process.js";
export type { BranchSession, CodexCliSessionOptions };
export { CODEXCLI_VERSION, createCodexCliOpenSession };
