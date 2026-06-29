/**
 * `@microfoom/opencode-adapter` — drives the OpenCode agent (via `@opencode-ai/sdk`)
 * as a microfoom harness, so a run can use the user's OpenCode providers. FOOM tools
 * execute via an in-process MCP server the OpenCode child connects back to.
 *
 * @packageDocumentation
 */

// The OpenCode harness adapter: binds core's harness port (OpenSession/
// HarnessSession) to a programmatic OpenCode server. Each microfoom turn spawns a
// fresh `opencode serve` child (via the SDK), runs one `session.prompt`, and tears
// the child down — a clean per-turn lifecycle, with each child re-listing this
// turn's MCP tools afresh. Sessions live in OpenCode's global database, so one
// `session()` threads a single conversation across turns by id; `fork()` branches
// it via `session.fork`. The model loop and tool execution happen inside the child;
// the FOOM tools are served by an in-process MCP server (mcp.ts) so each tool's
// `execute` is the real core closure over the live program.

import {
  FoomHarnessRejectedError,
  FoomHarnessUnavailableError,
  type HarnessSession,
  type HarnessSessionOptions,
  type NeutralToolDef,
  type OpenSession,
  type SessionTurnRequest,
  type SessionTurnResult,
} from "@microfoom/core";
import {
  type OpenCodeBackend,
  type OpenCodeBackendFactory,
  type OpenCodeConfig,
  type PromptSpec,
  spawnOpenCodeBackend,
  splitModel,
} from "./backend.js";
import { buildSessionControls, type OpenCodeSessionControls } from "./controls.js";
import { startMcpServer } from "./mcp.js";
import { applyRename } from "./rename.js";
import type { TurnOutcome } from "./result.js";

const OPENCODE_VERSION = "0.1.0";

/** Default MCP server name → tool prefix `foom_`. */
const DEFAULT_SERVER_NAME = "foom";

/** OpenCode's built-in tool names. A per-turn `allowedTools: []` disables every one
 *  of these (so a bare session cannot touch the machine); a list enables only the
 *  named ones. FOOM tools come from MCP and are never in this map. */
const BUILTIN_TOOLS: readonly string[] = [
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "glob",
  "list",
  "webfetch",
  "todowrite",
  "todoread",
  "task",
  "patch",
  "skill",
];

/** Options for {@link createOpenCodeOpenSession} — the OpenCode-backed harness. */
interface OpenCodeSessionOptions {
  /**
   * Inject the per-turn backend launcher (tests). Default: spawn the real
   * `opencode serve` child via the SDK. A fake can replay a scripted model against
   * the live MCP server, keeping the adapter offline + deterministic.
   */
  readonly backendFactory?: OpenCodeBackendFactory;
  /** MCP server name; changes the tool prefix. Default `foom`. */
  readonly serverName?: string;
}

/** The system prompt this session sends for a program prompt. OpenCode's `system`
 *  field REPLACES its base prompt, so the program prompt is sent verbatim. */
function composeSystemPrompt(programPrompt: string): string {
  return programPrompt;
}

/**
 * Reconcile core's bare FOOM tool names with the prefixed `<server>_<name>` the
 * model actually sees: rewrite every reference (tool descriptions, system prompt,
 * prompt) so the two agree. Each tool's `.name` stays canonical for MCP routing.
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

/** Build the per-turn OpenCode built-in tool gate from core's `allowedTools`:
 *  undefined → leave OpenCode's default; [] → every built-in off; a list → only
 *  those on. */
function buildTurnTools(
  allowedTools: readonly string[] | undefined,
): Record<string, boolean> | undefined {
  if (allowedTools === undefined) {
    return;
  }
  const allowed = new Set(allowedTools);
  return Object.fromEntries(BUILTIN_TOOLS.map((name) => [name, allowed.has(name)]));
}

/** Resolve this turn's OpenCode session id: reuse the current one if set; else
 *  branch from a fork seed; else open a fresh session. */
async function resolveSessionId(
  backend: OpenCodeBackend,
  currentSessionId: string | undefined,
  seedSessionId: string | undefined,
): Promise<string> {
  if (currentSessionId !== undefined) {
    return currentSessionId;
  }
  return seedSessionId === undefined ? backend.createSession() : backend.forkSession(seedSessionId);
}

/** Map a turn's reported failure to the right typed harness error (or do nothing). */
function throwOnTurnError(outcome: TurnOutcome): void {
  if (outcome.error === undefined) {
    return;
  }
  throw outcome.error.retryable
    ? new FoomHarnessUnavailableError(outcome.error.message)
    : new FoomHarnessRejectedError(outcome.error.message);
}

/** Build the OpenCode child config: serve the FOOM MCP tools, keep the session
 *  hermetic (no skills, no sharing, no auto-update), and pre-allow tool permissions
 *  so an enabled tool never blocks on an interactive prompt. */
function buildConfig(
  mcpUrl: string,
  serverName: string,
  controls: OpenCodeSessionControls,
): OpenCodeConfig {
  return {
    mcp: { [serverName]: { type: "remote", url: mcpUrl, enabled: true } },
    // `skill: false` both disables the skill tool and skips OpenCode's skill scan.
    tools: { skill: false },
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
    share: "disabled",
    autoupdate: false,
    ...(controls.plugins === undefined ? {} : { plugin: [...controls.plugins] }),
  };
}

/**
 * Build an OpenSession backed by OpenCode. Pass the result to runProgram's
 * `harnesses`. Models resolve through OpenCode itself (`provider/model`); auth comes
 * from the user's logged-in providers.
 */
function createOpenCodeOpenSession(options: OpenCodeSessionOptions = {}): OpenSession {
  const factory = options.backendFactory ?? spawnOpenCodeBackend;
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;

  return ({ model: modelId, skills, plugins }: HarnessSessionOptions): HarnessSession => {
    if (modelId.trim() === "") {
      throw new FoomHarnessRejectedError("no model specified for the opencode harness");
    }
    const controls = buildSessionControls(skills, plugins);
    const model = splitModel(modelId);

    // One OpenCode session id per microfoom session, threaded across turns by id
    // (OpenCode persists sessions in its global database). A fork() seeds a new
    // HarnessSession that branches from the parent's latest id.
    const makeHarnessSession = (seedSessionId: string | undefined): HarnessSession => {
      let currentSessionId: string | undefined;

      const runTurn = async (request: SessionTurnRequest): Promise<SessionTurnResult> => {
        const { renamedTools, systemPrompt, prompt } = renameForModel(request, serverName);
        const mcp = await startMcpServer(renamedTools, serverName);
        const backend = await factory({ config: buildConfig(mcp.url, serverName, controls) });
        try {
          currentSessionId = await resolveSessionId(backend, currentSessionId, seedSessionId);
          const spec: PromptSpec = {
            model,
            system: systemPrompt,
            prompt,
            tools: buildTurnTools(request.allowedTools),
            serverName,
            onEvent: request.onEvent,
            signal: request.signal,
          };
          const outcome = await backend.prompt(currentSessionId, spec);
          throwOnTurnError(outcome);
          return { assistantText: outcome.assistantText, usage: outcome.usage };
        } finally {
          await backend.close();
          await mcp.close();
        }
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

export type {
  OpenCodeBackend,
  OpenCodeBackendFactory,
  OpenCodeConfig,
  PromptSpec,
} from "./backend.js";
export type { OpenCodeSessionOptions };
export { createOpenCodeOpenSession, OPENCODE_VERSION };
