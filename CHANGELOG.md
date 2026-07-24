# Changelog

All notable changes to Unigent are recorded here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.10] - 2026-07-24

- Upgrade the pinned Pi dependencies to `0.81.0`, whose published shrinkwrap resolves the fixed
  `brace-expansion`, so clean npm consumers pass the high-severity audit.
- Audit the packed SDK and CLI as a clean npm consumer before publishing, preventing a failed
  post-publish audit from leaving an unverified release on the registry.

## [0.1.9] - 2026-07-24

- Rewrite the README for fresh readers: a "Why Unigent?" overview, a quickstart with explicit
  prerequisites, a mental-model map of agents, runs, tools, sessions, scopes, checkpoints, and
  traces, and an architecture diagram, while keeping the full API reference intact.
- Override vulnerable transitive dependencies (`brace-expansion`, `fast-uri`, `linkify-it`) to
  releases that fix their high-severity advisories.

## [0.1.8] - 2026-07-18

- Make Bun shebangs optional for project-backed TypeScript by shipping and automatically loading
  `tsx` whenever the CLI selects Node, with identical behavior in direct, TUI, development, and
  globally installed execution.

## [0.1.7] - 2026-07-18

- Expose each backend invocation as a separate trace turn, including automatic repair prompts and
  failed retry attempts, so the TUI no longer merges or hides repair activity.
- Retry transient repair failures from isolated pre-repair session forks when no user tool has
  completed, retaining only the successful session.

## [0.1.6] - 2026-07-18

- Display complete TUI activity, diagnostic, and output blocks instead of hiding content beyond
  8,000 characters.

## [0.1.5] - 2026-07-16

- Add explicit `-i` argument collection for direct terminal runs, with schema-driven prompts,
  validation retries, complex-input JSON fallback, optional descriptions, and deterministic
  non-interactive/TUI rejection.
- Update Ajv to a release that fixes the `$data` regular-expression denial-of-service advisory.

## [0.1.4] - 2026-07-15

- Replace the seven scoped public packages with two unscoped packages: `unigent-sdk` and
  `unigent-cli`.
- Bundle private core, adapter, and test workspaces into the public artifacts while keeping
  third-party runtime dependencies external and visible to npm.
- Reject packed JavaScript or declarations that leak private `@unigent/*` imports, then verify
  strict TypeScript, offline runtime behavior, repeat installs, and global CLI execution.
- Simplify releases to publish directly to `latest` through npm trusted publishing, followed by
  fresh-cache registry verification and creation of the matching GitHub release.

## [0.1.3] - 2026-07-14

- Keep Pi vendor declarations behind a stable SDK facade so strict consumers can compile with
  `skipLibCheck: false`.
- Stage releases under `next`, verify exact registry artifacts as clean consumers, and promote
  `latest` only after package, runtime, strict TypeScript, audit, and global CLI checks pass.
- Handle registry propagation and minimum-release-age clock skew during post-publish verification.

## [0.1.2] - 2026-07-14

- Publish core, test, and adapter workspaces as normal public packages instead of bundling them
  into the SDK and CLI tarballs.
- Publish the workspace dependency graph in dependency order with exact internal versions.
- Validate repeat installs, packed and global CLI execution, and the complete public package graph.
- Flush the terminal cancellation trace before the CLI exits on `SIGINT`.

## [0.1.1] - 2026-07-14

- Publish the SDK and CLI as `@unigent/sdk` and `@unigent/cli` under the Unigent organization.
- Bundle private core, adapter, and test workspaces into the two public packages.
- Expose deterministic test helpers from `@unigent/sdk/test`.

## [0.1.0] - 2026-07-14

- Attempted initial release; withdrawn after the SDK package name was rejected.

[Unreleased]: https://github.com/gintasz/unigent/compare/v0.1.10...HEAD
[0.1.10]: https://github.com/gintasz/unigent/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/gintasz/unigent/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/gintasz/unigent/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/gintasz/unigent/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/gintasz/unigent/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/gintasz/unigent/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/gintasz/unigent/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/gintasz/unigent/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/gintasz/unigent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/gintasz/unigent/releases/tag/v0.1.1
[0.1.0]: https://github.com/gintasz/unigent/releases/tag/v0.1.0
