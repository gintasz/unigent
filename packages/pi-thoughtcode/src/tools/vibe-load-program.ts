import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  VIBE_LOAD_PROGRAM_TOOL_DESCRIPTION,
  buildVibeLoadProgramUnreadableMessage,
  buildVibeProgramSyntaxErrorMessage,
} from "thoughtcode-core";
import { textResult } from "../shared/tool-result.js";
import type { ThoughtcodeToolOptions, VibeLoadProgramDetails } from "../types.js";
import { validateProgramSyntax } from "./return-type.js";
import { vibeLoadProgramParameters, type VibeLoadProgramParams } from "./schema.js";

export function createVibeLoadProgramTool(_options: ThoughtcodeToolOptions = {}) {
  return defineTool({
    ...VIBE_LOAD_PROGRAM_TOOL_DESCRIPTION,
    parameters: vibeLoadProgramParameters,
    executionMode: "parallel",
    async execute(
      _toolCallId,
      params: VibeLoadProgramParams,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<VibeLoadProgramDetails>> {
      const path = params.program_file_path;
      const absolute = isAbsolute(path) ? path : resolve(ctx?.cwd ?? process.cwd(), path);

      let text: string;
      try {
        text = await readFile(absolute, "utf8");
      } catch {
        // Throw so the agent receives a tool error and stops, per the load-program guideline.
        throw new Error(buildVibeLoadProgramUnreadableMessage(path));
      }

      const check = validateProgramSyntax(text);
      if (!check.ok) {
        throw new Error(buildVibeProgramSyntaxErrorMessage(path, check.errors));
      }

      return textResult(text, { kind: "vibeloadprogram", program_file_path: path });
    },
  });
}

export const vibeLoadProgramTool = createVibeLoadProgramTool();
