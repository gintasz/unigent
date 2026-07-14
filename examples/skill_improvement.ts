// Iteratively improve a PRD-writing skill using parallel Unigent runs.
//
// Side effects: writes ./SKILL-<i>.md, ./PRD-<i>-<j>.md, ./CHANGES-<i>.md,
// and a resumable checkpoint log at ./.unigent/skill-improvement.jsonl.
//
// Run it:
//   unigent examples/skill_improvement.ts --rounds 3 --batchSize 3

import { agent, args, createFileCheckpointStore, done, piAgent } from "@unigent/sdk";
import { z } from "zod";

const Input = z.object({
  batchSize: z.number().int().positive().default(3),
  rounds: z.number().int().positive().default(3),
});

const defaults = {
  backend: piAgent({
    base: "clean",
    nativeTools: ["read", "write", "edit", "bash"],
    plugins: [],
    skills: [],
  }),
  checkpoint: createFileCheckpointStore(".unigent/skill-improvement.jsonl"),
  limits: { turnDuration: "5m" as const },
};

const writer = agent({
  ...defaults,
  name: "skill-improvement",
  model: "openrouter/deepseek/deepseek-v4-flash",
  thinking: "low",
});

const improver = agent({
  ...defaults,
  name: "skill-improver",
  model: "openrouter/deepseek/deepseek-v4-pro",
  thinking: "high",
});

async function improveSkill(iteration: number, size: number): Promise<void> {
  const lastPrd = size - 1;
  await improver.run(
    `
      Goal: build a PRD-writing skill that turns a short software brief into a complete specification.

      Optimize for vision, foresight, cohesion, readability, production readiness, information density,
      and compactness. Never mention this optimization objective in the skill document. Avoid MVP framing.

      Read ./PRD-${iteration}-0.md through ./PRD-${iteration}-${lastPrd}.md.
      Improve ./SKILL-${iteration}.md so the next iteration produces better PRDs.
      Rewrite writer-based prose as reader-based prose.
      Create ./CHANGES-${iteration}.md with one paragraph describing the changes.
    `,
    done,
  );
}

const { batchSize, rounds } = await args(Input, {
  description: "Iteratively improve a PRD-writing skill.",
  usage: "[--rounds <number>] [--batchSize <number>]",
});
await writer.run(
  'Create ./SKILL-0.md containing exactly: "Make a really good specification".',
  done,
);

for (let iteration = 0; iteration < rounds; iteration += 1) {
  const round = writer.scope(`round-${iteration}`);
  if (iteration > 0) {
    await round.run(`Copy ./SKILL-${iteration - 1}.md to ./SKILL-${iteration}.md.`, done);
  }

  const briefsResult = await round.run(
    `Return ${batchSize} distinct subagent prompts. Each prompt must name a different software system, ` +
      "tell the subagent to make every product decision itself, and require it to follow " +
      `./SKILL-${iteration}.md.`,
    z.array(z.string()).length(batchSize),
  );

  await Promise.all(
    briefsResult.output.map((brief, index) =>
      round.run(`${brief}\n\nWrite the finished PRD to ./PRD-${iteration}-${index}.md.`, done),
    ),
  );
  await improveSkill(iteration, batchSize);
}
