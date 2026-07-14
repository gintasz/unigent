import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import { forkCodexSession } from "./fork.js";
import {
  buildCodexArgs,
  type CodexProcess,
  type CodexProcessFactory,
  MCP_TOKEN_ENVIRONMENT_VARIABLE,
  spawnCodex,
} from "./process.js";
import type { CodexSkill } from "./skills.js";
import { disabledSkillPaths, discoverCodexSkills } from "./skills.js";
import { CodexStreamReader } from "./stream.js";

const INCOMPATIBLE_CLI_ARGUMENT =
  /(?:unknown|unrecognized|unexpected).*(?:option|argument)|usage:/i;

/** Ambient Codex configuration base. */
type CodexBase = "clean" | "machine";

/** Codex can disable its default tools as a group, but cannot exactly allowlist them. */
type DisableOnly = readonly [];

/** Options for the installed Codex CLI backend. */
interface CodexCliOptions {
  readonly base?: CodexBase;
  readonly nativeTools?: DisableOnly;
  readonly skills?: readonly string[];
  readonly workdir?: string;
  readonly processFactory?: CodexProcessFactory;
  /** Codex executable path; defaults to the platform npm shim name. */
  readonly binary?: string;
  /** `bypass` is non-interactive; `cli` leaves approval and sandbox policy to Codex CLI. */
  readonly permissions?: "bypass" | "cli";
  readonly forkSession?: (parentSessionId: string, workdir: string) => string;
  readonly discoverSkills?: (workdir: string) => readonly CodexSkill[];
  readonly extraArgs?: readonly string[];
  /** Explicit identity for checkpoint invalidation when ambient configuration changes. */
  readonly checkpointKey?: string;
}

interface TurnIdentity {
  readonly resumeSessionId?: string;
  readonly profileName?: string;
}

interface CodexProfileHome {
  readonly path: string;
  readonly profileName: string;
  readonly dispose: () => void;
}

function isClean(options: CodexCliOptions): boolean {
  return (options.base ?? "clean") === "clean";
}

function configuredSkills(options: CodexCliOptions): readonly string[] | undefined {
  return options.skills ?? (isClean(options) ? [] : undefined);
}

function instructionsRequired(options: CodexCliOptions, request: BackendTurnRequest): boolean {
  return isClean(options) || request.systemPromptMode === "replace";
}

function instructionFile(systemPrompt: string): {
  readonly path: string;
  readonly dispose: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "unigent-codex-"));
  const path = join(directory, "instructions.md");
  try {
    writeFileSync(path, systemPrompt);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    dispose: (): void => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function codexHome(): string {
  // biome-ignore lint/style/noProcessEnv: Codex defines its state root through this environment variable.
  return process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

function temporaryProfileHome(developerInstructions: string): CodexProfileHome {
  const sourceHome = codexHome();
  const directory = mkdtempSync(join(tmpdir(), "unigent-codex-home-"));
  const profileName = `unigent-${randomUUID()}`;
  try {
    if (existsSync(sourceHome)) {
      for (const entry of readdirSync(sourceHome, { withFileTypes: true })) {
        symlinkSync(
          join(sourceHome, entry.name),
          join(directory, entry.name),
          entry.isDirectory() ? "junction" : "file",
        );
      }
    }
    writeFileSync(
      join(directory, `${profileName}.config.toml`),
      `developer_instructions = ${JSON.stringify(developerInstructions)}\n`,
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: directory,
    profileName,
    dispose: (): void => rmSync(directory, { recursive: true, force: true }),
  };
}

function resolveDisabledSkillPaths(
  options: CodexCliOptions,
  workdir: string,
): readonly string[] | undefined {
  const selection = configuredSkills(options);
  return selection === undefined
    ? undefined
    : disabledSkillPaths((options.discoverSkills ?? discoverCodexSkills)(workdir), selection);
}

function makeTurnArgs(
  options: CodexCliOptions,
  model: string,
  identity: TurnIdentity,
  request: BackendTurnRequest,
  mcpUrl: string,
  instructionsFile: string | undefined,
  disabledSkills: readonly string[] | undefined,
): readonly string[] {
  const profileArguments =
    identity.profileName === undefined
      ? []
      : ["-c", `profile=${JSON.stringify(identity.profileName)}`];
  const extraArgs = [...(options.extraArgs ?? []), ...profileArguments];
  return buildCodexArgs({
    model,
    mcpUrl,
    clean: isClean(options),
    disableNativeTools: options.nativeTools?.length === 0,
    permissions: options.permissions ?? "bypass",
    ...(instructionsFile === undefined ? {} : { instructionsFile }),
    ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
    ...(disabledSkills === undefined ? {} : { disabledSkillPaths: disabledSkills }),
    ...(identity.resumeSessionId === undefined
      ? {}
      : { resumeSessionId: identity.resumeSessionId }),
    ...(extraArgs.length === 0 ? {} : { extraArgs }),
  });
}

async function consumeCodexOutput(
  reader: CodexStreamReader,
  lines: AsyncIterable<string>,
): Promise<void> {
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as unknown;
      if (typeof event === "object" && event !== null && !Array.isArray(event)) {
        reader.handle(event as Readonly<Record<string, unknown>>);
      }
    } catch {
      // Codex can interleave non-JSON diagnostics with JSONL output.
    }
  }
}

async function consumeCodexProcess(
  reader: CodexStreamReader,
  codexProcess: CodexProcess,
): Promise<void> {
  try {
    await consumeCodexOutput(reader, codexProcess.lines);
  } catch (streamError) {
    codexProcess.kill();
    await codexProcess.completion;
    throw streamError;
  }
  await codexProcess.completion;
}

function codexBoundaryError(error: unknown, aborted: boolean): Error {
  if (aborted && !(error instanceof AgentCancelledError)) {
    return new AgentCancelledError("Codex run was cancelled", { cause: error });
  }
  if (
    error instanceof AgentConfigError ||
    error instanceof AgentBackendRejectedError ||
    error instanceof AgentBackendUnavailableError ||
    error instanceof AgentCancelledError
  ) {
    return error;
  }
  return new AgentBackendUnavailableError("Codex CLI stream failed", { cause: error });
}

function throwIfCodexCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AgentCancelledError("Codex run was cancelled");
  }
}

function settledResult(
  reader: CodexStreamReader,
  stderr: string,
): { readonly result: BackendTurnResult; readonly sessionId?: string } {
  const error = reader.error();
  if (error !== undefined) {
    throw new AgentBackendUnavailableError(error);
  }
  const result = reader.result();
  if (result === undefined) {
    const detail = stderr.trim();
    if (INCOMPATIBLE_CLI_ARGUMENT.test(detail)) {
      throw new AgentBackendRejectedError(
        `installed Codex CLI is incompatible with this adapter; update Codex CLI. ${detail}`,
      );
    }
    throw new AgentBackendUnavailableError(
      detail.length === 0 ? "Codex CLI produced no result" : detail,
    );
  }
  const sessionId = reader.sessionId();
  return { result, ...(sessionId === undefined ? {} : { sessionId }) };
}

async function runCodexTurn(
  options: CodexCliOptions,
  model: string,
  identity: TurnIdentity,
  request: BackendTurnRequest,
): Promise<{ readonly result: BackendTurnResult; readonly sessionId?: string }> {
  throwIfCodexCancelled(request.signal);
  const workdir = options.workdir ?? process.cwd();
  const disabledSkills = resolveDisabledSkillPaths(options, workdir);
  const server = await startMcpToolServer(request.tools);
  let instructions: ReturnType<typeof instructionFile> | undefined;
  let profileHome: CodexProfileHome | undefined;
  try {
    throwIfCodexCancelled(request.signal);
    instructions = instructionsRequired(options, request)
      ? instructionFile(request.systemPrompt)
      : undefined;
    profileHome =
      instructions === undefined ? temporaryProfileHome(request.systemPrompt) : undefined;
    const reader = new CodexStreamReader(request.onEvent);
    const factory = options.processFactory ?? spawnCodex;
    const args = makeTurnArgs(
      options,
      model,
      {
        ...identity,
        ...(profileHome === undefined ? {} : { profileName: profileHome.profileName }),
      },
      request,
      server.url,
      instructions?.path,
      disabledSkills,
    );
    const environment = {
      [MCP_TOKEN_ENVIRONMENT_VARIABLE]: server.authorizationHeader.slice("Bearer ".length),
      ...(profileHome === undefined ? {} : { CODEX_HOME: profileHome.path }),
    };
    const codexProcess =
      options.processFactory === undefined
        ? spawnCodex(args, request.signal, request.prompt, environment, options.binary)
        : factory(args, request.signal, request.prompt, environment);
    await consumeCodexProcess(reader, codexProcess);
    throwIfCodexCancelled(request.signal);
    return settledResult(reader, codexProcess.stderr());
  } catch (error) {
    throw codexBoundaryError(error, request.signal.aborted);
  } finally {
    instructions?.dispose();
    profileHome?.dispose();
    await server.close();
  }
}

function makeSession(options: CodexCliOptions, model: string, seed?: string): BackendSession {
  let currentSessionId = seed;
  let forkOnNextTurn = seed !== undefined;
  const workdir = options.workdir ?? process.cwd();
  return {
    runTurn: async (request: BackendTurnRequest): Promise<BackendTurnResult> => {
      if (forkOnNextTurn && currentSessionId !== undefined) {
        try {
          currentSessionId = (options.forkSession ?? forkCodexSession)(currentSessionId, workdir);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new AgentBackendUnavailableError(`Codex session fork failed: ${message}`, {
            cause: error,
          });
        }
      }
      forkOnNextTurn = false;
      const settled = await runCodexTurn(
        { ...options, workdir },
        model,
        {
          ...(currentSessionId === undefined ? {} : { resumeSessionId: currentSessionId }),
        },
        request,
      );
      currentSessionId = settled.sessionId ?? currentSessionId;
      return settled.result;
    },
    fork: (): BackendSession => makeSession(options, model, currentSessionId),
  };
}

/** Create a Codex CLI backend. Clean ambient configuration is the default. */
function codexCli(options: CodexCliOptions = {}): Backend {
  if (options.binary !== undefined && options.binary.trim().length === 0) {
    throw new AgentConfigError("Codex binary must be non-empty");
  }
  if (options.permissions !== undefined && !["bypass", "cli"].includes(options.permissions)) {
    throw new AgentConfigError(`unsupported Codex permissions mode: ${options.permissions}`);
  }
  return {
    name: "codex-cli",
    checkpointKey:
      options.checkpointKey ??
      JSON.stringify({
        adapter: "codex-cli-v1",
        base: options.base ?? "clean",
        nativeTools: options.nativeTools,
        skills: options.skills,
        workdir: options.workdir,
        binary: options.binary,
        permissions: options.permissions ?? "bypass",
        extraArgs: options.extraArgs,
      }),
    capabilities: {
      reportsCost: false,
      supportsSessionFork: true,
    },
    openSession: ({ model }: BackendSessionOptions): BackendSession => {
      if (model.trim().length === 0) {
        throw new AgentBackendRejectedError("Codex model must be non-empty");
      }
      return makeSession(options, model);
    },
  };
}

export type {
  CodexProcess,
  CodexProcessCompletion,
  CodexProcessFactory,
  CodexTurnSpec,
} from "./process.js";
export type { CodexSkill } from "./skills.js";
export type { CodexBase, CodexCliOptions, DisableOnly };
export { codexCli };
