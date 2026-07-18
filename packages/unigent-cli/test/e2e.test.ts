import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createTerminal } from "@termless/core";
import { createXtermBackend } from "@termless/xtermjs";
import { afterAll, beforeAll, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const cli = resolve(packageRoot, "dist/cli.js");
const developmentCli = resolve(packageRoot, "../../scripts/unigent-dev.mjs");
const helloExample = resolve(packageRoot, "../../examples/hello.ts");
const fixture = resolve(here, "support/traced_script.ts");
const toolFixture = resolve(here, "support/tool_script.ts");
const stressFixture = resolve(here, "support/stress_script.ts");
const longMessageFixture = resolve(here, "support/long_message_script.ts");
const failingFixture = resolve(here, "support/failing_script.ts");
const positionalFixture = resolve(here, "support/positional_script.ts");
const rawArgumentsFixture = resolve(here, "support/raw_arguments_script.ts");
const bunFixture = resolve(here, "support/bun_script.ts");
const nodeTypescriptFixture = resolve(here, "support/node_typescript_script.ts");
const interactiveFixture = resolve(here, "support/interactive_script.ts");
const screenshotDirectory = resolve(tmpdir(), "unigent-tui-shots");
const terminal = createTerminal({ backend: createXtermBackend(), cols: 120, rows: 34 });

beforeAll(async () => {
  if (!existsSync(cli)) {
    throw new Error("TUI test requires dist/cli.js; run the workspace build first");
  }
  mkdirSync(screenshotDirectory, { recursive: true });
  await terminal.spawn([process.execPath, cli, "tui", fixture, "--", "Ada"]);
  await terminal.waitFor("● complete", 20_000);
}, 30_000);

afterAll(async () => {
  await terminal.close();
});

test("renders live Unigent tracing and isolated script output", async () => {
  const screen = terminal.screen.getText();
  expect(screen).toContain("unigent");
  expect(screen).toContain("TRACE");
  expect(screen).toContain("ACTIVITY");
  expect(screen).toContain("fake/test-model");
  expect(screen).toContain("greeter");
  expect(screen).toContain("Checking the requested name");
  expect(screen).not.toContain("SCRIPT OUTPUT: Hello, Ada.");
  expect(screen).toContain("o output (1)");
  expect(screen).toContain("s sys prompt");
  expect(screen).toContain("18tok");
  writeFileSync(resolve(screenshotDirectory, "overview.svg"), terminal.screenshotSvg());
  terminal.press("o");
  await terminal.waitFor("SCRIPT OUTPUT: Hello, Ada.", 5000);
  expect(terminal.screen.getText()).toContain("OUTPUT");
  terminal.press("o");
  await terminal.waitFor("ACTIVITY", 5000);
});

test("focuses a trace and progressively reveals the system prompt", async () => {
  terminal.click(7, 2);
  await terminal.waitFor("ACTIVITY · greeter", 5000);
  terminal.press("s");
  await terminal.waitFor("MUST call it", 5000);
  expect(terminal.screen.getText()).toContain("✦ system");
  writeFileSync(resolve(screenshotDirectory, "focused.svg"), terminal.screenshotSvg());
});

test("reruns inside the same TUI process", async () => {
  terminal.press("r");
  await terminal.waitFor("running", 5000);
  await terminal.waitFor("● complete", 10_000);
  expect(terminal.screen.getText()).toContain("o output (1)");
  terminal.press("o");
  await terminal.waitFor("SCRIPT OUTPUT: Hello, Ada.", 5000);
  terminal.press("o");
});

test("cancels an active run without killing the inspector", async () => {
  const cancellationTerminal = createTerminal({
    backend: createXtermBackend(),
    cols: 100,
    rows: 28,
  });
  try {
    await cancellationTerminal.spawn([process.execPath, cli, "tui", fixture, "--", "__slow__"]);
    await cancellationTerminal.waitFor("Checking the requested name", 5000);
    cancellationTerminal.press("Ctrl+r");
    await cancellationTerminal.waitFor("stopped", 5000);
    expect(cancellationTerminal.screen.getText()).not.toContain("AgentCancelledError");
    expect(cancellationTerminal.screen.getText()).not.toContain("Node.js v");
  } finally {
    await cancellationTerminal.close();
  }
});

test("summarizes tool calls and expands them only for the selected agent", async () => {
  const toolTerminal = createTerminal({ backend: createXtermBackend(), cols: 110, rows: 30 });
  try {
    await toolTerminal.spawn([process.execPath, cli, "tui", toolFixture]);
    await toolTerminal.waitFor("● complete", 10_000);
    expect(toolTerminal.screen.getText()).toContain("2 backends · 2 models");
    expect(toolTerminal.screen.getText()).toContain("▪ evaluation");
    expect(toolTerminal.screen.getText()).toContain("▪ review");
    expect(toolTerminal.screen.getText()).toContain("tools  rate ×3");
    expect(toolTerminal.screen.getText()).not.toContain("◇ rate");
    toolTerminal.click(7, 2);
    await toolTerminal.waitFor("ACTIVITY · evaluation", 5000);
    await toolTerminal.waitFor("best draft scored 92", 5000);
    expect(toolTerminal.screen.getText()).toContain("evaluation · annotation");
    writeFileSync(resolve(screenshotDirectory, "workflow.svg"), toolTerminal.screenshotSvg());
    toolTerminal.click(10, 3);
    await toolTerminal.waitFor("ACTIVITY · scorer", 5000);
    expect(toolTerminal.screen.getText()).toContain("fake-tools/test-model");
    expect(toolTerminal.screen.getText()).not.toContain("◆ run · scorer");
    toolTerminal.press("Enter");
    await toolTerminal.waitFor("◇ rate", 5000);
    expect(toolTerminal.screen.getText()).toContain("enter hide details");
  } finally {
    await toolTerminal.close();
  }
});

test("stays responsive through 5000 agent runs", async () => {
  const stressTerminal = createTerminal({ backend: createXtermBackend(), cols: 120, rows: 32 });
  try {
    await stressTerminal.spawn([process.execPath, cli, "tui", stressFixture]);
    await stressTerminal.waitFor("● complete", 60_000);
    await stressTerminal.waitFor("Showing 4751–5000 of 5000 rows", 10_000);
    expect(stressTerminal.screen.getText()).toContain("10.0ktok");
    expect(stressTerminal.screen.getText()).toContain("o output (1)");
    stressTerminal.press("[");
    await stressTerminal.waitFor("Showing 4501–4750 of 5000 rows", 5000);
    stressTerminal.press("]");
    await stressTerminal.waitFor("Showing 4751–5000 of 5000 rows", 5000);
    stressTerminal.press("o");
    await stressTerminal.waitFor("STRESS COMPLETE: 5000", 5000);
  } finally {
    await stressTerminal.close();
  }
}, 75_000);

test("displays complete messages longer than the former character limit", async () => {
  const longMessageTerminal = createTerminal({
    backend: createXtermBackend(),
    cols: 100,
    rows: 28,
  });
  try {
    await longMessageTerminal.spawn([process.execPath, cli, "tui", longMessageFixture]);
    await longMessageTerminal.waitFor("● complete", 10_000);
    longMessageTerminal.wheel(0, 200, { x: 75, y: 12 });
    await longMessageTerminal.waitForStable(250, 5000);
    expect(longMessageTerminal.screen.getText()).toContain("COMPLETE-TAIL");
    expect(longMessageTerminal.screen.getText()).not.toContain("more characters");
  } finally {
    await longMessageTerminal.close();
  }
});

test("shows startup failures without requiring the output hotkey", async () => {
  const failingTerminal = createTerminal({ backend: createXtermBackend(), cols: 100, rows: 28 });
  try {
    await failingTerminal.spawn([process.execPath, cli, "tui", failingFixture]);
    await failingTerminal.waitFor("● failed", 5000);
    await failingTerminal.waitFor("STARTUP FAILURE: invalid script input", 5000);
    expect(failingTerminal.screen.getText()).toContain("OUTPUT");
    expect(failingTerminal.screen.getText()).not.toContain("This selection emitted no activity");
  } finally {
    await failingTerminal.close();
  }
});

test("forwards a natural multi-word positional input through the TUI", async () => {
  const positionalTerminal = createTerminal({ backend: createXtermBackend(), cols: 100, rows: 28 });
  try {
    await positionalTerminal.spawn([
      process.execPath,
      cli,
      "tui",
      positionalFixture,
      "Kebab",
      "app",
    ]);
    await positionalTerminal.waitFor("● complete", 5000);
    positionalTerminal.press("o");
    await positionalTerminal.waitFor("POSITIONAL INPUT: Kebab app", 5000);
  } finally {
    await positionalTerminal.close();
  }
});

test("preserves a literal separator inside TUI script arguments", async () => {
  const positionalTerminal = createTerminal({ backend: createXtermBackend(), cols: 100, rows: 28 });
  try {
    await positionalTerminal.spawn([
      process.execPath,
      cli,
      "tui",
      rawArgumentsFixture,
      "--",
      "Kebab",
      "--",
      "app",
    ]);
    await positionalTerminal.waitFor("● complete", 5000);
    positionalTerminal.press("o");
    await positionalTerminal.waitFor('RAW ARGUMENTS: ["Kebab","--","app"]', 5000);
  } finally {
    await positionalTerminal.close();
  }
});

test("honors a Bun shebang through the TUI", async () => {
  const bunTerminal = createTerminal({ backend: createXtermBackend(), cols: 100, rows: 28 });
  try {
    await bunTerminal.spawn([process.execPath, cli, "tui", bunFixture]);
    await bunTerminal.waitFor("● complete", 5000);
    bunTerminal.press("o");
    await bunTerminal.waitFor("SCRIPT RUNTIME: bun", 5000);
  } finally {
    await bunTerminal.close();
  }
});

test("runs a NodeNext TypeScript module graph without a Bun shebang through the TUI", async () => {
  const nodeTerminal = createTerminal({ backend: createXtermBackend(), cols: 100, rows: 28 });
  try {
    await nodeTerminal.spawn([process.execPath, cli, "tui", nodeTypescriptFixture]);
    await nodeTerminal.waitFor("● complete", 5000);
    nodeTerminal.press("o");
    await nodeTerminal.waitFor("TYPESCRIPT MODULE: loaded", 5000);
    expect(nodeTerminal.screen.getText()).toContain("SCRIPT RUNTIME: node");
  } finally {
    await nodeTerminal.close();
  }
});

test("collects and validates missing arguments in a real terminal", async () => {
  const interactiveTerminal = createTerminal({
    backend: createXtermBackend(),
    cols: 100,
    rows: 30,
  });
  try {
    await interactiveTerminal.spawn([
      process.execPath,
      cli,
      interactiveFixture,
      "--depth",
      "thorough",
      "-i",
    ]);
    await interactiveTerminal.waitFor("--topic (Topic to research):", 5000);
    interactiveTerminal.type("x");
    interactiveTerminal.press("Enter");
    await interactiveTerminal.waitFor("Invalid --topic (Topic to research)", 5000);
    interactiveTerminal.type("TypeScript agents");
    interactiveTerminal.press("Enter");
    await interactiveTerminal.waitFor("owner:", 5000);
    interactiveTerminal.type("Ada");
    interactiveTerminal.press("Enter");
    await interactiveTerminal.waitFor("Add an item to --tags? [Y/n]:", 5000);
    interactiveTerminal.press("Enter");
    await interactiveTerminal.waitFor("tags.0:", 5000);
    interactiveTerminal.type("automation");
    interactiveTerminal.press("Enter");
    await interactiveTerminal.waitFor("Add an item to --tags? [y/N]:", 5000);
    interactiveTerminal.press("Enter");
    await interactiveTerminal.waitFor("2. port", 5000);
    interactiveTerminal.type("2");
    interactiveTerminal.press("Enter");
    await interactiveTerminal.waitFor("--destination.port:", 5000);
    interactiveTerminal.type("8080");
    interactiveTerminal.press("Enter");
    await interactiveTerminal.waitFor("INTERACTIVE INPUT:", 5000);

    const output = interactiveTerminal.buffer.getText();
    expect(output).toContain('"topic":"TypeScript agents"');
    expect(output).toContain('"owner":"Ada"');
    expect(output).toContain('"depth":"thorough"');
    expect(output).toContain('"rounds":3');
    expect(output).toContain('"destination":{"kind":"port","port":8080}');
  } finally {
    await interactiveTerminal.close();
  }
});

test("cancels interactive collection with the conventional exit code", async () => {
  const cancellationTerminal = createTerminal({
    backend: createXtermBackend(),
    cols: 100,
    rows: 24,
  });
  try {
    await cancellationTerminal.spawn([process.execPath, cli, interactiveFixture, "-i"]);
    await cancellationTerminal.waitFor("--topic (Topic to research):", 5000);
    cancellationTerminal.press("Ctrl+c");
    await cancellationTerminal.waitForStable(100, 5000);
    expect(cancellationTerminal.alive).toBe(false);
    expect(cancellationTerminal.exitInfo).toContain("130");
    expect(cancellationTerminal.buffer.getText()).not.toContain("INTERACTIVE INPUT:");
  } finally {
    await cancellationTerminal.close();
  }
});

test("reports that interactive argument collection is unavailable inside the TUI", async () => {
  const interactiveTui = createTerminal({
    backend: createXtermBackend(),
    cols: 100,
    rows: 28,
  });
  try {
    await interactiveTui.spawn([process.execPath, cli, "tui", interactiveFixture, "-i"]);
    await interactiveTui.waitFor("● failed", 5000);
    await interactiveTui.waitFor("unavailable in TUI and piped execution", 5000);
  } finally {
    await interactiveTui.close();
  }
});

test("runs the TUI through the globally linked development source", async () => {
  const developmentTerminal = createTerminal({
    backend: createXtermBackend(),
    cols: 100,
    rows: 28,
  });
  try {
    await developmentTerminal.spawn([
      process.execPath,
      developmentCli,
      "tui",
      fixture,
      "--",
      "Ada",
    ]);
    await developmentTerminal.waitFor("● complete", 10_000);
    expect(developmentTerminal.screen.getText()).not.toContain("ERR_MODULE_NOT_FOUND");
  } finally {
    await developmentTerminal.close();
  }
});

test("shows a concise validation error without a runtime stack", async () => {
  const validationTerminal = createTerminal({
    backend: createXtermBackend(),
    cols: 100,
    rows: 28,
  });
  try {
    await validationTerminal.spawn([process.execPath, developmentCli, "tui", helloExample]);
    await validationTerminal.waitFor("● failed", 10_000);
    await validationTerminal.waitFor(
      "unigent: Too small: expected string to have >=1 characters",
      5000,
    );
    const screen = validationTerminal.screen.getText();
    expect(screen).not.toContain("ZodError");
    expect(screen).not.toContain("Node.js v");
  } finally {
    await validationTerminal.close();
  }
});
