// The two-pane run inspector. Left: the trace tree (click a node to focus it).
// Right: the live transcript — the user prompt, the assistant's reasoning and
// prose, and every tool call with its args + result — scrollable, sticky to the
// newest line. Selecting a trace node filters the transcript to that subtree.

import process from "node:process";
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
import { fmtCost, fmtDuration, fmtTokens } from "../format.js";
import { copyToClipboard } from "./clipboard.js";
import { runControlAction } from "./keys.js";
import { MacScrollAccel } from "./scroll.js";
import type { TuiStore } from "./store.js";
import { tidy } from "./text.js";
import type { Palette, ThemeMode } from "./theme.js";
import { paletteFor } from "./theme.js";
import { flattenTree, subtreeSpans, type TreeRow } from "./tree.js";

const CLOCK_TICK_MS = 250;
const COPIED_NOTICE_MS = 1500;
const TRACE_PANE_MIN_WIDTH = 26;
const TRACE_PANE_WIDTH_FRACTION = 0.4;
const TRACE_LABEL_MIN_WIDTH = 8;
const TRACE_ROW_RESERVED_CELLS = 7;
const ENTRY_BODY_MAX_CHARS = 4000;

interface AppProps {
  readonly store: TuiStore;
  /** Initial light/dark mode (OSC-detected by the entry); kept live thereafter. */
  readonly initialMode: ThemeMode;
  /** Show the per-turn system prompt in the transcript (toggle with `s`). */
  readonly showSystem: boolean;
  /** Show the full user message — incl. the instructions microfoom appends to user
   *  prompts — rather than just the authored prompt (toggle with `m`). */
  readonly showNotices: boolean;
  /** Re-run the program (bound to `r`, only when the run has settled). */
  readonly onRerun: () => void;
  /** Abort the in-flight run (bound to Ctrl+R, only while running). */
  readonly onAbort: () => void;
}

// Strip the delimited runtime notes microfoom appends to a user prompt — runtime
// instruction (microfoom:begin/end), not the dev's task input — so the prompt
// reads as authored.
const NOTICE_RE = /\n*<!-- microfoom:begin -->[\s\S]*?<!-- microfoom:end -->\n*/g;
function stripNotices(text: string): string {
  return text.replace(NOTICE_RE, "\n").trim();
}

const KIND_COLOR = (pal: Palette, kind: TreeRow["kind"]): string => {
  const byKind: Record<TreeRow["kind"], string> = {
    program: pal.program,
    method: pal.method,
    turn: pal.turn,
    scope: pal.scope,
  };
  return byKind[kind];
};

function ellipsize(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The span to select when moving `delta` rows from the current selection; wraps
 *  from no-selection to the first (down) or last (up) row. */
function selectRelative(
  rows: readonly TreeRow[],
  selected: string | undefined,
  delta: number,
): string | undefined {
  const index = rows.findIndex((r) => r.span === selected);
  const wrapStart = delta > 0 ? 0 : rows.length - 1;
  const next = index < 0 ? wrapStart : index + delta;
  return rows[Math.max(0, Math.min(rows.length - 1, next))]?.span;
}

/** The App state a key binding can act on (passed to {@link handleKey}). */
interface KeyActions {
  readonly renderer: ReturnType<typeof useRenderer>;
  readonly rows: readonly TreeRow[];
  readonly selected: string | undefined;
  readonly setSelected: (span: string | undefined) => void;
  readonly setShowSystem: (update: (v: boolean) => boolean) => void;
  readonly setShowNotices: (update: (v: boolean) => boolean) => void;
  readonly onRerun: () => void;
  readonly onAbort: () => void;
  /** Whether the run is currently in flight — gates abort (running) vs rerun (settled). */
  readonly running: boolean;
}

/** Move the selection on an arrow / vim-nav key; ignores anything else. */
function handleNavKey(name: string | undefined, a: KeyActions): void {
  if (name === "up" || name === "k" || name === "down" || name === "j") {
    const span = selectRelative(a.rows, a.selected, name === "up" || name === "k" ? -1 : 1);
    if (span !== undefined) {
      a.setSelected(span);
    }
  }
}

/** Key bindings: quit, abort (Ctrl+R, running), rerun (`r`, settled), clear
 *  selection, toggle system/notices, navigate. */
function handleKey(key: { readonly name?: string; readonly ctrl?: boolean }, a: KeyActions): void {
  const { name } = key;
  const control = runControlAction(key, a.running);
  if (name === "q" || (key.ctrl === true && name === "c")) {
    a.renderer.destroy();
    process.exit(0);
  } else if (control === "abort") {
    a.onAbort();
  } else if (control === "rerun") {
    a.onRerun();
  } else if (name === "a" || name === "escape") {
    a.setSelected(undefined);
  } else if (name === "s") {
    a.setShowSystem((v) => !v);
  } else if (name === "m") {
    a.setShowNotices((v) => !v);
  } else {
    handleNavKey(name, a);
  }
}

/** The header status dot color + label for the run's current status. */
function statusStyle(status: string, palette: Palette): { color: string; text: string } {
  if (status === "error") {
    return { color: palette.error, text: "● error" };
  }
  if (status === "aborted") {
    return { color: palette.scope, text: "● aborted" };
  }
  if (status === "done") {
    return { color: palette.ok, text: "● done" };
  }
  return { color: palette.accent, text: "● running" };
}

/** Stamp the first time each span is seen, so an open span can report live elapsed. */
function stampFirstSeen(
  rows: readonly TreeRow[],
  firstSeen: Map<string, number>,
  now: number,
): void {
  for (const row of rows) {
    if (!firstSeen.has(row.span)) {
      firstSeen.set(row.span, now);
    }
  }
}

/** The contextual header clock. With a span selected, reflect THAT span (its exact
 *  duration once settled, or a live tick while open). With nothing selected, fall
 *  back to whole-run elapsed while running, and hide when done. */
function computeClock(args: {
  selected: string | undefined;
  tree: RunNode;
  now: number;
  firstSeen: Map<string, number>;
  startedAt: number;
  status: string;
}): { text: string; span: boolean } | undefined {
  const { selected, tree, now, firstSeen, startedAt, status } = args;
  if (selected !== undefined) {
    const node = findNode(tree, selected);
    if (node !== undefined) {
      const ms =
        node.settled && node.durationMs !== undefined
          ? node.durationMs
          : now - (firstSeen.get(selected) ?? startedAt);
      return { text: fmtDuration(ms), span: true };
    }
  }
  if (status === "running") {
    return { text: fmtDuration(now - startedAt), span: false };
  }
  return;
}

/** Track the terminal's light/dark mode live and keep the renderer background in
 *  sync. The entry seeds the mode from an OSC query (what makes VS Code's light
 *  terminal show a white panel); we then follow `theme_mode` events. */
function useLiveThemeMode(
  initialMode: ThemeMode,
  renderer: ReturnType<typeof useRenderer>,
): Palette {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const palette = paletteFor(mode);
  useEffect(() => {
    const sync = (): void => {
      const detected = renderer.themeMode;
      if (detected !== null) {
        setMode(detected);
      }
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
  return palette;
}

/** Header-clock state: a mount baseline (a re-run respawns the process → fresh
 *  baseline), a ~4×/s tick while running, and a per-span first-seen map so an open
 *  span can show live elapsed the metrics column can't (it has no duration yet). */
function useElapsedClock(running: boolean): {
  startedAt: number;
  now: number;
  firstSeen: Map<string, number>;
} {
  const startedAt = useMemo(() => Date.now(), []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [running]);
  const firstSeen = useRef<Map<string, number>>(new Map());
  return { startedAt, now, firstSeen: firstSeen.current };
}

/** Drag-to-select copies to the clipboard (OSC 52): the app owns the mouse, so
 *  native selection + Cmd/Ctrl-C can't reach it. Reports the copied size briefly. */
function useClipboardCopy(): number | undefined {
  const [copied, setCopied] = useState<number | undefined>(undefined);
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (copyToClipboard(text)) {
      setCopied(text.length);
    }
  });
  useEffect(() => {
    if (copied === undefined) {
      return;
    }
    const handle = setTimeout(() => setCopied(undefined), COPIED_NOTICE_MS);
    return () => clearTimeout(handle);
  }, [copied]);
  return copied;
}

/** All derived view state for one render: the run tree, the (focus-filtered)
 *  transcript, the contextual clock, and the header status. */
function useRunView(args: {
  store: TuiStore;
  renderer: ReturnType<typeof useRenderer>;
  initialMode: ThemeMode;
  selected: string | undefined;
  showSystem: boolean;
}): {
  snapshot: ReturnType<TuiStore["getSnapshot"]>;
  width: number;
  height: number;
  palette: Palette;
  transcriptAccel: MacScrollAccel;
  traceAccel: MacScrollAccel;
  tree: RunNode;
  rows: readonly TreeRow[];
  shown: readonly TranscriptEntry[];
  focused: boolean;
  traceWidth: number;
  statusColor: string;
  statusText: string;
  clock: { text: string; span: boolean } | undefined;
  file: string;
  copied: number | undefined;
} {
  const { store, renderer, initialMode, selected, showSystem } = args;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { width, height } = useTerminalDimensions();
  const palette = useLiveThemeMode(initialMode, renderer);
  const { startedAt, now, firstSeen } = useElapsedClock(snapshot.status === "running");
  const copied = useClipboardCopy();

  // One accel instance per pane, persisted across renders so streaks accumulate.
  const transcriptAccel = useMemo(() => new MacScrollAccel(), []);
  const traceAccel = useMemo(() => new MacScrollAccel({ base: 1, max: 8 }), []);

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
    if (!showSystem) {
      list = list.filter((e) => e.kind !== "system");
    }
    return list;
  }, [transcript, focusSpans, showSystem]);

  const traceWidth = Math.max(TRACE_PANE_MIN_WIDTH, Math.floor(width * TRACE_PANE_WIDTH_FRACTION));
  const { color: statusColor, text: statusText } = statusStyle(snapshot.status, palette);
  stampFirstSeen(rows, firstSeen, now);
  const clock = computeClock({
    selected,
    tree,
    now,
    firstSeen,
    startedAt,
    status: snapshot.status,
  });
  const file = snapshot.meta?.file.split("/").pop() ?? "—";

  return {
    snapshot,
    width,
    height,
    palette,
    transcriptAccel,
    traceAccel,
    tree,
    rows,
    shown,
    focused: focusSpans !== undefined,
    traceWidth,
    statusColor,
    statusText,
    clock,
    file,
    copied,
  };
}

interface HeaderProps {
  readonly palette: Palette;
  readonly file: string;
  readonly harness: string;
  readonly model: string;
  readonly clock: { text: string; span: boolean } | undefined;
  readonly statusColor: string;
  readonly statusText: string;
}

function AppHeader(props: HeaderProps): React.ReactNode {
  const { palette, file, harness, model, clock, statusColor, statusText } = props;
  return (
    <box
      height={1}
      flexDirection="row"
      backgroundColor={palette.panelBg}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={palette.accent}>microfoom</text>
      <text fg={palette.dim}>{`  ${file}  ·  ${harness}  ·  ${model}`}</text>
      <box flexGrow={1} />
      {clock === undefined ? null : (
        <text fg={clock.span ? palette.accent : palette.dim}>{`${clock.text}  `}</text>
      )}
      <text fg={statusColor}>{statusText}</text>
    </box>
  );
}

interface TracePaneProps {
  readonly palette: Palette;
  readonly rows: readonly TreeRow[];
  readonly traceWidth: number;
  readonly traceAccel: MacScrollAccel;
  readonly selected: string | undefined;
  readonly onSelect: (span: string | undefined) => void;
}

function TracePane(props: TracePaneProps): React.ReactNode {
  const { palette, rows, traceWidth, traceAccel, selected, onSelect } = props;
  return (
    <scrollbox
      width={traceWidth}
      scrollY={true}
      scrollAcceleration={traceAccel}
      backgroundColor={palette.panelBg}
      border={true}
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
          onSelect={() => onSelect(row.span)}
        />
      ))}
    </scrollbox>
  );
}

interface TranscriptPaneProps {
  readonly palette: Palette;
  readonly shown: readonly TranscriptEntry[];
  readonly error: string | undefined;
  readonly status: "running" | "done" | "error" | "aborted";
  readonly selected: string | undefined;
  readonly focused: boolean;
  readonly transcriptAccel: MacScrollAccel;
  readonly showNotices: boolean;
  /** Whatever the program wrote to stdout/stderr, captured (not span-scoped). */
  readonly programOutput: string;
}

function TranscriptPane(props: TranscriptPaneProps): React.ReactNode {
  const { palette, shown, error, status, selected, focused, transcriptAccel, showNotices } = props;
  const programOutput = tidy(props.programOutput);
  return (
    <scrollbox
      flexGrow={1}
      scrollY={true}
      scrollAcceleration={transcriptAccel}
      stickyScroll={true}
      stickyStart="bottom"
      backgroundColor={palette.bg}
      border={true}
      borderColor={palette.border}
      title={focused ? ` TRANSCRIPT · ${selected} ` : " TRANSCRIPT (all) "}
      titleColor={palette.dim}
    >
      {shown.length === 0 && error === undefined ? (
        <box flexDirection="column" alignItems="center" paddingTop={2}>
          <text fg={palette.dim}>{emptyMessage(status, selected)}</text>
        </box>
      ) : (
        shown.map((entry, i) => (
          <EntryView key={i} entry={entry} palette={palette} showNotices={showNotices} />
        ))
      )}
      {/* Program stdout/stderr, captured so it renders here instead of bleeding
          onto the screen. Not span-scoped, so it shows regardless of focus. */}
      {programOutput.length === 0 ? null : (
        <box flexDirection="column" paddingTop={1} paddingLeft={1} paddingRight={1}>
          <text fg={palette.dim}>▣ stdout</text>
          <text fg={palette.dim} wrapMode="word">
            {programOutput}
          </text>
        </box>
      )}
      {/* Surface a run failure (bad input schema, thrown program, …) in the pane
          itself — the header alone only flips to "● error". Last child so it stays
          visible under the transcript's sticky-bottom scroll. */}
      {error === undefined ? null : (
        <box flexDirection="column" paddingTop={1} paddingLeft={1} paddingRight={1}>
          <text fg={palette.error}>✦ error</text>
          <text fg={palette.error}>{error}</text>
        </box>
      )}
    </scrollbox>
  );
}

interface FooterProps {
  readonly palette: Palette;
  readonly showSystem: boolean;
  readonly showNotices: boolean;
  readonly copied: number | undefined;
  readonly tree: ReturnType<typeof buildRunTree>;
  readonly running: boolean;
}

function AppFooter(props: FooterProps): React.ReactNode {
  const { palette, showSystem, showNotices, copied, tree, running } = props;
  return (
    <box
      height={1}
      flexDirection="row"
      backgroundColor={palette.panelBg}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={palette.dim}>
        {running ? <span fg={palette.scope}>^R abort</span> : "r rerun"} ·{" "}
        <span fg={showSystem ? palette.accent : palette.dim}>s sys prompt</span> ·{" "}
        <span fg={showNotices ? palette.accent : palette.dim}>m full user msg</span> · drag copy ·
        ↑↓ select · a all · q quit
      </text>
      <box flexGrow={1} />
      {copied === undefined ? null : <text fg={palette.ok}>{`✓ copied ${copied} chars  `}</text>}
      <text fg={palette.dim}>{footerStats(tree)}</text>
    </box>
  );
}

function App({
  store,
  initialMode,
  showSystem: showSystemInit,
  showNotices: showNoticesInit,
  onRerun,
  onAbort,
}: AppProps): React.ReactNode {
  const renderer = useRenderer();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [showSystem, setShowSystem] = useState(showSystemInit);
  const [showNotices, setShowNotices] = useState(showNoticesInit);
  const v = useRunView({ store, renderer, initialMode, selected, showSystem });
  const running = v.snapshot.status === "running";

  useKeyboard((key) =>
    handleKey(key, {
      renderer,
      rows: v.rows,
      selected,
      setSelected,
      setShowSystem,
      setShowNotices,
      onRerun,
      onAbort,
      running,
    }),
  );

  return (
    <box width={v.width} height={v.height} backgroundColor={v.palette.bg} flexDirection="column">
      <AppHeader
        palette={v.palette}
        file={v.file}
        harness={v.snapshot.meta?.harness ?? ""}
        model={v.snapshot.meta?.model ?? ""}
        clock={v.clock}
        statusColor={v.statusColor}
        statusText={v.statusText}
      />
      <box flexGrow={1} flexDirection="row">
        <TracePane
          palette={v.palette}
          rows={v.rows}
          traceWidth={v.traceWidth}
          traceAccel={v.traceAccel}
          selected={selected}
          onSelect={setSelected}
        />
        <TranscriptPane
          palette={v.palette}
          shown={v.shown}
          error={v.snapshot.error}
          status={v.snapshot.status}
          selected={selected}
          focused={v.focused}
          transcriptAccel={v.transcriptAccel}
          showNotices={showNotices}
          programOutput={v.snapshot.stdout}
        />
      </box>
      <AppFooter
        palette={v.palette}
        showSystem={showSystem}
        showNotices={showNotices}
        copied={v.copied}
        tree={v.tree}
        running={running}
      />
    </box>
  );
}

/** Find a span node by id in the run tree (depth-first). */
function findNode(node: RunNode, span: string): RunNode | undefined {
  if (node.span === span) {
    return node;
  }
  for (const child of node.children) {
    const hit = findNode(child, span);
    if (hit !== undefined) {
      return hit;
    }
  }
  return;
}

function emptyMessage(
  status: "running" | "done" | "error" | "aborted",
  selected: string | undefined,
): string {
  if (selected !== undefined) {
    return `no transcript for ${selected} (e.g. a pure method or scope)`;
  }
  return status === "running" ? "waiting for the run…" : "no transcript";
}

function footerStats(tree: ReturnType<typeof buildRunTree>): string {
  const u = tree.usage;
  const parts: string[] = [fmtTokens(u.totalTokens)];
  if (u.costUsd !== undefined && u.costUsd > 0) {
    parts.push(fmtCost(u.costUsd));
  }
  if (tree.durationMs !== undefined) {
    parts.push(fmtDuration(tree.durationMs));
  }
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
  const labelMax = Math.max(
    TRACE_LABEL_MIN_WIDTH,
    width - TRACE_ROW_RESERVED_CELLS - row.metrics.length,
  );
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
        body: tidy(entry.text),
        bodyColor: pal.fg,
      };
    case "thinking":
      return {
        header: "✻ thinking",
        headerColor: pal.thinking,
        body: tidy(entry.text),
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
        body: ellipsizeBlock(tidy(entry.content), ENTRY_BODY_MAX_CHARS),
        bodyColor: entry.isError ? pal.error : pal.fg,
      };
  }
}

function prettyArgs(args: unknown): string {
  try {
    // The catch is the fallback: if JSON.stringify yields undefined (functions,
    // symbols), ellipsizeBlock throws and we stringify directly below.
    return ellipsizeBlock(JSON.stringify(args, null, 2), ENTRY_BODY_MAX_CHARS);
  } catch {
    return String(args);
  }
}

function ellipsizeBlock(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

export { App };
