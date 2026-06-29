import { describe, expect, it } from "vitest";
import { makeNaming } from "../src/rename.ts";

describe("makeNaming — bracket style (Claude Code)", () => {
  const { prefixedToolName, stripPrefix, applyRename } = makeNaming("bracket");

  it("prefixes and strips the `mcp__<server>__` form", () => {
    expect(prefixedToolName("foom", "foom_return")).toBe("mcp__foom__foom_return");
    expect(stripPrefix("foom", "mcp__foom__foom_return")).toBe("foom_return");
    expect(stripPrefix("foom", "bash")).toBe("bash");
  });

  it("rewrites whole-word references and is idempotent", () => {
    const once = applyRename(
      "call foom_return or foom_throw",
      ["foom_return", "foom_throw"],
      "foom",
    );
    expect(once).toBe("call mcp__foom__foom_return or mcp__foom__foom_throw");
    expect(applyRename(once, ["foom_return", "foom_throw"], "foom")).toBe(once);
  });
});

describe("makeNaming — underscore style (OpenCode)", () => {
  const { prefixedToolName, stripPrefix, applyRename } = makeNaming("underscore");

  it("prefixes and strips the `<server>_` form", () => {
    expect(prefixedToolName("foom", "foom_return")).toBe("foom_foom_return");
    expect(stripPrefix("foom", "foom_foom_return")).toBe("foom_return");
  });

  it("rewrites whole-word references without double-prefixing", () => {
    const once = applyRename("use foom_return", ["foom_return"], "foom");
    expect(once).toBe("use foom_foom_return");
    expect(applyRename(once, ["foom_return"], "foom")).toBe(once);
  });

  it("does not touch unrelated text", () => {
    expect(applyRename("the return value", ["foom_return"], "foom")).toBe("the return value");
  });
});
