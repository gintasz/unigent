import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  VIBE_RETURN_TOOL_DESCRIPTION,
  type VibeReturnArgs,
} from "thoughtcode-core";
import { textResult } from "../shared/tool-result.js";
import type { ThoughtcodeToolOptions, VibeReturnDetails } from "../types.js";
import { vibeReturnParameters, type VibeReturnParams } from "./schema.js";

export function createVibeReturnTool(options: ThoughtcodeToolOptions = {}) {
  return defineTool({
    ...VIBE_RETURN_TOOL_DESCRIPTION,
    parameters: vibeReturnParameters,
    async execute(_toolCallId, params: VibeReturnParams): Promise<AgentToolResult<VibeReturnDetails>> {
      const args: VibeReturnArgs = {
        value: params.value,
      };

      if (options.onVibeReturn) {
        options.onVibeReturn(args.value);
      }

      return textResult(
        args.value,
        {
          kind: "vibereturn",
          value: args.value,
        },
        true,
      );
    },
  });
}

export const vibeReturnTool = createVibeReturnTool();
