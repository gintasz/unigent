# Unigent pre-publish audit — 2026-07-14

Full review before first npm publish: 5 independent code-review passes (core, adapters, CLI, secrets/history, docs) plus hands-on publish-mechanics testing. 52 deduped findings, numbered for reference. Severity: **BLOCKER** = fix before publish, **DECISION** = resolve before publish (not code), **MAJOR** = should fix, acceptable in 0.1.1 if release is urgent, **MINOR** = backlog.

## Verified green (no action needed)

- `check:full` all 21 tasks pass (build, typecheck, lint, coverage, audit, dead code, dup, docs, package contract, API surface).
- `test:tui` deterministic terminal + stress suite passes.
- Live e2e passes 4/4 against real Pi, Claude CLI, and Codex CLI backends — none skipped.
- Clean-room consumer test: all 7 tarballs packed, installed into a fresh project outside the workspace; prose runs, structured output (zod), and the `done` sentinel all work; `unigent <file>` bin runs scripts; `--help` works.
- publint clean on all 7 tarballs; shebang preserved in `dist/cli.js`; `workspace:*` correctly rewritten to concrete versions on pack; root LICENSE auto-embedded by pnpm into every tarball.
- No secrets in working tree or in any of the 197 commits (key-prefix scans, pickaxe over full history, credential-file checks all clean).
- LICENSE is complete verbatim MIT, correct holder/year.
- All 7 npm names unclaimed (`unigent`, `unigent-cli`, `@gintasz/*`).
- GitHub CI green on latest main. Release workflow (tag-triggered, version-tag verification, full gate, provenance) is well designed.
- README code examples import only real exports; API claims match source; no TODO/FIXME/console.log/personal paths in any published src.

---

## Blockers — fix before publish

1. **[security] Codex prompt passed positionally without `--` terminator.**
   `packages/unigent-adapter-codexcli/src/process.ts:85-90` (`buildCodexArgs`) — prompt is the last bare argv element. Verified against the installed CLI: a prompt starting with `-` kills the turn with a clap usage error; a prompt starting with `-c<key>=<value>` parses as a Codex config override — untrusted prompt text can rewrite e.g. `base_url` or `shell_environment_policy` in a process already running `--dangerously-bypass-approvals-and-sandbox`. The Claude adapter already guards with `--` (`unigent-adapter-claudecli/src/index.ts:141`). Fix: insert `--` before the prompt; also in the `exec resume` branch.

2. **Ctrl+C orphans the running script (reproduced empirically).**
   `packages/unigent-cli/src/register.ts:36-41` + `src/cli.ts:49-57`. The injected SIGINT handler only aborts agent runs, never exits, and there is no second-SIGINT force-exit; the parent CLI has no SIGINT handler, so the terminal Ctrl+C kills the parent and leaves the child running (verified on macOS: orphan survived indefinitely). Any script with a timer/server/stalled backend needs `kill -9`. Exit code 130 is also lost.

3. **"npm — coming soon" badge ships onto live npm pages.**
   `README.md:14`. `scripts/sync-package-docs.mjs` copies this README verbatim into all 7 packages at release, so every published package page will say "coming soon" for a live package. Replace with a real version badge (e.g. shields `npm/v/unigent`).

4. **`unigent tui` hard-requires Bun — undeclared and undocumented.**
   `packages/unigent-cli/src/cli.ts:81` unconditionally spawns `"bun"` for TUI mode, even for plain Node scripts. No Bun → `unigent: spawn bun ENOENT`. README install section says only "Node.js 24 or newer"; package.json declares nothing. Fix: detect and print an actionable error (or fall back to node where possible), and document the requirement in README + package description.

5. **`@gintasz/core` force-loads the TypeScript compiler on every consumer.**
   `packages/unigent-core/src/source_tools.ts:2` — static `import ts from "typescript"`, reached via `index.ts → runtime.ts:26`. Every consumer pays a ~50MB install AND loads the entire compiler at `import "@gintasz/core"` time, even with zero source tools. Bundlers also choke on typescript's dynamic requires. Fix without behavior change: lazy `await import("typescript")` inside `compileSourceTools`, move `typescript` to an optional peerDependency, throw `AgentConfigError` with an install hint when absent.

## Decisions — resolve before publish (not code)

6. **Git history: 81 of 197 commit messages on public main are junk.**
   ~71 are `.`/`asd`/`mnb`/`≥`/single chars; ~10 are keyboard mash (`jkhgkhj`, `m,hjghdfhg`, `,';l';l`, `good shit`). Repo `github.com/gintasz/unigent` is already public; the npm release is what sends readers there. Additionally, `.papercuts.jsonl` (tracked between commits bf5b419 and 01b9413, blobs still reachable) leaks `/Users/gintas/...` paths and prior project names, and history carries ~1MB of deleted binaries. Only fix is a history rewrite (squash/filter-repo or fresh-root).

7. skip #7

8. **READMEs exist in tarballs only via the exact `pnpm run release` path, unguarded.**
   `packages/*/README.md` do not exist in the tree; `scripts/sync-package-docs.mjs` creates them transiently only inside the root `release` script. `scripts/check-package-contract.mjs` packs from the working tree and passes without them, so the gate green-lights README-less tarballs. Any other publish path (manual `pnpm publish` in a package dir) ships blank npm pages. Rule: publish ONLY via the tag → Actions path; better, make `check-package-contract` assert README presence inside the packed tarball.

## Major — fix soon (0.1.1 acceptable)

9. **[security] Unauthenticated localhost MCP tool server, DNS-rebinding exposed.**
   `packages/unigent-core/src/mcp.ts:89-124`, started per turn by both CLI adapters. Binds 127.0.0.1 with no auth token, no Origin/Host validation (the SDK's DNS-rebinding protection options are not enabled; options are cast through `as unknown as`), answers on any path, stateless sessions. While a turn is in flight, any local process — or a malicious web page via DNS rebinding — can POST `tools/call` and execute the agent's tools with the harness's privileges. Fix: per-server random bearer token checked on every request + enable the SDK's `enableDnsRebindingProtection`/allowed-hosts options. Consider pulling this into the pre-publish list.

10. **Source tools crash in compiled production builds.**
    `packages/unigent-core/src/source_tools.ts:84, 247, 296`. The documented `source: import.meta.url` pattern points at compiled `.js` in production: the checker sees `any` and throws `AgentConfigError: unsupported source tool type: any`, or the anchor file is missing from the parsed program. Works under `tsx`/dev, dies after `tsc && node dist/main.js` or in a dist-only Docker image.

    **Fix — one architecture, built properly upfront: schema extraction becomes a resolution pipeline whose canonical production source is a build-time artifact.**
    - Add `unigent bake <entry>` (command in unigent-cli, logic in core): runs the exact reflection `compileSourceTools` performs today, but at build time, and emits a manifest (`unigent-tools.json` or a generated `.tools.js` module) next to the compiled output. Same code path as dev — one reflection implementation, two invocation times.
    - Schema resolution order inside `compileSourceTools`:
      1. Manifest found adjacent to the resolved anchor module → use it (production).
      2. Anchor resolves to real `.ts` source (tsx, bun, Node 24 native type stripping — already the engine floor) → live reflection, today's behavior (development).
      3. Neither → throw `AgentConfigError` at `agent()` construction naming both remedies. The TypeScript checker must never be reached with a `.js` anchor — that is the source of today's cryptic `any` error.
    - Consequences: dev and prod produce identical schemas from one code path; `typescript` becomes a genuinely optional peer (completes #5 — production images never install or load the compiler); schemas become deterministic, diffable build artifacts, consistent with the checkpoint-fingerprint design.
    - Precedent: typia and Deepkit — runtime type magic relocated to compile time is the pattern that survived in this ecosystem.

11. **Memory leak: every root run's full trace is retained forever.**
    `packages/unigent-core/src/runtime.ts:912-916, 1114-1116`. Each run's complete `EventLog` (prompts + all streamed text) is pushed into the agent's own `ScopeState.traces` and never removed; plain `Agent` handles don't expose `traces`, so it's unfreeable. Long-lived server with one `agent()` and `.run()` per request → unbounded heap growth.

    **Fix — ownership principle: the run owns its trace; any storage outliving the run needs an owner with a bounded lifetime.**
    - Delete the push into the agent's implicit root `ScopeState` in `registerScopeTrace` (`runtime.ts:912-916`). The agent handle exposes no `traces` getter, so this copy is unreachable by anyone — pure leak. Callers already receive the complete trace as `result.trace`; live observers already receive every event via `subscribeTrace` (diagnostics_channel).
    - Keep `scope.traces` on explicit `scope()` handles (`makeScope`, `runtime.ts:1276`), but bound it: `scope({ retainTraces: <n> })` ring buffer of the most recent root-run logs, with a documented default (e.g. 50). Raise it where full retro-inspection of a bounded workflow is wanted.
    - **DX impact — nothing user-visible degrades, no data loss:**
      - Plain `agent()` users: zero behavior change; only the OOM disappears. `result.trace` remains the complete trace of that run.
      - TUI/CLI rendering: unaffected. The inspector consumes the live event stream (`register.ts` `subscribeTrace` → trace pipe → TUI's own store), never `ScopeState.traces` — verified: zero references in `packages/unigent-cli/src`. Every event still flows; pagination in the TUI is its own concern.
      - Only visible change: on a long-lived explicit scope, `scope.traces` returns the last N runs instead of every run since process start — the alternative ("keep everything") is precisely the leak.
    - Do this before publish, not in 0.1.1: it changes `AgentScope.traces` semantics, and the only free moment for that is before anyone has installed 0.1.0. Small change: one push site, one option, one getter (~2-4 h with tests).

12. **Script-runner fatal handler suppresses stacks and never exits.**
    `packages/unigent-cli/src/register.ts:43-60` + `src/error_message.ts:63-69`. `uncaughtException`/`unhandledRejection` print only `error.message` — no file/line/stack — and set `exitCode` without exiting, so a script with any live handle runs forever after a "fatal" error. Debugging user scripts is this product's job.

13. **Prompts passed as single argv elements → `E2BIG` on Linux; also visible in `ps`.**
    `unigent-adapter-claudecli/src/index.ts:137-141`, `unigent-adapter-codexcli/src/process.ts:65, 88-89`. Linux `MAX_ARG_STRLEN` caps one argv element at ~128KiB; a prompt embedding file context beyond that fails spawn as `AgentBackendUnavailableError("spawn E2BIG")`. Both CLIs accept stdin; the adapters set `stdio[0]: "ignore"`. Feed prompts via stdin (also fixes #19).

14. **Budget double-counting across scopes.**
    `packages/unigent-core/src/runtime.ts:946-959`. Nested run whose scope differs from the parent's adds usage to that scope only, while root finalization adds the rolled-up usage to all ancestors → nested usage counted twice in the ancestor; with `limits.budgetUsd`, `AgentBudgetExceededError` fires at roughly half the real budget.

15. **Checkpoint store I/O on the run's critical path with no degradation.**
    `packages/unigent-core/src/runtime.ts:733, 762`. A throwing `store.set` rejects the run after the agent finished (money spent, output discarded); a throwing `store.get` fails the run before it starts. One transient disk/network error converts a completed multi-dollar run into an error.

16. **Claude adapter leaks the MCP server when arg construction throws.**
    `packages/unigent-adapter-claudecli/src/index.ts:189-192`. `startMcpToolServer` is awaited before `baseArgs(...)`, which is evaluated outside the `try/finally`. `baseArgs → pluginSettings → execFileSync("claude plugin list --json")` throws on missing binary, non-zero exit, bad JSON, or unknown plugin name → one leaked listening HTTP server per turn; process never exits.

17. **Codex adapter: same leak shape via temp-file creation outside `try`.**
    `packages/unigent-adapter-codexcli/src/index.ts:156-159`. `instructionFile()` (`mkdtempSync`/`writeFileSync`) runs between server start and `try`. Full disk or unwritable `$TMPDIR` → leaked MCP server; if `writeFileSync` throws after `mkdtempSync`, the temp dir leaks too.

18. **tsconfig parsed against process CWD instead of the config's directory.**
    `packages/unigent-core/src/source_tools.ts:296` — `ts.parseJsonConfigFileContent(config.config, ts.sys, ts.sys.getCurrentDirectory())`. `include`/`exclude`/relative paths resolve against wherever the app was launched from → wrong file sets, giant scans, or missing project files depending purely on cwd. Base should be `dirname(configPath)`.

19. **Prompt and system prompt readable in `ps`/`/proc/*/cmdline`.**
    Same lines as #13 — full prompt text sits in argv for the duration of each turn, readable by any local user. Fixed by the stdin move.

## Minor — core

20. Checkpoint `hit`/`wait` re-adds recorded usage incl. `costUsd` to the current account — scopes report money never spent; budgets drained by cache replays. If intentional, document it. `runtime.ts:736, 743-745`. Maintainer comment: yes, it's intentional.
21. Session `opening ??= ...` caches a rejected promise forever — one transient `openSession` failure permanently poisons the session. `runtime.ts:1180-1186`.
22. Same pattern in the Pi adapter: `wiringPromise` caches the first `buildWiring` rejection; re-authenticating never recovers the `Backend`. `unigent-adapter-pi/src/index.ts:378-382`.
23. `run(prompt, x)` with a non-object second arg crashes with bare `TypeError: Cannot use 'in' operator`; config failures throw synchronously from `run()` while all other failures reject the returned `AgentRun` — inconsistent error delivery on the flagship API. `runtime.ts:1237-1246, 1102-1112`.
24. `limits.turnDuration` actually bounds the entire run (all retries + repair turns + tool time), not one turn; the error even says "run exceeded". Rename or fix semantics. `runtime.ts:1121-1127, 987`.
25. `retries`/`repairAttempts` unvalidated: `repairAttempts: -1` makes the first recoverable tool error fatal; `retries: -1` yields the misleading "backend produced no result". Reject at `agent()`. `runtime.ts:1348-1349, 366`.
26. `TraceProjection.snapshot()` returns the live mutable `roots` array typed `readonly`; later `append()` mutates previously returned "snapshots", breaking memoized rendering. `trace.ts:182-193`.
27. Nested run's `run.events` is the shared root `EventLog`: streams parent + sibling events, terminates only at root end; events emitted after `end()` (fire-and-forget nested run outliving root) are recorded but never delivered. `events.ts:95-116, 130-146`; `runtime.ts:970-973`.
28. `budgetUsd` checked only pre-start/post-settle: parallel siblings each pass the pre-check without seeing each other's in-flight spend; the post-check throws away successful output. Document as best-effort. `runtime.ts:569-577, 1021-1034`.
29. `programCache` holds `ts.Program` instances forever keyed by path — stale after file edits (hot-reload reflects old signatures) and pins a full compiler program graph in memory per anchor module. `source_tools.ts:278-303`.

## Minor — adapters

30. Child CLI process not killed when the stream loop exits via a thrown exception (only the abort signal kills it); the CLI keeps running with permissions bypassed. `unigent-adapter-claudecli/src/index.ts:193-207`; `unigent-adapter-codexcli/src/index.ts:109-127`.
31. `execFileSync("claude", ["plugin","list","--json"])` runs per turn when `plugins` is set — blocks the event loop ~1-2s, stalling all concurrent runs' streams and MCP servers. Cache it / make it async. `unigent-adapter-claudecli/src/index.ts:43, 116`.
32. User cancel surfaces as `AgentBackendUnavailableError` from both CLI adapters (core masks it, but direct adapter consumers see "backend unavailable" for a cancel); the Pi adapter correctly throws `AgentCancelledError` — inconsistent contract. `claudecli/src/index.ts:208-218`; `codexcli/src/index.ts:129-146`.
33. stderr concatenated into an uncapped string for the turn's lifetime (claude runs with `--verbose`) — unbounded memory on a chatty/looping CLI. `claudecli/src/process.ts:35-37`; `codexcli/src/process.ts:110-112`.
34. Turn completion keys on stdout close and reads stderr immediately after — chunks still buffered in the pipe are lost, truncating the only diagnostic on the no-result failure path. `claudecli/src/index.ts:214`; `codexcli/src/index.ts:174`.
35. Windows: bare `spawn("claude")`/`spawn("codex")`/`execFileSync("claude")` with no `.cmd` resolution and no binary-path option (only the test-only `processFactory`) → `ENOENT` for npm-shim installs; no stated platform support. `claudecli/src/process.ts:19`, `src/index.ts:43`; `codexcli/src/process.ts:97`.
36. No version-drift handling for wrapped CLIs (newer flags on older CLIs → raw usage errors); worse, codex fork greps `~/.codex/sessions` for `-<sessionId>.jsonl` and patches only the first line if it is `session_meta` — a rollout-format change makes forks silently keep the parent id. `codexcli/src/fork.ts:36-67`.
37. `thinking` handled three ways: Pi validates and throws, Codex silently drops unknown levels, Claude forwards unvalidated to `--effort` (fails downstream). Same option, three behaviors. `claudecli/src/index.ts:167-169`; `codexcli/src/process.ts:70`; `adapter-pi/src/index.ts:83-91`.
38. Permission bypass unconditional (`--permission-mode bypassPermissions` / `--dangerously-bypass-approvals-and-sandbox`) with no opt-out; adding sandbox flags via `extraArgs` conflicts with the always-present bypass. Documented as deliberate, but consumers cannot opt into the wrapped CLI's own sandbox. `claudecli/src/index.ts:135-136`; `codexcli/src/process.ts:40`.

## Minor — CLI

39. No `--version` flag — `unigent --version` is treated as a filename and dies with raw `ENOENT: no such file or directory, open '.../--version'`; same raw ENOENT for any typo'd path. `packages/unigent-cli/src/command.ts:13-23`; `src/script_runtime.ts:16`.
40. Trace events serialized and written to hardcoded fd 3 even in plain `run` mode where no fd-3 pipe exists — environment-dependent (first write fails ENXIO, swallowed) and wasted CPU per event. `src/register.ts:7-12`.
41. Shared (non-circular) sibling objects render as `[Circular]` in the TUI — the replacer's WeakSet tracks all seen objects, not the ancestor path. Silent data loss in the inspector. `src/protocol.ts:17-38`.
42. Literal `--` inside script arguments drops args in TUI mode: `unigent tui s.ts -- a -- b` yields `["b"]` instead of `["a","--","b"]`. Run mode unaffected. `src/tui.tsx:47-49`.
43. Signal death always reported as exit 128 instead of 128+signum (SIGKILL should be 137). `src/cli.ts:20, 54`.
44. Shipped sourcemaps reference unshipped `../src/*.ts` with no `sourcesContent`; `.d.ts`/`.d.ts.map` are dead weight in a bin-only package with no `exports`/`main`.
45. Unmet transitive peers (`react-devtools-core`, `ws` from @opentui/react; `web-tree-sitter` from @opentui/core) print warnings on pnpm/yarn installs. Verified none are statically imported — works, but noisy first impression.
46. `engines: node >=24` unenforced — Node 20/22 users get "Unknown file extension .ts" instead of a clear version message. Cheap runtime check in `cli.ts` fixes it.
47. Copy notice can lie: OSC-52 written straight to stdout and `true` returned unconditionally — "✓ N copied" on terminals without OSC-52 support (stock Terminal.app) while nothing was copied. `src/tui/clipboard.ts:3-9`.

## Minor — docs, repo, packaging

48. ignore 48
49. README relative links (`./examples`, `examples/hello.ts`, `LICENSE`) will misresolve on npmjs.com — npm rewrites them against `repository.url` + per-package `directory`, e.g. `.../packages/unigent-core/examples/hello.ts` (nonexistent). Images are already absolute (correct). Verify one package page right after first publish.
50. Failed mid-publish leaves stray uncommitted `README.md`/`LICENSE` copies in every package — `release` is `&&`-chained so `sync --clean` never runs on failure; easy to commit by accident. Wrap in a trap/finally.
51. Small items: CONSTITUTION.md verdicts jump V4 → V6 (looks like a deleted verdict); `examples/skill_improvement.ts` header says `node ...` and skips the `--` separator every other example uses; `keywords` missing in 5 of 7 package.json files (npm search discoverability); "cross-session" tagline in README:7 has no direct feature behind it ("cross-harness" is substantiated); `.gitignore` lacks `.env`/`.env.*` (preventive); no CHANGELOG.md anywhere — fine for 0.1.0, decide the convention before 0.2.0.
52. Deliberate-decision items — fine if intentional, flagged so they are chosen, not accidental: ESM-only publish profile (attw: CJS consumers get dynamic-import-only, node10 `moduleResolution` fails entirely); workspace deps publish as exact `0.1.0` rather than `^0.1.0` (blocks node_modules dedupe across patch releases; syncpack may be enforcing this); author email is public in all package.json files and on npm. Maintainer comment: author's real email should not be public in packages.

---

## Suggested order of work

1. #1 (5 min, security) → #3 (5 min) → #4 (~30 min) → #2 (~1-2 h) → #5 (~1-2 h).
2. Decide #6 (history rewrite) and complete #7 (npm org + token) — required for the release workflow to succeed.
3. #9 (MCP auth) strongly recommended before publish if time allows; otherwise first patch release together with #10-#19.
