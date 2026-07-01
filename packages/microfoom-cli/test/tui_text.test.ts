import { describe, expect, it } from "vitest";
import { tidy } from "../src/tui/text.ts";

// `tidy` keeps the transcript pane from rendering a model's blank-line padding as a
// tall empty gap (a body of mostly newlines streamed before a tool call).
describe("tidy (transcript whitespace normalization)", () => {
  it("collapses a run of 3+ blank lines to a single blank line", () => {
    expect(tidy("**V41:**\n\n\n\n\n\n\nnext")).toBe("**V41:**\n\nnext");
  });

  it("strips trailing spaces on each line", () => {
    expect(tidy("a   \nb\t\nc")).toBe("a\nb\nc");
  });

  it("trims leading and trailing whitespace", () => {
    expect(tidy("\n\n  hello  \n\n")).toBe("hello");
  });

  it("leaves already-tidy text untouched", () => {
    expect(tidy("one\n\ntwo\nthree")).toBe("one\n\ntwo\nthree");
  });

  it("reduces an all-whitespace body to the empty string (no gap)", () => {
    expect(tidy("\n \n\t\n\n")).toBe("");
  });
});
