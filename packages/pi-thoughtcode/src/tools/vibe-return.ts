import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  THOUGHTCODE_MAX_VIBE_RETURN_TYPE_FAILURES,
  VIBE_RETURN_TOOL_DESCRIPTION,
  checkReturnValue,
  type VibeReturnArgs,
} from "thoughtcode-core";
import { textResult } from "../shared/tool-result.js";
import type { ThoughtcodeToolOptions, VibeReturnDetails } from "../types.js";
import { vibeReturnParameters, type VibeReturnParams } from "./schema.js";

export function createVibeReturnTool(options: ThoughtcodeToolOptions = {}) {
  // Counts rejected returns within this VIBEFUNCTION execution. After the cap we accept whatever the
  // agent returns so a value that never satisfies the type can't trap it in an infinite retry loop.
  let typeFailures = 0;

  return defineTool({
    ...VIBE_RETURN_TOOL_DESCRIPTION,
    parameters: vibeReturnParameters,
    async execute(_toolCallId, params: VibeReturnParams): Promise<AgentToolResult<VibeReturnDetails>> {
      const args: VibeReturnArgs = {
        value: params.value,
      };

      if (options.returnType && typeFailures < THOUGHTCODE_MAX_VIBE_RETURN_TYPE_FAILURES) {
        const check = checkReturnValue(args.value, options.returnType);
        if (!check.ok) {
          typeFailures += 1;
          // Throw so the agent receives a tool error and retries VIBERETURN with a correct value.
          throw new Error(
            `Return value does not match the VIBEFUNCTION's declared return type \`${options.returnType}\`: ${check.message}. ` +
              "Call VIBERETURN again with a value of the correct type.",
          );
        }
      }

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
