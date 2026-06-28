// The interactive TUI entry — runs under BUN (OpenTUI needs bun's FFI), spawned by
// `microfoom run <file> --tui` (see cli.ts). It runs the program in-process and
// renders the two-pane inspector (trace tree + live transcript). stdin is left to
// OpenTUI for keyboard/mouse; the run streams in via the store. Args mirror the
// node CLI's, passed after `--`.

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type OpenSession, runProgram } from "@microfoom/core";
import type { AgentEvent } from "@microfoom/core/trace";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { fakeOpenSession } from "./fake.js";
import { App } from "./tui/app.js";
import { RERUN_EXIT_CODE } from "./tui/rerun.js";
import { createStore } from "./tui/store.js";
import { paletteFor, type ThemeMode } from "./tui/theme.js";

const HARNESSES: Record<string, () => OpenSession> = {
  pi: createPiOpenSession,
  fake: fakeOpenSession,
};

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

async function main(): Promise<void> {
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
      theme: { type: "string" },
      "omit-harness-prompt": { type: "boolean", default: false },
      "system-prompt": { type: "boolean", default: false },
      "full-user-msg": { type: "boolean", default: false },
    },
  });

  const file = positionals[0];
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
  const model =
    values.model ?? process.env.MICROFOOM_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";
  const makeHarness = HARNESSES[harnessName];
  if (makeHarness === undefined) {
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
  const openSession =
    harnessName === "pi"
      ? createPiOpenSession({ omitHarnessBasePrompt: values["omit-harness-prompt"] })
      : makeHarness();
  const store = createStore();
  store.setMeta({
    file: sourceFile,
    model,
    harness: harnessName,
    input: input === undefined ? "" : String(input),
  });

  // Mount the UI first so it shows immediately, then drive the run into the store.
  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: true, targetFps: 30 });
  // Theme precedence: explicit override (flag/env) → terminal OSC query → dark.
  // The OSC query is what correctly picks up VS Code's light terminal (COLORFGBG
  // is unreliable there), so we ask the terminal itself rather than guessing.
  const override = values.theme ?? process.env.MICROFOOM_TUI_THEME;
  const detected =
    override === "light" || override === "dark" ? override : await renderer.waitForThemeMode(300);
  const mode: ThemeMode = detected === "light" ? "light" : "dark";
  renderer.setBackgroundColor(paletteFor(mode).bg);
  // `r` exits with a sentinel; the node launcher respawns a fresh bun process so
  // the re-run picks up source edits (bun can't reload a module in-process).
  const rerun = (): void => {
    renderer.destroy();
    process.exit(RERUN_EXIT_CODE);
  };
  createRoot(renderer).render(
    <App
      store={store}
      initialMode={mode}
      showSystem={values["system-prompt"]}
      showNotices={values["full-user-msg"]}
      onRerun={rerun}
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
  const defaults = {
    ...(values.thinking !== undefined ? { thinking: values.thinking } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(plugins !== undefined ? { plugins } : {}),
  };
  try {
    const result = await runProgram(ProgramClass as never, input, {
      harnesses: { [harnessName]: openSession },
      model,
      sourceFile,
      onEvent: (event: AgentEvent) => store.push(event),
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    });
    store.done(typeof result === "string" ? result : JSON.stringify(result), undefined);
  } catch (error) {
    store.done(undefined, errMessage(error));
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main();
