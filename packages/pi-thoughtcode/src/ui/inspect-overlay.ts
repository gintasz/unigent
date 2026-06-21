import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  EXPANDED_ARGS_MAX_LENGTH,
  EXPANDED_VALUE_MAX_LENGTH,
  INSPECT_VIEWPORT_HEIGHT_PCT,
  formatArgsForDisplay,
  formatDuration,
  formatPathForDisplay,
  labelForStatus,
  markerForProgress,
} from "../shared/display.js";
import { truncateEnd } from "../shared/truncate.js";
import type { VibeCallRunRecord, VibeCallTranscriptItem } from "../types.js";

function padToWidth(value: string, width: number): string {
  const clipped = truncateToWidth(value.replace(/\t/g, "  "), width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export class ThoughtcodeInspectOverlay implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private lastInnerWidth = 80;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly record: VibeCallRunRecord,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {
    if (record.status === "running") {
      this.timer = setInterval(() => this.tui.requestRender(), 500);
      this.timer.unref?.();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.close();
      return;
    }

    const contentLines = this.buildContentLines(this.lastInnerWidth);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (matchesKey(data, "up") || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = false;
    } else if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 12) {
      return [];
    }

    const th = this.theme;
    const innerWidth = Math.max(8, width - 4);
    this.lastInnerWidth = innerWidth;
    const contentLines = this.buildContentLines(innerWidth);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    const row = (content: string) => `${th.fg("border", "│")} ${padToWidth(content, innerWidth)} ${th.fg("border", "│")}`;
    const divider = row(th.fg("dim", "─".repeat(innerWidth)));
    const icon = markerForProgress(this.record.progress, this.record.status, th);
    const status = labelForStatus(this.record.progress, this.record.status);
    const title = `${icon} ${th.bold("Thoughtcode")} ${this.record.id} ${status} ${formatDuration(this.record.startedAt, this.record.endedAt)}`;
    const footerLeft = th.fg("dim", `${contentLines.length} lines`);
    const footerRight = th.fg("dim", "↑↓/jk scroll · PgUp/PgDn · q/Esc close");
    const gap = Math.max(1, innerWidth - visibleWidth(footerLeft) - visibleWidth(footerRight));

    return [
      th.fg("border", `╭${"─".repeat(width - 2)}╮`),
      row(title),
      divider,
      ...Array.from({ length: viewportHeight }, (_, index) => row(visible[index] ?? "")),
      divider,
      row(`${footerLeft}${" ".repeat(gap)}${footerRight}`),
      th.fg("border", `╰${"─".repeat(width - 2)}╯`),
    ];
  }

  invalidate(): void {
    // No cached render state.
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private close(): void {
    if (this.closed) {
      return;
    }
    this.dispose();
    this.done();
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal?.rows ?? 36;
    return Math.max(6, Math.floor((rows * INSPECT_VIEWPORT_HEIGHT_PCT) / 100) - 6);
  }

  private buildContentLines(width: number): string[] {
    const th = this.theme;
    const lines = [
      `${th.fg("muted", "entry")} ${this.record.call.name}`,
      `${th.fg("muted", "file")} ${formatPathForDisplay(this.record.call.program_file_path, this.record.cwd)}`,
      `${th.fg("muted", "args")} ${formatArgsForDisplay(this.record.call.args, EXPANDED_ARGS_MAX_LENGTH)}`,
      `${th.fg("muted", "depth")} ${this.record.depth}`,
      "",
      th.fg("muted", "Prompt"),
    ];

    for (const line of this.record.prompt.split("\n")) {
      lines.push(...wrapTextWithAnsi(`  ${line}`, width));
    }

    lines.push("", th.fg("muted", "Subagent"));
    if (this.record.transcript.length === 0) {
      lines.push(th.fg("dim", "  Waiting for subagent activity..."));
    } else {
      const labels: Record<VibeCallTranscriptItem["role"], string> = {
        assistant: "Assistant",
        tool: "Tool",
        return: "Return",
        error: "Error",
        thinking: "Reasoning",
        status: "Status",
      };
      for (const item of this.record.transcript) {
        lines.push(th.fg("accent", labels[item.role]));
        for (const line of item.text.split("\n")) {
          lines.push(...wrapTextWithAnsi(`  ${line}`, width));
        }
        lines.push("");
      }
      if (lines.at(-1) === "") {
        lines.pop();
      }
    }

    if (this.record.result !== undefined) {
      lines.push("", `${th.fg("muted", "result")} ${truncateEnd(this.record.result, EXPANDED_VALUE_MAX_LENGTH)}`);
    } else if (this.record.error !== undefined) {
      lines.push("", `${th.fg("muted", "error")} ${truncateEnd(this.record.error, EXPANDED_VALUE_MAX_LENGTH)}`);
    }

    return lines;
  }
}
