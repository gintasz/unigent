import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderVibeCallResult } from "../dist/index.js";

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

// truncateToWidth caps visible width but injects invisible bytes, so assert visibleWidth, not length.
function renderCard(details: Record<string, unknown>, expanded: boolean, width: number): string[] {
  const component = renderVibeCallResult(
    { content: [{ type: "text", text: "x" }], details } as never,
    expanded,
    plainTheme as never,
    "/tmp/agentic_coding",
  );
  return component.render(width);
}

describe("renderVibeCallResult width safety", () => {
  const longError =
    "VIBEFUNCTION `fac` declares an unrecognized return type `intfaketype`. " +
    'Use a valid type — e.g. int, str, bool, number, number.integer, or an ArkType expression like "number > 0" or \'"ok" | "fail"\'.';

  const baseDetails = {
    kind: "vibecall",
    runId: "tc-1",
    program_file_path: "./program2.txt",
    name: "fac",
    args: "n = 2",
    prompt: "ENTRYPOINT = fac\nENTRYPOINT_ARGS = n = 2\nYou are called to execute a VIBEFUNCTION.",
    depth: 1,
    transcript: [{ t: 1, role: "assistant", text: "a".repeat(400) }],
  };

  it("never emits a line wider than the terminal (collapsed, long error)", () => {
    const lines = renderCard({ ...baseDetails, status: "error", error: longError }, false, 80);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  it("never emits a line wider than the terminal (expanded, long error + prompt + transcript)", () => {
    const lines = renderCard({ ...baseDetails, status: "error", error: longError }, true, 100);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
  });

  it("never emits a line wider than the terminal (narrow width)", () => {
    const lines = renderCard({ ...baseDetails, status: "done", result: "x".repeat(500) }, true, 40);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });
});

describe("streaming step shows a trailing window", () => {
  const baseDetails = {
    kind: "vibecall",
    runId: "tc-1",
    program_file_path: "./program2.txt",
    name: "fac",
    args: "n = 2",
    prompt: "ENTRYPOINT = fac",
    depth: 1,
  };

  function runningCard(step: string, width: number): string[] {
    return renderCard(
      { ...baseDetails, status: "running", progress: { status: "run", depth: 1, startedAt: Date.now(), step } },
      false,
      width,
    );
  }

  it("shows the tail of a streaming response, not the head", () => {
    const head = "HEAD_SHOULD_DROP";
    const tail = "TAIL_NEWEST_TEXT";
    const long = `${head} ${"x".repeat(300)} ${tail}`;
    const responding = runningCard(`text ${long}`, 300).find((line) => line.includes("responding"));
    expect(responding).toBeDefined();
    expect(responding).toContain(tail);
    expect(responding).not.toContain(head);
    expect(responding?.startsWith("responding ...")).toBe(true);
  });

  it("shows the tail of streaming thinking, not the head", () => {
    const head = "THINK_HEAD_DROP";
    const tail = "THINK_TAIL_NEW";
    const long = `${head} ${"y".repeat(300)} ${tail}`;
    const thinking = runningCard(`think ${long}`, 300).find((line) => line.includes("thinking"));
    expect(thinking).toBeDefined();
    expect(thinking).toContain(tail);
    expect(thinking).not.toContain(head);
  });

  it("shows short streaming text in full without an ellipsis", () => {
    const responding = runningCard("text hello world", 200).find((line) => line.includes("responding"));
    expect(responding).toBe("responding hello world");
  });
});
