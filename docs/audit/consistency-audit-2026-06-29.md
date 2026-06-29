# microfoom Internal-Consistency & Naming Audit

> Pre-open-source sweep. Produced 2026-06-29 by a multi-agent audit (5 dimensions → adversarial verification → synthesis). 25 findings confirmed, 7 dropped as false-positive/intentional. `docs-website/` excluded by request. No code was edited — this is the review artifact.
>
> **STATUS — IMPLEMENTED 2026-06-29** on branch `claude/funny-wilbur-7a5f21` (46 files, +473/-416; not yet committed). Every finding below is applied. P3.7 resolved with option (a) (ban kept, retagged review). All gates green: typecheck · 157 tests · biome lint · api:check · docs:check · dependency-cruiser · knip · jscpd · syncpack.
>
> **Revised 2026-06-29 (maintainer corrections):** (1) `Foomtime` is dead codename residue (the project's old name, renamed to microfoom) — it is **eliminated**, not preserved. (2) CONSTITUTION.md is a **candidate for change, not an authority** — it was an early draft and may itself be the defect. Where a constitution rule blocks higher coherence, the rule is amended, not the code bent to fit it. Findings whose only justification was "the constitution says so" are re-grounded on independent merit or dropped.

---

## Keystone decision (everything depends on it)

The single internal turn-executing component (runs turns, the repair loop, caps, dispatch) is named **four** ways across the repo:

| Name | Where |
|---|---|
| `runtime` | code majority; the test-pinned model prompt `"You are running inside a microfoom runtime."`; core run-context `interface Runtime` (program.ts:268); 5 of 6 constitution clauses (A5/E1/E3/F6/F7/X2) |
| `Foomtime` | program base class + 16 error classes (`FoomtimeError`, …) — `foom` + `runtime`; **DEAD CODENAME RESIDUE** |
| `engine` | README + 4 code comments |
| `run engine` | CONSTITUTION A1 only |

N5 ("one term per concept across code **and** prompts") forbids this split.

**Canonical: `runtime`** for the internal turn-executing component — chosen from what the thing *is*, not from file-headcount.

DNA test: *does your code run **inside** it (runtime), or do you hand work **to** it (engine)?* This component hosts the program (`extends FoomProgram`, it invokes your `main()`), the model "runs **inside**" it (prompt text), and it is a threaded run-context (`interface Runtime`, program.ts:268) carrying execution services — the in-process-runtime shape of Effect's `Runtime` / a Tokio runtime, **not** a VM/sandbox. `engine` is wrong because there is no distinct doer object you feed work to — the loop is functions over the runtime-context; "engine"/"run engine" were loose synonyms for a referent that doesn't exist separately. `engine` and `run engine` are retired on those grounds (not on losing a headcount).

- **`Foomtime` is eliminated** (not preserved — earlier draft of this report was wrong). It is the project's old codename (`foom`+`runtime`), renamed to microfoom; it has no reason to survive. All 17 symbols (`FoomtimeProgram` + 16 error classes) rename to the **`Foom*`** stem (drop `time`): `FoomProgram`, `FoomError`, `FoomAbortError`, …. `foom` is *live* protocol vocabulary (`foom_call`/`foom_return`, the `@foom` decorator, "FOOM tools"), so this ties the framework-identity types to the real protocol stem. (Alternative considered: `Microfoom*` — rejected as a ×17 mouthful that duplicates the `@microfoom/` namespace.)
- **Two-stem story** (resolves the "competing families" finding): **`Foom*` = framework identity** (`FoomProgram` base, `FoomError` taxonomy) · **`Agent*` = runtime-domain objects** (`AgentRun`, `AgentSession`, `AgentResult`, `AgentUsage`, `AgentConfig`, and the `this.agent` handle). Each stem has one job; the relationship is legible.
- **`framework`** = docs-only genus word (the project *is* a framework — three IoC inversions: lifecycle bootstrap, capability dispatch, observation hooks). Never a code identifier.
- `runtime` already appears in CONSTITUTION line 30 ("runtime performance" — different sense). The A1 amendment wording must disambiguate.
- **F6 does NOT reserve the *word* "runtime" from public identifiers** — its sound kernel is only "don't leak the internal `Runtime` *type* into public `.d.ts`." It is amended below to say so. It therefore never governed `this.agent` or `AgentRuntimeHooks`.

---

## Decisions locked (maintainer, 2026-06-29)

1. **`Foomtime*` — ELIMINATED → `Foom*`.** Dead codename. All 17 symbols rename (see rename map). New stem `Foom*` for framework-identity types; `Agent*` retained for runtime-domain types.
2. **`this.agent` — KEPT (confirmed), on merit (NOT on F6).** F6 never governed it (it bans leaking the internal `Runtime` *type*, not the lexeme). Kept because: it is consistent with the `Agent*` runtime-domain family, and `this.agent.value()/.do()/.prose()` reads as *commanding an agent* — the actual mental model. `this.runtime` was considered and declined (call-site ergonomics win over max disambiguation). The only forced change is the weld `AgentRuntimeHooks → AgentRunHooks` (consistency with `AgentRun` + drops the retired word). Add one README sentence distinguishing the per-turn agent from the handle.
3. **CONSTITUTION = candidate, not authority.** Amendments below stand on their own coherence merits, not on preserving the existing text. F6 is itself amended (lexeme vs type).
4. **`AgentEvent` forgotten export — FIX by re-exporting `AgentEvent` from the core barrel** (not by retyping `onEvent`).
5. **`ClaudeSpec.allowedHarnessTools` — KEPT + add TSDoc** explaining the `Harness` qualifier (disambiguates from the sibling `foomTools` field).
6. **Execution — report-only for now.** Nothing edited. Apply later in reviewable slices.

---

## Findings

Severities are the verified/adjusted values. P0 = behavioral contradiction or embarrassing public-surface defect; P3 = cosmetic.

### P0
None. (All originally-tagged P0s downgraded — they are drift across multiple surfaces, not single-artifact behavioral contradictions.)

### P1 — fix before public release

**P1.1 — `AgentEvent` is a committed forgotten-export on the *primary* entrypoint.**
`runProgram`'s `onEvent` callback parameter type cannot be imported from `@microfoom/core` (only via the `/trace` subpath). Violates A2 (one curated barrel), F6/X2 (internal type in a generated public `.d.ts`), F8 (common-path option, trace-only type).
- `packages/microfoom-core/etc/core.api.md` — `// Warning: (ae-forgotten-export) The symbol "AgentEvent" needs to be exported…` directly above `readonly onEvent?: (event: AgentEvent) => void`
- `packages/microfoom-core/src/events.ts:8` — `export type AgentEvent` on the common path
- `packages/microfoom-core/src/trace/index.ts:15` — re-exported ONLY here
- `packages/microfoom-core/src/index.ts` — barrel never re-exports it
- **Fix (locked):** re-export `AgentEvent` from `src/index.ts`. (`RunNode` is legitimately CLI/trace-only — leave it.)

**P1.2 — System prompt says "runtime"; README says "engine" for the same thing.** N5 drift at the model boundary.
- `packages/microfoom-core/src/program.ts:225` — `const PROTOCOL_INTRO = "You are running inside a microfoom runtime.";` (test-pinned)
- `README.md:106` — "this.agent is your handle to the engine — how your program drives the engine that runs agents."
- `README.md:131` — "An agent running inside a microfoom engine interacts with it through 4 native tools"
- **Fix:** change README "engine" → "runtime". The prompt is already canonical — do not touch it.

**P1.3 — CONSTITUTION A1 "run engine" vs "runtime" in 6 clauses.** The governing doc breaks its own N5.
- `CONSTITUTION.md:76` (A1) — "The reusable core library and run engine are harness-agnostic"
- `CONSTITUTION.md:80,119,121,158,159,224` (A5/E1/E3/F6/F7/X2) — all "runtime"
- **Fix:** amend A1 (see Amendments; disambiguate from line 30 "runtime performance").

**P1.4 — Effect U-turn residue (docs-only; code is already 100% effect-free).**
**Verified:** zero `effect`/`@effect` in any `package.json` dependency and zero `@effect`/`from "effect"` imports in any `src`. (The "effect" string in code is only React `useEffect`, the English "side effect", and the `noUncheckedSideEffectImports` tsconfig flag — none is the Effect library.) **No code change.** Effect is dead and irrelevant; the only residue is three documents:
- **ADR-0002** (the P1.4 defect) — "usage accounting stays a `@effect/typeclass` Monoid (OB3)" in the same decision that drops `effect`. Cross-checked against `docs/adr/0001-…md` ("hand-written `combineUsage`/`emptyUsage`") and `packages/microfoom-core/src/usage.ts` (plain TS). **Fix:** rewrite the bullet to the hand-written monoid.
- **ADR-0001** ("No Effect") — carries the *separate* false eslint claim (P1.5). Keep a one-line "Effect evaluated and rejected" as legitimate ADR history; strip the rest.
- **CONSTITUTION L2 + X2** — scar-tissue parentheticals "*(amended by ADR-0002 — the former Effect-internal mandate was dropped)*". **Fix:** delete them; restate positively (no "we used to use Effect" archaeology in the governing doc). See Amendments.

**P1.5 — ADR-0001 falsely claims "eslint removed — biome sole linter."** A live, gated type-aware ESLint layer exists. ADR-0001 is the source of truth binding enforcement-classes to tools, so this mis-describes L3/T1 enforcement.
- `docs/adr/0001-…md` (No Effect) — "…and eslint itself were removed — biome is the sole linter."; enforcement table has no ESLint row
- `eslint.config.js` — ~25 error-level type-aware rules (`no-unsafe-*`, `strict-boolean-expressions`, `only-throw-error`, `switch-exhaustiveness-check`, …); wired into `lint:types` + a lefthook hook
- **Fix:** correct both prose claims + add an enforcement-table row.

**P1.6 — Opaque public exports lack docstrings (violates ratified C2).**
- `cli.api.md` — `fakeOpenSession`, `Panel`, `ProgramClass`, `RenderOptions` `(undocumented)`
- `claudecli-adapter.api.md` — `CLAUDECLI_HARNESS_VERSION`, `ClaudeCliSessionOptions` `(undocumented)`
- `core.api.md` — `ControlToolName` `(undocumented)`
- **Fix:** add TSDoc to: `ControlToolName`, `ProgramClass`, `Panel`, `fakeOpenSession`, `RenderOptions`, `ClaudeCliSessionOptions`. (Self-evident getters like `AgentUsage.inputTokens` may stay terse.)

### P2 — should fix

**P2.1 — `foom_*` primitives named three live ways + one dead synonym.**
"control operations" / "control tools" / "FOOM tools" for one concept; plus fossil "keyword" (dead ThoughtCode-thesis residue) still in the constitution.
- `protocol.ts:7,19` — identifiers `CONTROL_TOOLS`/`isControlTool` mixed with prose "control operations"
- `CONSTITUTION.md` F2 "structured control operations"; I1 "tool/keyword definitions" (stale "keyword")
- `docs/adr/0003` — "control operations"/"control ops" interchangeably; `README.md` — "4 native tools" + "FOOM tools"
- **Fix:** canonicalize on **"control tool"** (matches immovable code identifiers `CONTROL_TOOLS`/`ControlToolName`/`isControlTool`). Amend F2; delete "keyword" from I1; gloss "FOOM tool" once as an alias. `foom_*` stay as wire names.

**P2.2 — `AgentRuntimeHooks` embeds the reserved word "runtime" in a public export.** Lone `Runtime` in an otherwise `AgentRun`/`AgentConfig`/`AgentUsage` family; borrows the word the constitution reserves for non-leaking internals.
- `core.api.md` — `export interface AgentRuntimeHooks { onToken?: … }`; intersected into public `AgentOptions`
- `options.ts:13` (definition); `program.ts:268` internal `interface Runtime` shares the word
- **Fix (locked):** rename `AgentRuntimeHooks` → **`AgentRunHooks`** (aligns with `AgentRun`; no collision). Update `options.ts`, the `index.ts` re-export, the `AgentOptions` intersection.

**P2.3 — Harness-tools allowlist has two public names.** `SessionTurnRequest.allowedTools` (core) vs `ClaudeSpec.allowedHarnessTools` (claudecli) for the same value (`allowedHarnessTools: request.allowedTools`). This is the *harness's own built-in tools* allowlist, NOT the model-provider wire mirror.
- **Decision (locked):** keep `allowedHarnessTools` + add a one-line TSDoc — the `Harness` qualifier disambiguates from the sibling `foomTools` field in the same DTO.

**P2.4 — Version constants disagree in shape; CLI has none.** All are decorative stamps with zero internal consumers.
- `CORE_VERSION` / `PI_HARNESS_VERSION` / `CLAUDECLI_HARNESS_VERSION` / (CLI: none)
- **Fix:** standardize to `<PKG>_VERSION` (`CORE_VERSION`, `PI_VERSION`, `CLAUDECLI_VERSION`, `CLI_VERSION`); add the missing CLI constant; drop the `_HARNESS_` infix (core is not a harness). Pre-1.0, do it now.

**P2.5 — Adapter internals leaked `@public`.** `buildSessionControls`/`ClaudeSessionControls` are pure internal helpers (only caller: `createClaudeCliOpenSession` + a unit test). The sibling pi-adapter exposes a clean minimal surface — the project norm.
- **Fix:** mark `buildSessionControls` + `ClaudeSessionControls` `@internal`. Keep `createClaudeCliOpenSession`, `ClaudeCliSessionOptions`, and the `ClaudeProcess*` injection seam public.

**P2.6 — X2's tag claims a "custom code-pattern checker" that was deleted.** The no-raw-try ast-grep rule was removed by ADR-0002; remaining ast-grep rules (`no-export-star`=L3, `no-expose-private`=F3) don't enforce X2's substance. Violates P-Bias.
- `CONSTITUTION.md:224` X2 tag claims `custom code-pattern checker` (= ast-grep); `config/ast-grep/rules/` holds only `no-export-star` (enforces L3/A2) and `no-expose-private` (enforces F3) — **neither enforces X2.** The ast-grep rule that did (ban raw `try` outside the facade) was deleted by ADR-0002. So X2 advertises an enforcement tool it no longer has.
- **Fix:** drop "custom code-pattern checker" from X2's tag → `*(tool: import-graph checker + public-surface reporter + review)*`. (The import-graph checker genuinely enforces X2's "no internal runtime type leaks past the facade"; the rest is review.) Chosen over re-adding the rule because ADR-0002 deleted it deliberately — make the label honest, don't manufacture a rule to fit it.

### P3 — low priority / polish

- **P3.1 — `PiRuntime` collides with the canonical word.** Adapter-internal (not in `pi-adapter.api.md`). Rename when applying the keystone: `PiRuntime`→`PiSessionWiring`, `runtimeCache`→`wiringCache`, `buildRuntime`→`buildWiring`, `runtimeKey`→`wiringKey`, param `runtime`→`wiring`. (`packages/pi-adapter/src/index.ts`)
- **P3.2 — `framework` genus word inconsistent across metadata.** `package.json` keyword `agent-framework` + README:16 say "framework"; both `description`s avoid it (root: "coordination engineering"; core: "Typed building blocks" — reads *library*, the opposite genus). **Keyword stays `agent-framework`.** Alignment: make "framework" appear in the root description so metadata + README + keyword agree. Root → `"A TypeScript framework for agentic coordination: compose many agents, sessions, and model harnesses into one typed program."`; core (one package *inside* the framework, "building blocks" OK but anchored) → `"Core of the microfoom framework: the agent runtime + typed building blocks for coordination."` `framework` stays metadata/docs-only, never a code identifier.
- **P3.3 — Two interior `allowedTools` carriers are stale residue** (your hunch, confirmed narrow). Wire/contract sites are legit and kept. Stale: `Prepared.allowedTools` (program.ts:410; `prepare()` at :452 does `{ allowedTools: merged.tools }`), `RunTurnParams.allowedTools` (tools.ts:356). Rename both to `tools`; do the config→wire rename in exactly one place (`buildTurnRequest`). No public-surface change.
- **P3.4 — `scope()` verb vs `span` noun read as synonyms in README.** Internally a "scope" is one kind of span (real distinction) not surfaced. One-line README precision: "open a scope (a manual grouping span)". (`trace/index.ts:23`, `README.md:121-122`)
- **P3.5 — `foom_call` description verb disagrees with the tool name.** `program.ts:441` announcement says "Methods you may **call** via foom_call:"; `protocol.ts:35` description says "**Invoke** an exposed…". **Fix:** standardize on the tool's own word — `protocol.ts:35` "Invoke" → "**Call** an exposed microfoom method by name." Now description + tool name (`foom_call`) + header all say "call"; zero translation for the model. (One word.)
- **P3.6 — 3 of 4 packages lack `@packageDocumentation`** (core has one; the asymmetry is the defect). Add a `/** @packageDocumentation */` block to the cli / pi-adapter / claudecli-adapter entry indexes.
- **P3.7 — L3's `{ok}`/Result ban: no tool checks it, and the pattern isn't even used.** **Verified:** failures flow through the `FoomtimeError` taxonomy (exceptions); the only result-ish shape is `ToolExecResult { content; isError: boolean; terminate? }` (session.ts:13) — a tool→model *transport DTO*, not a `Result<T,E>`/`{ok:true}|{ok:false}` union. `ok`/`fail`/`stop` (tools.ts:104-106) are just its constructors. No `Result`/`Either` anywhere; no biome/ast-grep rule matches it. **Decision (maintainer):** (a) keep the ban as a forward guardrail protecting the F7 single-error-model, retag the sub-clause `review`; or (b) delete the `{ok}`/Result clause from L3 entirely. **Recommend (a)** — cheap guard on a real design choice, truthful label. *(awaiting maintainer pick)*
- **P3.8 — ADR-0002 title leads with the removed "pi-extension deployment."** Cosmetic. Reorder title → "The harness/adapter owns the turn loop"; keep filename + Context section.

---

## Rename map

`serena rename_symbol` = type-aware LSP rename (safe, follows references). `.api.md` files regenerate via `pnpm api`. Run typecheck + tests after each slice.

| From | To | Kind | Tool | Risk | Scope |
|---|---|---|---|---|---|
| `FoomtimeProgram` | `FoomProgram` | class | serena | low | program.ts (base class) + all `extends` sites in examples/tests + core.api.md |
| `FoomtimeError` | `FoomError` | class | serena | low | errors.ts (taxonomy base) + every `instanceof` site + core.api.md |
| `Foomtime{Abort,Budget…,CallDepth,Cancelled,Concurrency,Config,Dispatch,Harness,HarnessRejected,HarnessUnavailable,Input,RepairExhausted,Throw,Timeout,TokenLimit…}Error` (15) | `Foom*Error` (drop `time`) | class | serena | low | errors.ts + catch/instanceof sites + tests pinning class names + core.api.md |
| `Prepared.allowedTools` | `Prepared.tools` | property | serena | low | program.ts:410 + prepare() :452 + buildRunTurnParams :555 |
| `RunTurnParams.allowedTools` | `RunTurnParams.tools` | property | serena | low | tools.ts:356 + buildTurnRequest :382 (config→wire rename lands here) |
| `AgentRuntimeHooks` | `AgentRunHooks` | type | serena | low | options.ts:13 + index.ts re-export + AgentOptions intersection |
| `PiRuntime` | `PiSessionWiring` | type | serena | low | pi-adapter/src/index.ts (internal) |
| `runtimeCache` | `wiringCache` | identifier | serena | low | pi-adapter/src/index.ts ~514 |
| `buildRuntime` | `buildWiring` | identifier | serena | low | pi-adapter/src/index.ts |
| `runtimeKey` | `wiringKey` | identifier | serena | low | pi-adapter/src/index.ts:375 (+ drop "redundant runtimes" phrasing) |
| `selectTurnTools(runtime)` | `selectTurnTools(wiring)` | identifier | serena | low | pi-adapter/src/index.ts:222 |
| `PI_HARNESS_VERSION` | `PI_VERSION` | identifier | serena | medium | pi-adapter/src/index.ts:57 |
| `CLAUDECLI_HARNESS_VERSION` | `CLAUDECLI_VERSION` | identifier | serena | medium | claudecli-adapter/src/index.ts:41 |
| *(missing)* | `CLI_VERSION` | identifier | manual | low | microfoom-cli/src/index.ts — add export |
| `buildSessionControls` @public | @internal | tag | manual | low | claudecli-adapter/src/index.ts:166 |
| `ClaudeSessionControls` @public | @internal | tag | manual | low | claudecli-adapter/src |
| `AgentEvent` (not in barrel) | re-export from core index.ts | identifier | manual | low | microfoom-core/src/index.ts |
| README "engine" ×4 | "runtime" | doc-text | manual | low | README.md:20,106,106,131 |
| code comments "the engine" ×4 | "the runtime" | doc-text | manual | low | config.ts:8, registry.ts:2, registry.ts:9, usage.ts:102 |
| CONSTITUTION A1 "run engine" | "runtime" | doc-text | manual | low | CONSTITUTION.md:76 |
| CONSTITUTION I1 "tool/keyword" | "control-tool definitions" | doc-text | manual | low | CONSTITUTION.md I1 |
| CONSTITUTION F2 "control operations" | "control tools" | doc-text | manual | low | CONSTITUTION.md F2 |
| ADR-0003 "control operations/ops" | "control tools" | doc-text | manual | low | docs/adr/0003 |
| ADR-0002 title | "The harness/adapter owns the turn loop" | doc-text | manual | low | docs/adr/0002 (title only; keep filename) |
| protocol.ts:35 "Invoke an exposed…" | "Call an exposed…" | prompt-text | manual | low | foom_call description; align verb to tool name (P3.5) |
| root `package.json` description | "A TypeScript framework for agentic coordination…" | doc-text | manual | low | add genus word "framework" (P3.2); keyword `agent-framework` unchanged |
| core `package.json` description | "Core of the microfoom framework: the agent runtime + typed building blocks…" | doc-text | manual | low | anchor to framework (P3.2) |
| CONSTITUTION L2/X2 effect parentheticals | (deleted) | doc-text | manual | low | strip "(amended by ADR-0002 — former Effect mandate dropped)" scar tissue (P1.4) |
| ADR-0002 "@effect/typeclass Monoid" | "hand-written combineUsage/emptyUsage" | doc-text | manual | low | P1.4 |
| ADR-0001 "eslint removed" claim | corrected + table row added | doc-text | manual | low | P1.5 |

**Kept (do NOT rename — legitimate):** `SessionTurnRequest.allowedTools` (wire contract), the `--allowedTools` CLI flag (claudecli index.ts:227, process.ts:92), pi index.ts:223 (reads wire field), `ClaudeSpec.allowedHarnessTools` (keep + TSDoc), `this.agent` (kept on merit — see Decisions #2), the `PROTOCOL_INTRO` prompt string, the `foom_*` wire tool names + `@foom` decorator.

`this.agent → this.runtime` was considered and **declined** — `this.agent` stays.

---

## Constitution & ADR amendments (exact text)

**A1** — *Problem:* names the component "run engine" (only such use) vs "runtime" everywhere else; line 30 uses "runtime" in a different sense.
> A1. Architectural style `[tradeoff]` — Modular monorepo. The reusable core library and the harness-agnostic **runtime** (the turn-executing engine that runs the repair loop, caps, and dispatch) never depend on any specific agent harness; a harness is an adapter built on top of them. *(review)*

**F2** — canonicalize on the public code term.
> F2. … structured **control tools** surfaced as native function-calling … (the four reserved `foom_*` tools — the codebase calls these "control tools" everywhere; "FOOM tools" is an alias for the same set).

**I1** — delete dead "keyword" fossil.
> I1. … the protocol surface (**control-tool definitions**, prompts, operator commands) …

**X2** — drop the deleted checker from the tag.
> X2. … (unchanged body) … *(tool: import-graph checker + public-surface reporter + review)*

**L3** — the `{ok}`/Result pattern is **not used anywhere** in the code and no tool checks it (verified: failures use the `FoomtimeError` taxonomy; `ToolExecResult` is a transport DTO, not a Result union). *Maintainer pick:*
> **(a, recommended)** keep the ban as a forward guard on the F7 single-error-model, retag truthfully: *(tool: linter + custom code-pattern checker + import-graph checker + review)* — the ad-hoc `{ ok }`/`Result`-shape and stringly-typed-failure bans are **review-enforced**; the remainder is tool-enforced.
> **(b)** delete the `{ ok }`/`Result`-shape clause from L3 entirely (the single-error-model is still stated by T6/F7).

**L2 + X2 (effect scar tissue)** — delete the historical Effect parentheticals; state the choice positively.
> L2. Paradigm — plain TypeScript, Promise at the seam `[tradeoff]` — The core is plain, strict TypeScript … (delete "*(amended by ADR-0002 — the former Effect-internal mandate was dropped.)*"). … No additional functional-runtime substrate is layered over the language. *(judgment)*
> X2. Conventional internals, Promise/exception facade. (delete "*(amended by ADR-0002 — the former Effect-internal mandate was dropped.)*") … *(tool: import-graph checker + public-surface reporter + review)*

**ADR-0001 (No Effect bullet + enforcement table)** — correct the false ESLint-removed claim.
> No Effect bullet: "the `@effect/eslint-plugin` rule was removed with `effect`; biome is the primary linter/formatter, with a thin type-aware ESLint layer (typescript-eslint, `eslint.config.js`) for the `no-unsafe-*` family and other rules biome's shallow inference cannot express."
> Enforcement table: ADD row — `type-aware linter | typescript-eslint (eslint.config.js) | L3 (no-any-leak via no-unsafe-*), T1`.

**ADR-0002 (Decision + Consequences — usage monoid)** — remove the effect-typeclass contradiction.
> "usage accounting is a plain hand-written monoid — `combineUsage`/`emptyUsage` (OB3), laws pinned by property tests." (apply in both the Decision bullet and the Consequences paragraph)

**F6** — *Problem:* its "no internal runtime abstraction in any public export or generated type declaration" was (mis)read as banning the *word* "runtime" from public identifier names, and was used to foreclose naming decisions (`this.agent`, `AgentRuntimeHooks`). The sound kernel is about leaking the internal *type*, not the lexeme.
> F6. … The public surface is Promise/`AbortSignal`-based; the internal `Runtime` **type/abstraction** (the run-context and turn-executor) never appears in any public export or generated `.d.ts`. This constrains what types cross the facade, **not** which words may appear in public identifier names — a public symbol may legitimately use the word "runtime"/"run" where it reads clearly. Internals stay behind this one facade seam (X2). *(tool: import-graph checker + public-surface reporter + review)*

**New ADR (recommended)** — record the runtime/`Foom*`/`Agent*`/`framework` naming resolution: `runtime` = the internal turn-executing component; `Foom*` = framework-identity types (program base + error taxonomy); `Agent*` = runtime-domain objects; `framework` = docs-only genus; `Foomtime` retired as dead codename.

---

## Suggested execution order

1. **Keystone slice:** rename `Foomtime*` → `Foom*` (17 symbols); amend A1 + F6; README + 4 comments "engine"→"runtime"; new ADR recording the naming resolution; bundle the pi-adapter `PiRuntime`→`PiSessionWiring` renames so "runtime" means exactly one thing. Regenerate `.api.md`; typecheck + test.
2. **Public-surface P1:** re-export `AgentEvent`; add C2 docstrings.
3. **Governance P1:** ADR-0002 monoid bullet; ADR-0001 ESLint claim + table row.
4. **P2 sweep:** `AgentRuntimeHooks`→`AgentRunHooks`; control-tool canonicalization + delete "keyword"; version-constant normalization; mark adapter internals `@internal`; `allowedHarnessTools` TSDoc; X2 tag fix.
5. **P3 polish** as capacity allows.

---

## Dropped (7 — for transparency, not re-litigated)

- 2 intended-design confirmations: `f6-cli-trace-types-in-public-surface`, `adapters-consume-protocol-no-redrift` — verified clean.
- 1 wrong premise: the core package "double coordination" tagline is a deliberate README-mirrored echo, not a defect.
- 4 naming-taste refutations: `fakeOpenSession` (`fake` is a load-bearing test-double family + dispatch-map key), adapter option-prefix divergence (no shared base to hoist; prefixes are package brands), `omitHarnessBasePrompt` vs `omitBasePrompt` (deliberate T5 domain-vs-transport split), `foomTools` vs `tools` within `ClaudeSpec` (distinct concepts; `ClaudeSpec` is a process-spawn DTO below the contract layer).
