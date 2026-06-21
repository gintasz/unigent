import type { ThoughtcodeToolOptions } from "../types.js";
import { createVibeCallTool } from "./vibe-call.js";
import { createVibeReturnTool } from "./vibe-return.js";

export { runThoughtcodeSubagent } from "./subagent.js";
export { createVibeCallTool, vibeCallTool } from "./vibe-call.js";
export { createVibeReturnTool, vibeReturnTool } from "./vibe-return.js";

export function createThoughtcodeTools(options: ThoughtcodeToolOptions = {}) {
  return [createVibeCallTool(options), createVibeReturnTool(options)] as const;
}
