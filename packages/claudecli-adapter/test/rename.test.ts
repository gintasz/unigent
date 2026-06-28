import { describe, expect, it } from "vitest";
import { applyRename, prefixedToolName, stripPrefix } from "../src/rename.ts";

const NAMES = ["foom_call", "foom_return", "foom_throw", "foom_inspect"];

describe("prefix rename", () => {
  it("rewrites whole-word tool references in prose to their prefixed form", () => {
    const out = applyRename("Call foom_return now, or foom_throw to abort.", NAMES, "foom");
    expect(out).toBe("Call mcp__foom__foom_return now, or mcp__foom__foom_throw to abort.");
  });

  it("is idempotent — an already-prefixed name is not prefixed twice", () => {
    const once = applyRename("use foom_inspect", NAMES, "foom");
    const twice = applyRename(once, NAMES, "foom");
    expect(once).toBe("use mcp__foom__foom_inspect");
    expect(twice).toBe(once);
  });

  it("leaves unrelated text untouched", () => {
    const out = applyRename("the foomulator returns foomy results", NAMES, "foom");
    expect(out).toBe("the foomulator returns foomy results");
  });

  it("round-trips through stripPrefix", () => {
    const prefixed = prefixedToolName("foom", "foom_return");
    expect(prefixed).toBe("mcp__foom__foom_return");
    expect(stripPrefix("foom", prefixed)).toBe("foom_return");
    expect(stripPrefix("foom", "Read")).toBe("Read");
  });
});
