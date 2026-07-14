import { describe, expect, it } from "vitest";
import { fatalErrorMessage } from "../src/error_message.ts";

describe("fatal error messages", () => {
  it("keeps a single pathless validation issue compact", () => {
    expect(
      fatalErrorMessage({
        issues: [{ message: "Invalid input: expected string, received undefined", path: [] }],
      }),
    ).toBe("Invalid input: expected string, received undefined");
  });

  it("prints every validation issue with its input path", () => {
    expect(
      fatalErrorMessage({
        issues: [
          { message: "Invalid input: expected string, received undefined", path: ["name"] },
          { message: "Invalid input: expected number, received undefined", path: ["age"] },
          { message: "Invalid input: expected boolean, received undefined", path: ["options", 0] },
        ],
      }),
    ).toBe(
      [
        "validation failed:",
        "  input.name: expected string, received undefined",
        "  input.age: expected number, received undefined",
        "  input.options[0]: expected boolean, received undefined",
      ].join("\n"),
    );
  });

  it("does not reinterpret ordinary errors", () => {
    expect(fatalErrorMessage(new Error("script failed"))).toBe("script failed");
  });
});
