import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

for (const file of ["README.md", "LICENSE"]) {
  if (!existsSync(join(process.cwd(), file))) {
    throw new Error(
      `${basename(process.cwd())} is missing ${file}; publish through the root release workflow`,
    );
  }
}
