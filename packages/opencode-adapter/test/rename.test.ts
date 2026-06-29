import { describe, expect, it } from "vitest";
import { applyRename, prefixedToolName, stripPrefix } from "../src/rename.ts";

describe("opencode tool-name prefix", () => {
  it("prefixes a canonical name with `<server>_`", () => {
    expect(prefixedToolName("foom", "foom_return")).toBe("foom_foom_return");
  });

  it("strips the prefix back to canonical (and leaves un-prefixed names)", () => {
    expect(stripPrefix("foom", "foom_foom_return")).toBe("foom_return");
    expect(stripPrefix("foom", "bash")).toBe("bash");
  });

  it("rewrites whole-word tool references and is idempotent", () => {
    const names = ["foom_return", "foom_throw"];
    const once = applyRename("call foom_return or foom_throw", names, "foom");
    expect(once).toBe("call foom_foom_return or foom_foom_throw");
    // running again must not double-prefix (the leading `_` blocks the boundary)
    expect(applyRename(once, names, "foom")).toBe(once);
  });

  it("does not touch unrelated text", () => {
    expect(applyRename("the return value", ["foom_return"], "foom")).toBe("the return value");
  });
});
