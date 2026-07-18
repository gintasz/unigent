import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { detectScriptRuntime, runtimeInvocation } from "./script_runtime.js";
import { App } from "./tui/app.js";
import { createScriptRunner } from "./tui/runner.js";
import { createTuiStore } from "./tui/store.js";
import { paletteFor, type ThemeMode } from "./tui/theme.js";

const THEME_QUERY_TIMEOUT_MILLISECONDS = 300;

const TUI_ARGUMENTS = {
  allowPositionals: true,
  options: {
    node: { type: "string" },
    register: { type: "string" },
    typescriptLoader: { type: "string" },
    theme: { type: "string" },
  },
} as const;

async function detectTheme(
  override: string | undefined,
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
): Promise<ThemeMode> {
  if (override === "light" || override === "dark") {
    return override;
  }
  const detected = await Promise.race([
    renderer.waitForThemeMode(),
    new Promise<undefined>((resolveTheme) =>
      setTimeout(() => resolveTheme(undefined), THEME_QUERY_TIMEOUT_MILLISECONDS),
    ),
  ]);
  return detected ?? "dark";
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs(TUI_ARGUMENTS);
  const [source] = positionals;
  if (
    source === undefined ||
    values.node === undefined ||
    values.register === undefined ||
    values.typescriptLoader === undefined
  ) {
    throw new Error("unigent tui: internal launch arguments are incomplete");
  }
  const sourceFile = isAbsolute(source) ? source : resolve(process.cwd(), source);
  const scriptArguments = positionals.slice(1);
  const runtime = runtimeInvocation(
    await detectScriptRuntime(sourceFile),
    values.node,
    values.typescriptLoader,
  );
  const store = createTuiStore(sourceFile);
  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: false, targetFps: 30 });
  const theme = await detectTheme(values.theme, renderer);
  renderer.setBackgroundColor(paletteFor(theme).background);
  const runner = createScriptRunner(
    {
      runtime,
      registerEntry: values.register,
      sourceFile,
      scriptArguments,
    },
    store,
  );
  const quit = (): void => {
    runner.dispose();
    renderer.destroy();
  };
  createRoot(renderer).render(
    <App
      store={store}
      initialTheme={theme}
      onAbort={runner.abort}
      onRerun={runner.start}
      onQuit={quit}
    />,
  );
  runner.start();
}

main().catch((error: unknown) => {
  process.stderr.write(`unigent tui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
