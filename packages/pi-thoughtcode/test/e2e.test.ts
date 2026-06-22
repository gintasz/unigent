/**
 * Closed-loop e2e for pi-thoughtcode. Runs a real pi AgentSession (in-process, no TUI) with the
 * thoughtcode extension, prompts it to execute a VIBEFUNCTION, and asserts on the structured debug log
 * + captured tool results — never on LLM wording.
 *
 * This is the end-to-end smoke layer; the deterministic guarantees for the type system live in
 * return-type.test.ts and extension.test.ts (faux provider). One execution per scenario.
 *
 * A scenario is SKIPPED (not failed) when the run hit a transport/provider error — empirically the
 * dominant failure mode here is "Connection error." talking to the provider, which the model SDK
 * already retries with backoff. A connection drop is an infra event, not a code regression, so we
 * refuse to turn it red. Red here means the model genuinely produced the wrong behavior. Also skips
 * when the test model has no configured auth.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createThoughtcodeHarness, hasModelAuth, type LogEntry, type ThoughtcodeHarness } from "./harness.js";

const LLM_TIMEOUT = 180_000;

const live = await hasModelAuth();
const describeLive = live ? describe : describe.skip;
if (!live) {
  console.warn("[thoughtcode e2e] skipped — no auth for the test model.");
}

const RECURSIVE = [
  "# recursive factorial",
  "VIBEFUNCTION main() -> number.integer",
  "    res = VIBECALL fac(n = 2)",
  "    VIBERETURN(res)",
  "",
  "VIBEFUNCTION fac(n: number) -> number.integer",
  "    if n <= 1",
  "        VIBERETURN(1)",
  "    else",
  "        subres = VIBECALL fac(n = n - 1)",
  "        n = n * subres",
  "    VIBERETURN(n)",
  "",
].join("\n");

const BOGUS_TYPE = [
  "# bogus return type",
  "VIBEFUNCTION main()",
  "    res = VIBECALL fac(n = 2)",
  "    VIBERETURN(res)",
  "",
  "VIBEFUNCTION fac(n: number) -> intfaketype",
  "    VIBERETURN(1)",
  "",
].join("\n");

const WRONG_RETURN = [
  "# returns a string where number.integer is declared",
  "VIBEFUNCTION main()",
  "    res = VIBECALL fac(n = 2)",
  "    VIBERETURN(res)",
  "",
  "VIBEFUNCTION fac(n: number) -> number.integer",
  "    VIBERETURN(hello)",
  "",
].join("\n");

function skipOnTransportError(ctx: { skip: (note?: string) => void }, h: ThoughtcodeHarness): void {
  if (h.hadTransportError()) ctx.skip("provider/transport error (e.g. Connection error) — infra, not a regression");
}

const returnsInLog = (log: LogEntry[]): LogEntry[] => log.filter((e) => e.kind === "return");
const vibeReturnTypeErrors = (log: LogEntry[]): LogEntry[] =>
  log.filter((e) => e.kind === "tool.end" && e.toolName === "VIBERETURN" && e.isError === true);

async function runProgram(file: string, contents: string, function_name: string): Promise<ThoughtcodeHarness> {
  const h = await createThoughtcodeHarness();
  const path = await h.writeProgram(file, contents);
  await h.execute(path, function_name);
  return h;
}

describeLive("thoughtcode e2e: typed recursion (happy path)", () => {
  let h: ThoughtcodeHarness;
  let log: LogEntry[];

  beforeAll(async () => {
    h = await runProgram("rec.txt", RECURSIVE, "main");
    log = await h.readLog();
  }, LLM_TIMEOUT);

  it("delegates the nested call via the VIBECALL tool", (ctx) => {
    skipOnTransportError(ctx, h);
    expect(h.toolCalls).toContain("VIBECALL");
  });

  it("spawns at least one nested subagent run", (ctx) => {
    skipOnTransportError(ctx, h);
    expect(log.some((e) => e.kind === "run.start" && e.depth === 2)).toBe(true);
  });

  it("produces integer returns with no type rejections", (ctx) => {
    skipOnTransportError(ctx, h);
    expect(vibeReturnTypeErrors(log)).toHaveLength(0);
    const values = returnsInLog(log).map((e) => String(e.value));
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(Number.isInteger(Number(v))).toBe(true);
  });
});

describeLive("thoughtcode e2e: unrecognized return type fails loudly", () => {
  let h: ThoughtcodeHarness;

  beforeAll(async () => {
    h = await runProgram("bogus.txt", BOGUS_TYPE, "main");
  }, LLM_TIMEOUT);

  it("surfaces an error naming the unrecognized type", (ctx) => {
    skipOnTransportError(ctx, h);
    // The bad type is caught either at load (VIBELOADPROGRAM validates the whole program) or at the
    // VIBECALL boundary (resolveReturnType) — accept whichever surface the model reaches first.
    const failed = h.toolResults.filter(
      (r) =>
        (r.toolName === "VIBELOADPROGRAM" || r.toolName === "VIBECALL") &&
        /(unrecognized return type|syntax error)/i.test(r.text),
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((r) => r.text.includes("intfaketype"))).toBe(true);
  });
});

describeLive("thoughtcode e2e: wrong-typed return is rejected", () => {
  let h: ThoughtcodeHarness;
  let log: LogEntry[];

  beforeAll(async () => {
    h = await runProgram("wrong.txt", WRONG_RETURN, "main");
    log = await h.readLog();
  }, LLM_TIMEOUT);

  it("rejects the string return against the declared int type", (ctx) => {
    skipOnTransportError(ctx, h);
    const errors = vibeReturnTypeErrors(log);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /must be a number|must be an integer/i.test(String(e.result)))).toBe(true);
  });
});
