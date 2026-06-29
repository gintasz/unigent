// The subprocess seam. A turn is one `claude -p` invocation; this builds its argv
// and spawns it, exposing the stdout NDJSON as an async line stream. The factory
// is injectable (mirrors pi's `streamFn`): tests pass a fake that replays a
// scripted model against the same in-process MCP server, so the whole adapter —
// argv mapping aside — runs offline and deterministically.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { prefixedToolName } from "./rename.js";

/** Everything one turn's subprocess needs. Harness-neutral; argv is built here. */
export interface ClaudeSpec {
  readonly model: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  /** The in-process MCP endpoint serving this turn's FOOM tools. */
  readonly mcpUrl: string;
  /** The MCP server name (→ tool prefix `mcp__<name>__`). */
  readonly serverName: string;
  /** Canonical FOOM tool names this turn exposes (always allowed). */
  readonly foomTools: readonly string[];
  /** The harness's OWN (built-in) tools to allow: undefined = all, [] = none. */
  readonly allowedHarnessTools?: readonly string[] | undefined;
  /** Settings to inject via `--settings` for this session (e.g. `enabledPlugins`,
   *  `skillOverrides`). Composed on top of the hermetic `--setting-sources ""` base.
   *  Undefined when the session constrains neither skills nor plugins. */
  readonly settings?: Record<string, unknown> | undefined;
  /** Disable ALL of Claude's skills for the session (`--disable-slash-commands`). */
  readonly disableSlashCommands?: boolean | undefined;
  /** Reasoning effort, when the request asked for one. */
  readonly effort?: string | undefined;
  /** Replace Claude's system prompt (default) vs. append to it. */
  readonly appendSystemPrompt: boolean;
  /** Fresh session: pin this id. */
  readonly sessionId?: string | undefined;
  /** Continue (or, with `fork`, branch from) this prior session. */
  readonly resumeSessionId?: string | undefined;
  readonly fork?: boolean | undefined;
  /** Extra args appended verbatim (escape hatch). */
  readonly extraArgs?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A running turn: its stdout lines, a kill switch, and any stderr seen. */
export interface ClaudeProcess {
  readonly lines: AsyncIterable<string>;
  kill(): void;
  /** Collected stderr (+ spawn error), available once `lines` is exhausted. */
  stderr(): string;
}

/** Injected per-turn subprocess launcher. */
export type ClaudeProcessFactory = (spec: ClaudeSpec) => ClaudeProcess;

/** The Claude Code valid `--effort` levels; anything else is dropped. */
const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Build the full `claude` argv (the binary itself excluded) for one turn. */
export function buildArgs(spec: ClaudeSpec): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: { [spec.serverName]: { type: "http", url: spec.mcpUrl } },
  });

  const args: string[] = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    spec.model,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--permission-mode",
    "bypassPermissions",
    // No user/project/local settings: no hooks, no foreign MCP, no CLAUDE.md —
    // the harness sends exactly what it intends. (Auth is unaffected.)
    "--setting-sources",
    "",
    spec.appendSystemPrompt ? "--append-system-prompt" : "--system-prompt",
    spec.systemPrompt,
  ];

  // Built-in tool exposure. undefined = leave Claude's default set; [] = none;
  // a list = exactly those. FOOM tools come from MCP regardless and are allowed.
  const harness = spec.allowedHarnessTools;
  if (harness !== undefined) {
    args.push("--tools", harness.join(","));
  }
  const foomNames = spec.foomTools.map((name) => prefixedToolName(spec.serverName, name));
  args.push("--allowedTools", [...foomNames, ...(harness ?? [])].join(" "));

  if (spec.effort !== undefined && EFFORT_LEVELS.has(spec.effort)) {
    args.push("--effort", spec.effort);
  }

  // Skills/plugins scoping. `--disable-slash-commands` turns ALL skills off; the
  // `--settings` JSON (enabledPlugins / skillOverrides) layers on top of the
  // hermetic `--setting-sources ""` base.
  if (spec.disableSlashCommands === true) {
    args.push("--disable-slash-commands");
  }
  if (spec.settings !== undefined) {
    args.push("--settings", JSON.stringify(spec.settings));
  }

  if (spec.resumeSessionId !== undefined) {
    args.push("--resume", spec.resumeSessionId);
    if (spec.fork === true) args.push("--fork-session");
  } else if (spec.sessionId !== undefined) {
    args.push("--session-id", spec.sessionId);
  }

  if (spec.extraArgs !== undefined) args.push(...spec.extraArgs);

  // Prompt last, as the positional argument.
  args.push(spec.prompt);
  return args;
}

/** The default factory: spawn the real `claude` binary. */
export function spawnClaude(spec: ClaudeSpec): ClaudeProcess {
  let child: ChildProcessByStdio<null, Readable, Readable>;
  let stderr = "";
  try {
    child = spawn("claude", buildArgs(spec), {
      stdio: ["ignore", "pipe", "pipe"],
      // Eager-load the FOOM tools instead of deferring them behind Claude Code's
      // ToolSearch tool: the model must see the control tools (and their schemas)
      // directly, every turn, to speak the protocol without an extra discovery
      // round-trip. Honour an explicit override from the environment.
      // biome-ignore lint/style/noProcessEnv: the child must inherit the full parent environment (model auth, PATH, …); forwarding raw process.env is the intent, not a config read to route through env.ts.
      env: { ...process.env, ENABLE_TOOL_SEARCH: process.env["ENABLE_TOOL_SEARCH"] ?? "false" },
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    });
  } catch (error) {
    // Synchronous spawn failure (e.g. binary missing): present an empty line
    // stream so the caller surfaces it as an unavailable harness.
    const message = String(error);
    return {
      lines: (async function* () {})(),
      kill: () => {},
      stderr: () => message,
    };
  }

  child.on("error", (error) => {
    stderr += String(error);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return {
    lines: createInterface({ input: child.stdout }),
    kill: () => child.kill("SIGTERM"),
    stderr: () => stderr,
  };
}
