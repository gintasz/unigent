import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  VIBE_CALL_TOOL_DESCRIPTION,
  buildVibeCallFailureMessage,
  buildVibeCallSubagentPrompt,
  type VibeCallArgs,
} from "thoughtcode-core";
import { appendProgressUpdate, createVibeCallDetails, createVibeCallProgress, createVibeCallRunId, createVibeCallRunRecord, setVibeCallRun } from "../runs/index.js";
import { STEP_MAX_LENGTH } from "../shared/display.js";
import { getErrorMessage, textResult } from "../shared/tool-result.js";
import { truncateEnd } from "../shared/truncate.js";
import type { ThoughtcodeToolOptions, VibeCallDetails } from "../types.js";
import { renderVibeCallCall, renderVibeCallResult } from "../ui/index.js";
import { vibeCallParameters, type VibeCallParams } from "./schema.js";
import { runThoughtcodeSubagent } from "./subagent.js";

export function createVibeCallTool(options: ThoughtcodeToolOptions = {}) {
  const runSubagent = options.runSubagent ?? runThoughtcodeSubagent;
  const depth = options.depth ?? 1;

  return defineTool({
    ...VIBE_CALL_TOOL_DESCRIPTION,
    parameters: vibeCallParameters,
    executionMode: "parallel",
    async execute(
      toolCallId,
      params: VibeCallParams,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<VibeCallDetails>> {
      const call: VibeCallArgs = {
        program_file_path: params.program_file_path,
        name: params.name,
        args: params.args,
      };
      const prompt = buildVibeCallSubagentPrompt(call);
      const progress = createVibeCallProgress(depth);
      const runId = createVibeCallRunId();
      const run = createVibeCallRunRecord(runId, toolCallId, call, prompt, depth, progress, ctx?.cwd);
      setVibeCallRun(run);
      appendProgressUpdate(run, progress, ctx?.cwd);

      try {
        const value = await runSubagent({
          runId,
          toolCallId,
          call,
          prompt,
          ctx,
          signal,
          depth,
          progress,
          onUpdate,
        });

        progress.status = "done";
        progress.endedAt ??= Date.now();
        progress.step = `done ${truncateEnd(value, STEP_MAX_LENGTH - 5)}`;
        run.status = "done";
        run.endedAt = progress.endedAt;
        run.result = value;
        appendProgressUpdate(run, progress, ctx?.cwd);

        return textResult(value, createVibeCallDetails(runId, call, prompt, "done", depth, progress, run.events, run.transcript, { result: value }));
      } catch (error) {
        const status = signal?.aborted ? "aborted" : "error";
        const message = getErrorMessage(error);
        progress.status = "fail";
        progress.endedAt ??= Date.now();
        progress.step = `fail ${truncateEnd(message, STEP_MAX_LENGTH - 5)}`;
        run.status = status;
        run.endedAt = progress.endedAt;
        run.error = message;
        appendProgressUpdate(run, progress, ctx?.cwd);
        return textResult(
          buildVibeCallFailureMessage(status, message),
          createVibeCallDetails(runId, call, prompt, status, depth, progress, run.events, run.transcript, { error: message }),
        );
      }
    },
    renderCall(args, theme, context) {
      return renderVibeCallCall(args, theme, context.executionStarted);
    },
    renderResult(result, { expanded }, theme, context) {
      return renderVibeCallResult(result, expanded, theme, context.cwd);
    },
  });
}

export const vibeCallTool = createVibeCallTool();
