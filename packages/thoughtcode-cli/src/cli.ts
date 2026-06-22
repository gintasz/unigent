#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateProgramSyntax } from "thoughtcode-core";

const USAGE = `thoughtcode — ThoughtCode tooling

Usage:
  thoughtcode check <file>...   Validate program syntax (does not run the program)

Exit codes:
  0  no errors
  1  syntax errors found
  2  usage or file error
`;

/**
 * Validate each file's syntax. Success is silent (exit 0); syntax errors print to stdout (exit 1);
 * unreadable files / no files print to stderr (exit 2). Errors take precedence over IO issues.
 */
async function check(files: string[]): Promise<number> {
  if (files.length === 0) {
    process.stderr.write("thoughtcode check: no files given\n");
    return 2;
  }
  let hasSyntaxError = false;
  let hasIoError = false;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      process.stderr.write(`thoughtcode: cannot read ${file}\n`);
      hasIoError = true;
      continue;
    }
    const result = validateProgramSyntax(text);
    if (!result.ok) {
      hasSyntaxError = true;
      for (const error of result.errors) {
        process.stdout.write(`${file}: ${error}\n`);
      }
    }
  }
  if (hasSyntaxError) return 1;
  if (hasIoError) return 2;
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "check":
      return check(rest);
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    case undefined:
      process.stderr.write(USAGE);
      return 2;
    default:
      process.stderr.write(`thoughtcode: unknown command \`${command}\`\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`thoughtcode: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
