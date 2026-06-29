// The subprocess seam. A turn is one `codex exec` invocation; this builds its argv
// and spawns it, exposing the stdout JSONL as an async line stream. The factory is
// injectable (mirrors pi's `streamFn`): tests pass a fake that replays a scripted
// model against the same in-process MCP server, so the whole adapter — argv mapping
// aside — runs offline and deterministically.
//
// Codex has no flag to pin a fresh session id or to append to its base prompt, so:
//   - a continued turn uses the `exec resume <id>` subcommand;
//   - the turn's full system prompt is written to a temp file and passed via
//     `-c model_instructions_file=…`, which REPLACES Codex's built-in coding-agent
//     instructions (the controlled, hermetic default);
//   - MCP tool calls are auto-approved via `--dangerously-bypass-approvals-and-sandbox`
//     (Codex auto-cancels MCP calls under any prompting approval policy in
//     non-interactive mode), and Codex's own `shell` tool is disabled so the only
//     tools the model can reach are this turn's FOOM tools.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { type CliProcess, spawnLineProcess } from "@microfoom/adapter-base";

/** Everything one turn's subprocess needs. Harness-neutral; argv is built here. */
interface CodexSpec {
  readonly model: string;
  /** The full system prompt — written to a temp file, passed via
   *  `model_instructions_file` (replaces Codex's base instructions). */
  readonly systemPrompt: string;
  readonly prompt: string;
  /** The in-process MCP endpoint serving this turn's FOOM tools. */
  readonly mcpUrl: string;
  /** The MCP server name (the `mcp_servers.<name>` config key). */
  readonly serverName: string;
  /** The working directory Codex runs in (pinned so a forked session's recorded
   *  cwd matches and `exec resume` can locate it). */
  readonly workdir: string;
  /** Reasoning effort, when the request asked for one. */
  readonly effort?: string | undefined;
  /** SKILL.md paths to disable for this session (from the skills tri-state). Empty
   *  / absent = no skill override (Codex keeps all discovered skills). */
  readonly skillDisablePaths?: readonly string[] | undefined;
  /** Continue (or, after a fork copy, branch from) this prior session id. Absent =
   *  a fresh session whose id is read from the `thread.started` event. */
  readonly resumeSessionId?: string | undefined;
  /** Extra args appended verbatim (escape hatch). */
  readonly extraArgs?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A running turn's subprocess (an alias of adapter-base's `CliProcess`). */
type CodexProcess = CliProcess;

/** Injected per-turn subprocess launcher. */
type CodexProcessFactory = (spec: CodexSpec) => CodexProcess;

/** The Codex valid `model_reasoning_effort` levels; anything else is dropped. */
const EFFORT_LEVELS: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high", "xhigh"]);

/** The shared `-c`/sandbox/mcp flags every turn (fresh or resumed) carries. The
 *  instructions-file path is written by the caller and threaded in here. */
function commonArgs(spec: CodexSpec, instructionsFile: string): string[] {
  const args: string[] = [
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    spec.model,
    "-c",
    "features.shell_tool=false",
    "-c",
    `model_instructions_file="${instructionsFile}"`,
    "-c",
    `mcp_servers.${spec.serverName}.url="${spec.mcpUrl}"`,
  ];
  if (spec.effort !== undefined && EFFORT_LEVELS.has(spec.effort)) {
    args.push("-c", `model_reasoning_effort="${spec.effort}"`);
  }
  // Disable selected skills via per-skill `enabled = false` overrides. Paths are
  // JSON-quoted (valid TOML basic strings) to survive spaces/escapes.
  if (spec.skillDisablePaths !== undefined && spec.skillDisablePaths.length > 0) {
    const entries = spec.skillDisablePaths
      .map((path) => `{path=${JSON.stringify(path)},enabled=false}`)
      .join(",");
    args.push("-c", `skills.config=[${entries}]`);
  }
  if (spec.extraArgs !== undefined) {
    args.push(...spec.extraArgs);
  }
  return args;
}

/** Build the full `codex` argv (the binary itself excluded) for one turn. A
 *  continued turn uses the `exec resume <id>` subcommand; a fresh turn uses `exec`.
 *  The prompt is always the trailing positional. */
function buildArgs(spec: CodexSpec, instructionsFile: string): string[] {
  const common = commonArgs(spec, instructionsFile);
  if (spec.resumeSessionId !== undefined) {
    return ["exec", "resume", ...common, spec.resumeSessionId, spec.prompt];
  }
  return ["exec", ...common, spec.prompt];
}

/** The default factory: spawn the real `codex` binary. The system prompt goes
 *  through a temp file (Codex has no inline flag for it), written just before spawn
 *  and removed when the turn's stream is drained. */
function spawnCodex(spec: CodexSpec): CodexProcess {
  const dir = mkdtempSync(join(tmpdir(), "foom-codex-"));
  const instructionsFile = join(dir, "instructions.md");
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  };

  return spawnLineProcess("codex", buildArgs(spec, instructionsFile), {
    // Codex runs in the turn's workdir via the child's cwd (the `exec resume`
    // subcommand rejects a `-C` flag, so cwd can't be an argv flag).
    cwd: spec.workdir,
    prepare: () => writeFileSync(instructionsFile, spec.systemPrompt),
    // The child inherits the parent environment (Codex auth lives in CODEX_HOME,
    // PATH, …); `--ignore-user-config` already isolates ambient config.
    // biome-ignore lint/style/noProcessEnv: the child must inherit the full parent environment (model auth, PATH, CODEX_HOME); forwarding raw process.env is the intent, not a config read.
    env: { ...process.env },
    ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    onExit: cleanup,
  });
}

/** A fresh random session id (used by the fork file-copy to name a branch). */
function freshSessionId(): string {
  return randomUUID();
}

export type { CodexProcess, CodexProcessFactory, CodexSpec };
export { buildArgs, freshSessionId, spawnCodex };
