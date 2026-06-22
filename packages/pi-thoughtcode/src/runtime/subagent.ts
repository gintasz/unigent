import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  THOUGHTCODE_MAX_VIBE_RETURN_REMINDERS,
  THOUGHTCODE_MISSING_VIBE_RETURN_MESSAGE,
  THOUGHTCODE_MISSING_VIBE_RETURN_PROGRESS_STEP,
  THOUGHTCODE_SUBAGENT_ABORTED_BEFORE_PROMPT_MESSAGE,
  THOUGHTCODE_SUBAGENT_FAILED_MESSAGE,
  THOUGHTCODE_VIBE_RETURN_REMINDER_MESSAGE,
  VIBE_CALL_TOOL_NAME,
  VIBE_LOAD_PROGRAM_TOOL_NAME,
  VIBE_RETURN_TOOL_NAME,
  VIBE_THROW_TOOL_NAME,
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
  addNestedVibeCallUsage,
  appendProgressUpdate,
  appendTranscriptItem,
  appendVibeCallEvent,
  emitVibeCallProgress,
  getVibeCallRun,
  logReminder,
  logSessionEvent,
  vibeCallDetailsFromToolResult,
} from "../runs/index.js";
import { VibeThrowError } from "../tools/vibe-throw.js";
import { STEP_MAX_LENGTH } from "../shared/display.js";
import { getTextContent } from "../shared/tool-result.js";
import { truncateEnd } from "../shared/truncate.js";
import type { VibeCallRunRecord, VibeReturnDetails, VibeSubagentRunRequest } from "../types.js";
import { createThoughtcodeTools } from "../tools/index.js";

type RunOutcome =
  | { kind: "done"; value: string }
  | { kind: "throw"; message: string }
  | { kind: "error"; message: string; step?: string };

interface RunLimiter {
  signal: AbortSignal;
  throwIfAborted(): void;
  checkBudget(costSoFar: number, budgetUsd: number | undefined): void;
  dispose(): void;
}

/**
 * Owns @timeout / @budget / parent-cancel aborting for one subagent run. A deliberate limit breach
 * sets a reason so it surfaces as a VibeThrowError rather than a plain cancel.
 */
function createRunLimiter(opts: {
  parentSignal: AbortSignal | undefined;
  timeoutMs: number | undefined;
  functionName: string;
  onAbort: () => void;
}): RunLimiter {
  const controller = new AbortController();
  let abortReason: string | undefined;
  const onParentAbort = () => controller.abort();
  if (opts.parentSignal) {
    if (opts.parentSignal.aborted) controller.abort();
    else opts.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      abortReason ??= `exceeded its ${opts.timeoutMs! / 1000}s timeout`;
      controller.abort();
    }, opts.timeoutMs);
    timer.unref?.();
  }
  const onAbort = () => opts.onAbort();
  if (controller.signal.aborted) {
    opts.onAbort();
  } else {
    controller.signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    throwIfAborted() {
      if (!controller.signal.aborted) return;
      if (abortReason) throw new VibeThrowError(`VIBEFUNCTION \`${opts.functionName}\` ${abortReason}.`);
      throw new Error(THOUGHTCODE_SUBAGENT_ABORTED_BEFORE_PROMPT_MESSAGE);
    },
    checkBudget(costSoFar, budgetUsd) {
      if (budgetUsd === undefined || controller.signal.aborted || costSoFar <= budgetUsd) return;
      abortReason ??= `exceeded its $${budgetUsd} cost budget`;
      controller.abort();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      opts.parentSignal?.removeEventListener("abort", onParentAbort);
      controller.signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Single place that records a run's final progress/status and emits it (replaces 4 near-identical blocks). */
function concludeRun(
  request: VibeSubagentRunRequest,
  run: VibeCallRunRecord | undefined,
  cwd: string | undefined,
  outcome: RunOutcome,
): void {
  const progress = request.progress;
  progress.endedAt = Date.now();
  if (outcome.kind === "done") {
    progress.status = "done";
    progress.step = `done ${truncateEnd(outcome.value, STEP_MAX_LENGTH - 5)}`;
  } else {
    progress.status = "fail";
    progress.step =
      outcome.kind === "throw"
        ? `throw ${truncateEnd(outcome.message, STEP_MAX_LENGTH - 6)}`
        : (outcome.step ?? `fail ${truncateEnd(outcome.message, STEP_MAX_LENGTH - 5)}`);
  }
  if (run) {
    run.status = outcome.kind === "done" ? "done" : "error";
    run.endedAt = progress.endedAt;
    if (outcome.kind === "done") {
      run.result = outcome.value;
    } else {
      run.error = outcome.message;
      // Record the full message as its own transcript item — progress.step is truncated for the
      // compact one-line status, but the expanded/inspect view must show the whole thing.
      if (outcome.kind === "throw") {
        appendTranscriptItem(run, "error", outcome.message);
      }
    }
    appendProgressUpdate(run, progress, cwd);
  }
  if (outcome.kind === "done") {
    emitVibeCallProgress(request, progress);
  } else {
    emitVibeCallProgress(request, progress, "error");
  }
}

export async function runThoughtcodeSubagent(request: VibeSubagentRunRequest): Promise<string> {
  const { ctx, signal } = request;
  let model = ctx.model;
  const run = getVibeCallRun(request.runId);

  if (!model) {
    throw new Error(buildCannotSpawnThoughtcodeSubagentMessage("no PI model is selected."));
  }

  let returnedValue: string | undefined;
  let thrownMessage: string | undefined;
  let subagentError: string | undefined;

  // The caller (vibe-call) parsed the program once and resolved these from the model; the subagent
  // just runs the session with them.
  const returnType = request.returnType;
  const runConfig = request.runConfig ?? {};

  if (runConfig.modelId) {
    const requested = ctx.modelRegistry
      ?.getAll()
      .find((candidate) => candidate.id === runConfig.modelId || `${candidate.provider}/${candidate.id}` === runConfig.modelId);
    if (!requested) {
      throw new Error(
        `VIBEFUNCTION \`${request.call.name}\` requests model \`${runConfig.modelId}\` via @model, which is not available.`,
      );
    }
    model = requested;
  }

  const childTools = createThoughtcodeTools({
    depth: request.depth + 1,
    traceId: request.traceId,
    parentRunId: request.runId,
    returnType,
    onVibeReturn: (value) => {
      returnedValue = value;
    },
    onVibeThrow: (message) => {
      thrownMessage = message;
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
    tools: ["read", VIBE_CALL_TOOL_NAME, VIBE_RETURN_TOOL_NAME, VIBE_LOAD_PROGRAM_TOOL_NAME, VIBE_THROW_TOOL_NAME],
    ...(runConfig.thinkingLevel ? { thinkingLevel: runConfig.thinkingLevel } : {}),
  });

  const limiter = createRunLimiter({
    parentSignal: signal,
    timeoutMs: runConfig.timeoutMs,
    functionName: request.call.name,
    onAbort: () => void session.abort(),
  });

  const unsubscribe = session.subscribe((event) => {
    logSessionEvent(request, event);

    if (run && event.type === "message_update") {
      appendTranscriptFromAssistantUpdate(run, event);
    }

    if (
      run &&
      (event.type === "tool_execution_update" || event.type === "tool_execution_end") &&
      event.toolName === VIBE_CALL_TOOL_NAME
    ) {
      const details = vibeCallDetailsFromToolResult(event.type === "tool_execution_update" ? event.partialResult : event.result);
      if (details) {
        addNestedVibeCallUsage(run, details);
      }
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

    limiter.checkBudget(request.progress.usage?.cost ?? 0, runConfig.budgetUsd);

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

  try {
    limiter.throwIfAborted();

    await session.bindExtensions({});

    limiter.throwIfAborted();

    emitVibeCallProgress(request, request.progress);
    await session.prompt(appendThoughtcodeSystemPrompt(request.prompt), {
      expandPromptTemplates: false,
      source: "extension",
    });
    limiter.throwIfAborted();

    // The subagent sometimes ends its turn without calling VIBERETURN. Remind it with a
    // follow-up user message and let it try again, bounded so a stubborn agent can't loop forever.
    for (
      let reminders = 0;
      returnedValue === undefined &&
      thrownMessage === undefined &&
      !subagentError &&
      reminders < THOUGHTCODE_MAX_VIBE_RETURN_REMINDERS;
      reminders++
    ) {
      limiter.throwIfAborted();
      if (run) {
        appendTranscriptItem(run, "status", THOUGHTCODE_VIBE_RETURN_REMINDER_MESSAGE);
        logReminder(run, THOUGHTCODE_VIBE_RETURN_REMINDER_MESSAGE);
      }
      await session.prompt(THOUGHTCODE_VIBE_RETURN_REMINDER_MESSAGE, {
        expandPromptTemplates: false,
        source: "extension",
      });
      limiter.throwIfAborted();
    }

    if (thrownMessage !== undefined) {
      // The VIBEFUNCTION deliberately aborted via VIBETHROW. Surface it as a VibeThrowError so the
      // VIBECALL boundary reports an intentional program throw, not an infrastructure failure.
      concludeRun(request, run, cwd, { kind: "throw", message: thrownMessage });
      throw new VibeThrowError(thrownMessage);
    }

    if (returnedValue === undefined) {
      if (subagentError) {
        concludeRun(request, run, cwd, { kind: "error", message: subagentError });
        throw new Error(subagentError);
      }
      concludeRun(request, run, cwd, {
        kind: "error",
        message: THOUGHTCODE_MISSING_VIBE_RETURN_MESSAGE,
        step: THOUGHTCODE_MISSING_VIBE_RETURN_PROGRESS_STEP,
      });
      throw new Error(THOUGHTCODE_MISSING_VIBE_RETURN_MESSAGE);
    }

    concludeRun(request, run, cwd, { kind: "done", value: returnedValue });
    return returnedValue;
  } finally {
    limiter.dispose();
    unsubscribe();
    session.dispose();
  }
}
