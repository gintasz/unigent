// Maximalist example that exercises the whole microfoom surface in one coherent task:
// turn a one-line product idea into a polished elevator pitch.
//
// Run it:
//   microfoom run examples/pitch.ts "a budgeting app for freelancers"
//   node --import tsx examples/run.ts examples/pitch.ts "a CLI to tidy dotfiles"
//
// It writes ./pitch.json as a side effect (the `save` tool).

import { writeFile } from "node:fs/promises";
import { FoomThrowError, foom, Program } from "@microfoom/core";
import "@microfoom/core/trace";
import { z } from "zod"; // any Standard Schema validator works

const WHITESPACE = /\s+/u;

const Idea = z.string().min(1);

const Pitch = z.object({
  headline: z.string(),
  body: z.string(),
  score: z.number().min(0).max(100),
});
type Pitch = z.infer<typeof Pitch>;

// ── Class scope of the config cascade (run-defaults → class → method → .with) ──
@foom.config({
  model: "openrouter/deepseek/deepseek-v4-flash",
  harness: "pi",
  thinking: "low",
  tools: [], // disable harness tools, except FOOM tools
  retries: 1, // re-run a turn once on a transient harness/network failure
  maxConcurrentRootTurns: 5, // cap concurrent top-level turns (nested foom_calls exempt)
  maxBudgetUsd: 0.5, // whole-run cost ceiling; exceeding aborts
  systemPrompt: { append: "Be terse. Marketing copy, never code." },
})
export default class Pitchwright extends Program(Idea) {
  // Whole-program wall-clock ceiling.
  static maxProgramDuration = "3m";

  async main(idea: string): Promise<Pitch> {
    // 1) Structured turn → schema-validated, typed value. The agent ends with
    //    foom_return; malformed output is auto-repaired. If the idea is unworkable
    //    it calls foom_throw instead — surfaced to your code as FoomThrowError.
    let angles: string[];
    try {
      angles = await this.agent.value(z.array(z.string()).max(4))`
        List up to 4 distinct angles to pitch a solution for this idea: ${idea}.
        If the idea is empty or incoherent, call foom_throw instead. Call foom_return tool with the list.`;
    } catch (error) {
      if (error instanceof FoomThrowError) {
        throw new Error(`unworkable idea: ${error.message}`, { cause: error });
      }
      throw error;
    }

    // 2) A named trace scope: annotate it, fan child turns out in PARALLEL (plain
    //    TypeScript owns the control flow), each one foom_calling the exposed `rate`
    //    method (its own span nests under the scope), then log a line. The whole
    //    subtree shows up in the --tui inspector.
    const ranking = this.agent.scope("rank");
    ranking.annotate({ angleCount: angles.length });
    const scored = await Promise.all(
      angles.map(
        (angle, i) =>
          ranking
            .with({ label: `angle-${i}` })
            .value(z.object({ angle: z.string(), score: z.number() }))`
            Use foom_call tool with method 'rate' on this angle to get a 0-100 punchiness score: ${angle}.
            Then call foom_return tool with the angle and score.`,
      ),
    );
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    ranking.log(`best angle scored ${best.score}`);

    // 3) Cross-session: open a STATEFUL session (shared transcript), seed it once,
    //    then fork() into two independent tonal branches that each continue from
    //    that shared context. Pick the better-scoring draft.
    const draft = this.agent.session({ thinking: "medium" });
    await draft.prose`We are drafting an elevator pitch for this angle: ${best.angle}. Reply "ready".`;
    const [punchy, formal] = await Promise.all([
      draft.fork().value(Pitch)`
        Write a PUNCHY two-line pitch (headline + body, each under 12 words — you may use
        foom_call tool with method 'wordCount' to check). Use foom_call method 'rate' to get a score.
        Don't do more than 5 rate calls.
        Then call foom_return tool with the Pitch.`,
      draft.fork().value(Pitch)`
        Write a FORMAL two-line pitch (headline + body, each under 12 words — you may use
        foom_call tool with method 'wordCount' to check). Use foom_call method 'rate' to get a score.
        Don't do more than 5 rate calls.
        Then call foom_return tool with the Pitch.`,
    ]);
    const draftWinner = punchy.score >= formal.score ? punchy : formal;

    // 4) Best-of-N on a STRONGER model (cross-model). Two stateless samples of one
    //    prompt: distinct `storeKey`s keep them as separate store records under
    //    --store (otherwise identical turns collapse to one). Keep the better.
    //    Swap `model` for `harness: "claudecli"` here to route it CROSS-HARNESS
    const polish = (key: string) =>
      this.agent
        .with({ model: "openrouter/deepseek/deepseek-v4-pro", thinking: "high", storeKey: key })
        .value(Pitch)`
          Tighten this pitch to its sharpest, most truthful form. Use foom_call tool with method 'rate' on the new
          body to get a new score. Don't do more than 5 rate calls. Then call foom_return tool with the Pitch: ${JSON.stringify(draftWinner)}`;
    const samples = await Promise.all([polish("polish-a"), polish("polish-b")]);
    const winner = samples.reduce((a, b) => (b.score > a.score ? b : a));

    // 5) Act turn (`do`): side effects only, no final response tokens billed. The agent
    //    persists the result through the `save` tool, then ends with a no-arg foom_return call.
    await this.agent.do`Save the final pitch via the save tool: ${JSON.stringify(winner)}`;

    // 6) Read run usage and record it as a trace log — it shows in the --tui span
    //    tree / run panel. (A program shouldn't write to stdout under --tui: that
    //    bypasses the inspector's renderer and corrupts the screen.)
    const { totalTokens, costUsd } = this.agent.usage;
    this.agent.scope("usage").log(`${totalTokens} tokens · $${(costUsd ?? 0).toFixed(4)}`);

    return winner;
  }

  // Silent expose: agent-callable via foom_call, but NOT advertised — the agent
  // only learns it exists when you name it in a prompt, then foom_inspects its
  // signature before calling. Pure, offline.
  @foom.expose
  async wordCount(text: string): Promise<number> {
    return text.trim().split(WHITESPACE).filter(Boolean).length;
  }

  // Announced expose: named in the system prompt so the agent knows it's there
  // (it still foom_inspects for the signature). A deterministic punchiness score.
  @foom.expose({ announcement: "Returns a 0–100 punchiness score for a line of copy." })
  async rate(text: string): Promise<number> {
    const words = await this.wordCount(text);
    return Math.max(0, Math.min(100, 120 - words * 6));
  }

  // Tool expose: a first-class native tool the harness advertises up front, with a
  // full parameter schema. Persists the result to disk.
  @foom.expose({ tool: { description: "Persist the final pitch as JSON to ./pitch.json." } })
  async save(pitch: Pitch): Promise<void> {
    await writeFile("./pitch.json", `${JSON.stringify(pitch, null, 2)}\n`);
  }
}
