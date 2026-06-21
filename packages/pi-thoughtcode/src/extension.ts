import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { VIBE_CALL_TOOL_NAME, appendThoughtcodeSystemPrompt } from "thoughtcode-core";
import { listVibeCallRuns } from "./runs/index.js";
import { createThoughtcodeTools } from "./tools/index.js";
import { inspectThoughtcodeRun } from "./ui/index.js";

const thoughtcodeExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  for (const tool of createThoughtcodeTools()) {
    pi.registerTool(tool);
  }
  pi.on("before_agent_start", (event) => ({
    systemPrompt: appendThoughtcodeSystemPrompt(event.systemPrompt),
  }));
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
};

export default thoughtcodeExtension;
