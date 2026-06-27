#!/usr/bin/env node
// `microfoom run <file> [input]` — the default way to run a program file. Added
// value over `node --import tsx run.ts`: zero per-program boilerplate, model/key
// resolved from ~/.pi (via the pi harness), and a live run panel (span tree with
// cost/latency/repairs). Output discipline: the program result goes to STDOUT
// (clean, pipeable, --json for machines); all observability goes to STDERR.
//
// Modes: interactive TTY → live panel by default; piped/redirected → auto-headless
// (no ANSI). Force with --panel / --headless. --faux runs offline (no model).

import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runProgram } from "@microfoom/core";
import { type AgentEvent, buildRunTree } from "@microfoom/core/trace";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import { fauxOpenSession } from "./faux.js";
import { fmtSummary } from "./format.js";
import { loadProgram } from "./loader.js";
import { attachPanel } from "./panel.js";

const HELP = `microfoom — run a microfoom program file

Usage:
  microfoom run <file> [input]        run a program (default the way you run files)
  microfoom <file> [input]            'run' is optional

Options:
  --model <id>        model id (default: $MICROFOOM_MODEL or a deepseek default)
  --thinking <level>  off | minimal | low | medium | high | xhigh
  --input <value>     program input (alternative to the positional)
  --panel             force the live run panel (even when piped)
  --headless          no panel, no ANSI — result only (integrations, CI)
  --json              print the result as JSON to stdout (implies quiet)
  --quiet             suppress the stderr summary footer
  --faux              run offline with a deterministic stub session (no model)
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

async function run(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string" },
      thinking: { type: "string" },
      input: { type: "string" },
      panel: { type: "boolean", default: false },
      headless: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      faux: { type: "boolean", default: false },
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
  const input = parseInput(values.input ?? args[1] ?? "");
  const model =
    values.model ?? process.env.MICROFOOM_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";

  // Panel on an interactive stderr unless headless; auto-off when piped.
  const interactive = process.stderr.isTTY === true;
  const usePanel = values.panel || (!values.headless && interactive);

  const ProgramClass = await loadProgram(sourceFile);
  const openSession = values.faux ? fauxOpenSession() : createPiOpenSession();

  const events: AgentEvent[] = [];
  const panel = usePanel ? attachPanel(process.stderr) : undefined;
  const onEvent = (event: AgentEvent): void => {
    events.push(event);
    panel?.onEvent(event);
  };

  try {
    const result = await runProgram(ProgramClass, input, {
      openSession,
      model,
      sourceFile,
      onEvent,
      ...(values.thinking !== undefined ? { defaults: { thinking: values.thinking } } : {}),
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
