import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VibeCallArgs } from "thoughtcode-core";

export interface VibeCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export type VibeCallEventType = "thinking" | "tool" | "responding" | "return" | "error" | "status";

export interface VibeCallEvent {
  t: number;
  type: VibeCallEventType;
  text: string;
}

export interface VibeCallTranscriptItem {
  t: number;
  role: "thinking" | "assistant" | "tool" | "return" | "error" | "status";
  text: string;
  toolCallId?: string;
}

export interface VibeCallProgress {
  status: "run" | "done" | "fail";
  depth: number;
  startedAt: number;
  endedAt?: number;
  step: string;
  usage?: VibeCallUsage;
}

export interface VibeCallDetails {
  kind: "vibecall";
  runId: string;
  program_file_path: string;
  name: string;
  args: string;
  prompt: string;
  status: "running" | "done" | "error" | "aborted";
  depth: number;
  progress?: VibeCallProgress;
  events?: VibeCallEvent[];
  transcript?: VibeCallTranscriptItem[];
  result?: string;
  error?: string;
}

export interface VibeReturnDetails {
  kind: "vibereturn";
  value: string;
}

export interface VibeSubagentRunRequest {
  runId: string;
  toolCallId: string;
  call: VibeCallArgs;
  prompt: string;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  depth: number;
  progress: VibeCallProgress;
  onUpdate: ((result: AgentToolResult<VibeCallDetails>) => void) | undefined;
}

export type VibeSubagentRunner = (request: VibeSubagentRunRequest) => Promise<string>;

export interface ThoughtcodeToolOptions {
  runSubagent?: VibeSubagentRunner;
  onVibeReturn?: (value: string) => void;
  depth?: number;
}

export interface VibeCallRunRecord {
  id: string;
  toolCallId: string;
  call: VibeCallArgs;
  prompt: string;
  status: VibeCallDetails["status"];
  depth: number;
  progress: VibeCallProgress;
  events: VibeCallEvent[];
  transcript: VibeCallTranscriptItem[];
  result?: string;
  error?: string;
  cwd?: string;
  startedAt: number;
  endedAt?: number;
}
