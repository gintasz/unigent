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

import { fileURLToPath } from "node:url";
import { startMcpServer, toolDescription } from "@microfoom/adapter-base";
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
import { applyRename } from "./rename.js";
import type { TurnOutcome } from "./result.js";

const OPENCODE_VERSION = "0.1.0";

/** Default MCP server name → tool prefix `foom_`. */
const DEFAULT_SERVER_NAME = "foom";

/** The shipped `experimental.chat.system.transform` plugin, loaded into every child
 *  to make the system prompt an exact replace (hermetic) or opt-in append — OpenCode
 *  otherwise appends our prompt onto its base persona + ambient AGENTS.md/skills.
 *  Resolved relative to this module (../plugin/ ships alongside dist/). */
const SYSTEM_PLUGIN_PATH = fileURLToPath(new URL("../plugin/system-transform.js", import.meta.url));

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
  /**
   * Construction default for dropping OpenCode's base prompt (its coding persona +
   * ambient AGENTS.md/CLAUDE.md). Default true: send ONLY microfoom's prompt, for a
   * controlled, hermetic session. A per-turn `omitBasePrompt` overrides this.
   */
  readonly omitHarnessBasePrompt?: boolean;
}

/** The system prompt this session sends for a program prompt — the program prompt
 *  verbatim. The shipped transform plugin then makes it a hermetic replace (or an
 *  opt-in append) of OpenCode's base, per the turn's omitBasePrompt. */
function composeSystemPrompt(programPrompt: string): string {
  return programPrompt;
}

/**
 * Reconcile core's bare FOOM tool names with the prefixed `<server>_<name>` the
 * model actually sees: rewrite every reference (system prompt + prompt) so the two
 * agree. The tool DESCRIPTIONS are rewritten by the `describe` hook handed to
 * adapter-base's MCP server (see {@link makeDescribe}); each tool's `.name` stays
 * canonical for MCP routing.
 */
function renameForModel(
  request: SessionTurnRequest,
  serverName: string,
): { names: string[]; systemPrompt: string; prompt: string } {
  const names = request.tools.map((tool) => tool.name);
  return {
    names,
    systemPrompt: applyRename(composeSystemPrompt(request.systemPrompt), names, serverName),
    prompt: applyRename(request.prompt, names, serverName),
  };
}

/** A `describe` hook for adapter-base's MCP server: fold a tool's snippet/guidelines
 *  into its description, then rewrite every tool-name reference to its prefixed form
 *  so the listing the model reads matches the names it can call. */
function makeDescribe(
  names: readonly string[],
  serverName: string,
): (tool: NeutralToolDef) => string {
  return (tool: NeutralToolDef): string => applyRename(toolDescription(tool), names, serverName);
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

/** Map a microfoom `ThinkingLevel` onto OpenCode's `reasoningEffort` value. The
 *  known levels (`low`/`medium`/`high`) and provider-passthrough raw strings
 *  (`minimal`/`xhigh`/…) align 1:1; only `off` needs renaming to `none`. */
function mapReasoningEffort(thinking: string): string {
  return thinking === "off" ? "none" : thinking;
}

/** Per-turn provider override carrying this turn's reasoning effort. OpenCode has no
 *  per-prompt reasoning field, but it reads it from `provider.<id>.models.<id>.options`
 *  — and since we spawn a fresh server per turn with fresh config, that IS per-turn. */
function reasoningConfig(
  model: { providerID: string; modelID: string },
  thinking: string | undefined,
): OpenCodeConfig {
  if (thinking === undefined) {
    return {};
  }
  return {
    provider: {
      [model.providerID]: {
        models: { [model.modelID]: { options: { reasoningEffort: mapReasoningEffort(thinking) } } },
      },
    },
  };
}

/** Build the OpenCode child config: serve the FOOM MCP tools, keep the session
 *  hermetic (no sharing, no auto-update), pre-allow tool permissions so an enabled
 *  tool never blocks on an interactive prompt, apply this turn's reasoning effort,
 *  and gate skills (disabled by default; a list opens a `permission.skill` allow-list). */
function buildConfig(
  mcpUrl: string,
  serverName: string,
  controls: OpenCodeSessionControls,
  model: { providerID: string; modelID: string },
  thinking: string | undefined,
): OpenCodeConfig {
  const { skillPermission } = controls;
  return {
    mcp: { [serverName]: { type: "remote", url: mcpUrl, enabled: true } },
    // No allow-list → disable the skill tool (hermetic + skips OpenCode's skill scan).
    // An allow-list leaves the tool enabled; `permission.skill` restricts which load.
    tools: skillPermission === undefined ? { skill: false } : {},
    permission: {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      ...(skillPermission === undefined ? {} : { skill: skillPermission }),
    },
    share: "disabled",
    autoupdate: false,
    // The system-transform plugin always loads; session plugins follow it.
    plugin: [SYSTEM_PLUGIN_PATH, ...(controls.plugins ?? [])],
    ...reasoningConfig(model, thinking),
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
  const omitBaseDefault = options.omitHarnessBasePrompt ?? true;

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
        const { names, systemPrompt, prompt } = renameForModel(request, serverName);
        const mcp = await startMcpServer(
          request.tools,
          serverName,
          makeDescribe(names, serverName),
        );
        const config = buildConfig(mcp.url, serverName, controls, model, request.thinking);
        const omitBase = request.omitBasePrompt ?? omitBaseDefault;
        const backend = await factory({ config, system: systemPrompt, omitBase });
        try {
          currentSessionId = await resolveSessionId(backend, currentSessionId, seedSessionId);
          const spec: PromptSpec = {
            model,
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
