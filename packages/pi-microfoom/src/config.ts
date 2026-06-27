// microfoom extension config (microfoom.json): an explicit list of program files
// to register with pi. Each entry's `disable_model_invocation` picks the surface:
// `true` → a user-only slash-command (the model can't invoke it); `false` → an
// agent-callable tool. No folder scanning — paths are explicit. Validated by hand
// (clear, indexed errors); duplicate names are rejected per namespace (commands
// vs tools are separate, so the same name can be registered as both).

import { readFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { FoomtimeConfigError } from "@microfoom/core";

/** A program surfaced as a user slash-command `/name`. */
export interface CommandProgram {
  readonly type: "command";
  readonly name: string;
  readonly sourceFile: string;
  readonly description: string;
  readonly model: string | undefined;
}

/** A program surfaced as an agent-callable tool. */
export interface ToolProgram {
  readonly type: "tool";
  readonly name: string;
  readonly sourceFile: string;
  readonly description: string;
  readonly promptSnippet: string | undefined;
  readonly promptGuidelines: readonly string[] | undefined;
  readonly model: string | undefined;
}

export type ResolvedProgram = CommandProgram | ToolProgram;

export interface LoadedConfig {
  readonly defaultModel: string | undefined;
  readonly programs: readonly ResolvedProgram[];
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FoomtimeConfigError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") throw new FoomtimeConfigError(`${where} must be a string`);
  return value;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, where);
}

function optionalStringArray(value: unknown, where: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new FoomtimeConfigError(`${where} must be an array of strings`);
  return value.map((item, index) => asString(item, `${where}[${index}]`));
}

/** Parse + validate a config object, resolving paths relative to `configDir`. */
export function parseConfig(raw: unknown, configDir: string): LoadedConfig {
  const root = asRecord(raw, "config");
  const defaultModel = optionalString(root.model, "config.model");
  const entries = root.programs;
  if (!Array.isArray(entries)) {
    throw new FoomtimeConfigError("config.programs must be an array");
  }

  const commandNames = new Set<string>();
  const toolNames = new Set<string>();
  const programs = entries.map((entry, index): ResolvedProgram => {
    const where = `config.programs[${index}]`;
    const record = asRecord(entry, where);
    const path = asString(record.path, `${where}.path`);
    const sourceFile = resolve(configDir, path);
    const name = optionalString(record.name, `${where}.name`) ?? parse(path).name;
    const model = optionalString(record.model, `${where}.model`);
    // The surface discriminator. Required (no default): exposing a program to the
    // model is a deliberate per-entry choice, never implicit (cf. F3 — capability
    // opt-in). true → user-only command; false → agent-callable tool.
    const disableModelInvocation = record.disable_model_invocation;
    if (typeof disableModelInvocation !== "boolean") {
      throw new FoomtimeConfigError(
        `${where}.disable_model_invocation must be a boolean ` +
          `(true = user-only command, false = agent-callable tool)`,
      );
    }

    if (disableModelInvocation) {
      if (commandNames.has(name)) {
        throw new FoomtimeConfigError(`duplicate command name "${name}" (${where})`);
      }
      commandNames.add(name);
      return {
        type: "command",
        name,
        sourceFile,
        description:
          optionalString(record.description, `${where}.description`) ?? `(microfoom) ${path}`,
        model,
      };
    }

    if (toolNames.has(name)) {
      throw new FoomtimeConfigError(`duplicate tool name "${name}" (${where})`);
    }
    toolNames.add(name);
    return {
      type: "tool",
      name,
      sourceFile,
      description: asString(record.description, `${where}.description`),
      promptSnippet: optionalString(record.promptSnippet, `${where}.promptSnippet`),
      promptGuidelines: optionalStringArray(record.promptGuidelines, `${where}.promptGuidelines`),
      model,
    };
  });

  return { defaultModel, programs };
}

/** Read and parse a config file. */
export function loadConfig(configPath: string): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    throw new FoomtimeConfigError(`cannot read microfoom config: ${configPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new FoomtimeConfigError(
      `invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseConfig(raw, dirname(configPath));
}
