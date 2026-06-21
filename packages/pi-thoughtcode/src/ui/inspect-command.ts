import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { INSPECT_VIEWPORT_HEIGHT_PCT } from "../shared/display.js";
import { getVibeCallRun, listVibeCallRuns } from "../runs/index.js";
import type { VibeCallRunRecord } from "../types.js";
import { ThoughtcodeInspectOverlay } from "./inspect-overlay.js";

function latestVibeCallRun(): VibeCallRunRecord | undefined {
  return listVibeCallRuns().at(-1);
}

function resolveVibeCallRun(runId: string): VibeCallRunRecord | undefined {
  const trimmed = runId.trim();
  if (!trimmed || trimmed === "latest") {
    return latestVibeCallRun();
  }
  return getVibeCallRun(trimmed);
}

export async function inspectThoughtcodeRun(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const run = resolveVibeCallRun(args);
  if (!run) {
    ctx.ui.notify(args.trim() ? `Thoughtcode run not found: ${args.trim()}` : "No Thoughtcode runs yet.", "warning");
    return;
  }

  if (ctx.mode !== "tui") {
    ctx.ui.notify(`Thoughtcode run ${run.id}: ${run.status}. Use TUI mode for the live inspector.`, "info");
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new ThoughtcodeInspectOverlay(tui, run, theme, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        maxHeight: `${INSPECT_VIEWPORT_HEIGHT_PCT}%`,
        minWidth: 60,
      },
    },
  );
}
