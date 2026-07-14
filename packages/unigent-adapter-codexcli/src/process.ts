import process from "node:process";
import {
  type AdapterProcess,
  type AdapterProcessCompletion,
  AgentConfigError,
  spawnAdapterProcess,
} from "@unigent/core";

const MCP_TOKEN_ENVIRONMENT_VARIABLE = "UNIGENT_MCP_TOKEN";

/** A running Codex CLI process. */
type CodexProcess = AdapterProcess;

/** Settlement metadata for a Codex subprocess. */
type CodexProcessCompletion = AdapterProcessCompletion;

/** Injectable Codex process launcher used by deterministic adapter tests. */
type CodexProcessFactory = (
  args: readonly string[],
  signal: AbortSignal,
  prompt: string,
  environment: Readonly<Record<string, string>>,
) => CodexProcess;

/** Complete CLI configuration for one Codex turn. */
interface CodexTurnSpec {
  readonly model: string;
  readonly mcpUrl: string;
  readonly clean: boolean;
  readonly disableNativeTools: boolean;
  readonly permissions?: "bypass" | "cli";
  readonly instructionsFile?: string;
  readonly thinking?: string;
  readonly disabledSkillPaths?: readonly string[];
  readonly resumeSessionId?: string;
  readonly extraArgs?: readonly string[];
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function configValue(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}

function commonArgs(spec: CodexTurnSpec): string[] {
  const args = [
    "--json",
    "--skip-git-repo-check",
    "-m",
    spec.model,
    "-c",
    configValue("mcp_servers.unigent.url", spec.mcpUrl),
    "-c",
    configValue("mcp_servers.unigent.bearer_token_env_var", MCP_TOKEN_ENVIRONMENT_VARIABLE),
    "-c",
    configValue("mcp_servers.unigent.default_tools_approval_mode", "approve"),
  ];
  if ((spec.permissions ?? "bypass") === "bypass") {
    args.splice(2, 0, "--dangerously-bypass-approvals-and-sandbox");
  }
  if (spec.clean) {
    args.push("--ignore-user-config", "--ignore-rules", "-c", "features.hooks=false");
  }
  if (spec.disableNativeTools) {
    args.push("-c", "features.shell_tool=false", "-c", configValue("web_search", "disabled"));
  }
  appendPromptConfiguration(args, spec);
  appendOptionalConfiguration(args, spec);
  return args;
}

function appendPromptConfiguration(args: string[], spec: CodexTurnSpec): void {
  if (spec.instructionsFile !== undefined) {
    args.push("-c", configValue("model_instructions_file", spec.instructionsFile));
  }
}

function appendOptionalConfiguration(args: string[], spec: CodexTurnSpec): void {
  if (spec.thinking !== undefined) {
    if (!THINKING_LEVELS.has(spec.thinking)) {
      throw new AgentConfigError(`unsupported Codex thinking level: ${spec.thinking}`);
    }
    args.push("-c", configValue("model_reasoning_effort", spec.thinking));
  }
  if (spec.disabledSkillPaths !== undefined && spec.disabledSkillPaths.length > 0) {
    const skills = spec.disabledSkillPaths
      .map((path) => `{path=${JSON.stringify(path)},enabled=false}`)
      .join(",");
    args.push("-c", `skills.config=[${skills}]`);
  }
  if (spec.extraArgs !== undefined) {
    args.push(...spec.extraArgs);
  }
}

/** Build a Codex `exec` or `exec resume` command line for one Unigent turn. */
function buildCodexArgs(spec: CodexTurnSpec): readonly string[] {
  const shared = commonArgs(spec);
  return spec.resumeSessionId === undefined
    ? ["exec", ...shared, "--", "-"]
    : ["exec", "resume", ...shared, spec.resumeSessionId, "--", "-"];
}

/** Launch Codex and expose its JSONL stdout plus bounded stderr. */
function spawnCodex(
  args: readonly string[],
  signal: AbortSignal,
  prompt: string,
  environment: Readonly<Record<string, string>>,
  binary = process.platform === "win32" ? "codex.cmd" : "codex",
): CodexProcess {
  return spawnAdapterProcess({ binary, args, signal, stdin: prompt, environment });
}

export type { CodexProcess, CodexProcessCompletion, CodexProcessFactory, CodexTurnSpec };
export { buildCodexArgs, MCP_TOKEN_ENVIRONMENT_VARIABLE, spawnCodex };
