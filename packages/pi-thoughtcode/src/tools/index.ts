import type { ThoughtcodeToolOptions } from "../types.js";
import { createVibeCallTool } from "./vibe-call.js";
import { createVibeLoadProgramTool } from "./vibe-load-program.js";
import { createVibeReturnTool } from "./vibe-return.js";
import { createVibeThrowTool } from "./vibe-throw.js";

export { createVibeCallTool, vibeCallTool } from "./vibe-call.js";
export { createVibeLoadProgramTool, vibeLoadProgramTool } from "./vibe-load-program.js";
export { createVibeReturnTool, vibeReturnTool } from "./vibe-return.js";
export { createVibeThrowTool, vibeThrowTool, VibeThrowError } from "./vibe-throw.js";

/** The four LLM-callable VIBE tools, bound to the given options. */
export function createThoughtcodeTools(options: ThoughtcodeToolOptions = {}) {
  return [
    createVibeCallTool(options),
    createVibeReturnTool(options),
    createVibeLoadProgramTool(options),
    createVibeThrowTool(options),
  ] as const;
}
