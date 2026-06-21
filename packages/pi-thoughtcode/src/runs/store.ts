import type { VibeCallRunRecord } from "../types.js";

const vibeCallRuns = new Map<string, VibeCallRunRecord>();
let vibeCallRunCounter = 0;

export function createVibeCallRunId(): string {
  vibeCallRunCounter += 1;
  return `tc-${vibeCallRunCounter}`;
}

export function getVibeCallRun(runId: string): VibeCallRunRecord | undefined {
  return vibeCallRuns.get(runId);
}

export function setVibeCallRun(record: VibeCallRunRecord): void {
  vibeCallRuns.set(record.id, record);
}

export function listVibeCallRuns(): VibeCallRunRecord[] {
  return [...vibeCallRuns.values()];
}

export function clearVibeCallRunsForTests(): void {
  vibeCallRuns.clear();
  vibeCallRunCounter = 0;
}
