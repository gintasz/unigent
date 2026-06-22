import {
  formatProgressStepForDisplay,
} from "../shared/display.js";
import type { VibeCallEventType, VibeCallProgress, VibeCallRunRecord } from "../types.js";
import { appendTranscriptItem, appendVibeCallEvent } from "./transcript.js";

export function classifyProgressStep(step: string): VibeCallEventType {
  if (step === "think" || step.startsWith("think ")) {
    return "thinking";
  }
  if (step.startsWith("tool ")) {
    return "tool";
  }
  if (step.startsWith("text ")) {
    return "responding";
  }
  if (step.startsWith("done ")) {
    return "return";
  }
  if (step.startsWith("fail ") || step.startsWith("throw ")) {
    return "error";
  }
  return "status";
}

export function appendProgressEvent(record: VibeCallRunRecord, progress: VibeCallProgress, cwd: string | undefined): void {
  appendVibeCallEvent(
    record,
    classifyProgressStep(progress.step),
    formatProgressStepForDisplay(progress.step, true, cwd),
  );
}

export function appendProgressTranscript(
  record: VibeCallRunRecord,
  progress: VibeCallProgress,
  cwd: string | undefined,
  toolCallId?: string,
): void {
  const step = progress.step;
  // Thinking/responding text is accumulated into the transcript separately (from assistant updates),
  // so the progress step — a compact trailing window — must not add a duplicate transcript item.
  if (step === "think" || step.startsWith("think ") || step.startsWith("text ")) {
    return;
  }
  if (step.startsWith("tool ")) {
    appendTranscriptItem(record, "tool", formatProgressStepForDisplay(step, true, cwd).replace(/^tool /, ""), toolCallId);
    return;
  }
  if (step.startsWith("done ")) {
    appendTranscriptItem(record, "return", step.slice(5));
    return;
  }
  // "fail " and "throw " steps carry only the truncated message; the full text is appended as a
  // dedicated "error" transcript item by the caller, so skip the truncated duplicate here.
  if (step.startsWith("fail ") || step.startsWith("throw ")) {
    return;
  }
  appendTranscriptItem(record, "status", formatProgressStepForDisplay(step, true, cwd));
}

export function appendProgressUpdate(
  record: VibeCallRunRecord,
  progress: VibeCallProgress,
  cwd: string | undefined,
  toolCallId?: string,
): void {
  appendProgressEvent(record, progress, cwd);
  appendProgressTranscript(record, progress, cwd, toolCallId);
}
