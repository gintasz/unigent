// The pi extension entry (AGENTS.md: thin glue). It (1) registers `/microfoom-run
// <path> [json-input]` as an ad-hoc runner, and (2) reads a microfoom.json config
// and registers each listed program as a user slash-command and/or an
// agent-callable tool. Every program runs against a programmatic pi sub-session
// (createPiOpenSession); the FOOM ops drive the model (ADR-0002 rev). `pi` loads
// this module's default export as an extension.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  deriveProgramInput,
  type FoomtimeProgram,
  type OpenSession,
  runProgram,
} from "@microfoom/core";
import { register } from "tsx/esm/api";
import { Type } from "typebox";
import { loadConfig, type ResolvedProgram } from "./config.js";
import { createPiOpenSession } from "./index.js";

// `pi` runs under plain `node` with no TS loader, so program files (TypeScript
// syntax, `@foom` decorators) can't be `import()`ed as-is. Register tsx on the
// host's module loader once — globally, so each program and its `@microfoom/core`
// import resolve into the *same* module graph as this extension. (A scoped
// loader duplicates core, splitting the program→agent WeakMap binding so
// `this.agent` reads an empty map and throws.)
register();

/** Default model when neither @foom.config, the config, nor MICROFOOM_MODEL set one. */
const DEFAULT_MODEL = process.env.MICROFOOM_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";

type ProgramClass = abstract new () => FoomtimeProgram<never, unknown>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Load a microfoom program (default export) from `sourceFile` and run it. Exposed
 * for testing the load+run path with a faux session; commands/tools use it with a
 * real pi session.
 */
export async function runProgramFile(
  sourceFile: string,
  input: unknown,
  openSession: OpenSession,
  model: string,
): Promise<unknown> {
  const moduleExports = (await import(pathToFileURL(sourceFile).href)) as { default?: unknown };
  const ProgramClass = moduleExports.default as ProgramClass | undefined;
  if (typeof ProgramClass !== "function") {
    throw new TypeError(`${sourceFile} has no default-exported program`);
  }
  return runProgram(ProgramClass, input, { openSession, model, sourceFile });
}

// Command args are free text: JSON when it looks like JSON, else the raw string.
function parseCommandInput(args: string): unknown {
  const trimmed = args.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/** Register one config program as a slash-command or an agent tool. */
function registerProgram(
  pi: ExtensionAPI,
  program: ResolvedProgram,
  defaultModel: string | undefined,
): void {
  const model = program.model ?? defaultModel ?? DEFAULT_MODEL;

  if (program.type === "command") {
    pi.registerCommand(program.name, {
      description: program.description,
      handler: async (args, ctx) => {
        try {
          const result = await runProgramFile(
            program.sourceFile,
            parseCommandInput(args),
            createPiOpenSession(),
            model,
          );
          ctx.ui.notify(`${program.name}: ${JSON.stringify(result)}`, "info");
        } catch (error) {
          ctx.ui.notify(`${program.name} error: ${errorMessage(error)}`, "error");
        }
      },
    });
    return;
  }

  // Tool: advertise main()'s input type as the parameter schema; the LLM's args
  // object carries the single input value under main's parameter name.
  const derived = deriveProgramInput(program.sourceFile);
  const inputName = derived.paramNames[0];
  pi.registerTool(
    defineTool({
      name: program.name,
      label: program.name,
      description: program.description,
      parameters: Type.Unsafe(derived.jsonSchema as Record<string, unknown>),
      ...(program.promptSnippet !== undefined ? { promptSnippet: program.promptSnippet } : {}),
      ...(program.promptGuidelines !== undefined
        ? { promptGuidelines: [...program.promptGuidelines] }
        : {}),
      execute: async (_id: string, params: unknown) => {
        const input =
          inputName !== undefined ? (params as Record<string, unknown>)[inputName] : undefined;
        const result = await runProgramFile(
          program.sourceFile,
          input,
          createPiOpenSession(),
          model,
        );
        return {
          content: [
            { type: "text", text: typeof result === "string" ? result : JSON.stringify(result) },
          ],
          details: {},
        };
      },
    }),
  );
}

async function runCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify("usage: /microfoom-run <program-path> [json-input]", "error");
    return;
  }
  const space = trimmed.indexOf(" ");
  const rawPath = space < 0 ? trimmed : trimmed.slice(0, space);
  const rawInput = space < 0 ? "" : trimmed.slice(space + 1).trim();
  const sourceFile = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

  try {
    const result = await runProgramFile(
      sourceFile,
      parseCommandInput(rawInput),
      createPiOpenSession(),
      DEFAULT_MODEL,
    );
    ctx.ui.notify(`microfoom result: ${JSON.stringify(result)}`, "info");
  } catch (error) {
    ctx.ui.notify(`microfoom error: ${errorMessage(error)}`, "error");
  }
}

/** The extension factory pi invokes with its API. */
const microfoomExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerCommand("microfoom-run", {
    description: "Run a microfoom program: /microfoom-run <program-path> [json-input]",
    handler: runCommand,
  });

  // Register programs listed in microfoom.json (MICROFOOM_CONFIG or ./microfoom.json).
  // A bad config throws here so the error surfaces when pi loads the extension.
  const configPath = process.env.MICROFOOM_CONFIG ?? join(process.cwd(), "microfoom.json");
  if (existsSync(configPath)) {
    const config = loadConfig(configPath);
    for (const program of config.programs) registerProgram(pi, program, config.defaultModel);
  }
};

export default microfoomExtension;
