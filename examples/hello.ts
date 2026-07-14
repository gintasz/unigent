// A minimal Unigent agent.
//
// Run it:
//   unigent examples/hello.ts "Chuck Norris"

import process from "node:process";
import { agent, args, piAgent } from "@unigent/sdk";
import { z } from "zod";

const Name = z.string().min(1);

const hello = agent({
  name: "hello",
  backend: piAgent(),
  model: "openrouter/deepseek/deepseek-v4-flash",
});

const who = await args(Name, {
  description: "Write a greeting for one person.",
  usage: '"Name"',
});
const result = await hello.run(
  `Write a warm, one-sentence greeting for ${who} embarking on a new journey.`,
);

process.stdout.write(`${result.output}\n`);
