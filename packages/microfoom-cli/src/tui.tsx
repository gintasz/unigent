// The interactive TUI entry — runs under BUN (OpenTUI needs bun's FFI), spawned by
// `microfoom run <file> --tui` (see cli.ts). It runs the program in-process and
// renders the two-pane inspector (trace tree + live transcript). stdin is left to
// OpenTUI for keyboard/mouse; the run streams in via the store. Args mirror the
// node CLI's, passed after `--`.

import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type OpenSession, runProgram } from "@microfoom/core";
import type { AgentEvent } from "@microfoom/core/trace";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { modelFromEnv, tuiThemeFromEnv } from "./env.js";
import { fakeOpenSession } from "./fake.js";
import { App } from "./tui/app.js";
import { RERUN_EXIT_CODE } from "./tui/rerun.js";
import { createStore } from "./tui/store.js";
import { paletteFor, type ThemeMode } from "./tui/theme.js";

const THEME_QUERY_TIMEOUT_MS = 300;

const HARNESSES: Record<string, () => OpenSession> = {
  pi: createPiOpenSession,
  fake: fakeOpenSession,
};

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

/** Open a session on the named harness (pi gets the omit-base-prompt option), or
 *  undefined when the name isn't a known harness. */
function openTuiHarness(harnessName: string, omitHarnessPrompt: boolean): OpenSession | undefined {
  const makeHarness = HARNESSES[harnessName];
  if (makeHarness === undefined) {
    return;
  }
  return harnessName === "pi"
    ? createPiOpenSession({ omitHarnessBasePrompt: omitHarnessPrompt })
    : makeHarness();
}

/** Theme precedence: explicit override (flag/env) → terminal OSC query → dark. The
 *  OSC query is what correctly picks up VS Code's light terminal (COLORFGBG is
 *  unreliable there), so we ask the terminal itself rather than guessing. */
async function resolveTheme(
  override: string | undefined,
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
): Promise<ThemeMode> {
  const detected =
    override === "light" || override === "dark"
      ? override
      : await renderer.waitForThemeMode(THEME_QUERY_TIMEOUT_MS);
  return detected === "light" ? "light" : "dark";
}

/** Render the program input for the meta header: strings as-is, anything else as JSON. */
function formatInputMeta(input: unknown): string {
  if (input === undefined) {
    return "";
  }
  return typeof input === "string" ? input : JSON.stringify(input);
}

/** The per-run defaults from CLI flags, each field added only when supplied. */
function buildTuiDefaults(
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

/** Run the program and report its result (or failure) into the TUI store. */
async function runIntoStore(
  ProgramClass: unknown,
  input: unknown,
  runOptions: Parameters<typeof runProgram>[2],
  store: ReturnType<typeof createStore>,
): Promise<void> {
  try {
    const result: unknown = await runProgram(ProgramClass as never, input, runOptions);
    store.done(typeof result === "string" ? result : JSON.stringify(result), undefined);
  } catch (error) {
    // A user abort surfaces as a rejection too; mark it distinctly (not an error).
    if (runOptions.signal?.aborted === true) {
      store.aborted(errMessage(error));
    } else {
      store.done(undefined, errMessage(error));
    }
  }
}

const TUI_PARSE_CONFIG = {
  allowPositionals: true,
  options: {
    harness: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    tools: { type: "string" },
    skills: { type: "string" },
    plugins: { type: "string" },
    input: { type: "string" },
    theme: { type: "string" },
    "omit-harness-prompt": { type: "boolean", default: false },
    "system-prompt": { type: "boolean", default: false },
    "full-user-msg": { type: "boolean", default: false },
  },
} as const;

function parseTuiArgs(): ReturnType<typeof parseArgs<typeof TUI_PARSE_CONFIG>> {
  return parseArgs(TUI_PARSE_CONFIG);
}

async function main(): Promise<void> {
  const { values, positionals } = parseTuiArgs();

  const [file] = positionals;
  if (file === undefined) {
    process.stderr.write("microfoom tui: missing program file\n");
    process.exit(1);
  }
  const sourceFile = isAbsolute(file) ? file : resolve(process.cwd(), file);
  // No input token → `undefined` (not "") so `Program(z.void())` validates; an
  // explicit value is parsed as given. Mirrors the node CLI.
  const rawInput = values.input ?? positionals[1];
  const input = rawInput === undefined ? undefined : parseInput(rawInput);
  const harnessName = values.harness ?? "pi";
  const model = values.model ?? modelFromEnv() ?? "openrouter/deepseek/deepseek-v4-flash";
  const openSession = openTuiHarness(harnessName, values["omit-harness-prompt"]);
  if (openSession === undefined) {
    process.stderr.write(`microfoom tui: unknown harness "${harnessName}"\n`);
    process.exit(1);
  }

  const toList = (raw: string | undefined): readonly string[] | undefined =>
    raw === undefined
      ? undefined
      : raw
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
  const skills = toList(values.skills);
  const plugins = toList(values.plugins);
  const store = createStore();
  store.setMeta({
    file: sourceFile,
    model,
    harness: harnessName,
    input: formatInputMeta(input),
  });

  // Mount the UI first so it shows immediately, then drive the run into the store.
  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: true, targetFps: 30 });
  // Theme precedence: explicit override (flag/env) → terminal OSC query → dark.
  // The OSC query is what correctly picks up VS Code's light terminal (COLORFGBG
  // is unreliable there), so we ask the terminal itself rather than guessing.
  const mode = await resolveTheme(values.theme ?? tuiThemeFromEnv(), renderer);
  renderer.setBackgroundColor(paletteFor(mode).bg);
  // `r` exits with a sentinel; the node launcher respawns a fresh bun process so
  // the re-run picks up source edits (bun can't reload a module in-process).
  const rerun = (): void => {
    renderer.destroy();
    process.exit(RERUN_EXIT_CODE);
  };
  // Ctrl+R aborts the in-flight run via this signal (threaded into runProgram).
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  createRoot(renderer).render(
    <App
      store={store}
      initialMode={mode}
      showSystem={values["system-prompt"]}
      showNotices={values["full-user-msg"]}
      onRerun={rerun}
      onAbort={abort}
    />,
  );

  // Fresh process each run ⇒ a clean import that reflects the current source.
  let ProgramClass: unknown;
  try {
    ProgramClass = ((await import(pathToFileURL(sourceFile).href)) as { default?: unknown })
      .default;
  } catch (error) {
    store.done(undefined, errMessage(error));
    return;
  }
  if (typeof ProgramClass !== "function") {
    store.done(undefined, `${sourceFile} has no default-exported program`);
    return;
  }
  const tools = toList(values.tools);
  const defaults = buildTuiDefaults(values.thinking, tools, skills, plugins);
  await runIntoStore(
    ProgramClass,
    input,
    {
      harnesses: { [harnessName]: openSession },
      model,
      sourceFile,
      signal: controller.signal,
      onEvent: (event: AgentEvent) => store.push(event),
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    },
    store,
  );
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`${errMessage(error)}\n`);
  process.exit(1);
});
