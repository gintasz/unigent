#!/usr/bin/env node
// `microfoom run <file> [input]` — the default way to run a program file. Added
// value over `node --import tsx run.ts`: zero per-program boilerplate, model
// resolved from flags/env, and a live run panel (span tree with cost/latency/
// repairs). Output discipline: the program result goes to STDOUT (clean,
// pipeable, --json for machines); all observability goes to STDERR.
//
// Modes: interactive TTY → live panel by default; piped/redirected → auto-headless
// (no ANSI). Force with --panel / --headless. `--harness fake` runs offline (no model).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createFileTurnStore, type OpenSession, runProgram, type TurnStore } from "@microfoom/core";
import { type AgentEvent, buildRunTree } from "@microfoom/core/trace";
import { modelFromEnv } from "./env.js";
import { fmtSummary } from "./format.js";
import { knownHarnessNames, openHarnessRegistry } from "./harnesses.js";
import { loadProgram } from "./loader.js";
import { attachPanel } from "./panel.js";
import { RERUN_EXIT_CODE } from "./tui/rerun.js";

const HELP = `microfoom — run a microfoom program file

Usage:
  microfoom run <file> [input]        run a program (default the way you run files)
  microfoom <file> [input]            'run' is optional

Options:
  --harness <name>    harness to run on: claudecli | pi | fake (offline stub, no model)
  --omit-harness-prompt   send the model ONLY microfoom's prompt (drop the harness
                      base prompt — pi's coding-agent persona + project context)
  --model <id>        model id (default: $MICROFOOM_MODEL or a deepseek default)
  --thinking <level>  off | minimal | low | medium | high | xhigh
  --tools <a,b>       harness tools to expose (default: all; "" = none; comma-separated
                      names). FOOM protocol tools are always available.
  --skills <a,b>      skills to load for the model (default: all installed; "" = none;
                      by skill name). pi only.
  --plugins <a,b>     plugins/extensions to load (default: all installed; "" = none;
                      by source name). pi only.
  --store <uri>       resume after termination: record completed turns to a store and
                      recall them on a re-run instead of re-calling the model. A path
                      or file:// URI is an on-disk JSONL store (created if missing);
                      run the same command again to resume.
  --input <value>     program input (alternative to the positional)
  --tui               open the interactive two-pane inspector (trace tree + live
                      transcript; mouse + scroll). Runs under bun; stays open when
                      the run finishes — press q to quit, r to re-run (picks up edits).
  --system-prompt     with --tui: show each turn's full system prompt (toggle: s; default off)
  --full-user-msg     with --tui: show the full user message incl. appended instructions (toggle: m; default off)
  --panel             force the live run panel (even when piped)
  --headless          no panel, no ANSI — result only (integrations, CI)
  --json              print the result as JSON to stdout (implies quiet)
  --quiet             suppress the stderr summary footer
  -h, --help          show this help

Output: result → stdout; run panel + summary → stderr.
`;

function parseInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function stringifyResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}

/** Parse a tri-state list flag (--tools/--skills/--plugins): undefined → all (inherit);
 *  "" → none ([]); else comma-separated names. */
function parseList(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) {
    return;
  }
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Build the run-level config defaults from CLI flags (only set fields present).
 *  These become the run's widest config scope, so skills/plugins reach the harness
 *  at session-open (and a program's `@foom.config` can still override). */
function cliDefaults(
  thinking: string | undefined,
  tools: readonly string[] | undefined,
  skills: readonly string[] | undefined,
  plugins: readonly string[] | undefined,
): {
  thinking?: string;
  tools?: readonly string[];
  skills?: readonly string[];
  plugins?: readonly string[];
} {
  return {
    ...(thinking === undefined ? {} : { thinking }),
    ...(tools === undefined ? {} : { tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(plugins === undefined ? {} : { plugins }),
  };
}

/** Assemble the run options, adding optional fields only when set. */
function buildRunOptions(args: {
  harnesses: Record<string, OpenSession>;
  defaultHarness: string | undefined;
  model: string;
  sourceFile: string;
  onEvent: (event: AgentEvent) => void;
  defaults: ReturnType<typeof cliDefaults>;
  store: TurnStore | undefined;
}): Parameters<typeof runProgram>[2] {
  return {
    harnesses: args.harnesses,
    ...(args.defaultHarness === undefined ? {} : { defaultHarness: args.defaultHarness }),
    model: args.model,
    sourceFile: args.sourceFile,
    onEvent: args.onEvent,
    ...(Object.keys(args.defaults).length > 0 ? { defaults: args.defaults } : {}),
    ...(args.store === undefined ? {} : { store: args.store }),
  };
}

/** A `<scheme>://` prefix in a `--store` URI (anything but `file://` is unsupported). */
const STORE_URI_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Resolve the `--store <uri>` flag to a TurnStore. A `file://` URI or a bare
 *  filesystem path is an on-disk JSONL store; any other URI scheme is rejected (no
 *  backend yet). Undefined when the flag is absent (no store; nothing persisted). */
function resolveStore(uri: string | undefined): TurnStore | undefined {
  if (uri === undefined) {
    return;
  }
  if (uri.startsWith("file://")) {
    return createFileTurnStore(fileURLToPath(uri));
  }
  const scheme = STORE_URI_SCHEME.exec(uri);
  if (scheme !== null) {
    throw new Error(
      `unsupported --store scheme "${scheme[1]}://" — use a filesystem path or file:// URI`,
    );
  }
  return createFileTurnStore(isAbsolute(uri) ? uri : resolve(process.cwd(), uri));
}

/** Locate the TUI entry next to this module: `tui.tsx` in dev (src), `tui.js` built. */
function resolveTuiEntry(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ["tui.tsx", "tui.js"]) {
    const candidate = resolve(here, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return;
}

interface TuiArgs {
  readonly sourceFile: string;
  readonly input: string | undefined;
  readonly harness: string | undefined;
  readonly model: string | undefined;
  readonly thinking: string | undefined;
  readonly tools: string | undefined;
  readonly skills: string | undefined;
  readonly plugins: string | undefined;
  readonly store: string | undefined;
  readonly systemPrompt: boolean;
  readonly fullUserMsg: boolean;
  readonly omitHarnessPrompt: boolean;
}

/** Spawn one bun TUI process; resolve with its exit code (or 1 if bun is missing). */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- wraps child-process spawn events in `new Promise`; it resolves from an event handler, not an await.
function spawnTui(entry: string, argv: readonly string[]): Promise<number> {
  return new Promise<number>((resolveCode) => {
    const child = spawn("bun", [entry, ...argv], { stdio: "inherit" });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === "ENOENT"
          ? "bun not found on PATH — install bun (https://bun.sh) to use --tui"
          : error.message;
      process.stderr.write(`microfoom: ${hint}\n`);
      resolveCode(1);
    });
    child.on("exit", (code) => resolveCode(code ?? 0));
  });
}

/**
 * Launch the bun TUI, inheriting the terminal. Pressing `r` in the TUI exits with
 * RERUN_EXIT_CODE; we respawn a fresh process so the re-run reflects source edits
 * (bun can't reload a module in-process). Any other exit code ends the session.
 */
async function runTui(args: TuiArgs): Promise<number> {
  const entry = resolveTuiEntry();
  if (entry === undefined) {
    process.stderr.write("microfoom: TUI entry not found (build the cli package)\n");
    return 1;
  }
  const argv: string[] = [];
  if (args.input !== undefined) {
    argv.push(args.input);
  }
  if (args.harness !== undefined) {
    argv.push("--harness", args.harness);
  }
  if (args.model !== undefined) {
    argv.push("--model", args.model);
  }
  if (args.thinking !== undefined) {
    argv.push("--thinking", args.thinking);
  }
  if (args.tools !== undefined) {
    argv.push("--tools", args.tools);
  }
  if (args.skills !== undefined) {
    argv.push("--skills", args.skills);
  }
  if (args.plugins !== undefined) {
    argv.push("--plugins", args.plugins);
  }
  if (args.store !== undefined) {
    argv.push("--store", args.store);
  }
  if (args.omitHarnessPrompt) {
    argv.push("--omit-harness-prompt");
  }
  if (args.systemPrompt) {
    argv.push("--system-prompt");
  }
  if (args.fullUserMsg) {
    argv.push("--full-user-msg");
  }
  // Theme is detected by the bun TUI itself via an OSC query (reliable in VS Code);
  // a user can still force it with MICROFOOM_TUI_THEME, which the child inherits.
  argv.unshift(args.sourceFile);

  for (;;) {
    const code = await spawnTui(entry, argv);
    if (code !== RERUN_EXIT_CODE) {
      return code;
    }
  }
}

/** Run the program and render its result + run summary; map a thrown failure to a
 *  non-zero exit. Returns the process exit code. */
async function executeProgram(
  ProgramClass: Awaited<ReturnType<typeof loadProgram>>,
  input: unknown,
  runOptions: Parameters<typeof runProgram>[2],
  values: { json?: boolean; quiet?: boolean },
  events: readonly AgentEvent[],
  panel: ReturnType<typeof attachPanel> | undefined,
): Promise<number> {
  try {
    const result: unknown = await runProgram(ProgramClass, input, runOptions);
    panel?.done();
    process.stdout.write(
      `${values.json === true ? JSON.stringify(result) : stringifyResult(result)}\n`,
    );
    if (values.json !== true && values.quiet !== true) {
      const tree = buildRunTree(events);
      process.stderr.write(`${fmtSummary(tree.usage, tree.durationMs)}\n`);
    }
    return 0;
  } catch (error) {
    panel?.done();
    process.stderr.write(`microfoom: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const CLI_PARSE_CONFIG = {
  allowPositionals: true,
  options: {
    harness: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    tools: { type: "string" },
    skills: { type: "string" },
    plugins: { type: "string" },
    input: { type: "string" },
    store: { type: "string" },
    tui: { type: "boolean", default: false },
    "omit-harness-prompt": { type: "boolean", default: false },
    "system-prompt": { type: "boolean", default: false },
    "full-user-msg": { type: "boolean", default: false },
    panel: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
} as const;

function parseCliArgs(): ReturnType<typeof parseArgs<typeof CLI_PARSE_CONFIG>> {
  return parseArgs(CLI_PARSE_CONFIG);
}

async function run(): Promise<number> {
  const { values, positionals } = parseCliArgs();

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // Allow an optional leading `run` verb.
  const args = positionals[0] === "run" ? positionals.slice(1) : positionals;
  const [file] = args;
  if (file === undefined) {
    process.stderr.write(HELP);
    return 1;
  }
  const sourceFile = isAbsolute(file) ? file : resolve(process.cwd(), file);
  // No input token → pass `undefined` (not ""), so a no-input program declared with
  // `Program(z.void())` validates. An explicit (even empty) value is parsed as given.
  const rawInput = values.input ?? args[1];
  const input = rawInput === undefined ? undefined : parseInput(rawInput);
  const model = values.model ?? modelFromEnv() ?? "openrouter/deepseek/deepseek-v4-flash";

  // The interactive TUI is a separate runtime (OpenTUI needs bun's FFI): re-exec
  // the bun entry, which runs the program in-process and renders. We just wait.
  if (values.tui) {
    return await runTui({
      sourceFile,
      input: values.input ?? args[1],
      harness: values.harness,
      model: values.model,
      thinking: values.thinking,
      tools: values.tools,
      skills: values.skills,
      plugins: values.plugins,
      store: values.store,
      systemPrompt: values["system-prompt"],
      fullUserMsg: values["full-user-msg"],
      omitHarnessPrompt: values["omit-harness-prompt"],
    });
  }

  // Panel on an interactive stderr unless headless; auto-off when piped.
  const interactive = process.stderr.isTTY;
  const usePanel = values.panel || (!values.headless && interactive);

  const ProgramClass = await loadProgram(sourceFile);
  const harnesses = openHarnessRegistry(values.harness, values["omit-harness-prompt"]);
  if (harnesses === undefined) {
    process.stderr.write(
      `microfoom: unknown harness "${values.harness}" (known: ${knownHarnessNames().join(", ")})\n`,
    );
    return 1;
  }

  const events: AgentEvent[] = [];
  const panel = usePanel ? attachPanel(process.stderr) : undefined;
  const onEvent = (event: AgentEvent): void => {
    events.push(event);
    panel?.onEvent(event);
  };

  const defaults = cliDefaults(
    values.thinking,
    parseList(values.tools),
    parseList(values.skills),
    parseList(values.plugins),
  );
  const store = resolveStore(values.store);
  return executeProgram(
    ProgramClass,
    input,
    buildRunOptions({
      harnesses,
      defaultHarness: values.harness,
      model,
      sourceFile,
      onEvent,
      defaults,
      store,
    }),
    values,
    events,
    panel,
  );
}

run().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`microfoom: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
