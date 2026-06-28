// The two-pane run inspector. Left: the trace tree (click a node to focus it).
// Right: the live transcript — the user prompt, the assistant's reasoning and
// prose, and every tool call with its args + result — scrollable, sticky to the
// newest line. Selecting a trace node filters the transcript to that subtree.

import {
  buildRunTree,
  buildTranscript,
  type RunNode,
  type TranscriptEntry,
} from "@microfoom/core/trace";
import {
  useKeyboard,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { copyToClipboard } from "./clipboard.js";
import { MacScrollAccel } from "./scroll.js";
import type { TuiStore } from "./store.js";
import type { Palette, ThemeMode } from "./theme.js";
import { paletteFor } from "./theme.js";
import { flattenTree, subtreeSpans, type TreeRow } from "./tree.js";

export interface AppProps {
  readonly store: TuiStore;
  /** Initial light/dark mode (OSC-detected by the entry); kept live thereafter. */
  readonly initialMode: ThemeMode;
  /** Show the per-turn system prompt in the transcript (toggle with `s`). */
  readonly showSystem: boolean;
  /** Show the full user message — incl. the instructions microfoom appends to user
   *  prompts — rather than just the authored prompt (toggle with `m`). */
  readonly showNotices: boolean;
  /** Re-run the program (bound to `r`). */
  readonly onRerun: () => void;
}

// Strip the delimited runtime notes microfoom appends to a user prompt — runtime
// instruction (microfoom:begin/end), not the dev's task input — so the prompt
// reads as authored.
const NOTICE_RE = /\n*<!-- microfoom:begin -->[\s\S]*?<!-- microfoom:end -->\n*/g;
function stripNotices(text: string): string {
  return text.replace(NOTICE_RE, "\n").trim();
}

const KIND_COLOR = (pal: Palette, kind: TreeRow["kind"]): string =>
  kind === "program"
    ? pal.program
    : kind === "method"
      ? pal.method
      : kind === "turn"
        ? pal.turn
        : pal.scope;

function ellipsize(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function App({
  store,
  initialMode,
  showSystem: showSystemInit,
  showNotices: showNoticesInit,
  onRerun,
}: AppProps): React.ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [showSystem, setShowSystem] = useState(showSystemInit);
  const [showNotices, setShowNotices] = useState(showNoticesInit);

  // Track the terminal's light/dark mode live (the entry seeds it from an OSC
  // query, which is what makes VS Code's light terminal show a white panel).
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const palette = paletteFor(mode);

  // Header clock. The stream carries no timestamps, so we baseline on mount (a
  // re-run respawns the process → fresh baseline) and tick ~4×/s while running.
  // We also stamp each span's first-seen wall-clock so an in-flight (open) span can
  // show a live elapsed the metrics column can't — it has no duration until it ends.
  const startedAt = useMemo(() => Date.now(), []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snapshot.status !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [snapshot.status]);
  const firstSeen = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const sync = (): void => {
      const detected = renderer.themeMode;
      if (detected !== null && detected !== undefined) setMode(detected);
    };
    sync();
    renderer.on("theme_mode", sync);
    return () => {
      renderer.off("theme_mode", sync);
    };
  }, [renderer]);
  useEffect(() => {
    renderer.setBackgroundColor(palette.bg);
  }, [renderer, palette.bg]);

  // One accel instance per pane, persisted across renders so streaks accumulate.
  const transcriptAccel = useMemo(() => new MacScrollAccel(), []);
  const traceAccel = useMemo(() => new MacScrollAccel({ base: 1, max: 8 }), []);

  // Drag-to-select copies to the clipboard (OSC 52): the app owns the mouse, so
  // native selection + Cmd/Ctrl-C can't reach it. Show a brief confirmation.
  const [copied, setCopied] = useState<number | undefined>(undefined);
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (copyToClipboard(text)) setCopied(text.length);
  });
  useEffect(() => {
    if (copied === undefined) return;
    const handle = setTimeout(() => setCopied(undefined), 1500);
    return () => clearTimeout(handle);
  }, [copied]);

  const tree = useMemo(() => buildRunTree(snapshot.events), [snapshot.events]);
  const rows = useMemo(() => flattenTree(tree), [tree]);
  const transcript = useMemo(() => buildTranscript(snapshot.events), [snapshot.events]);
  const focusSpans = useMemo(
    () => (selected === undefined ? undefined : subtreeSpans(tree, selected)),
    [tree, selected],
  );
  const shown = useMemo(() => {
    let list =
      focusSpans === undefined ? transcript : transcript.filter((e) => focusSpans.has(e.span));
    if (!showSystem) list = list.filter((e) => e.kind !== "system");
    return list;
  }, [transcript, focusSpans, showSystem]);

  useKeyboard((key) => {
    const name = key.name;
    if (name === "q" || (key.ctrl && name === "c")) {
      renderer.destroy();
      process.exit(0);
    } else if (name === "a" || name === "escape") {
      setSelected(undefined);
    } else if (name === "r") {
      onRerun();
    } else if (name === "s") {
      setShowSystem((v) => !v);
    } else if (name === "m") {
      setShowNotices((v) => !v);
    } else if (name === "up" || name === "k" || name === "down" || name === "j") {
      const delta = name === "up" || name === "k" ? -1 : 1;
      const index = rows.findIndex((r) => r.span === selected);
      const next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : index + delta;
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (row !== undefined) setSelected(row.span);
    }
  });

  const traceWidth = Math.max(26, Math.floor(width * 0.4));
  const statusColor =
    snapshot.status === "error"
      ? palette.error
      : snapshot.status === "done"
        ? palette.ok
        : palette.accent;
  const statusText =
    snapshot.status === "error" ? "● error" : snapshot.status === "done" ? "● done" : "● running";
  // Stamp the first time we see each span so an open span can report live elapsed.
  for (const row of rows) if (!firstSeen.current.has(row.span)) firstSeen.current.set(row.span, now);

  // Contextual clock. With a span selected, the header reflects THAT span: its exact
  // duration once settled, or a live tick while it's still open. With nothing
  // selected, it falls back to whole-run elapsed while running, and hides when done
  // (the footer + main row already carry the final total — no need to duplicate).
  const clock = ((): { text: string; span: boolean } | undefined => {
    if (selected !== undefined) {
      const node = findNode(tree, selected);
      if (node !== undefined) {
        const ms =
          node.settled && node.durationMs !== undefined
            ? node.durationMs
            : now - (firstSeen.current.get(selected) ?? startedAt);
        return { text: fmtSpan(ms), span: true };
      }
    }
    if (snapshot.status === "running") return { text: fmtClock(now - startedAt), span: false };
    return undefined;
  })();
  const file = snapshot.meta?.file.split("/").pop() ?? "—";

  return (
    <box width={width} height={height} backgroundColor={palette.bg} flexDirection="column">
      {/* Header */}
      <box
        height={1}
        flexDirection="row"
        backgroundColor={palette.panelBg}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={palette.accent}>microfoom</text>
        <text fg={palette.dim}>
          {`  ${file}  ·  ${snapshot.meta?.harness ?? ""}  ·  ${snapshot.meta?.model ?? ""}`}
        </text>
        <box flexGrow={1} />
        {clock !== undefined ? (
          <text fg={clock.span ? palette.accent : palette.dim}>{`${clock.text}  `}</text>
        ) : null}
        <text fg={statusColor}>{statusText}</text>
      </box>

      {/* Body: trace | transcript */}
      <box flexGrow={1} flexDirection="row">
        <scrollbox
          width={traceWidth}
          scrollY
          scrollAcceleration={traceAccel}
          backgroundColor={palette.panelBg}
          border
          borderColor={palette.border}
          title=" TRACE "
          titleColor={palette.dim}
        >
          {rows.map((row) => (
            <TraceRowView
              key={row.span}
              row={row}
              palette={palette}
              width={traceWidth}
              selected={row.span === selected}
              onSelect={() => setSelected(row.span)}
            />
          ))}
        </scrollbox>

        <scrollbox
          flexGrow={1}
          scrollY
          scrollAcceleration={transcriptAccel}
          stickyScroll
          stickyStart="bottom"
          backgroundColor={palette.bg}
          border
          borderColor={palette.border}
          title={focusSpans === undefined ? " TRANSCRIPT " : ` TRANSCRIPT · ${selected} `}
          titleColor={palette.dim}
        >
          {shown.length === 0 ? (
            <box flexDirection="column" alignItems="center" paddingTop={2}>
              <text fg={palette.dim}>{emptyMessage(snapshot.status, selected)}</text>
            </box>
          ) : (
            shown.map((entry, i) => (
              <EntryView key={i} entry={entry} palette={palette} showNotices={showNotices} />
            ))
          )}
        </scrollbox>
      </box>

      {/* Footer */}
      <box
        height={1}
        flexDirection="row"
        backgroundColor={palette.panelBg}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={palette.dim}>
          r rerun · <span fg={showSystem ? palette.accent : palette.dim}>s sys prompt</span> ·{" "}
          <span fg={showNotices ? palette.accent : palette.dim}>m full user msg</span> · drag copy ·
          ↑↓ select · a all · q quit
        </text>
        <box flexGrow={1} />
        {copied !== undefined ? <text fg={palette.ok}>{`✓ copied ${copied} chars  `}</text> : null}
        <text fg={palette.dim}>{footerStats(tree)}</text>
      </box>
    </box>
  );
}

/** Find a span node by id in the run tree (depth-first). */
function findNode(node: RunNode, span: string): RunNode | undefined {
  if (node.span === span) return node;
  for (const child of node.children) {
    const hit = findNode(child, span);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Span duration in the trace column's style (`820ms` / `2.3s`), so the header
 *  reading matches the selected row's metric. */
function fmtSpan(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `m:ss` (or `h:mm:ss` past an hour) for the whole-run live header clock. */
function fmtClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const sec = String(total % 60).padStart(2, "0");
  const min = Math.floor(total / 60);
  if (min >= 60) return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}:${sec}`;
  return `${min}:${sec}`;
}

function emptyMessage(status: "running" | "done" | "error", selected: string | undefined): string {
  if (selected !== undefined) return `no transcript for ${selected} (e.g. a pure method or scope)`;
  return status === "running" ? "waiting for the run…" : "no transcript";
}

function footerStats(tree: ReturnType<typeof buildRunTree>): string {
  const u = tree.usage;
  const parts: string[] = [`${u.totalTokens}tok`];
  if (u.costUsd !== undefined && u.costUsd > 0) parts.push(`$${u.costUsd.toFixed(4)}`);
  if (tree.durationMs !== undefined)
    parts.push(
      tree.durationMs < 1000 ? `${tree.durationMs}ms` : `${(tree.durationMs / 1000).toFixed(1)}s`,
    );
  return parts.join("  ");
}

interface TraceRowProps {
  readonly row: TreeRow;
  readonly palette: Palette;
  /** Pane width, so the label budget tracks the pane instead of a fixed cap. */
  readonly width: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function TraceRowView({ row, palette, width, selected, onSelect }: TraceRowProps): React.ReactNode {
  const indent = "  ".repeat(row.depth);
  const label = `${indent}${row.glyph} ${row.name}${row.settled ? "" : " …"}`;
  // Reserve cells for: both borders (2), horizontal padding (2), the selection
  // marker (2), a one-cell gap, and the metrics tail. The rest is the label budget.
  const labelMax = Math.max(8, width - 7 - row.metrics.length);
  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={selected ? palette.selBg : palette.panelBg}
      onMouseDown={onSelect}
    >
      {/* A bar marker so the focused row reads even with no background color. */}
      <text fg={palette.accent}>{selected ? "▌ " : "  "}</text>
      <text fg={KIND_COLOR(palette, row.kind)}>{ellipsize(label, labelMax)}</text>
      <box flexGrow={1} />
      <text fg={palette.dim}>{row.metrics}</text>
    </box>
  );
}

interface EntryProps {
  readonly entry: TranscriptEntry;
  readonly palette: Palette;
  readonly showNotices: boolean;
}

function EntryView({ entry, palette, showNotices }: EntryProps): React.ReactNode {
  const { header, headerColor, body, bodyColor } = describe(entry, palette);
  // Strip the runtime notes microfoom appends to USER prompts unless shown. The
  // system block is never stripped — it IS the full prompt the model received.
  const shownBody = entry.kind === "user" && !showNotices ? stripNotices(body) : body;
  // User prompts get a subtle fill so they read as turn separators in the stream.
  const isUser = entry.kind === "user";
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      {...(isUser ? { backgroundColor: palette.userBg } : {})}
    >
      <text fg={headerColor} {...(isUser ? { bg: palette.userBg } : {})}>
        {header}
      </text>
      <text fg={bodyColor} wrapMode="word" {...(isUser ? { bg: palette.userBg } : {})}>
        {shownBody}
      </text>
    </box>
  );
}

function describe(
  entry: TranscriptEntry,
  pal: Palette,
): { header: string; headerColor: string; body: string; bodyColor: string } {
  switch (entry.kind) {
    case "system":
      return { header: "✦ system", headerColor: pal.scope, body: entry.text, bodyColor: pal.dim };
    case "user":
      return { header: "▸ user", headerColor: pal.user, body: entry.text, bodyColor: pal.fg };
    case "assistant":
      return {
        header: "● assistant",
        headerColor: pal.accent,
        body: entry.text,
        bodyColor: pal.fg,
      };
    case "thinking":
      return {
        header: "✻ thinking",
        headerColor: pal.thinking,
        body: entry.text,
        bodyColor: pal.dim,
      };
    case "tool_call":
      return {
        header: `⚙ ${entry.name}`,
        headerColor: pal.tool,
        body: prettyArgs(entry.args),
        bodyColor: pal.fg,
      };
    case "tool_result":
      return {
        header: entry.isError ? "✗ tool error" : "✓ tool result",
        headerColor: entry.isError ? pal.error : pal.ok,
        body: ellipsizeBlock(entry.content, 4000),
        bodyColor: entry.isError ? pal.error : pal.fg,
      };
  }
}

function prettyArgs(args: unknown): string {
  try {
    return ellipsizeBlock(JSON.stringify(args, null, 2) ?? String(args), 4000);
  } catch {
    return String(args);
  }
}

function ellipsizeBlock(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}
