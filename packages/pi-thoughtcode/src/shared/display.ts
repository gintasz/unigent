import type { Theme } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative } from "node:path";
import type { VibeCallDetails, VibeCallProgress, VibeCallUsage } from "../types.js";
import { truncateEnd, truncateMiddle } from "./truncate.js";

export const COLLAPSED_ARGS_MAX_LENGTH = 140;
export const EXPANDED_ARGS_MAX_LENGTH = 1000;
export const COLLAPSED_VALUE_MAX_LENGTH = 200;
export const EXPANDED_VALUE_MAX_LENGTH = 2000;
export const PATH_MAX_LENGTH = 120;
export const STEP_MAX_LENGTH = 180;
export const MAX_RUN_EVENTS = 200;
export const INSPECT_VIEWPORT_HEIGHT_PCT = 80;

export function formatPathForDisplay(path: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(path)) {
    return truncateMiddle(path, PATH_MAX_LENGTH);
  }
  const relativePath = relative(cwd, path);
  const displayPath = relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : path;
  return truncateMiddle(displayPath, PATH_MAX_LENGTH);
}

export function formatDuration(startedAt: number, endedAt = Date.now()): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function formatTokens(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 10000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${Math.round(value / 1000)}k`;
}

export function formatUsage(usage: VibeCallUsage | undefined, cumulative = false): string {
  if (!usage) {
    return "";
  }
  const parts = [`↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`];
  if (usage.cacheRead > 0) {
    parts.push(`R${formatTokens(usage.cacheRead)}`);
  }
  if (usage.cacheWrite > 0) {
    parts.push(`W${formatTokens(usage.cacheWrite)}`);
  }
  if (usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(5)}`);
  }
  if (cumulative) {
    parts.push("(cumulative)");
  }
  return parts.join(" ");
}

export function markerForProgress(progress: VibeCallProgress | undefined, status: VibeCallDetails["status"], theme: Theme): string {
  if (progress?.status === "done" || status === "done") {
    return theme.fg("success", "✓");
  }
  if (progress?.status === "fail" || status === "error" || status === "aborted") {
    return theme.fg("error", "✗");
  }
  return theme.fg("accent", "◐");
}

export function labelForStatus(progress: VibeCallProgress | undefined, status: VibeCallDetails["status"]): string {
  if (progress?.status === "done" || status === "done") {
    return "done";
  }
  if (progress?.status === "fail" || status === "aborted") {
    return "failed";
  }
  if (status === "error") {
    return "failed";
  }
  return "running";
}

export function formatProgressStepForDisplay(step: string, expanded: boolean, cwd: string | undefined): string {
  if (step === "think") {
    return "thinking";
  }
  const textPrefix = "text ";
  if (step.startsWith(textPrefix)) {
    return truncateEnd(`responding ${step.slice(textPrefix.length)}`, expanded ? EXPANDED_VALUE_MAX_LENGTH : STEP_MAX_LENGTH);
  }
  const readPrefix = "tool read ";
  const formatted =
    step.startsWith(readPrefix) && cwd
      ? `${readPrefix}${formatPathForDisplay(step.slice(readPrefix.length), cwd)}`
      : step;
  return truncateEnd(formatted, expanded ? EXPANDED_VALUE_MAX_LENGTH : STEP_MAX_LENGTH);
}

export function formatArgsForDisplay(args: string, maxLength: number): string {
  return args.trim() ? truncateEnd(args, maxLength) : "<empty>";
}
