import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
import { VIBE_CALL_TOOL_NAME } from "thoughtcode-core";
import {
  COLLAPSED_ARGS_MAX_LENGTH,
  COLLAPSED_VALUE_MAX_LENGTH,
  EXPANDED_ARGS_MAX_LENGTH,
  EXPANDED_VALUE_MAX_LENGTH,
  formatArgsForDisplay,
  formatDuration,
  formatPathForDisplay,
  formatProgressStepForDisplay,
  formatUsage,
  labelForStatus,
  markerForProgress,
} from "../shared/display.js";
import { truncateEnd } from "../shared/truncate.js";
import type { VibeCallParams } from "../tools/schema.js";
import type { VibeCallDetails } from "../types.js";
import { appendTranscriptLines } from "./transcript-lines.js";

export function renderVibeCallCall(args: VibeCallParams, theme: Theme, executionStarted: boolean): Text {
  if (executionStarted) {
    return new Text("", 0, 0);
  }
  const name = args.name || "unknown";
  const preview = truncateEnd(args.args || "", 80);
  const suffix = preview ? ` ${theme.fg("dim", preview)}` : "";
  return new Text(`${theme.fg("toolTitle", theme.bold(VIBE_CALL_TOOL_NAME))} ${theme.fg("muted", name)}${suffix}`, 0, 0);
}

export function renderVibeCallResult(
  result: AgentToolResult<VibeCallDetails>,
  expanded: boolean,
  theme: Theme,
  cwd: string | undefined,
): Component {
  return {
    render(width: number) {
      return renderVibeCallResultLines(result, expanded, theme, cwd, width);
    },
    invalidate() {
      // No cached render state.
    },
  };
}

function renderVibeCallResultLines(
  result: AgentToolResult<VibeCallDetails>,
  expanded: boolean,
  theme: Theme,
  cwd: string | undefined,
  width: number,
): string[] {
  const details = result.details;
  const progress = details.progress;
  const status = labelForStatus(progress, details.status);
  const duration = progress ? formatDuration(progress.startedAt, progress.endedAt) : "";
  const usage = formatUsage(progress?.usage, progress?.usageCumulative);
  const headerParts = [
    markerForProgress(progress, details.status, theme),
    theme.fg("toolTitle", theme.bold(VIBE_CALL_TOOL_NAME)),
    theme.fg(status === "done" ? "success" : status === "failed" ? "error" : "accent", status),
    duration,
    `id=${details.runId}`,
    usage,
  ].filter(Boolean);

  const argsMax = expanded ? EXPANDED_ARGS_MAX_LENGTH : COLLAPSED_ARGS_MAX_LENGTH;
  const valueMax = expanded ? EXPANDED_VALUE_MAX_LENGTH : COLLAPSED_VALUE_MAX_LENGTH;
  const entryLine = `${theme.fg("muted", "entry")} ${details.name}`;
  const fileLine = `${theme.fg("muted", "file")} ${formatPathForDisplay(details.program_file_path, cwd)}`;
  const entryFileLine = `${entryLine}  ${fileLine}`;
  const lines = [headerParts.join(" ")];

  if (visibleWidth(entryFileLine) <= width) {
    lines.push(entryFileLine);
  } else {
    lines.push(entryLine, fileLine);
  }
  lines.push(`${theme.fg("muted", "args")} ${formatArgsForDisplay(details.args, argsMax)}`);

  if (details.status === "done" && details.result !== undefined) {
    lines.push(`${theme.fg("muted", "done")} ${truncateEnd(details.result, valueMax)}`);
  } else if (details.error) {
    lines.push(`${theme.fg("muted", "fail")} ${truncateEnd(details.error, valueMax)}`);
  } else if (progress?.step) {
    lines.push(formatProgressStepForDisplay(progress.step, expanded, cwd));
  }

  if (expanded) {
    lines.push("", theme.fg("muted", "debug"));
    lines.push(`  ${theme.fg("muted", "depth")} ${progress?.depth ?? details.depth}`);
    lines.push(`  ${theme.fg("muted", "prompt")} ${truncateEnd(details.prompt.replace(/\s+/g, " "), 220)}`);
    if (details.transcript?.length) {
      lines.push("", theme.fg("muted", "Subagent"));
      appendTranscriptLines(lines, details.transcript, theme, undefined);
    }
  }

  return lines;
}
