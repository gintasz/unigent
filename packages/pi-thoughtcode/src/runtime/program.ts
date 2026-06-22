import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseProgram, type Program } from "thoughtcode-core";

export type LoadedProgram = { ok: true; program: Program; text: string } | { ok: false };

/** Read a program file once and parse it into the reusable {@link Program} model. */
export async function loadProgram(programFilePath: string, cwd: string | undefined): Promise<LoadedProgram> {
  try {
    const absolute = isAbsolute(programFilePath) ? programFilePath : resolve(cwd ?? process.cwd(), programFilePath);
    const text = await readFile(absolute, "utf8");
    return { ok: true, program: parseProgram(text), text };
  } catch {
    return { ok: false };
  }
}
