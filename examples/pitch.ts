// A maximal Unigent example: turn one product idea into a polished elevator pitch.
//
// Run it:
//   unigent tui examples/pitch.ts "a budgeting app for freelancers"
//
// It writes ./pitch.json through a source-derived Unigent tool.

import { writeFile } from "node:fs/promises";
import process from "node:process";
import { AgentRaisedError, agent, args, done, fail, piAgent } from "@unigent/sdk";
import { z } from "zod";

const WHITESPACE = /\s+/u;
const Input = z.string().min(1);
const PitchSchema = z.object({
  headline: z.string(),
  body: z.string(),
  score: z.number().min(0).max(100),
});

interface Pitch {
  readonly headline: string;
  readonly body: string;
  readonly score: number;
}

/** Count the words in a line of copy. */
function wordCount(text: string): number {
  return text.trim().split(WHITESPACE).filter(Boolean).length;
}

/** Return a deterministic 0-100 punchiness score for a line of copy.
 *
 * @promptSnippet Use this to compare candidate pitch copy.
 * @promptGuideline Do not call rate more than five times per draft.
 */
function rate(text: string): number {
  return Math.max(0, Math.min(100, 120 - wordCount(text) * 6));
}

/** Persist the final pitch as JSON to ./pitch.json. */
async function save(pitch: Pitch): Promise<void> {
  await writeFile("./pitch.json", `${JSON.stringify(pitch, undefined, 2)}\n`);
}

const base = agent({
  name: "pitch-writer",
  source: import.meta.url,
  backend: piAgent({ base: "clean", nativeTools: [] }),
  model: "openrouter/deepseek/deepseek-v4-flash",
  thinking: "low",
  systemPrompt: { append: "Be terse. Write truthful marketing copy, never code." },
  tools: [wordCount, rate, save, fail],
  retries: 1,
  limits: { turnDuration: "3m", nestedAgentDepth: 4 },
});

const idea = await args(Input, {
  description: "Turn a product idea into a scored elevator pitch.",
  usage: '"Product idea"',
});
const work = base.scope("pitch", { limits: { budgetUsd: 0.5 } });

let angles: string[];
try {
  const result = await work.run(
    `List up to four distinct angles for pitching this product idea: ${idea}. ` +
      "If it is incoherent, call unigent_fail.",
    z.array(z.string()).max(4),
  );
  angles = result.output;
} catch (error) {
  if (error instanceof AgentRaisedError) {
    throw new Error(`unworkable idea: ${error.message}`, { cause: error });
  }
  throw error;
}

const ranking = work.scope("ranking");
ranking.annotate({ angleCount: angles.length });
const scored = await Promise.all(
  angles.map(async (angle, index) => {
    const result = await ranking
      .scope(`angle-${index}`)
      .run(
        `Call the rate tool for this angle, then return its angle and score: ${angle}`,
        z.object({ angle: z.string(), score: z.number() }),
      );
    return result.output;
  }),
);
const best = scored.reduce((left, right) => (right.score > left.score ? right : left));
ranking.log(`best angle scored ${best.score}`);

const drafting = work.scope("drafting").session();
await drafting.run(`We are drafting an elevator pitch for this angle: ${best.angle}. Reply ready.`);
const punchyBranch = drafting.fork();
const formalBranch = drafting.fork();
const [punchy, formal] = await Promise.all([
  punchyBranch.run(
    "Write a punchy two-line pitch. Use wordCount and rate, then return the pitch.",
    PitchSchema,
  ),
  formalBranch.run(
    "Write a formal two-line pitch. Use wordCount and rate, then return the pitch.",
    PitchSchema,
  ),
]);
const draftWinner = punchy.output.score >= formal.output.score ? punchy.output : formal.output;

const polish = work.scope("polish").with({
  model: "openrouter/deepseek/deepseek-v4-pro",
  thinking: "high",
  limits: { turnDuration: "1m" },
});
const samples = await Promise.all([
  polish
    .scope("variant-a")
    .run(
      `Tighten this pitch and rescore it with rate: ${JSON.stringify(draftWinner)}`,
      PitchSchema,
    ),
  polish
    .scope("variant-b")
    .run(
      `Produce a sharper truthful variant and rescore it: ${JSON.stringify(draftWinner)}`,
      PitchSchema,
    ),
]);
const winner = samples
  .map((sample) => sample.output)
  .reduce((left, right) => (right.score > left.score ? right : left));

await work
  .scope("save")
  .run(`Call the save tool exactly once with this final pitch: ${JSON.stringify(winner)}`, done);
process.stdout.write(`${JSON.stringify(winner, undefined, 2)}\n`);
