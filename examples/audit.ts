// A deliberately multi-stage program to exercise the full observability surface
// (F8) and the CLI run panel. It produces a deep span tree:
//
//   ▼ main
//     ▸ intro                 (sequential turn)
//     ▼ audit   routeCount=3  (scope: annotate + log + concurrent child turns)
//       ▸ /login              (concurrent labeled turns under the scope)
//       ▸ /signup
//       ▸ /reset
//       ▼ deep-check          (nested scope)
//         ▸ /login
//       • 3 routes audited    (scope log line)
//     ▸ value                 (a turn whose agent foom_calls score() → method span)
//     ▸ text                  (final streamed summary turn)
//
// Every value turn is string-typed so it also runs under `--harness fake`
// (the fake session returns strings). Run it:
//   microfoom run examples/audit.ts "acme.com"
//   pnpm cli examples/audit.ts "acme.com" --harness fake   # offline, deterministic

import { foom, Program } from "@microfoom/core";
// Importing the trace entry adds the instrumentation surface (scope/annotate/log)
// to `this.agent` — the methods exist at runtime regardless; this types them (F8).
import "@microfoom/core/trace";
import { z } from "zod";

// Schemas are any Standard Schema (F4); zod implements it natively, so a bare
// `z.string()` is a valid return/input schema — no wrapper needed.
const site = z.string();

@foom.config({
  model: process.env.MICROFOOM_MODEL ?? "openrouter/deepseek/deepseek-v4-flash",
  thinking: "low",
  // No harness tools — the program drives everything via FOOM (foom_return / score).
  tools: [],
})
export default class Audit extends Program(site) {
  async main(target: string): Promise<string> {
    // 1) A plain sequential turn. `.with({ label })` names its row in the panel.
    const intro = await this.agent.with({ label: "intro" }).value(z.string())`
      One short sentence introducing a security audit of ${target}.
      Respond ONLY with the foom_return tool call carrying that sentence.
    `;

    // 2) A named scope: annotate it, fan out concurrent labeled child turns, then
    // log. Each route turn (and the nested scope) nests under "audit" in the panel.
    const routes = ["/login", "/signup", "/reset"];
    const audit = this.agent.scope("audit");
    audit.annotate({ routeCount: routes.length });

    const findings = await Promise.all(
      routes.map(
        (route) => audit.with({ label: route }).value(z.string())`
          Give a one-line finding about missing authentication on the ${route} route
          of ${target}. Respond ONLY with the foom_return tool call.
        `,
      ),
    );

    // A nested scope under "audit" — re-checks the riskiest route, one level deeper.
    const primary = routes[0] ?? "/login";
    const deep = audit.scope("deep-check");
    const recheck = await deep.with({ label: primary }).value(z.string())`
      Re-examine ${primary} for auth bypass specifically. One line.
      Respond ONLY with the foom_return tool call.
    `;
    audit.log(`${findings.length} routes audited`);

    // 3) A turn that asks the agent to call an exposed method (a foom_call → its
    // own method span in the tree), then return a string verdict.
    const verdict = await this.agent.with({ label: "verdict" }).value(z.string())`
      Call score with findingCount=${findings.length} to get a numeric risk score,
      then foom_return a one-line verdict that includes that score.
    `;

    // 4) A final streamed text turn that composes the report.
    return await this.agent.with({ label: "summary" }).text`
      Write a two-sentence security audit summary for ${target}.
      Intro: ${intro}
      Findings: ${[...findings, recheck].join(" | ")}
      Verdict: ${verdict}
    `;
  }

  // Exposed so the agent may foom_call it (capability security, F3). Pure TS — a
  // deterministic risk score from the finding count.
  @foom.expose({ announcement: "Returns a 0–100 risk score for a given finding count." })
  async score(findingCount: number): Promise<number> {
    return Math.min(100, findingCount * 25);
  }
}
