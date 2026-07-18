import { basename } from "node:path";
import {
  useKeyboard,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import type { TraceTree, TranscriptEntry } from "@unigent/core/trace";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { formatDuration, formatUsage } from "../format.js";
import { copyToClipboard } from "./clipboard.js";
import { NaturalScrollAcceleration } from "./scroll.js";
import type { TuiSnapshot, TuiStore } from "./store.js";
import { type Palette, paletteFor, type ThemeMode } from "./theme.js";
import {
  diagnosticsForRow,
  environmentLabel,
  flattenTraceTree,
  focusLabel,
  type TreeDiagnostic,
  type TreeRow,
} from "./tree.js";

interface AppProps {
  readonly store: TuiStore;
  readonly initialTheme: ThemeMode;
  readonly onAbort: () => void;
  readonly onRerun: () => void;
  readonly onQuit: () => void;
}

const CLOCK_INTERVAL_MILLISECONDS = 250;
const COPY_NOTICE_MILLISECONDS = 1400;
const MINIMUM_WIDTH = 68;
const MINIMUM_HEIGHT = 12;
const TRACE_WIDTH_RATIO = 0.36;
const TRACE_MINIMUM_WIDTH = 27;
const TRACE_PAGE_SIZE = 250;
const ACTIVITY_ENTRY_LIMIT = 250;
const DIAGNOSTIC_ENTRY_LIMIT = 20;
const TREE_BRANCH_LENGTH = 3;

function statusAppearance(
  status: ReturnType<TuiStore["getSnapshot"]>["status"],
  palette: Palette,
): {
  readonly color: string;
  readonly label: string;
} {
  switch (status) {
    case "running":
      return { color: palette.accent, label: "● running" };
    case "succeeded":
      return { color: palette.success, label: "● complete" };
    case "cancelled":
      return { color: palette.warning, label: "● stopped" };
    case "failed":
      return { color: palette.error, label: "● failed" };
  }
}

function usePalette(initialTheme: ThemeMode): Palette {
  const renderer = useRenderer();
  const [theme, setTheme] = useState(initialTheme);
  const palette = useMemo(() => paletteFor(theme), [theme]);
  useEffect(() => {
    const synchronize = (): void => {
      if (renderer.themeMode !== null) {
        setTheme(renderer.themeMode);
      }
    };
    renderer.on("theme_mode", synchronize);
    return (): void => {
      renderer.off("theme_mode", synchronize);
    };
  }, [renderer]);
  useEffect(() => {
    renderer.setBackgroundColor(palette.background);
  }, [palette.background, renderer]);
  return palette;
}

function useCurrentTime(running: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MILLISECONDS);
    return (): void => clearInterval(timer);
  }, [running]);
  return now;
}

function useCopyNotice(): number | undefined {
  const [copiedCharacters, setCopiedCharacters] = useState<number | undefined>();
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (copyToClipboard(text)) {
      setCopiedCharacters(text.length);
    }
  });
  useEffect(() => {
    if (copiedCharacters === undefined) {
      return;
    }
    const timer = setTimeout(() => setCopiedCharacters(undefined), COPY_NOTICE_MILLISECONDS);
    return (): void => clearTimeout(timer);
  }, [copiedCharacters]);
  return copiedCharacters;
}

function nextSelection(
  rows: readonly TreeRow[],
  selectedSpanId: string | undefined,
  direction: -1 | 1,
): string | undefined {
  const selectableRows = rows.filter((row) => row.selectable);
  if (selectableRows.length === 0) {
    return;
  }
  const selectedIndex = selectableRows.findIndex((row) => row.spanId === selectedSpanId);
  const initialIndex = direction === 1 ? 0 : selectableRows.length - 1;
  const nextIndex = selectedIndex < 0 ? initialIndex : selectedIndex + direction;
  return selectableRows[Math.max(0, Math.min(selectableRows.length - 1, nextIndex))]?.spanId;
}

type KeyboardAction =
  | "quit"
  | "abort"
  | "rerun"
  | "system"
  | "clearFocus"
  | "toggleOutput"
  | "toggleTools"
  | "older"
  | "newer"
  | "up"
  | "down"
  | undefined;

const KEYBOARD_ACTIONS: Readonly<Record<string, KeyboardAction>> = {
  q: "quit",
  s: "system",
  escape: "clearFocus",
  o: "toggleOutput",
  enter: "toggleTools",
  return: "toggleTools",
  "[": "older",
  leftbracket: "older",
  "]": "newer",
  rightbracket: "newer",
  up: "up",
  k: "up",
  down: "down",
  j: "down",
};

function keyboardAction(
  key: { readonly name?: string; readonly ctrl?: boolean },
  running: boolean,
): KeyboardAction {
  if (key.ctrl === true && key.name === "c") {
    return "quit";
  }
  if (key.ctrl === true && key.name === "r") {
    return running ? "abort" : undefined;
  }
  if (key.name === "r") {
    return running ? undefined : "rerun";
  }
  return key.name === undefined ? undefined : KEYBOARD_ACTIONS[key.name];
}

interface KeyboardBindings {
  readonly running: boolean;
  readonly rows: readonly TreeRow[];
  readonly selectedSpanId: string | undefined;
  readonly setSelectedSpanId: (spanId: string | undefined) => void;
  readonly toggleSystemPrompt: () => void;
  readonly toggleOutput: () => void;
  readonly toggleSelectedTools: () => void;
  readonly showOlderTraces: () => void;
  readonly showNewerTraces: () => void;
  readonly onAbort: () => void;
  readonly onRerun: () => void;
  readonly onQuit: () => void;
}

function useAppKeyboard(bindings: KeyboardBindings): void {
  useKeyboard((key) => {
    switch (keyboardAction(key, bindings.running)) {
      case "quit":
        bindings.onQuit();
        break;
      case "abort":
        bindings.onAbort();
        break;
      case "rerun":
        bindings.onRerun();
        break;
      case "system":
        bindings.toggleSystemPrompt();
        break;
      case "clearFocus":
        bindings.setSelectedSpanId(undefined);
        break;
      case "toggleOutput":
        bindings.toggleOutput();
        break;
      case "toggleTools":
        bindings.toggleSelectedTools();
        break;
      case "older":
        bindings.showOlderTraces();
        break;
      case "newer":
        bindings.showNewerTraces();
        break;
      case "up":
        bindings.setSelectedSpanId(nextSelection(bindings.rows, bindings.selectedSpanId, -1));
        break;
      case "down":
        bindings.setSelectedSpanId(nextSelection(bindings.rows, bindings.selectedSpanId, 1));
        break;
      case undefined:
        break;
    }
  });
}

function formatBlock(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text;
}

function rowKindAppearance(row: TreeRow, palette: Palette): { color: string; glyph: string } {
  if (row.kind === "scope") {
    return { color: palette.success, glyph: "▪" };
  }
  if (row.kind === "run") {
    return { color: palette.accent, glyph: "◆" };
  }
  return { color: palette.tool, glyph: "◇" };
}

function nestedSummaryPrefix(prefix: string): string {
  if (prefix.endsWith("├─ ")) {
    return `${prefix.slice(0, -TREE_BRANCH_LENGTH)}│  └─ `;
  }
  if (prefix.endsWith("└─ ")) {
    return `${prefix.slice(0, -TREE_BRANCH_LENGTH)}   └─ `;
  }
  return "└─ ";
}

function TraceRow(props: {
  readonly row: TreeRow;
  readonly selected: boolean;
  readonly palette: Palette;
  readonly onSelect: () => void;
}): React.ReactNode {
  const { row, selected, palette, onSelect } = props;
  const kind = rowKindAppearance(row, palette);
  let outcomeGlyph = "·";
  let outcomeColor = palette.muted;
  if (row.outcome === "running") {
    outcomeGlyph = "◌";
    outcomeColor = palette.accent;
  } else if (row.outcome === "succeeded") {
    outcomeGlyph = "✓";
    outcomeColor = palette.success;
  } else if (row.outcome === "failed") {
    outcomeGlyph = "×";
    outcomeColor = palette.error;
  } else {
    outcomeGlyph = "■";
    outcomeColor = palette.warning;
  }
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={selected ? palette.selected : palette.surface}
      onMouseDown={onSelect}
    >
      <box flexDirection="row">
        <text fg={palette.accent}>{selected ? "▌ " : "  "}</text>
        <text fg={palette.muted}>{row.prefix}</text>
        <text fg={kind.color}>{`${kind.glyph} ${row.name}`}</text>
        <box flexGrow={1} />
        <text fg={palette.muted}>{row.metrics.length > 0 ? `${row.metrics}  ` : ""}</text>
        <text fg={outcomeColor}>{outcomeGlyph}</text>
      </box>
      {row.toolSummary === undefined || row.toolsExpanded ? null : (
        <text fg={palette.muted}>{`  ${nestedSummaryPrefix(row.prefix)}${row.toolSummary}`}</text>
      )}
    </box>
  );
}

function diagnosticColor(diagnostic: TreeDiagnostic, palette: Palette): string {
  switch (diagnostic.kind) {
    case "error":
      return palette.error;
    case "repair":
      return palette.warning;
    case "checkpoint":
      return palette.tool;
    case "annotation":
      return palette.reasoning;
    case "log":
      return palette.success;
  }
}

function SelectionDetails(props: {
  readonly row: TreeRow | undefined;
  readonly palette: Palette;
}): React.ReactNode {
  if (props.row === undefined) {
    return null;
  }
  const { row, palette } = props;
  const diagnostics = diagnosticsForRow(row);
  if (diagnostics.length === 0) {
    return null;
  }
  const hidden = Math.max(0, diagnostics.length - DIAGNOSTIC_ENTRY_LIMIT);
  const visible = diagnostics.slice(-DIAGNOSTIC_ENTRY_LIMIT);
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      marginBottom={1}
      backgroundColor={palette.surface}
    >
      {hidden > 0 ? <text fg={palette.muted}>{`${hidden} older diagnostics hidden`}</text> : null}
      {visible.map(
        (diagnostic, index): React.ReactNode => (
          <box key={`${diagnostic.label}-${index}`} flexDirection="column" paddingTop={1}>
            <text fg={diagnosticColor(diagnostic, palette)}>{diagnostic.label}</text>
            <text fg={palette.foreground} wrapMode="word">
              {formatBlock(diagnostic.value)}
            </text>
          </box>
        ),
      )}
    </box>
  );
}

function Entry(props: {
  readonly entry: TranscriptEntry;
  readonly palette: Palette;
}): React.ReactNode {
  const { entry, palette } = props;
  let header: string;
  let color: string;
  let body: unknown;
  switch (entry.kind) {
    case "system":
      header = "✦ system";
      color = palette.muted;
      body = entry.text;
      break;
    case "user":
      header = "▸ prompt";
      color = palette.success;
      body = entry.text;
      break;
    case "assistant":
      header = "● assistant";
      color = palette.accent;
      body = entry.text;
      break;
    case "reasoning":
      header = "✻ reasoning";
      color = palette.reasoning;
      body = entry.text;
      break;
    case "tool_call":
      header = `⚙ ${entry.name}`;
      color = palette.tool;
      body = entry.input;
      break;
    case "tool_result":
      header = entry.isError ? `× ${entry.name}` : `✓ ${entry.name}`;
      color = entry.isError ? palette.error : palette.success;
      body = entry.output;
      break;
  }
  const userEntry = entry.kind === "user";
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      {...(userEntry ? { backgroundColor: palette.userSurface } : {})}
    >
      <text fg={color}>{header}</text>
      <text fg={entry.kind === "reasoning" ? palette.muted : palette.foreground} wrapMode="word">
        {formatBlock(body)}
      </text>
    </box>
  );
}

function OutputBlock(props: {
  readonly title: string;
  readonly content: string;
  readonly color: string;
}): React.ReactNode {
  if (props.content.trim().length === 0) {
    return null;
  }
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1}>
      <text fg={props.color}>{props.title}</text>
      <text fg={props.color} wrapMode="word">
        {formatBlock(props.content.trimEnd())}
      </text>
    </box>
  );
}

function CompactFallback(props: {
  readonly width: number;
  readonly height: number;
  readonly palette: Palette;
}): React.ReactNode {
  return (
    <box
      width={props.width}
      height={props.height}
      backgroundColor={props.palette.background}
      flexDirection="column"
      padding={1}
    >
      <text fg={props.palette.accent}>unigent</text>
      <text fg={props.palette.foreground}>Terminal too small for the inspector.</text>
      <text
        fg={props.palette.muted}
      >{`Current ${props.width}×${props.height} · need ${MINIMUM_WIDTH}×${MINIMUM_HEIGHT}`}</text>
      <text fg={props.palette.muted}>q quit</text>
    </box>
  );
}

function Header(props: {
  readonly snapshot: TuiSnapshot;
  readonly environment: string;
  readonly duration: number | undefined;
  readonly palette: Palette;
}): React.ReactNode {
  const appearance = statusAppearance(props.snapshot.status, props.palette);
  return (
    <box
      height={1}
      flexDirection="row"
      backgroundColor={props.palette.surface}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <span fg={props.palette.accent}>unigent</span>
        <span fg={props.palette.muted}>{`  ${basename(props.snapshot.sourceFile)}  ·  ${
          props.environment
        }`}</span>
      </text>
      <box flexGrow={1} />
      <text fg={props.palette.muted}>{`${formatDuration(props.duration)}  `}</text>
      <text fg={appearance.color}>{appearance.label}</text>
    </box>
  );
}

function TracePane(props: {
  readonly rows: readonly TreeRow[];
  readonly totalRows: number;
  readonly rangeStart: number;
  readonly width: number;
  readonly running: boolean;
  readonly selectedSpanId: string | undefined;
  readonly palette: Palette;
  readonly scrollAcceleration: NaturalScrollAcceleration;
  readonly onSelect: (spanId: string) => void;
}): React.ReactNode {
  const rangeEnd = props.rangeStart + props.rows.length;
  return (
    <scrollbox
      width={props.width}
      scrollY={true}
      scrollAcceleration={props.scrollAcceleration}
      viewportCulling={true}
      backgroundColor={props.palette.surface}
      border={true}
      borderColor={props.selectedSpanId === undefined ? props.palette.border : props.palette.accent}
      title=" TRACE "
      titleColor={props.palette.muted}
    >
      {props.totalRows <= props.rows.length ? null : (
        <box paddingLeft={1} paddingRight={1} marginBottom={1}>
          <text
            fg={props.palette.muted}
          >{`Showing ${props.rangeStart + 1}–${rangeEnd} of ${props.totalRows} rows · [ older · ] newer`}</text>
        </box>
      )}
      {props.rows.length === 0 ? (
        <box padding={1}>
          <text fg={props.palette.muted}>
            {props.running ? "Waiting for first agent run…" : "No Unigent traces"}
          </text>
        </box>
      ) : (
        props.rows.map(
          (row): React.ReactNode => (
            <TraceRow
              key={row.spanId}
              row={row}
              selected={row.spanId === props.selectedSpanId}
              palette={props.palette}
              onSelect={() => {
                if (row.selectable) {
                  props.onSelect(row.spanId);
                }
              }}
            />
          ),
        )
      )}
    </scrollbox>
  );
}

function ActivityContent(props: {
  readonly transcript: readonly TranscriptEntry[];
  readonly hiddenEntryCount: number;
  readonly running: boolean;
  readonly selectedRow: TreeRow | undefined;
  readonly palette: Palette;
}): React.ReactNode {
  return (
    <box flexDirection="column">
      {props.transcript.length === 0 ? (
        <box paddingTop={2} alignItems="center">
          <text fg={props.palette.muted}>
            {props.running ? "Listening for activity…" : "This selection emitted no activity"}
          </text>
        </box>
      ) : null}
      {props.hiddenEntryCount > 0 ? (
        <box paddingLeft={1} paddingRight={1} marginBottom={1}>
          <text
            fg={props.palette.muted}
          >{`Showing latest ${props.transcript.length} entries · ${props.hiddenEntryCount} older entries retained`}</text>
        </box>
      ) : null}
      {props.transcript.map(
        (entry, index): React.ReactNode => (
          <Entry key={index} entry={entry} palette={props.palette} />
        ),
      )}
      <SelectionDetails row={props.selectedRow} palette={props.palette} />
    </box>
  );
}

function OutputContent(props: {
  readonly snapshot: TuiSnapshot;
  readonly palette: Palette;
}): React.ReactNode {
  const empty =
    props.snapshot.stdout.length === 0 &&
    props.snapshot.stderr.length === 0 &&
    props.snapshot.error === undefined;
  if (empty) {
    return (
      <box paddingTop={2} alignItems="center">
        <text fg={props.palette.muted}>This script emitted no process output</text>
      </box>
    );
  }
  return (
    <box flexDirection="column">
      <OutputBlock
        title="▣ stdout"
        content={props.snapshot.stdout}
        color={props.palette.foreground}
      />
      <OutputBlock title="▣ stderr" content={props.snapshot.stderr} color={props.palette.warning} />
      {props.snapshot.error === undefined ? null : (
        <OutputBlock title="× process" content={props.snapshot.error} color={props.palette.error} />
      )}
    </box>
  );
}

function rightPaneTitle(view: "activity" | "output", selectedLabel: string | undefined): string {
  if (view === "output") {
    return " OUTPUT ";
  }
  return selectedLabel === undefined ? " ACTIVITY " : ` ACTIVITY · ${selectedLabel} `;
}

function ActivityPane(props: {
  readonly snapshot: TuiSnapshot;
  readonly transcript: readonly TranscriptEntry[];
  readonly hiddenEntryCount: number;
  readonly focusLabel: string | undefined;
  readonly selectedRow: TreeRow | undefined;
  readonly view: "activity" | "output";
  readonly palette: Palette;
  readonly scrollAcceleration: NaturalScrollAcceleration;
}): React.ReactNode {
  return (
    <scrollbox
      flexGrow={1}
      scrollY={true}
      scrollAcceleration={props.scrollAcceleration}
      viewportCulling={true}
      stickyScroll={true}
      stickyStart="bottom"
      backgroundColor={props.palette.background}
      border={true}
      borderColor={props.palette.border}
      title={rightPaneTitle(props.view, props.focusLabel)}
      titleColor={props.palette.muted}
    >
      {props.view === "activity" ? (
        <ActivityContent
          transcript={props.transcript}
          hiddenEntryCount={props.hiddenEntryCount}
          running={props.snapshot.status === "running"}
          selectedRow={props.selectedRow}
          palette={props.palette}
        />
      ) : (
        <OutputContent snapshot={props.snapshot} palette={props.palette} />
      )}
    </scrollbox>
  );
}

function Footer(props: {
  readonly running: boolean;
  readonly showSystemPrompt: boolean;
  readonly selectedRow: TreeRow | undefined;
  readonly view: "activity" | "output";
  readonly outputCount: number;
  readonly hasTraceHistory: boolean;
  readonly copiedCharacters: number | undefined;
  readonly tree: TraceTree;
  readonly palette: Palette;
}): React.ReactNode {
  return (
    <box
      height={1}
      flexDirection="row"
      backgroundColor={props.palette.surface}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={props.palette.muted}>
        {props.running ? (
          <span fg={props.palette.warning}>^R stop</span>
        ) : (
          <span fg={props.palette.accent}>r rerun</span>
        )}
        {"  ·  ↑↓ trace"}
        {props.selectedRow === undefined ? null : "  ·  esc show all"}
        {props.selectedRow?.hasTools === true ? (
          <span fg={props.palette.accent}>
            {props.selectedRow.toolsExpanded ? "  ·  enter hide tools" : "  ·  enter show tools"}
          </span>
        ) : null}
        {props.hasTraceHistory ? "  ·  [ ] history" : null}
        {"  ·  "}
        <span fg={props.view === "output" ? props.palette.accent : props.palette.muted}>
          {props.view === "output"
            ? "o activity"
            : `o output${props.outputCount > 0 ? ` (${props.outputCount})` : ""}`}
        </span>
        {props.view === "activity" ? "  ·  " : null}
        {props.view === "activity" ? (
          <span fg={props.showSystemPrompt ? props.palette.accent : props.palette.muted}>
            s sys prompt
          </span>
        ) : null}
        {"  ·  drag copy  ·  q quit"}
      </text>
      <box flexGrow={1} />
      {props.copiedCharacters === undefined ? null : (
        <text fg={props.palette.success}>{`✓ ${props.copiedCharacters} copied  `}</text>
      )}
      <text fg={props.palette.muted}>{formatUsage(props.tree.usage)}</text>
    </box>
  );
}

interface AppView {
  readonly snapshot: TuiSnapshot;
  readonly width: number;
  readonly height: number;
  readonly palette: Palette;
  readonly running: boolean;
  readonly copiedCharacters: number | undefined;
  readonly tree: TraceTree;
  readonly rows: readonly TreeRow[];
  readonly totalRows: number;
  readonly traceRangeStart: number;
  readonly maximumTracePage: number;
  readonly activeTracePage: number;
  readonly selectedRow: TreeRow | undefined;
  readonly environment: string;
  readonly visibleTranscript: readonly TranscriptEntry[];
  readonly hiddenActivityEntries: number;
  readonly duration: number | undefined;
  readonly traceWidth: number;
  readonly traceScrollAcceleration: NaturalScrollAcceleration;
  readonly activityScrollAcceleration: NaturalScrollAcceleration;
  readonly outputCount: number;
}

interface TranscriptView {
  readonly visible: readonly TranscriptEntry[];
  readonly hiddenCount: number;
}

function useTranscriptView(
  snapshot: TuiSnapshot,
  showSystemPrompt: boolean,
  selectedRow: TreeRow | undefined,
): TranscriptView {
  const selectedSpanIds = useMemo(
    () => (selectedRow === undefined ? undefined : new Set(selectedRow.selectedSpanIds)),
    [selectedRow],
  );
  const filtered = useMemo(
    () =>
      snapshot.eventCount === 0
        ? []
        : snapshot.transcript.filter(
            (entry) =>
              (showSystemPrompt || entry.kind !== "system") &&
              (selectedSpanIds === undefined || selectedSpanIds.has(entry.spanId)),
          ),
    [selectedSpanIds, showSystemPrompt, snapshot.eventCount, snapshot.transcript],
  );
  const visible = useMemo(() => filtered.slice(-ACTIVITY_ENTRY_LIMIT), [filtered]);
  return {
    visible,
    hiddenCount: Math.max(0, filtered.length - ACTIVITY_ENTRY_LIMIT),
  };
}

function useAppView(args: {
  readonly store: TuiStore;
  readonly initialTheme: ThemeMode;
  readonly selectedSpanId: string | undefined;
  readonly showSystemPrompt: boolean;
  readonly expandedRunSpanIds: ReadonlySet<string>;
  readonly tracePage: number;
}): AppView {
  const snapshot = useSyncExternalStore(args.store.subscribe, args.store.getSnapshot);
  const { width, height } = useTerminalDimensions();
  const palette = usePalette(args.initialTheme);
  const running = snapshot.status === "running";
  const currentTime = useCurrentTime(running);
  const copiedCharacters = useCopyNotice();
  const { tree } = snapshot;
  const allRows = useMemo(
    () => flattenTraceTree(tree, args.expandedRunSpanIds),
    [args.expandedRunSpanIds, tree],
  );
  const maximumTracePage = Math.max(0, Math.ceil(allRows.length / TRACE_PAGE_SIZE) - 1);
  const activeTracePage = Math.min(args.tracePage, maximumTracePage);
  const traceRangeEnd = Math.max(0, allRows.length - activeTracePage * TRACE_PAGE_SIZE);
  const traceRangeStart = Math.max(0, traceRangeEnd - TRACE_PAGE_SIZE);
  const rows = useMemo(
    () => allRows.slice(traceRangeStart, traceRangeEnd),
    [allRows, traceRangeEnd, traceRangeStart],
  );
  const selectedRow = useMemo(
    () => allRows.find((row) => row.spanId === args.selectedSpanId),
    [allRows, args.selectedSpanId],
  );
  const transcript = useTranscriptView(snapshot, args.showSystemPrompt, selectedRow);
  const environment = useMemo(() => environmentLabel(tree, selectedRow), [selectedRow, tree]);
  return {
    snapshot,
    width,
    height,
    palette,
    running,
    copiedCharacters,
    tree,
    rows,
    totalRows: allRows.length,
    traceRangeStart,
    maximumTracePage,
    activeTracePage,
    selectedRow,
    environment,
    visibleTranscript: transcript.visible,
    hiddenActivityEntries: transcript.hiddenCount,
    duration: running ? currentTime - snapshot.startedAt : tree.durationMs,
    traceWidth: Math.max(TRACE_MINIMUM_WIDTH, Math.floor(width * TRACE_WIDTH_RATIO)),
    traceScrollAcceleration: useMemo(
      () => new NaturalScrollAcceleration({ base: 1, maximum: 8 }),
      [],
    ),
    activityScrollAcceleration: useMemo(() => new NaturalScrollAcceleration(), []),
    outputCount:
      Number(snapshot.stdout.length > 0) +
      Number(snapshot.stderr.length > 0) +
      Number(snapshot.error !== undefined),
  };
}

function toggleExpandedRun(
  selectedRow: TreeRow | undefined,
  setExpandedRunSpanIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
): void {
  if (selectedRow?.hasTools !== true) {
    return;
  }
  setExpandedRunSpanIds((expanded) => {
    const next = new Set(expanded);
    if (next.has(selectedRow.spanId)) {
      next.delete(selectedRow.spanId);
    } else {
      next.add(selectedRow.spanId);
    }
    return next;
  });
}

function AppLayout(props: {
  readonly view: AppView;
  readonly selectedSpanId: string | undefined;
  readonly showSystemPrompt: boolean;
  readonly rightPaneView: "activity" | "output";
  readonly onSelectSpan: (spanId: string) => void;
}): React.ReactNode {
  const { view } = props;
  if (view.width < MINIMUM_WIDTH || view.height < MINIMUM_HEIGHT) {
    return <CompactFallback width={view.width} height={view.height} palette={view.palette} />;
  }
  return (
    <box
      width={view.width}
      height={view.height}
      backgroundColor={view.palette.background}
      flexDirection="column"
    >
      <Header
        snapshot={view.snapshot}
        environment={view.environment}
        duration={view.duration}
        palette={view.palette}
      />
      <box flexGrow={1} flexDirection="row">
        <TracePane
          rows={view.rows}
          totalRows={view.totalRows}
          rangeStart={view.traceRangeStart}
          width={view.traceWidth}
          running={view.running}
          selectedSpanId={props.selectedSpanId}
          palette={view.palette}
          scrollAcceleration={view.traceScrollAcceleration}
          onSelect={props.onSelectSpan}
        />
        <ActivityPane
          snapshot={view.snapshot}
          transcript={view.visibleTranscript}
          hiddenEntryCount={view.hiddenActivityEntries}
          focusLabel={focusLabel(view.selectedRow)}
          selectedRow={view.selectedRow}
          view={props.rightPaneView}
          palette={view.palette}
          scrollAcceleration={view.activityScrollAcceleration}
        />
      </box>
      <Footer
        running={view.running}
        showSystemPrompt={props.showSystemPrompt}
        selectedRow={view.selectedRow}
        view={props.rightPaneView}
        outputCount={view.outputCount}
        hasTraceHistory={view.maximumTracePage > 0}
        copiedCharacters={view.copiedCharacters}
        tree={view.tree}
        palette={view.palette}
      />
    </box>
  );
}

function App(props: AppProps): React.ReactNode {
  const { store, initialTheme, onAbort, onRerun, onQuit } = props;
  const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>();
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [expandedRunSpanIds, setExpandedRunSpanIds] = useState<ReadonlySet<string>>(new Set());
  const [rightPaneView, setRightPaneView] = useState<"activity" | "output">("activity");
  const [tracePage, setTracePage] = useState(0);
  const view = useAppView({
    store,
    initialTheme,
    selectedSpanId,
    showSystemPrompt,
    expandedRunSpanIds,
    tracePage,
  });
  useEffect(() => {
    if (view.snapshot.status === "failed" && view.totalRows === 0 && view.outputCount > 0) {
      setRightPaneView("output");
    }
  }, [view.snapshot.status, view.totalRows, view.outputCount]);
  const rerun = (): void => {
    setSelectedSpanId(undefined);
    setExpandedRunSpanIds(new Set());
    setTracePage(0);
    setRightPaneView("activity");
    onRerun();
  };

  useAppKeyboard({
    running: view.running,
    rows: view.rows,
    selectedSpanId,
    setSelectedSpanId,
    toggleSystemPrompt: () => setShowSystemPrompt((visible) => !visible),
    toggleOutput: () =>
      setRightPaneView((current) => (current === "activity" ? "output" : "activity")),
    toggleSelectedTools: () => toggleExpandedRun(view.selectedRow, setExpandedRunSpanIds),
    showOlderTraces: () => setTracePage(Math.min(view.activeTracePage + 1, view.maximumTracePage)),
    showNewerTraces: () => setTracePage(Math.max(0, view.activeTracePage - 1)),
    onAbort,
    onRerun: rerun,
    onQuit,
  });

  return (
    <AppLayout
      view={view}
      selectedSpanId={selectedSpanId}
      showSystemPrompt={showSystemPrompt}
      rightPaneView={rightPaneView}
      onSelectSpan={setSelectedSpanId}
    />
  );
}

export { App };
