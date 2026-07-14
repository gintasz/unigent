import process from "node:process";
import { describe, expect, it } from "vitest";
import { clipboardCommands, copyWithCommand } from "../src/tui/clipboard.ts";

describe("clipboard reporting", () => {
  it("reports success only when the clipboard command exits successfully", () => {
    expect(
      copyWithCommand("copy me", {
        executable: process.execPath,
        arguments: ["-e", "process.stdin.resume()"],
      }),
    ).toBe(true);
    expect(
      copyWithCommand("copy me", {
        executable: process.execPath,
        arguments: ["-e", "process.exit(9)"],
      }),
    ).toBe(false);
  });

  it("uses a clipboard command that can report an exit status", () => {
    expect(clipboardCommands("darwin")).toEqual([{ executable: "pbcopy", arguments: [] }]);
    expect(clipboardCommands("win32")).toEqual([{ executable: "clip.exe", arguments: [] }]);
    expect(clipboardCommands("linux")).toContainEqual({
      executable: "wl-copy",
      arguments: [],
    });
  });
});
