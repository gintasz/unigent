import type { AgentSessionEvent, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  VIBE_CALL_TOOL_NAME,
  VIBE_RETURN_TOOL_NAME,
  VIBE_THROW_TOOL_NAME,
  appendThoughtcodeSystemPrompt,
  buildVibeCallSubagentPrompt,
} from "thoughtcode-core";
import {
  MAIN_RUN_ID,
  listVibeCallRuns,
  logTopLevelEnd,
  logTopLevelEvent,
  logTopLevelStart,
} from "./runs/index.js";
import { inspectThoughtcodeRun, prepareEntrypoint } from "./commands/index.js";
import { createThoughtcodeTools } from "./tools/index.js";

const thoughtcodeExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // One trace id for this process ties the top-level pi agent together with every VIBECALL subagent
  // it spawns, so the whole nested run lands in a single debug-log file.
  const traceId = `${MAIN_RUN_ID}-${Date.now()}`;
  let calledVibeReturn = false;
  let calledVibeThrow = false;

  for (const tool of createThoughtcodeTools({ traceId, parentRunId: MAIN_RUN_ID })) {
    pi.registerTool(tool);
  }
  pi.on("before_agent_start", (event) => ({
    systemPrompt: appendThoughtcodeSystemPrompt(event.systemPrompt),
  }));

  pi.on("agent_start", (_event, ctx) => {
    calledVibeReturn = false;
    calledVibeThrow = false;
    logTopLevelStart(traceId, ctx.cwd);
  });
  pi.on("message_end", (event, ctx) => {
    logTopLevelEvent(traceId, ctx.cwd, event as unknown as AgentSessionEvent);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    logTopLevelEvent(traceId, ctx.cwd, event as unknown as AgentSessionEvent);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName === VIBE_RETURN_TOOL_NAME && !event.isError) {
      calledVibeReturn = true;
    }
    if (event.toolName === VIBE_THROW_TOOL_NAME && !event.isError) {
      calledVibeThrow = true;
    }
    logTopLevelEvent(traceId, ctx.cwd, event as unknown as AgentSessionEvent);
  });
  pi.on("agent_end", (_event, ctx) => {
    logTopLevelEnd(traceId, ctx.cwd, calledVibeReturn, calledVibeThrow);
  });
  pi.registerCommand("thoughtcode-inspect", {
    description: `Inspect a live or recent Thoughtcode ${VIBE_CALL_TOOL_NAME} run. Usage: /thoughtcode-inspect <runId|latest>`,
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim();
      return listVibeCallRuns()
        .map((run) => run.id)
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ label: id, value: id, description: `Thoughtcode ${VIBE_CALL_TOOL_NAME} run` }));
    },
    handler: inspectThoughtcodeRun,
  });
  pi.registerCommand("thoughtcode-run", {
    description:
      "Run a ThoughtCode program. Usage: /thoughtcode-run <file> <entrypoint> [args]. " +
      "Args: a bare value for a single-arg function, name=value pairs, or a JSON object.",
    async handler(args, ctx) {
      const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim());
      if (!match) {
        ctx.ui.notify("Usage: /thoughtcode-run <file> <entrypoint> [args]", "error");
        return;
      }
      const [, programFilePath, name, rawArgs = ""] = match;
      const prepared = await prepareEntrypoint(programFilePath, name, rawArgs, ctx.cwd);
      if (!prepared.ok) {
        ctx.ui.notify(prepared.error, "error");
        return;
      }
      pi.sendUserMessage(buildVibeCallSubagentPrompt({ program_file_path: programFilePath, name, args: prepared.args }));
    },
  });
};

export default thoughtcodeExtension;
