import { isAbsolute, resolve } from "node:path";

interface RunCommand {
  readonly mode: "run" | "tui";
  readonly sourceFile: string;
  readonly scriptArguments: readonly string[];
}

interface BakeCommand {
  readonly sourceFile: string;
}

type ParsedCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "bake"; readonly command: BakeCommand }
  | { readonly kind: "run"; readonly command: RunCommand };

function isHelpFlag(argument: string | undefined): boolean {
  return argument === undefined || argument === "--help" || argument === "-h";
}

function isVersionFlag(argument: string | undefined): boolean {
  return argument === "--version" || argument === "-V";
}

function parseCommand(arguments_: readonly string[], workingDirectory: string): ParsedCommand {
  if (isHelpFlag(arguments_[0])) {
    return { kind: "help" };
  }
  if (isVersionFlag(arguments_[0])) {
    return { kind: "version" };
  }
  if (arguments_[0] === "bake") {
    const [, source] = arguments_;
    if (source === undefined || source === "--") {
      throw new Error("unigent bake: missing TypeScript entry file");
    }
    return {
      kind: "bake",
      command: { sourceFile: isAbsolute(source) ? source : resolve(workingDirectory, source) },
    };
  }
  const [requestedMode] = arguments_;
  const mode = requestedMode === "tui" ? "tui" : "run";
  const sourceIndex = requestedMode === "run" || requestedMode === "tui" ? 1 : 0;
  const source = arguments_[sourceIndex];
  if (source === undefined || source === "--") {
    throw new Error(`unigent ${mode}: missing script file`);
  }
  const remaining = arguments_.slice(sourceIndex + 1);
  const separator = remaining[0] === "--" ? 1 : 0;
  return {
    kind: "run",
    command: {
      mode,
      sourceFile: isAbsolute(source) ? source : resolve(workingDirectory, source),
      scriptArguments: remaining.slice(separator),
    },
  };
}

export type { RunCommand };
export { parseCommand };
