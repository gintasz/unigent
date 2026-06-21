import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  THOUGHTCODE_MISSING_VIBE_RETURN_MESSAGE,
  THOUGHTCODE_MISSING_VIBE_RETURN_PROGRESS_STEP,
  THOUGHTCODE_SUBAGENT_ABORTED_BEFORE_PROMPT_MESSAGE,
  THOUGHTCODE_SUBAGENT_FAILED_MESSAGE,
  VIBE_CALL_TOOL_NAME,
  VIBE_RETURN_TOOL_NAME,
  appendThoughtcodeSystemPrompt,
  buildCannotSpawnThoughtcodeSubagentMessage,
} from "thoughtcode-core";
import {
  appendTranscriptFromAssistantMessage,
  appendTranscriptFromAssistantUpdate,
  updateProgressFromChildEvent,
} from "../runs/child-session-events.js";
import {
  appendNestedVibeCallToolTranscript,
  appendProgressUpdate,
  appendTranscriptItem,
  appendVibeCallEvent,
  emitVibeCallProgress,
  getVibeCallRun,
} from "../runs/index.js";
import { STEP_MAX_LENGTH } from "../shared/display.js";
import { getTextContent } from "../shared/tool-result.js";
import { truncateEnd } from "../shared/truncate.js";
import type { VibeReturnDetails, VibeSubagentRunRequest } from "../types.js";
import { createThoughtcodeTools } from "./index.js";

export async function runThoughtcodeSubagent(request: VibeSubagentRunRequest): Promise<string> {
  const { ctx, signal } = request;
  const model = ctx.model;
  const run = getVibeCallRun(request.runId);

  if (!model) {
    throw new Error(buildCannotSpawnThoughtcodeSubagentMessage("no PI model is selected."));
  }

  let returnedValue: string | undefined;
  let subagentError: string | undefined;
  const childTools = createThoughtcodeTools({
    depth: request.depth + 1,
    onVibeReturn: (value) => {
      returnedValue = value;
    },
  });
  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRegistry: ctx.modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    customTools: [...childTools],
    tools: ["read", VIBE_CALL_TOOL_NAME, VIBE_RETURN_TOOL_NAME],
  });

  const unsubscribe = session.subscribe((event) => {
    if (run && event.type === "message_update") {
      appendTranscriptFromAssistantUpdate(run, event);
    }

    if (updateProgressFromChildEvent(request.progress, event, cwd)) {
      if (run) {
        const toolCallId =
          event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end"
            ? event.toolCallId
            : undefined;
        appendProgressUpdate(run, request.progress, cwd, toolCallId);
      }
      emitVibeCallProgress(request, request.progress);
    }

    if (run && event.type === "tool_execution_update" && event.toolName === VIBE_CALL_TOOL_NAME) {
      appendNestedVibeCallToolTranscript(run, event.partialResult, event.toolCallId);
    }
    if (run && event.type === "tool_execution_end" && event.toolName === VIBE_CALL_TOOL_NAME) {
      appendNestedVibeCallToolTranscript(run, event.result, event.toolCallId);
    }

    if (event.type !== "message_end") {
      return;
    }
    if (event.message.role === "assistant" && event.message.stopReason === "error") {
      subagentError = event.message.errorMessage ?? THOUGHTCODE_SUBAGENT_FAILED_MESSAGE;
      if (run) {
        appendVibeCallEvent(run, "error", subagentError);
        appendTranscriptItem(run, "error", subagentError);
      }
      return;
    }
    if (event.message.role === "assistant") {
      if (run) {
        appendTranscriptFromAssistantMessage(run, event.message.content);
      }
      return;
    }
    if (event.message.role !== "toolResult") {
      return;
    }
    if (event.message.toolName === VIBE_CALL_TOOL_NAME) {
      if (run) {
        appendNestedVibeCallToolTranscript(run, event.message, event.message.toolCallId);
      }
      return;
    }
    if (event.message.toolName !== VIBE_RETURN_TOOL_NAME) {
      return;
    }
    const details = event.message.details as Partial<VibeReturnDetails> | undefined;
    returnedValue = typeof details?.value === "string" ? details.value : getTextContent(event.message.content);
  });

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      void session.abort();
    };
    if (!signal.aborted) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  try {
    if (signal?.aborted) {
      throw new Error(THOUGHTCODE_SUBAGENT_ABORTED_BEFORE_PROMPT_MESSAGE);
    }

    await session.bindExtensions({});

    if (signal?.aborted) {
      throw new Error(THOUGHTCODE_SUBAGENT_ABORTED_BEFORE_PROMPT_MESSAGE);
    }

    emitVibeCallProgress(request, request.progress);
    await session.prompt(appendThoughtcodeSystemPrompt(request.prompt), {
      expandPromptTemplates: false,
      source: "extension",
    });

    if (returnedValue === undefined) {
      if (subagentError) {
        request.progress.status = "fail";
        request.progress.endedAt = Date.now();
        request.progress.step = `fail ${truncateEnd(subagentError, STEP_MAX_LENGTH - 5)}`;
        if (run) {
          run.status = "error";
          run.endedAt = request.progress.endedAt;
          run.error = subagentError;
          appendProgressUpdate(run, request.progress, cwd);
        }
        emitVibeCallProgress(request, request.progress, "error");
        throw new Error(subagentError);
      }
      request.progress.status = "fail";
      request.progress.endedAt = Date.now();
      request.progress.step = THOUGHTCODE_MISSING_VIBE_RETURN_PROGRESS_STEP;
      if (run) {
        run.status = "error";
        run.endedAt = request.progress.endedAt;
        run.error = THOUGHTCODE_MISSING_VIBE_RETURN_MESSAGE;
        appendProgressUpdate(run, request.progress, cwd);
      }
      emitVibeCallProgress(request, request.progress, "error");
      throw new Error(THOUGHTCODE_MISSING_VIBE_RETURN_MESSAGE);
    }

    request.progress.status = "done";
    request.progress.endedAt = Date.now();
    request.progress.step = `done ${truncateEnd(returnedValue, STEP_MAX_LENGTH - 5)}`;
    if (run) {
      run.status = "done";
      run.endedAt = request.progress.endedAt;
      run.result = returnedValue;
      appendProgressUpdate(run, request.progress, cwd);
    }
    emitVibeCallProgress(request, request.progress);
    return returnedValue;
  } finally {
    unsubscribe();
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    session.dispose();
  }
}
