#!/usr/bin/env bun

// Copy this file anywhere and run it without a package.json or install step.
// Bun downloads the Unigent packages into its global cache on first use.
//
// Run it:
//   chmod +x standalone.ts
//   ./standalone.ts "Write a launch announcement for a kebab app"

import { agent, args, claudeCli } from "@unigent/sdk";
import { z } from "zod";

const input = await args(z.string().min(1), {
  description: "Run one prompt through Claude CLI.",
  usage: '"Your prompt"',
});
const writer = agent({
  name: "writer",
  backend: claudeCli({ nativeTools: [] }),
  model: "sonnet",
});
const result = await writer.run(input);
process.stdout.write(`${result.output}\n`);
