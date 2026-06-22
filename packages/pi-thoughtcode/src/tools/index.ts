import type { ThoughtcodeToolOptions } from "../types.js";
import { createVibeCallTool } from "./vibe-call.js";
import { createVibeLoadProgramTool } from "./vibe-load-program.js";
import { createVibeReturnTool } from "./vibe-return.js";

export {
  checkReturnValue,
  isParsableReturnType,
  resolveReturnType,
  validateProgramSyntax,
  type ProgramSyntaxCheck,
  type ResolvedReturnType,
  type ReturnTypeCheck,
} from "./return-type.js";
export { runThoughtcodeSubagent } from "./subagent.js";
export { createVibeCallTool, vibeCallTool } from "./vibe-call.js";
export { createVibeLoadProgramTool, vibeLoadProgramTool } from "./vibe-load-program.js";
export { createVibeReturnTool, vibeReturnTool } from "./vibe-return.js";

export function createThoughtcodeTools(options: ThoughtcodeToolOptions = {}) {
  return [createVibeCallTool(options), createVibeReturnTool(options), createVibeLoadProgramTool(options)] as const;
}
