import { VIBE_CALL_TOOL_NAME } from "thoughtcode-core";
import { MAX_RUN_EVENTS } from "../shared/display.js";
import { truncateEnd } from "../shared/truncate.js";
import type {
  VibeCallDetails,
  VibeCallEventType,
  VibeCallRunRecord,
  VibeCallTranscriptItem,
} from "../types.js";

export function appendVibeCallEvent(record: VibeCallRunRecord, type: VibeCallEventType, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const last = record.events.at(-1);
  if (last?.type === type && last.text === trimmed) {
    return;
  }
  record.events.push({ t: Date.now(), type, text: trimmed });
  if (record.events.length > MAX_RUN_EVENTS) {
    record.events.splice(0, record.events.length - MAX_RUN_EVENTS);
  }
}

export function appendTranscriptItem(
  record: VibeCallRunRecord,
  role: VibeCallTranscriptItem["role"],
  text: string,
  toolCallId?: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  if (toolCallId) {
    const existing = record.transcript.find((item) => item.role === role && item.toolCallId === toolCallId);
    if (existing) {
      existing.text = trimmed;
      existing.t = Date.now();
      return;
    }
  }
  const last = record.transcript.at(-1);
  if (last?.role === role) {
    if (last.text === trimmed || last.text.endsWith(trimmed)) {
      return;
    }
    if (role === "assistant") {
      last.text = `${last.text}${trimmed}`;
      last.t = Date.now();
      return;
    }
  }
  record.transcript.push({ t: Date.now(), role, text: trimmed, ...(toolCallId ? { toolCallId } : {}) });
  if (record.transcript.length > MAX_RUN_EVENTS) {
    record.transcript.splice(0, record.transcript.length - MAX_RUN_EVENTS);
  }
}

export function vibeCallDetailsFromToolResult(result: unknown): VibeCallDetails | undefined {
  const details = (result as { details?: unknown } | undefined)?.details as Partial<VibeCallDetails> | undefined;
  if (details?.kind !== "vibecall" || typeof details.runId !== "string") {
    return undefined;
  }
  return details as VibeCallDetails;
}

export function formatNestedVibeCallTool(details: VibeCallDetails): string {
  const args = details.args.trim() ? ` ${truncateEnd(details.args, 80)}` : "";
  return `${VIBE_CALL_TOOL_NAME} run=${details.runId} ${details.name}${args}`;
}

export function appendNestedVibeCallToolTranscript(record: VibeCallRunRecord, result: unknown, toolCallId: string): boolean {
  const details = vibeCallDetailsFromToolResult(result);
  if (!details) {
    return false;
  }
  appendTranscriptItem(record, "tool", formatNestedVibeCallTool(details), toolCallId);
  return true;
}
