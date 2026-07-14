import { spawnSync } from "node:child_process";
import process from "node:process";

interface ClipboardCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
}

function clipboardCommands(platform: NodeJS.Platform): readonly ClipboardCommand[] {
  if (platform === "darwin") {
    return [{ executable: "pbcopy", arguments: [] }];
  }
  if (platform === "win32") {
    return [{ executable: "clip.exe", arguments: [] }];
  }
  return [
    { executable: "wl-copy", arguments: [] },
    { executable: "xclip", arguments: ["-selection", "clipboard"] },
    { executable: "xsel", arguments: ["--clipboard", "--input"] },
  ];
}

function copyWithCommand(text: string, command: ClipboardCommand): boolean {
  const result = spawnSync(command.executable, command.arguments, {
    encoding: "utf8",
    input: text,
    stdio: ["pipe", "ignore", "ignore"],
  });
  return result.error === undefined && result.status === 0;
}

function copyToClipboard(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  return clipboardCommands(process.platform).some((command) => copyWithCommand(text, command));
}

export { clipboardCommands, copyToClipboard, copyWithCommand };
