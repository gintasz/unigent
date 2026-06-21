import {
  formatProgressStepForDisplay,
} from "../shared/display.js";
import type { VibeCallEventType, VibeCallProgress, VibeCallRunRecord } from "../types.js";
import { appendTranscriptItem, appendVibeCallEvent } from "./transcript.js";

export function classifyProgressStep(step: string): VibeCallEventType {
  if (step === "think") {
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
  if (step.startsWith("fail ")) {
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
  if (step === "think") {
    return;
  }
  if (step.startsWith("tool ")) {
    appendTranscriptItem(record, "tool", formatProgressStepForDisplay(step, true, cwd).replace(/^tool /, ""), toolCallId);
    return;
  }
  if (step.startsWith("text ")) {
    return;
  }
  if (step.startsWith("done ")) {
    appendTranscriptItem(record, "return", step.slice(5));
    return;
  }
  if (step.startsWith("fail ")) {
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
