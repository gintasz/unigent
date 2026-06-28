#!/usr/bin/env node
// `microfoom run <file> [input]` — the default way to run a program file. Added
// value over `node --import tsx run.ts`: zero per-program boilerplate, model/key
// resolved from ~/.pi (via the pi harness), and a live run panel (span tree with
// cost/latency/repairs). Output discipline: the program result goes to STDOUT
// (clean, pipeable, --json for machines); all observability goes to STDERR.
//
// Modes: interactive TTY → live panel by default; piped/redirected → auto-headless
// (no ANSI). Force with --panel / --headless. `--harness fake` runs offline (no model).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type OpenSession, runProgram } from "@microfoom/core";
import { type AgentEvent, buildRunTree } from "@microfoom/core/trace";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import { fakeOpenSession } from "./fake.js";
import { fmtSummary } from "./format.js";
import { loadProgram } from "./loader.js";
import { attachPanel } from "./panel.js";
import { RERUN_EXIT_CODE } from "./tui/rerun.js";

// Selectable harnesses (composition root — the one place names map to adapters).
// Add new harness support here; the program then runs on `--harness <name>`.
const HARNESSES: Record<string, () => OpenSession> = {
  pi: createPiOpenSession,
  fake: fakeOpenSession,
};
const DEFAULT_HARNESS = "pi";

const HELP = `microfoom — run a microfoom program file

Usage:
  microfoom run <file> [input]        run a program (default the way you run files)
  microfoom <file> [input]            'run' is optional

Options:
  --harness <name>    harness to run on: pi (default) | fake (offline stub, no model)
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
  if (trimmed.length === 0) return "";
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
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Build the run-level config defaults from CLI flags (only set fields present).
 *  These become the run's widest config scope, so skills/plugins reach the harness
 *  at session-open (and a program's @foom.config can still override). */
function cliDefaults(
  thinking: string | undefined,
  tools: readonly string[] | undefined,
  skills: readonly string[] | undefined,
  plugins: readonly string[] | undefined,
) {
  return {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(plugins !== undefined ? { plugins } : {}),
  };
}

/** Locate the TUI entry next to this module: `tui.tsx` in dev (src), `tui.js` built. */
function resolveTuiEntry(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ["tui.tsx", "tui.js"]) {
    const candidate = resolve(here, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
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
  readonly systemPrompt: boolean;
  readonly fullUserMsg: boolean;
  readonly omitHarnessPrompt: boolean;
}

/** Spawn one bun TUI process; resolve with its exit code (or 1 if bun is missing). */
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
  if (args.input !== undefined) argv.push(args.input);
  if (args.harness !== undefined) argv.push("--harness", args.harness);
  if (args.model !== undefined) argv.push("--model", args.model);
  if (args.thinking !== undefined) argv.push("--thinking", args.thinking);
  if (args.tools !== undefined) argv.push("--tools", args.tools);
  if (args.skills !== undefined) argv.push("--skills", args.skills);
  if (args.plugins !== undefined) argv.push("--plugins", args.plugins);
  if (args.omitHarnessPrompt) argv.push("--omit-harness-prompt");
  if (args.systemPrompt) argv.push("--system-prompt");
  if (args.fullUserMsg) argv.push("--full-user-msg");
  // Theme is detected by the bun TUI itself via an OSC query (reliable in VS Code);
  // a user can still force it with MICROFOOM_TUI_THEME, which the child inherits.
  argv.unshift(args.sourceFile);

  for (;;) {
    const code = await spawnTui(entry, argv);
    if (code !== RERUN_EXIT_CODE) return code;
  }
}

async function run(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      harness: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      tools: { type: "string" },
      skills: { type: "string" },
      plugins: { type: "string" },
      input: { type: "string" },
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
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // Allow an optional leading `run` verb.
  const args = positionals[0] === "run" ? positionals.slice(1) : positionals;
  const file = args[0];
  if (file === undefined) {
    process.stderr.write(HELP);
    return 1;
  }
  const sourceFile = isAbsolute(file) ? file : resolve(process.cwd(), file);
  // No input token → pass `undefined` (not ""), so a no-input program declared with
  // `Program(z.void())` validates. An explicit (even empty) value is parsed as given.
  const rawInput = values.input ?? args[1];
  const input = rawInput === undefined ? undefined : parseInput(rawInput);
  const model =
    values.model ?? process.env.MICROFOOM_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";

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
      systemPrompt: values["system-prompt"],
      fullUserMsg: values["full-user-msg"],
      omitHarnessPrompt: values["omit-harness-prompt"],
    });
  }

  // Panel on an interactive stderr unless headless; auto-off when piped.
  const interactive = process.stderr.isTTY === true;
  const usePanel = values.panel || (!values.headless && interactive);

  const ProgramClass = await loadProgram(sourceFile);
  const harnessName = values.harness ?? DEFAULT_HARNESS;
  const makeHarness = HARNESSES[harnessName];
  if (makeHarness === undefined) {
    process.stderr.write(
      `microfoom: unknown harness "${harnessName}" (known: ${Object.keys(HARNESSES).join(", ")})\n`,
    );
    return 1;
  }
  const openSession =
    harnessName === "pi"
      ? createPiOpenSession({ omitHarnessBasePrompt: values["omit-harness-prompt"] })
      : makeHarness();

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
  try {
    const result = await runProgram(ProgramClass, input, {
      harnesses: { [harnessName]: openSession },
      model,
      sourceFile,
      onEvent,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    });
    panel?.done();

    process.stdout.write(`${values.json ? JSON.stringify(result) : stringifyResult(result)}\n`);

    if (!values.json && !values.quiet) {
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

run().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`microfoom: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
