import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  AgentBackendRejectedError,
  AgentBackendUnavailableError,
  AgentCancelledError,
  AgentConfigError,
  type Backend,
  type BackendSession,
  type BackendSessionOptions,
  type BackendTurnRequest,
  type BackendTurnResult,
} from "@unigent/core";
import { startMcpToolServer } from "@unigent/core/mcp";
import { type ClaudeProcess, type ClaudeProcessFactory, spawnClaude } from "./process.js";
import { ClaudeStreamReader } from "./stream.js";

const MCP_TOKEN_ENVIRONMENT_VARIABLE = "UNIGENT_MCP_TOKEN";
const INCOMPATIBLE_CLI_ARGUMENT =
  /(?:unknown|unrecognized|unexpected).*(?:option|argument)|usage:/i;

/** Ambient Claude configuration base. */
type ClaudeBase = "clean" | "machine";
type DisableOnly = readonly [];

/** Installed plugin record used for temporary allowlisting. */
interface InstalledPlugin {
  readonly id: string;
  readonly enabled: boolean;
}

/** Claude CLI backend options. */
interface ClaudeCliOptions {
  readonly base?: ClaudeBase;
  readonly nativeTools?: readonly string[];
  readonly mcpServers?: DisableOnly;
  readonly plugins?: readonly string[];
  readonly skills?: DisableOnly;
  readonly hooks?: DisableOnly;
  readonly processFactory?: ClaudeProcessFactory;
  readonly listPlugins?: () => readonly InstalledPlugin[] | Promise<readonly InstalledPlugin[]>;
  /** Claude executable path; defaults to the platform npm shim name. */
  readonly binary?: string;
  /** `bypass` is non-interactive; `cli` leaves permission policy to Claude CLI. */
  readonly permissions?: "bypass" | "cli";
  readonly extraArgs?: readonly string[];
  /** Explicit identity for checkpoint invalidation when ambient configuration changes. */
  readonly checkpointKey?: string;
}

type InstalledPluginLoader = () => Promise<readonly InstalledPlugin[]>;

function parseInstalledPlugins(output: string): readonly InstalledPlugin[] {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    throw new AgentConfigError("Claude plugin list returned invalid JSON");
  }
  return parsed.flatMap((entry: unknown): InstalledPlugin[] => {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      typeof entry.id === "string" &&
      "enabled" in entry &&
      typeof entry.enabled === "boolean"
    ) {
      return [{ id: entry.id, enabled: entry.enabled }];
    }
    return [];
  });
}

async function installedPlugins(binary: string): Promise<readonly InstalledPlugin[]> {
  return await new Promise((resolve, reject) => {
    execFile(binary, ["plugin", "list", "--json"], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      try {
        resolve(parseInstalledPlugins(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function throwIfClaudeCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AgentCancelledError("Claude run was cancelled");
  }
}

async function availablePlugins(options: ClaudeCliOptions): Promise<readonly InstalledPlugin[]> {
  try {
    return await (options.listPlugins === undefined
      ? installedPlugins(options.binary ?? (process.platform === "win32" ? "claude.cmd" : "claude"))
      : options.listPlugins());
  } catch (error) {
    throw new AgentConfigError("unable to enumerate installed Claude plugins", { cause: error });
  }
}

function installedPluginLoader(options: ClaudeCliOptions): InstalledPluginLoader {
  let cached: readonly InstalledPlugin[] | undefined;
  let loading: Promise<readonly InstalledPlugin[]> | undefined;
  return async (): Promise<readonly InstalledPlugin[]> => {
    if (cached !== undefined) {
      return cached;
    }
    const pending = loading ?? availablePlugins(options);
    loading = pending;
    try {
      cached = await pending;
      return cached;
    } finally {
      if (loading === pending) {
        loading = undefined;
      }
    }
  };
}

function validateDisableOnly(category: string, value: DisableOnly | undefined): void {
  const supplied: readonly unknown[] | undefined = value;
  if (supplied !== undefined && supplied.length > 0) {
    throw new AgentConfigError(
      `Claude CLI cannot allowlist ${category} by name; use undefined to inherit or [] to disable`,
    );
  }
}

async function pluginSettings(
  options: ClaudeCliOptions,
  loadInstalledPlugins: InstalledPluginLoader,
): Promise<Record<string, unknown>> {
  const settings: Record<string, unknown> = {};
  if (options.plugins !== undefined) {
    const installed = await loadInstalledPlugins();
    const known = new Set(installed.map((plugin) => plugin.id));
    for (const requested of options.plugins) {
      if (!known.has(requested)) {
        throw new AgentConfigError(`Claude plugin is not installed: ${requested}`);
      }
    }
    settings["enabledPlugins"] = Object.fromEntries(
      installed.map((plugin) => [plugin.id, options.plugins?.includes(plugin.id) === true]),
    );
  }
  const clean = (options.base ?? "clean") === "clean";
  if (clean || options.hooks?.length === 0) {
    settings["disableAllHooks"] = true;
  }
  return settings;
}

function validateOptions(options: ClaudeCliOptions): void {
  validateDisableOnly("machine MCP servers", options.mcpServers);
  validateDisableOnly("installed skills", options.skills);
  validateDisableOnly("individual hooks", options.hooks);
  if (options.binary !== undefined && options.binary.trim().length === 0) {
    throw new AgentConfigError("Claude binary must be non-empty");
  }
  if (options.permissions !== undefined && !["bypass", "cli"].includes(options.permissions)) {
    throw new AgentConfigError(`unsupported Claude permissions mode: ${options.permissions}`);
  }
}

async function baseArgs(
  request: BackendTurnRequest,
  options: ClaudeCliOptions,
  loadInstalledPlugins: InstalledPluginLoader,
  mcpUrl: string,
  systemPromptFile: string,
  model: string,
  session: { readonly id?: string; readonly resume?: string; readonly fork?: boolean },
): Promise<string[]> {
  const clean = (options.base ?? "clean") === "clean";
  const strictMcp = clean || options.mcpServers !== undefined;
  const settings = await pluginSettings(options, loadInstalledPlugins);
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model",
    model,
  ];
  if (clean) {
    args.push("--setting-sources", "");
  }
  if (strictMcp) {
    args.push("--strict-mcp-config");
  }
  args.push(
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        unigent: {
          type: "http",
          url: mcpUrl,
          headers: {
            ["Authorization"]: `Bearer \${${MCP_TOKEN_ENVIRONMENT_VARIABLE}}`,
          },
        },
      },
    }),
  );
  if ((options.permissions ?? "bypass") === "bypass") {
    args.push("--permission-mode", "bypassPermissions");
  }
  args.push(
    request.systemPromptMode === "append" && !clean
      ? "--append-system-prompt-file"
      : "--system-prompt-file",
    systemPromptFile,
  );
  appendOptionalArgs(args, request, options, settings, clean, session);
  args.push("--");
  return args;
}

function temporaryTextFile(
  prefix: string,
  name: string,
  content: string,
): {
  readonly path: string;
  readonly dispose: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = join(directory, name);
  try {
    writeFileSync(path, content);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    dispose: (): void => rmSync(directory, { recursive: true, force: true }),
  };
}

function appendOptionalArgs(
  args: string[],
  request: BackendTurnRequest,
  options: ClaudeCliOptions,
  settings: Readonly<Record<string, unknown>>,
  clean: boolean,
  session: { readonly id?: string; readonly resume?: string; readonly fork?: boolean },
): void {
  if (options.nativeTools !== undefined) {
    const nativeTools = [...options.nativeTools];
    if (request.tools.length > 0 && !nativeTools.includes("ToolSearch")) {
      nativeTools.push("ToolSearch");
    }
    args.push("--tools", nativeTools.join(","));
  }
  if (clean || options.skills?.length === 0) {
    args.push("--disable-slash-commands");
  }
  if (Object.keys(settings).length > 0) {
    args.push("--settings", JSON.stringify(settings));
  }
  args.push("--allowedTools", request.tools.map((tool) => `mcp__unigent__${tool.name}`).join(" "));
  if (request.thinking !== undefined) {
    if (!["low", "medium", "high"].includes(request.thinking)) {
      throw new AgentConfigError(`unsupported Claude thinking level: ${request.thinking}`);
    }
    args.push("--effort", request.thinking);
  }
  if (session.resume !== undefined) {
    args.push("--resume", session.resume);
    if (session.fork === true) {
      args.push("--fork-session");
    }
  } else if (session.id !== undefined) {
    args.push("--session-id", session.id);
  }
  if (options.extraArgs !== undefined) {
    args.push(...options.extraArgs);
  }
}

async function consumeClaudeOutput(
  reader: ClaudeStreamReader,
  claudeProcess: ClaudeProcess,
): Promise<void> {
  try {
    for await (const line of claudeProcess.lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        reader.handle(JSON.parse(trimmed) as Readonly<Record<string, unknown>>);
      } catch {
        // Claude can interleave non-JSON diagnostics with stream-json output.
      }
    }
  } catch (streamError) {
    claudeProcess.kill();
    await claudeProcess.completion;
    throw streamError;
  }
  await claudeProcess.completion;
}

function settledClaudeResult(
  reader: ClaudeStreamReader,
  stderr: string,
): { readonly result: BackendTurnResult; readonly sessionId?: string } {
  const readerError = reader.error();
  if (readerError !== undefined) {
    throw new AgentBackendUnavailableError(readerError);
  }
  const result = reader.result();
  if (result === undefined) {
    const detail = stderr.trim();
    if (INCOMPATIBLE_CLI_ARGUMENT.test(detail)) {
      throw new AgentBackendRejectedError(
        `installed Claude CLI is incompatible with this adapter; update Claude CLI. ${detail}`,
      );
    }
    throw new AgentBackendUnavailableError(
      detail.length === 0 ? "Claude CLI produced no result" : detail,
    );
  }
  const sessionId = reader.sessionId();
  return { result, ...(sessionId === undefined ? {} : { sessionId }) };
}

function claudeBoundaryError(error: unknown, aborted: boolean): Error {
  if (aborted && !(error instanceof AgentCancelledError)) {
    return new AgentCancelledError("Claude run was cancelled", { cause: error });
  }
  if (
    error instanceof AgentConfigError ||
    error instanceof AgentBackendRejectedError ||
    error instanceof AgentBackendUnavailableError ||
    error instanceof AgentCancelledError
  ) {
    return error;
  }
  return new AgentBackendUnavailableError("Claude CLI stream failed", { cause: error });
}

async function drain(
  request: BackendTurnRequest,
  options: ClaudeCliOptions,
  loadInstalledPlugins: InstalledPluginLoader,
  model: string,
  session: { readonly id?: string; readonly resume?: string; readonly fork?: boolean },
): Promise<{ readonly result: BackendTurnResult; readonly sessionId?: string }> {
  throwIfClaudeCancelled(request.signal);
  const server = await startMcpToolServer(request.tools);
  let systemPrompt: ReturnType<typeof temporaryTextFile> | undefined;
  try {
    throwIfClaudeCancelled(request.signal);
    systemPrompt = temporaryTextFile("unigent-claude-", "system-prompt.md", request.systemPrompt);
    const reader = new ClaudeStreamReader(request.onEvent);
    const args = await baseArgs(
      request,
      options,
      loadInstalledPlugins,
      server.url,
      systemPrompt.path,
      model,
      session,
    );
    const environment = {
      [MCP_TOKEN_ENVIRONMENT_VARIABLE]: server.authorizationHeader.slice("Bearer ".length),
    };
    const claudeProcess =
      options.processFactory === undefined
        ? spawnClaude(args, request.signal, request.prompt, environment, options.binary)
        : options.processFactory(args, request.signal, request.prompt, environment);
    await consumeClaudeOutput(reader, claudeProcess);
    throwIfClaudeCancelled(request.signal);
    return settledClaudeResult(reader, claudeProcess.stderr());
  } catch (error) {
    throw claudeBoundaryError(error, request.signal.aborted);
  } finally {
    systemPrompt?.dispose();
    await server.close();
  }
}

function makeSession(
  options: ClaudeCliOptions,
  loadInstalledPlugins: InstalledPluginLoader,
  model: string,
  seed?: string,
): BackendSession {
  let current = seed;
  let forkOnNext = seed !== undefined;
  return {
    runTurn: async (request: BackendTurnRequest): Promise<BackendTurnResult> => {
      const freshId = current === undefined ? randomUUID() : undefined;
      const settled = await drain(request, options, loadInstalledPlugins, model, {
        ...(freshId === undefined ? {} : { id: freshId }),
        ...(current === undefined ? {} : { resume: current }),
        ...(forkOnNext ? { fork: true } : {}),
      });
      current = settled.sessionId ?? freshId ?? current;
      forkOnNext = false;
      return settled.result;
    },
    fork: (): BackendSession => makeSession(options, loadInstalledPlugins, model, current ?? seed),
  };
}

/** Create a Claude CLI backend. Clean ambient configuration is the default. */
export function claudeCli(options: ClaudeCliOptions = {}): Backend {
  validateOptions(options);
  const loadInstalledPlugins = installedPluginLoader(options);
  return {
    name: "claude-cli",
    checkpointKey:
      options.checkpointKey ??
      JSON.stringify({
        adapter: "claude-cli-v1",
        base: options.base ?? "clean",
        nativeTools: options.nativeTools,
        mcpServers: options.mcpServers,
        plugins: options.plugins,
        skills: options.skills,
        hooks: options.hooks,
        binary: options.binary,
        permissions: options.permissions ?? "bypass",
        extraArgs: options.extraArgs,
      }),
    capabilities: {
      reportsCost: true,
      supportsSessionFork: true,
    },
    openSession: ({ model }: BackendSessionOptions): BackendSession => {
      if (model.trim().length === 0) {
        throw new AgentBackendRejectedError("Claude model must be non-empty");
      }
      return makeSession(options, loadInstalledPlugins, model);
    },
  };
}

export type { ClaudeProcess, ClaudeProcessCompletion, ClaudeProcessFactory } from "./process.js";
export type { ClaudeBase, ClaudeCliOptions, DisableOnly, InstalledPlugin };
