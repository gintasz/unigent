import type { VibeCallArgs } from "thoughtcode-core";
import { textResult } from "../shared/tool-result.js";
import type {
  VibeCallDetails,
  VibeCallProgress,
  VibeCallRunRecord,
  VibeSubagentRunRequest,
} from "../types.js";
import { getVibeCallRun } from "./store.js";

export function createVibeCallProgress(depth: number): VibeCallProgress {
  return {
    status: "run",
    depth,
    startedAt: Date.now(),
    step: "think",
  };
}

export function createVibeCallDetails(
  runId: string,
  call: VibeCallArgs,
  prompt: string,
  status: VibeCallDetails["status"],
  depth: number,
  progress: VibeCallProgress | undefined,
  events: VibeCallDetails["events"] | undefined,
  transcript: VibeCallDetails["transcript"] | undefined,
  extra: Pick<VibeCallDetails, "result" | "error"> = {},
): VibeCallDetails {
  return {
    kind: "vibecall",
    runId,
    program_file_path: call.program_file_path,
    name: call.name,
    args: call.args,
    prompt,
    status,
    depth,
    ...(progress ? { progress } : {}),
    ...(events ? { events: [...events] } : {}),
    ...(transcript ? { transcript: [...transcript] } : {}),
    ...extra,
  };
}

export function emitVibeCallProgress(
  request: VibeSubagentRunRequest,
  progress: VibeCallProgress,
  status: VibeCallDetails["status"] = "running",
): void {
  const record = getVibeCallRun(request.runId);
  request.onUpdate?.(
    textResult(
      progress.step,
      createVibeCallDetails(
        request.runId,
        request.call,
        request.prompt,
        status,
        request.depth,
        progress,
        record?.events,
        record?.transcript,
      ),
    ),
  );
}

export function createVibeCallRunRecord(
  runId: string,
  toolCallId: string,
  call: VibeCallArgs,
  prompt: string,
  depth: number,
  progress: VibeCallProgress,
  cwd: string | undefined,
): VibeCallRunRecord {
  return {
    id: runId,
    toolCallId,
    call,
    prompt,
    status: "running",
    depth,
    progress,
    events: [],
    transcript: [],
    nestedUsageByRunId: new Map(),
    cwd,
    startedAt: progress.startedAt,
  };
}
