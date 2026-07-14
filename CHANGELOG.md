# Changelog

All notable changes to Unigent are recorded here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/gintasz/unigent/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/gintasz/unigent/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/gintasz/unigent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/gintasz/unigent/releases/tag/v0.1.1
[0.1.0]: https://github.com/gintasz/unigent/releases/tag/v0.1.0
